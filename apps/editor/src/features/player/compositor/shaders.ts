/**
 * GLSL sources for the v1/v2-shared compositor.
 *
 * The colorAdjust uber-shader implements docs/rendering-semantics.md §4.1
 * EXACTLY, including the NORMATIVE stage order:
 *   exposure -> temperature -> tint -> contrast+brightness (ONE affine op)
 *   -> saturation
 * with a clamp to [0,1] after every stage (to match ffmpeg's 8-bit
 * intermediates). Changing any formula here without changing the doc (and the
 * ffmpeg compiler) is a contract violation.
 *
 * There are TWO programs:
 *   1. the per-layer program (one textured quad per draw) — the normal path;
 *   2. the TRANSITION program (§5.3): one full-frame pass that samples BOTH
 *      sides of a cut and mixes them with the xfade-equivalent function. It is
 *      a separate program on purpose — a transition needs two textures, two
 *      placements and two grades in ONE pass, and folding that into the layer
 *      program would cost every ordinary draw a pile of dead uniforms.
 * The §4.1 stages appear in both; core/colorAdjustRef.test.ts extracts the
 * constants from BOTH sources and compares them with the reference, so the two
 * copies cannot drift apart (or away from the doc).
 */

export const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aUnit;   // unit quad, (0,0)=top-left of source
uniform mat3 uMatrix;                 // unit quad -> NDC (CPU-composed, §2.4)
out vec2 vUv;
void main() {
  vUv = aUnit;                        // texture space matches unit space
  vec3 p = uMatrix * vec3(aUnit, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform float uOpacity;

// colorAdjust params, all in [-1..1], 0 = identity (rendering-semantics §4.1).
uniform float uExposure;
uniform float uTemperature;
uniform float uTint;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 c = texture(uTex, vUv);

  // 1. exposure: multiplicative gain 2^v (NOT gamma).
  c.rgb = clamp(c.rgb * exp2(uExposure), 0.0, 1.0);

  // 2. temperature: linear RGB channel offset, K_TEMP = 0.10 (+R, -B for warm).
  c.r = clamp(c.r + 0.10 * uTemperature, 0.0, 1.0);
  c.b = clamp(c.b - 0.10 * uTemperature, 0.0, 1.0);

  // 3. tint: linear green offset, K_TINT = 0.10 (positive = magenta, -G).
  c.g = clamp(c.g - 0.10 * uTint, 0.0, 1.0);

  // 4. contrast + brightness as ONE affine op (ffmpeg eq semantics):
  //    out = (in - 0.5) * (1 + contrast) + 0.5 + brightness
  //    Applying them separately is FORBIDDEN (order would differ from eq).
  c.rgb = clamp((c.rgb - 0.5) * (1.0 + uContrast) + 0.5 + uBrightness, 0.0, 1.0);

  // 5. saturation: linear mix around BT.709 luma.
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = clamp(mix(vec3(l), c.rgb, 1.0 + uSaturation), 0.0, 1.0);

  // Clip opacity multiplies straight (unassociated) alpha (§6.3).
  c.a *= uOpacity;
  outColor = c;
}
`;

// ---------------------------------------------------------------------------
// Transition program (rendering-semantics §5.3)
// ---------------------------------------------------------------------------

/**
 * Mix-function selector. MUST stay in sync with TRANSITION_MODE in
 * transitionRef.ts (the pure reference the tests compare pixels against) —
 * transitionRef.test.ts asserts the GLSL branch of every mode exists.
 */
export const TRANSITION_MODE_GLSL = {
  crossfade: 0,
  dissolve: 1,
  fadeToBlack: 2,
  wipeLeft: 3,
  wipeRight: 4,
  slideUp: 5,
} as const;

/**
 * Full-frame pass: gl_Position covers the whole drawing buffer and vNdc carries
 * the fragment's NDC so the fragment shader can map it back into EACH side's
 * own quad (the inverse of the §2.4 matrix). That is what lets two clips with
 * DIFFERENT transforms be mixed in a single pass.
 */
export const TRANSITION_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aUnit;   // same unit quad buffer as the layer program
out vec2 vNdc;
void main() {
  vec2 ndc = aUnit * 2.0 - 1.0;
  vNdc = ndc;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const TRANSITION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
// NDC -> unit-quad inverse of each side's §2.4 placement matrix.
uniform mat3 uInvA;
uniform mat3 uInvB;
uniform float uOpacityA;
uniform float uOpacityB;
// §4.1 grade of each side (0 = identity), kept per side: a transition must not
// smear the outgoing clip's grade onto the incoming one.
uniform float uExposureA;
uniform float uTemperatureA;
uniform float uTintA;
uniform float uBrightnessA;
uniform float uContrastA;
uniform float uSaturationA;
uniform float uExposureB;
uniform float uTemperatureB;
uniform float uTintB;
uniform float uBrightnessB;
uniform float uContrastB;
uniform float uSaturationB;
// p = (t - (T - D/2)) / D, linear (§5.3).
uniform float uProgress;
uniform int uMode;

in vec2 vNdc;
out vec4 outColor;

/**
 * §4.1 stages — byte-for-byte the same formulas as the layer program's main(),
 * only parameterised so both sides can be graded in one pass.
 */
vec4 applyColorAdjust(vec4 c, float exposure, float temperature, float tint,
                      float brightness, float contrast, float saturation) {
  c.rgb = clamp(c.rgb * exp2(exposure), 0.0, 1.0);
  c.r = clamp(c.r + 0.10 * temperature, 0.0, 1.0);
  c.b = clamp(c.b - 0.10 * temperature, 0.0, 1.0);
  c.g = clamp(c.g - 0.10 * tint, 0.0, 1.0);
  c.rgb = clamp((c.rgb - 0.5) * (1.0 + contrast) + 0.5 + brightness, 0.0, 1.0);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = clamp(mix(vec3(l), c.rgb, 1.0 + saturation), 0.0, 1.0);
  return c;
}

/** One side, sampled through its own placement. Outside its quad: nothing. */
vec4 layerAt(sampler2D tex, mat3 inv, vec2 ndc, float opacity,
             float exposure, float temperature, float tint,
             float brightness, float contrast, float saturation) {
  vec3 q = inv * vec3(ndc, 1.0);
  vec2 uv = q.xy / q.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = applyColorAdjust(texture(tex, uv), exposure, temperature, tint,
                            brightness, contrast, saturation);
  c.a *= opacity;
  return c;
}

/**
 * Weighted average of two STRAIGHT-alpha colours (§6.3): the weighting happens
 * in premultiplied space and is unpremultiplied again, so a half-transparent
 * overlay crossfading into a full-frame shot does not darken the shot.
 */
vec4 mixStraight(vec4 a, vec4 b, float p) {
  float oa = mix(a.a, b.a, p);
  if (oa <= 0.0) return vec4(0.0);
  vec3 rgb = mix(a.rgb * a.a, b.rgb * b.a, p) / oa;
  return vec4(rgb, oa);
}

/** Straight-alpha "src over dst" (§6.3 normative blend equation). */
vec4 overStraight(vec4 src, vec4 dst) {
  float oa = src.a + dst.a * (1.0 - src.a);
  if (oa <= 0.0) return vec4(0.0);
  vec3 rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / oa;
  return vec4(rgb, oa);
}

/** Per-pixel deterministic noise for the dissolve threshold. */
float dissolveNoise(vec2 uv) {
  return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float p = clamp(uProgress, 0.0, 1.0);

  // slideUp translates BOTH pictures upward by p of the frame height, so the
  // sampling point moves instead of the quad (one pass, no extra geometry).
  vec2 ndcA = vNdc;
  vec2 ndcB = vNdc;
  if (uMode == 5) {
    ndcA.y = vNdc.y - 2.0 * p;
    ndcB.y = vNdc.y + 2.0 * (1.0 - p);
  }

  vec4 a = layerAt(uTexA, uInvA, ndcA, uOpacityA,
                   uExposureA, uTemperatureA, uTintA, uBrightnessA, uContrastA, uSaturationA);
  vec4 b = layerAt(uTexB, uInvB, ndcB, uOpacityB,
                   uExposureB, uTemperatureB, uTintB, uBrightnessB, uContrastB, uSaturationB);

  // Screen uv (0..1, y down) — the geometric transitions are defined on it.
  vec2 s = vec2(vNdc.x * 0.5 + 0.5, 0.5 - vNdc.y * 0.5);

  vec4 result;
  if (uMode == 3) {
    // wipeLeft: the edge travels right -> left, B grows from the right.
    result = s.x > 1.0 - p ? b : a;
  } else if (uMode == 4) {
    // wipeRight: the edge travels left -> right, B grows from the left.
    result = s.x < p ? b : a;
  } else if (uMode == 1) {
    // dissolve: per-pixel threshold, no partial mixing.
    result = dissolveNoise(s) < p ? b : a;
  } else if (uMode == 2) {
    // fadeToBlack: A -> black in the first half, black -> B in the second.
    float k = p < 0.5 ? 1.0 - 2.0 * p : 2.0 * p - 1.0;
    vec4 src = p < 0.5 ? a : b;
    result = vec4(src.rgb * k, src.a);
  } else if (uMode == 5) {
    result = overStraight(b, a);
  } else {
    result = mixStraight(a, b, p);
  }
  outColor = result;
}
`;
