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
import type { Transform, TransitionType } from '@videoedit/timeline-schema';
import type { ColorAdjust } from '../core/resolve';
import { TRANSITION_MODE } from '../core/transitionRef';
import { computePlacement, invertAffineMat3, unitQuadToNdcMatrix } from '../core/transform';
import {
  FRAGMENT_SHADER,
  TRANSITION_FRAGMENT_SHADER,
  TRANSITION_VERTEX_SHADER,
  VERTEX_SHADER,
} from './shaders';

/**
 * GPU half of a §4.2 lut effect: the parsed .cube already uploaded as a 3D
 * texture (createLutTexture). `size` feeds the normative uLutScale/uLutOffset
 * ((N-1)/N and 1/(2N)); intensity is the mix weight.
 */
export interface LutDrawState {
  texture: WebGLTexture;
  size: number;
  /** 0..1 (0 never arrives: resolve.lutOf collapses it to "no lut"). */
  intensity: number;
}

export interface DrawItem {
  texture: WebGLTexture;
  /** Source natural size in px (video: videoWidth/Height). */
  srcW: number;
  srcH: number;
  /** Effective transform (keyframes already applied). */
  transform: Transform;
  /**
   * Overlay rasters (text/shape, §7) are drawn at `bboxPx * scale`, not fit to
   * the composition — see PlacementInput.baseScale. Omitted for media frames.
   */
  baseScale?: number;
  /** Effective opacity 0..1 (keyframes already applied). */
  opacity: number;
  /** null = no color adjust (identity — uniforms all 0 fall through as no-op). */
  colorAdjust: ColorAdjust | null;
  /**
   * §4.2 lut, or absent/null for none (uIntensity 0 + dummy 1-texel texture =
   * exact no-op). Optional so callers that predate the effect stay valid.
   */
  lut?: LutDrawState | null;
}

/**
 * Both sides of a cut, mixed in ONE pass (rendering-semantics §5.3).
 *
 * Why one item instead of "draw A, then draw B with opacity p": the xfade
 * functions are not all alpha blends. A wipe or a dissolve SELECTS a source per
 * pixel, and even a crossfade is a weighted average of the two colours, not B
 * painted over A (that would leave A's grade showing through where B is
 * transparent). One pass with two samplers is also what keeps the preview
 * honest at p=0.5: exactly half of each, computed once.
 */
export interface TransitionDrawItem {
  kind: 'transition';
  /** Outgoing side (A). */
  from: DrawItem;
  /** Incoming side (B). */
  to: DrawItem;
  type: TransitionType;
  /** p in [0,1] (§5.3, linear). */
  progress: number;
}

export type RenderItem = DrawItem | TransitionDrawItem;

export function isTransitionItem(item: RenderItem): item is TransitionDrawItem {
  return (item as TransitionDrawItem).kind === 'transition';
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
  // §4.2 — normative names.
  uLut3D: WebGLUniformLocation;
  uLutScale: WebGLUniformLocation;
  uLutOffset: WebGLUniformLocation;
  uIntensity: WebGLUniformLocation;
}

/** Uniform handles of the transition program (see shaders.ts). */
interface TransitionUniforms {
  uTexA: WebGLUniformLocation;
  uTexB: WebGLUniformLocation;
  uInvA: WebGLUniformLocation;
  uInvB: WebGLUniformLocation;
  uOpacityA: WebGLUniformLocation;
  uOpacityB: WebGLUniformLocation;
  uProgress: WebGLUniformLocation;
  uMode: WebGLUniformLocation;
  uExposureA: WebGLUniformLocation;
  uTemperatureA: WebGLUniformLocation;
  uTintA: WebGLUniformLocation;
  uBrightnessA: WebGLUniformLocation;
  uContrastA: WebGLUniformLocation;
  uSaturationA: WebGLUniformLocation;
  uExposureB: WebGLUniformLocation;
  uTemperatureB: WebGLUniformLocation;
  uTintB: WebGLUniformLocation;
  uBrightnessB: WebGLUniformLocation;
  uContrastB: WebGLUniformLocation;
  uSaturationB: WebGLUniformLocation;
  // §4.2 lut, per side (the export applies effects inside each source chain).
  uLut3DA: WebGLUniformLocation;
  uLutScaleA: WebGLUniformLocation;
  uLutOffsetA: WebGLUniformLocation;
  uIntensityA: WebGLUniformLocation;
  uLut3DB: WebGLUniformLocation;
  uLutScaleB: WebGLUniformLocation;
  uLutOffsetB: WebGLUniformLocation;
  uIntensityB: WebGLUniformLocation;
}

