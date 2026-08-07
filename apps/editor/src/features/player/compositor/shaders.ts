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
