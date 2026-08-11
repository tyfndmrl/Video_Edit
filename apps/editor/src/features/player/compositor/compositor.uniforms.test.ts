/**
 * Compositor -> shader UNIFORM wiring (M5 preview parity).
 *
 * The colorAdjust math is already pinned down three ways (doc §4.1, the pure
 * TS reference, the GLSL drift alarm in core/colorAdjustRef.test.ts). What
 * NONE of those cover is the last link of the chain: does the number the
 * inspector wrote actually land on the RIGHT uniform? A swapped
 * `uTemperature`/`uTint` pair, or an `exposure` that never leaves the
 * DrawItem, passes every existing test and ruins every exported frame.
 *
 * So this test drives the real Compositor against a recording fake WebGL2
 * context and asserts the exact (uniform name, value) pairs per draw.
 */
import { describe, expect, it } from 'vitest';
import { Compositor, parseHexColor, type DrawItem, type TransitionDrawItem } from './compositor';
import type { ColorAdjust } from '../core/resolve';
import { TRANSITION_MODE } from '../core/transitionRef';
import { applyMat3, computePlacement, unitQuadToNdcMatrix } from '../core/transform';

interface UniformCall {
  name: string;
  value: number;
}

interface MatrixCall {
  name: string;
  value: number[];
}

interface FakeGl {
  gl: Record<string, unknown>;
  uniform1f: UniformCall[];
  uniform1i: UniformCall[];
  uniformMatrix3fv: MatrixCall[];
  /** Program handles in the order they were bound with useProgram(). */
  programBinds: unknown[];
  /** (unit, texture) pairs in bind order — proves A and B land on 0 and 1. */
  textureBinds: { unit: number; texture: unknown }[];
  drawCalls: number;
  clearColor: number[] | null;
  readPixelsArgs: number[] | null;
}

/**
 * A WebGL2 stand-in that records what matters and answers everything else
 * plausibly. Uniform locations are unique objects tagged with their NAME, so
 * an assertion can talk about "uBrightness" instead of an opaque handle.
 */
