/**
 * WebGL2 compositor — shared by the v1 <video> engine and the future v2
 * WebCodecs engine (only the frame SOURCE differs, design doc §4.1).
 *
 * Contract highlights (docs/rendering-semantics.md):
 * - §2: transform math is done in project output space; the canvas drawing
 *   buffer IS project-resolution (W x H), CSS scales it to the panel.
 * - §6.3/§6.4: straight (unassociated) alpha compositing on non-linear sRGB:
 *   context { premultipliedAlpha: false }, UNPACK_PREMULTIPLY_ALPHA_WEBGL
 *   false, blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE,
 *   ONE_MINUS_SRC_ALPHA).
 * - Project backgroundColor is the clear color (the "canvas").
 * - Draw order: caller passes items BOTTOM first.
 */
import type { Transform } from '@videoedit/timeline-schema';
import type { ColorAdjust } from '../core/resolve';
import { computePlacement, unitQuadToNdcMatrix } from '../core/transform';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';

export interface DrawItem {
  texture: WebGLTexture;
  /** Source natural size in px (video: videoWidth/Height). */
  srcW: number;
  srcH: number;
  /** Effective transform (keyframes already applied). */
  transform: Transform;
  /** Effective opacity 0..1 (keyframes already applied). */
  opacity: number;
  /** null = no color adjust (identity — uniforms all 0 fall through as no-op). */
  colorAdjust: ColorAdjust | null;
}

interface Uniforms {
  uMatrix: WebGLUniformLocation;
  uTex: WebGLUniformLocation;
  uOpacity: WebGLUniformLocation;
  uExposure: WebGLUniformLocation;
  uTemperature: WebGLUniformLocation;
  uTint: WebGLUniformLocation;
  uBrightness: WebGLUniformLocation;
  uContrast: WebGLUniformLocation;
  uSaturation: WebGLUniformLocation;
}

/** #RGB / #RRGGBB / #RRGGBBAA -> [r,g,b] floats (alpha ignored: canvas is opaque). */
export function parseHexColor(hex: string): [number, number, number] {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const int = Number.parseInt(h.slice(0, 6).padEnd(6, '0'), 16);
  if (Number.isNaN(int)) return [0, 0, 0];
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms: Uniforms;
  private width = 0;
  private height = 0;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      // §6.4: straight alpha pipeline — the context must NOT premultiply.
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.program = this.buildProgram();
    this.uniforms = this.lookupUniforms();

    // Unit quad as a triangle strip: (0,0) top-left in source/texture space.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // §6.4: straight-alpha blend equation.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    // §6.4: never premultiply on upload.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`);
    }
    return program;
  }

  private lookupUniforms(): Uniforms {
    const gl = this.gl;
    const get = (name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(this.program, name);
      if (!loc) throw new Error(`Uniform not found: ${name}`);
      return loc;
    };
    return {
      uMatrix: get('uMatrix'),
      uTex: get('uTex'),
      uOpacity: get('uOpacity'),
      uExposure: get('uExposure'),
      uTemperature: get('uTemperature'),
      uTint: get('uTint'),
      uBrightness: get('uBrightness'),
      uContrast: get('uContrast'),
      uSaturation: get('uSaturation'),
    };
  }

  /** Set the drawing buffer to the project output resolution (math space §2.1). */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload a video frame / image into a texture (v1 frame source: texImage2D). */
  upload(texture: WebGLTexture, source: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  deleteTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  /** Compose one output frame. items are BOTTOM first (lower tracks first). */
  render(items: readonly DrawItem[], backgroundHex: string): void {
    if (this.disposed || this.width === 0) return;
    const gl = this.gl;
    const [r, g, b] = parseHexColor(backgroundHex);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (items.length === 0) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uniforms.uTex, 0);

    for (const item of items) {
      if (item.srcW <= 0 || item.srcH <= 0 || item.opacity <= 0) continue;
      const placement = computePlacement({
        srcW: item.srcW,
        srcH: item.srcH,
        compW: this.width,
        compH: this.height,
        transform: item.transform,
      });
      const matrix = unitQuadToNdcMatrix(placement, item.srcW, item.srcH, this.width, this.height);
      gl.uniformMatrix3fv(this.uniforms.uMatrix, false, matrix);
      gl.uniform1f(this.uniforms.uOpacity, item.opacity);
      const ca = item.colorAdjust;
      gl.uniform1f(this.uniforms.uExposure, ca?.exposure ?? 0);
      gl.uniform1f(this.uniforms.uTemperature, ca?.temperature ?? 0);
      gl.uniform1f(this.uniforms.uTint, ca?.tint ?? 0);
      gl.uniform1f(this.uniforms.uBrightness, ca?.brightness ?? 0);
      gl.uniform1f(this.uniforms.uContrast, ca?.contrast ?? 0);
      gl.uniform1f(this.uniforms.uSaturation, ca?.saturation ?? 0);
      gl.bindTexture(gl.TEXTURE_2D, item.texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