/** Suffix-per-side names of the §4.1 uniforms in the transition program. */
const CA_UNIFORM_KEYS = [
  'Exposure',
  'Temperature',
  'Tint',
  'Brightness',
  'Contrast',
  'Saturation',
] as const;

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
  private transitionProgram: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms: Uniforms;
  private transitionUniforms: TransitionUniforms;
  /**
   * 1-texel identity 3D texture, bound to the LUT units whenever a layer has
   * no lut. WebGL defines sampling an unbound sampler3D as (0,0,0,1), so the
   * math would still be right at uIntensity 0 — but leaving a sampler
   * incomplete draws driver warnings on every frame and is undefined enough
   * on old stacks that a real texture is the honest baseline.
   */
  private dummyLut: WebGLTexture;
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

    this.program = this.buildProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = this.lookupUniforms();
    this.transitionProgram = this.buildProgram(
      TRANSITION_VERTEX_SHADER,
      TRANSITION_FRAGMENT_SHADER,
    );
    this.transitionUniforms = this.lookupTransitionUniforms();

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

    // LUT'suz katmanların örneklediği 1 texel'lik yer tutucu (uIntensity 0 ile no-op).
    this.dummyLut = this.createLutTexture(1, new Float32Array([0, 0, 0, 1]));
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

  private buildProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
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

  /**
   * Uniform handle or a throw. A missing handle means the shader compiled but
   * does not USE the uniform (drivers strip those) — i.e. a value the CPU
   * carefully computes never reaches a pixel. Failing loudly at construction is
   * the only way that surfaces before someone stares at a wrong frame.
   */
  private uniformIn(program: WebGLProgram, name: string): WebGLUniformLocation {
    const loc = this.gl.getUniformLocation(program, name);
    if (!loc) throw new Error(`Uniform not found: ${name}`);
    return loc;
  }

  private lookupTransitionUniforms(): TransitionUniforms {
    const p = this.transitionProgram;
    const get = (name: string): WebGLUniformLocation => this.uniformIn(p, name);
    const grade = {} as Record<string, WebGLUniformLocation>;
    for (const key of CA_UNIFORM_KEYS) {
      grade[`u${key}A`] = get(`u${key}A`);
      grade[`u${key}B`] = get(`u${key}B`);
    }
    return {
      uTexA: get('uTexA'),
      uTexB: get('uTexB'),
      uInvA: get('uInvA'),
      uInvB: get('uInvB'),
      uOpacityA: get('uOpacityA'),
      uOpacityB: get('uOpacityB'),
      uProgress: get('uProgress'),
      uMode: get('uMode'),
      uLut3DA: get('uLut3DA'),
      uLutScaleA: get('uLutScaleA'),
      uLutOffsetA: get('uLutOffsetA'),
      uIntensityA: get('uIntensityA'),
      uLut3DB: get('uLut3DB'),
      uLutScaleB: get('uLutScaleB'),
      uLutOffsetB: get('uLutOffsetB'),
      uIntensityB: get('uIntensityB'),
      ...grade,
    } as TransitionUniforms;
  }

  private lookupUniforms(): Uniforms {
    const get = (name: string): WebGLUniformLocation => this.uniformIn(this.program, name);
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
      uLut3D: get('uLut3D'),
      uLutScale: get('uLutScale'),
      uLutOffset: get('uLutOffset'),
      uIntensity: get('uIntensity'),
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

  /**
   * Parsed .cube -> 3D texture (rendering-semantics §4.2).
   *
   * - `data` is RGBA float, length size³×4, red-fastest (cubeLut.parseCubeLut's
   *   layout — identical to texImage3D's x-fastest memory order, so the file
   *   order IS the upload order).
   * - Internal format RGBA16F: half floats keep the table's precision far
   *   under the ±1/255 quantisation of the 8-bit output while staying
   *   TEXTURE-FILTERABLE in core WebGL2 (32F would need an extension for
   *   LINEAR filtering; 8-bit would quantise the table itself).
   * - LINEAR min/mag on a 3D texture = trilinear interpolation, the §4.2
   *   normative mode (matches the export's `interp=trilinear`).
   * - CLAMP_TO_EDGE on all three axes: with the (N-1)/N + 1/(2N) mapping the
   *   coordinates stay inside texel centers anyway; clamping is defence.
   */
  createLutTexture(size: number, data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return tex;
  }

  deleteTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  /** The §2.4 unit-quad -> NDC matrix of one item at the current buffer size. */
  private matrixOf(item: DrawItem): Float32Array {
    const placement = computePlacement({
      srcW: item.srcW,
      srcH: item.srcH,
      compW: this.width,
      compH: this.height,
      transform: item.transform,
      baseScale: item.baseScale,
    });
    return unitQuadToNdcMatrix(placement, item.srcW, item.srcH, this.width, this.height);
  }

  private drawable(item: DrawItem): boolean {
    return item.srcW > 0 && item.srcH > 0 && item.opacity > 0;
  }

  /**
   * One transition pass: both sides sampled through the INVERSE of their own
   * placement, mixed by the §5.3 function for `type`.
   *
   * Degradation rule: when one side has no frame yet (a decoder still warming
   * up mid-window), the pass is skipped and the caller draws the available side
   * the ordinary way — a half-decoded crossfade must not black out the picture.
   */
  private renderTransition(item: TransitionDrawItem): boolean {
    const gl = this.gl;
    if (!this.drawable(item.from) || !this.drawable(item.to)) return false;
    const invA = invertAffineMat3(this.matrixOf(item.from));
    const invB = invertAffineMat3(this.matrixOf(item.to));
    if (!invA || !invB) return false; // degenerate placement (scale 0)

    const u = this.transitionUniforms;
    gl.useProgram(this.transitionProgram);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(u.uTexA, 0);
    gl.uniform1i(u.uTexB, 1);
    gl.uniform1i(u.uLut3DA, 2);
    gl.uniform1i(u.uLut3DB, 3);
    gl.uniformMatrix3fv(u.uInvA, false, invA);
    gl.uniformMatrix3fv(u.uInvB, false, invB);
    gl.uniform1f(u.uOpacityA, item.from.opacity);
    gl.uniform1f(u.uOpacityB, item.to.opacity);
    gl.uniform1f(u.uProgress, Math.min(1, Math.max(0, item.progress)));
    gl.uniform1i(u.uMode, TRANSITION_MODE[item.type]);
    const a = item.from.colorAdjust;
    const b = item.to.colorAdjust;
    gl.uniform1f(u.uExposureA, a?.exposure ?? 0);
    gl.uniform1f(u.uTemperatureA, a?.temperature ?? 0);
    gl.uniform1f(u.uTintA, a?.tint ?? 0);
    gl.uniform1f(u.uBrightnessA, a?.brightness ?? 0);
    gl.uniform1f(u.uContrastA, a?.contrast ?? 0);
    gl.uniform1f(u.uSaturationA, a?.saturation ?? 0);
    gl.uniform1f(u.uExposureB, b?.exposure ?? 0);
    gl.uniform1f(u.uTemperatureB, b?.temperature ?? 0);
    gl.uniform1f(u.uTintB, b?.tint ?? 0);
    gl.uniform1f(u.uBrightnessB, b?.brightness ?? 0);
    gl.uniform1f(u.uContrastB, b?.contrast ?? 0);
    gl.uniform1f(u.uSaturationB, b?.saturation ?? 0);
    // §4.2, per side: the lut of A must not leak onto B (and vice versa).
    const lutA = item.from.lut ?? null;
    const lutB = item.to.lut ?? null;
    gl.uniform1f(u.uLutScaleA, lutA ? (lutA.size - 1) / lutA.size : 0);
    gl.uniform1f(u.uLutOffsetA, lutA ? 1 / (2 * lutA.size) : 0.5);
    gl.uniform1f(u.uIntensityA, lutA ? lutA.intensity : 0);
    gl.uniform1f(u.uLutScaleB, lutB ? (lutB.size - 1) / lutB.size : 0);
    gl.uniform1f(u.uLutOffsetB, lutB ? 1 / (2 * lutB.size) : 0.5);
    gl.uniform1f(u.uIntensityB, lutB ? lutB.intensity : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, item.from.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, item.to.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, lutA ? lutA.texture : this.dummyLut);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, lutB ? lutB.texture : this.dummyLut);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Leave the sampler unit where the layer program expects it.
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  /** Compose one output frame. items are BOTTOM first (lower tracks first). */
  render(items: readonly RenderItem[], backgroundHex: string): void {
    if (this.disposed || this.width === 0) return;
    const gl = this.gl;
    const [r, g, b] = parseHexColor(backgroundHex);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (items.length === 0) return;

    /** Which program is bound right now (a transition pass swaps it). */
    let layerProgramBound = false;
    const bindLayerProgram = (): void => {
      if (layerProgramBound) return;
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.uniforms.uTex, 0);
      gl.uniform1i(this.uniforms.uLut3D, 1);
      layerProgramBound = true;
    };

    for (const entry of items) {
      if (isTransitionItem(entry)) {
        if (this.renderTransition(entry)) {
          layerProgramBound = false;
          continue;
        }
        // Fallback: whichever side has a frame is drawn on its own.
        bindLayerProgram();
        for (const side of [entry.from, entry.to]) {
          if (this.drawable(side)) this.drawLayer(side);
        }
        continue;
      }
      if (!this.drawable(entry)) continue;
      bindLayerProgram();
      this.drawLayer(entry);
    }
    gl.bindVertexArray(null);
  }

  /** One ordinary textured quad (caller has bound the layer program). */
  private drawLayer(item: DrawItem): void {
    const gl = this.gl;
    gl.uniformMatrix3fv(this.uniforms.uMatrix, false, this.matrixOf(item));
    gl.uniform1f(this.uniforms.uOpacity, item.opacity);
    const ca = item.colorAdjust;
    gl.uniform1f(this.uniforms.uExposure, ca?.exposure ?? 0);
    gl.uniform1f(this.uniforms.uTemperature, ca?.temperature ?? 0);
    gl.uniform1f(this.uniforms.uTint, ca?.tint ?? 0);
    gl.uniform1f(this.uniforms.uBrightness, ca?.brightness ?? 0);
    gl.uniform1f(this.uniforms.uContrast, ca?.contrast ?? 0);
    gl.uniform1f(this.uniforms.uSaturation, ca?.saturation ?? 0);
    // §4.2: uLutScale=(N-1)/N, uLutOffset=1/(2N); LUT yokken intensity 0 +
    // dummy doku = kimlik (mix'in ilk kolu). Ölçek/ofsetin "boş" değerleri
    // keyfî ama tanımlı: örneklenen texel hangisi olursa olsun karışıma girmez.
    const lut = item.lut ?? null;
    gl.uniform1f(this.uniforms.uLutScale, lut ? (lut.size - 1) / lut.size : 0);
    gl.uniform1f(this.uniforms.uLutOffset, lut ? 1 / (2 * lut.size) : 0.5);
    gl.uniform1f(this.uniforms.uIntensity, lut ? lut.intensity : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut ? lut.texture : this.dummyLut);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, item.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Reads ONE pixel out of the drawing buffer, in canvas pixel coordinates
   * (0,0 = top-left, matching what a caller measures on screen).
   *
   * MUST be called in the same frame as `render()` — the context is created
   * with `preserveDrawingBuffer: false` (one buffer copy saved per frame), so
   * the browser may discard the buffer at the end of the task. The engine's
   * probe queue is what enforces that ordering; this method is the raw half.
   *
   * Exists because "does the inspector value reach the SHADER?" has no answer
   * in any store: the uniforms live on the GPU and the only honest evidence is
   * the pixel that comes back out.
   */
  readPixel(x: number, y: number): [number, number, number, number] | null {
    if (this.disposed || this.width === 0 || this.height === 0) return null;
    const px = Math.min(this.width - 1, Math.max(0, Math.round(x)));
    // WebGL's origin is bottom-left; the caller thinks in top-left canvas px.
    const py = Math.min(this.height - 1, Math.max(0, Math.round(this.height - 1 - y)));
    const out = new Uint8Array(4);
    this.gl.readPixels(px, py, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2], out[3]];
  }

  /**
   * Reads the WHOLE drawing buffer (RGBA, top-left origin — rows flipped from
   * GL's bottom-left). Same same-frame contract as readPixel; exists for the
   * preview↔export parity measurement (§9.3 SSIM needs the full frame, and
   * probing it pixel-by-pixel through the queue would take minutes).
   */
  readFrame(): { width: number; height: number; pixels: Uint8Array } | null {
    if (this.disposed || this.width === 0 || this.height === 0) return null;
    const { width, height } = this;
    const raw = new Uint8Array(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, raw);
    // GL rows are bottom-up; callers (and PNG/ffmpeg frames) are top-down.
    const pixels = new Uint8Array(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      pixels.set(raw.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes), y * rowBytes);
    }
    return { width, height, pixels };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.transitionProgram);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.dummyLut);
  }
}