function makeFakeGl(readback: [number, number, number, number] = [0, 0, 0, 0]): FakeGl {
  const uniform1f: UniformCall[] = [];
  /**
   * Uniform locations are per PROGRAM here — the real GL is too, and a
   * compositor that looked up the transition uniforms on the layer program
   * would then quietly write into the wrong ones.
   */
  const locations = new Map<unknown, Map<string, { name: string }>>();
  const state: FakeGl = {
    gl: {},
    uniform1f,
    uniform1i: [],
    uniformMatrix3fv: [],
    programBinds: [],
    textureBinds: [],
    drawCalls: 0,
    clearColor: null,
    readPixelsArgs: null,
  };
  let activeUnit = 0;

  const gl: Record<string, unknown> = {
    // --- constants (any number works; they are only passed back to us) ---
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    BLEND: 8,
    SRC_ALPHA: 9,
    ONE_MINUS_SRC_ALPHA: 10,
    ONE: 11,
    DEPTH_TEST: 12,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 13,
    UNPACK_FLIP_Y_WEBGL: 14,
    TEXTURE_2D: 15,
    TEXTURE0: 16,
    TEXTURE1: 27,
    TRIANGLE_STRIP: 17,
    COLOR_BUFFER_BIT: 18,
    RGBA: 19,
    UNSIGNED_BYTE: 20,
    LINEAR: 21,
    CLAMP_TO_EDGE: 22,
    TEXTURE_MIN_FILTER: 23,
    TEXTURE_MAG_FILTER: 24,
    TEXTURE_WRAP_S: 25,
    TEXTURE_WRAP_T: 26,

    // --- program/VAO setup ---
    createShader: () => ({}),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => undefined,
    createProgram: () => ({}),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => undefined,
    getUniformLocation: (program: unknown, name: string) => {
      let byName = locations.get(program);
      if (!byName) {
        byName = new Map<string, { name: string }>();
        locations.set(program, byName);
      }
      let loc = byName.get(name);
      if (!loc) {
        loc = { name };
        byName.set(name, loc);
      }
      return loc;
    },
    createVertexArray: () => ({}),
    deleteVertexArray: () => undefined,
    bindVertexArray: () => undefined,
    createBuffer: () => ({}),
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    blendFuncSeparate: () => undefined,
    pixelStorei: () => undefined,
    viewport: () => undefined,

    // --- per-frame ---
    useProgram: (program: unknown) => {
      state.programBinds.push(program);
    },
    activeTexture: (unit: number) => {
      activeUnit = unit === 27 ? 1 : 0; // TEXTURE1 : TEXTURE0
    },
    createTexture: () => ({}),
    deleteTexture: () => undefined,
    bindTexture: (_target: number, texture: unknown) => {
      state.textureBinds.push({ unit: activeUnit, texture });
    },
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    uniform1i: (loc: { name: string }, value: number) => {
      state.uniform1i.push({ name: loc.name, value });
    },
    uniformMatrix3fv: (loc: { name: string }, _transpose: boolean, value: Float32Array) => {
      state.uniformMatrix3fv.push({ name: loc.name, value: [...value] });
    },
    uniform1f: (loc: { name: string }, value: number) => {
      uniform1f.push({ name: loc.name, value });
    },
    clearColor: (r: number, g: number, b: number, a: number) => {
      state.clearColor = [r, g, b, a];
    },
    clear: () => undefined,
    drawArrays: () => {
      state.drawCalls++;
    },
    readPixels: (
      x: number,
      y: number,
      w: number,
      h: number,
      _fmt: number,
      _type: number,
      out: Uint8Array,
    ) => {
      state.readPixelsArgs = [x, y, w, h];
      out.set(readback);
    },
  };

  state.gl = gl;
  return state;
}

function makeCompositor(fake: FakeGl): Compositor {
  const canvas = { width: 0, height: 0, getContext: () => fake.gl } as unknown as HTMLCanvasElement;
  return new Compositor(canvas);
}

function drawItem(colorAdjust: ColorAdjust | null): DrawItem {
  return {
    texture: {} as WebGLTexture,
    srcW: 1920,
    srcH: 1080,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    colorAdjust,
  };
}

/** The uniform values of the LAST draw, keyed by uniform name. */
function uniformsOf(fake: FakeGl): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of fake.uniform1f) out[call.name] = call.value;
  return out;
}

describe('Compositor colorAdjust uniforms (§4.1 param -> uniform mapping)', () => {
  it('each param lands on its OWN uniform (a swapped pair would show here)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);

    compositor.render(
      [
        drawItem({
          brightness: 0.11,
          contrast: 0.22,
          saturation: 0.33,
          temperature: 0.44,
          tint: 0.55,
          exposure: 0.66,
        }),
      ],
      '#000000',
    );

    expect(fake.drawCalls, 'the item must actually be drawn').toBe(1);
    expect(uniformsOf(fake)).toMatchObject({
      uBrightness: 0.11,
      uContrast: 0.22,
      uSaturation: 0.33,
      uTemperature: 0.44,
      uTint: 0.55,
      uExposure: 0.66,
      uOpacity: 1,
    });
  });

  it('no colorAdjust = every uniform at the §4.1 identity (0), not left over', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);

    // First a coloured item, THEN a plain one: uniforms are program state, so
    // a missing reset would leak the previous clip's grade onto this one.
    compositor.render(
      [drawItem({ brightness: 1, contrast: 1, saturation: 1, temperature: 1, tint: 1, exposure: 1 })],
      '#000000',
    );
    fake.uniform1f.length = 0;
    compositor.render([drawItem(null)], '#000000');

    expect(uniformsOf(fake)).toMatchObject({
      uBrightness: 0,
      uContrast: 0,
      uSaturation: 0,
      uTemperature: 0,
      uTint: 0,
      uExposure: 0,
    });
  });

  it('per-item uniforms are set per DRAW, so two clips can be graded differently', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);

    compositor.render(
      [
        drawItem({ brightness: 0.5, contrast: 0, saturation: 0, temperature: 0, tint: 0, exposure: 0 }),
        drawItem({ brightness: -0.5, contrast: 0, saturation: 0, temperature: 0, tint: 0, exposure: 0 }),
      ],
      '#000000',
    );

    const brightness = fake.uniform1f.filter((c) => c.name === 'uBrightness').map((c) => c.value);
    expect(brightness).toEqual([0.5, -0.5]);
    expect(fake.drawCalls).toBe(2);
  });

  it('the background hex becomes the clear colour (canvas is opaque)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    compositor.render([], '#336699');
    const [r, g, b] = parseHexColor('#336699');
    expect(fake.clearColor).toEqual([r, g, b, 1]);
  });
});

