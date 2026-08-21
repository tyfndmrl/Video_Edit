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
precision highp sampler3D;

uniform sampler2D uTex;
uniform float uOpacity;

// colorAdjust params, all in [-1..1], 0 = identity (rendering-semantics §4.1).
uniform float uExposure;
uniform float uTemperature;
uniform float uTint;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;

// lut (rendering-semantics §4.2) — NORMATIVE uniform names. uLut3D samples with
// LINEAR filtering (= trilinear in 3D); uLutScale = (N-1)/N and
// uLutOffset = 1/(2N) put [0,1] exactly onto texel CENTERS (without the offset
// the extremes would drift). uIntensity = 0 makes the stage an exact no-op
// (mix returns c.rgb), which is how "no LUT" is drawn — a 1-texel dummy stays
// bound so the sampler is never incomplete.
uniform sampler3D uLut3D;
uniform float uLutScale;
uniform float uLutOffset;
uniform float uIntensity;

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

  // 6. lut — AFTER colorAdjust (§4 normative order: colorAdjust -> lut).
  //    out = mix(original, LUT(original), intensity) — same formula as the
  //    ffmpeg split/blend chain (§4.2).
  vec3 lutted = texture(uLut3D, c.rgb * uLutScale + uLutOffset).rgb;
  c.rgb = mix(c.rgb, lutted, uIntensity);

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
precision highp sampler3D;

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
// §4.2 lut of each side — the export applies effects in each clip's OWN source
// chain before xfade, so a transition must grade+LUT each side independently
// (uIntensity* = 0 -> stage is a no-op, dummy texture stays bound).
uniform sampler3D uLut3DA;
uniform float uLutScaleA;
uniform float uLutOffsetA;
uniform float uIntensityA;
uniform sampler3D uLut3DB;
uniform float uLutScaleB;
uniform float uLutOffsetB;
uniform float uIntensityB;
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

/** §4.2 — same formula as the layer program's stage 6. */
vec3 applyLut(vec3 rgb, sampler3D lut, float scale, float offset, float intensity) {
  vec3 lutted = texture(lut, rgb * scale + offset).rgb;
  return mix(rgb, lutted, intensity);
}

/** One side, sampled through its own placement. Outside its quad: nothing. */
vec4 layerAt(sampler2D tex, mat3 inv, vec2 ndc, float opacity,
             float exposure, float temperature, float tint,
             float brightness, float contrast, float saturation,
             sampler3D lut, float lutScale, float lutOffset, float lutIntensity) {
  vec3 q = inv * vec3(ndc, 1.0);
  vec2 uv = q.xy / q.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = applyColorAdjust(texture(tex, uv), exposure, temperature, tint,
                            brightness, contrast, saturation);
  c.rgb = applyLut(c.rgb, lut, lutScale, lutOffset, lutIntensity);
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

/**
 * BT.709 LIMITED-range code units (0..255 scale) — the space the export's
 * fadeToBlack mixes in (§5.3, measured). Exact affine roundtrip; only the
 * fadeToBlack branch uses it, so no other transition can drift.
 */
vec3 toYuv709(vec3 c) {
  float yl = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec3(
    16.0 + 219.0 * yl,
    128.0 + 224.0 * (c.b - yl) / 1.8556,
    128.0 + 224.0 * (c.r - yl) / 1.5748);
}

vec3 fromYuv709(vec3 t) {
  float yl = (t.x - 16.0) / 219.0;
  float pb = (t.y - 128.0) / 224.0;
  float pr = (t.z - 128.0) / 224.0;
  return clamp(vec3(
    yl + 1.5748 * pr,
    yl - 0.1873 * pb - 0.4681 * pr,
    yl + 1.8556 * pb), 0.0, 1.0);
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
                   uExposureA, uTemperatureA, uTintA, uBrightnessA, uContrastA, uSaturationA,
                   uLut3DA, uLutScaleA, uLutOffsetA, uIntensityA);
  vec4 b = layerAt(uTexB, uInvB, ndcB, uOpacityB,
                   uExposureB, uTemperatureB, uTintB, uBrightnessB, uContrastB, uSaturationB,
                   uLut3DB, uLutScaleB, uLutOffsetB, uIntensityB);

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
    // dissolve: per-pixel threshold, no partial mixing. The threshold RULE and the
    // aggregate density match ffmpeg's dissolve exactly (B covers fraction p of the
    // frame); the noise FIELD is a documented approximation — ffmpeg hashes integer
    // pixel coords with libm sinf, which no shader can reproduce (measured: 50.01%
    // pattern agreement at p=0.5, i.e. uncorrelated; rendering-semantics §5.3).
    result = dissolveNoise(s) < p ? b : a;
  } else if (uMode == 2) {
    // fadeToBlack: ffmpeg xfade 'fadeblack' (phase 0.2) — KANONİK durumla (tek
    // katmanlı hızlı yol, yuv420p) piksel-eşit (§5.3). O yolda "siyah"
    // (Y=0, U=V=128) SÜPER-siyahtır (rgb siyahının afin görüntüsü Y=16 olurdu) —
    // gerçek ffmpeg 8.0 çıktısından ölçüldü, vektörler transitionRef.test.ts'te.
    // Kompozisyon yolunun rgb eğrisiyle dip farkı ≤ ~15/255 (bilinen sınır §2.3).
    // ffmpeg ilerlemesi 1->0 akar (P = 1-p); eğri ASİMETRİKTİR: A pencerenin ilk
    // %20'sinde söner, B kalan %80 boyunca yükselir.
    float P = 1.0 - p;
    float smA = smoothstep(0.8, 1.0, P);
    float smB = smoothstep(0.2, 1.0, P);
    vec3 bg = vec3(0.0, 128.0, 128.0);
    vec3 ya = mix(bg, toYuv709(a.rgb), smA);
    vec3 yb = mix(toYuv709(b.rgb), bg, smB);
    float oa = P * (a.a * smA + (1.0 - smA)) + (1.0 - P) * (smB + b.a * (1.0 - smB));
    result = vec4(fromYuv709(mix(yb, ya, P)), oa);
  } else if (uMode == 5) {
    result = overStraight(b, a);
  } else {
    result = mixStraight(a, b, p);
  }
  outColor = result;
}
`;