// ---------------------------------------------------------------------------
// Transition pass (rendering-semantics §5.3)
// ---------------------------------------------------------------------------

function transitionItem(overrides: Partial<TransitionDrawItem> = {}): TransitionDrawItem {
  return {
    kind: 'transition',
    from: { ...drawItem(null), texture: { side: 'A' } as unknown as WebGLTexture },
    to: { ...drawItem(null), texture: { side: 'B' } as unknown as WebGLTexture },
    type: 'crossfade',
    progress: 0.5,
    ...overrides,
  };
}

describe('Compositor transition pass (§5.3: two sources, ONE draw)', () => {
  it('mixes the pair in a single draw call on the transition program', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    fake.programBinds.length = 0;

    compositor.render([transitionItem()], '#000000');

    expect(fake.drawCalls, 'a transition is ONE pass, not two alpha draws').toBe(1);
    expect(fake.programBinds, 'the transition program must be bound').toHaveLength(1);
    const uniforms = uniformsOf(fake);
    expect(uniforms.uProgress).toBe(0.5);
    const mode = fake.uniform1i.find((c) => c.name === 'uMode');
    expect(mode?.value).toBe(TRANSITION_MODE.crossfade);
  });

  it('each transition type selects its OWN mode (a wipe must not render a crossfade)', () => {
    for (const type of ['wipeLeft', 'wipeRight', 'slideUp', 'dissolve', 'fadeToBlack'] as const) {
      const fake = makeFakeGl();
      const compositor = makeCompositor(fake);
      compositor.resize(1920, 1080);
      compositor.render([transitionItem({ type })], '#000000');
      expect(fake.uniform1i.find((c) => c.name === 'uMode')?.value).toBe(TRANSITION_MODE[type]);
    }
  });

  it('A goes to texture unit 0 and B to unit 1 (swapping them reverses the transition)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    fake.textureBinds.length = 0;

    compositor.render([transitionItem()], '#000000');

    const sides = fake.textureBinds.map((b) => ({
      unit: b.unit,
      side: (b.texture as { side?: string }).side,
    }));
    expect(sides).toContainEqual({ unit: 0, side: 'A' });
    expect(sides).toContainEqual({ unit: 1, side: 'B' });
    const samplers = fake.uniform1i.filter((c) => c.name === 'uTexA' || c.name === 'uTexB');
    expect(samplers).toEqual([
      { name: 'uTexA', value: 0 },
      { name: 'uTexB', value: 1 },
    ]);
  });

  it('each side keeps its OWN grade and opacity', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);

    compositor.render(
      [
        transitionItem({
          from: {
            ...drawItem({
              brightness: 0.1,
              contrast: 0.2,
              saturation: 0.3,
              temperature: 0.4,
              tint: 0.5,
              exposure: 0.6,
            }),
            opacity: 0.8,
          },
          to: { ...drawItem(null), opacity: 0.4 },
        }),
      ],
      '#000000',
    );

    expect(uniformsOf(fake)).toMatchObject({
      uBrightnessA: 0.1,
      uContrastA: 0.2,
      uSaturationA: 0.3,
      uTemperatureA: 0.4,
      uTintA: 0.5,
      uExposureA: 0.6,
      uOpacityA: 0.8,
      uBrightnessB: 0,
      uExposureB: 0,
      uOpacityB: 0.4,
    });
  });

  it('the inverse matrices really invert the §2.4 placement (round-trip)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    const from: DrawItem = {
      ...drawItem(null),
      transform: { x: 0.1, y: -0.2, scale: 0.5, rotationDeg: 30, anchorX: 0.5, anchorY: 0.5 },
    };
    compositor.render([transitionItem({ from })], '#000000');

    const inv = fake.uniformMatrix3fv.find((c) => c.name === 'uInvA');
    expect(inv, 'the pass must upload A\'s inverse placement').toBeDefined();
    const forward = unitQuadToNdcMatrix(
      computePlacement({
        srcW: from.srcW,
        srcH: from.srcH,
        compW: 1920,
        compH: 1080,
        transform: from.transform,
      }),
      from.srcW,
      from.srcH,
      1920,
      1080,
    );
    // A source corner -> NDC (forward) -> back through the uploaded inverse.
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0.25, 0.75],
    ] as const) {
      const ndc = applyMat3(forward, u, v);
      const back = applyMat3(new Float32Array(inv!.value), ndc.x, ndc.y);
      expect(back.x).toBeCloseTo(u, 5);
      expect(back.y).toBeCloseTo(v, 5);
    }
  });

  it('a side with no frame yet degrades to drawing the OTHER one, not to black', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    fake.programBinds.length = 0;

    // srcW = 0 is the engine's "decoder has nothing yet" shape.
    compositor.render(
      [transitionItem({ to: { ...drawItem(null), srcW: 0, srcH: 0 } })],
      '#000000',
    );

    expect(fake.drawCalls, 'the available side is still drawn').toBe(1);
    expect(fake.uniform1i.some((c) => c.name === 'uMode'), 'transition pass skipped').toBe(false);
  });

  it('ordinary layers still draw around a transition (the pass restores the layer program)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    fake.programBinds.length = 0;

    compositor.render([transitionItem(), drawItem(null)], '#000000');

    expect(fake.drawCalls).toBe(2);
    expect(fake.programBinds, 'transition program, then back to the layer one').toHaveLength(2);
    expect(fake.programBinds[0]).not.toBe(fake.programBinds[1]);
    // The layer program's own uniforms were re-sent after the swap.
    expect(fake.uniform1f.some((c) => c.name === 'uOpacity')).toBe(true);
    expect(fake.uniform1i.some((c) => c.name === 'uTex')).toBe(true);
  });
});

describe('Compositor.readPixel (the preview probe the E2E leans on)', () => {
  it('flips the y axis: canvas top-left maps to the WebGL bottom-left origin', () => {
    const fake = makeFakeGl([12, 34, 56, 255]);
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);

    expect(compositor.readPixel(100, 0)).toEqual([12, 34, 56, 255]);
    expect(fake.readPixelsArgs, 'y=0 (top) is the LAST row in GL space').toEqual([100, 1079, 1, 1]);

    compositor.readPixel(0, 1079);
    expect(fake.readPixelsArgs).toEqual([0, 0, 1, 1]);
  });

  it('clamps out-of-range coordinates instead of reading outside the buffer', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    compositor.resize(1920, 1080);
    compositor.readPixel(99999, -50);
    expect(fake.readPixelsArgs).toEqual([1919, 1079, 1, 1]);
  });

  it('returns null before the buffer has a size (nothing to sample yet)', () => {
    const fake = makeFakeGl();
    const compositor = makeCompositor(fake);
    expect(compositor.readPixel(0, 0)).toBeNull();
  });
});
