/**
 * Cheap output transform shared by the visualizer shaders (Quest 2 fragment budget).
 * Replaces three's `<tonemapping_fragment>` + `<colorspace_fragment>` (ACES fit + exact sRGB OETF ≈ 100 ALU slots)
 * with a Narkowicz ACES approximation and a sqrt OETF (≈ 30 slots). Exposure 1.1 matches App's renderer setting.
 * Usage in fragment shaders: `gl_FragColor = vec4(cheapOutput(col), alpha);` (do NOT also include the three chunks).
 * For additive sprite layers `cheapOutputAdditive` skips the tone curve (additive layers should stay linear-ish).
 */
export const OUTPUT_GLSL = /* glsl */ `
vec3 cheapOutput(vec3 c) {
  c *= 1.1;
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return sqrt(clamp(c, 0.0, 1.0));
}
vec3 cheapOutputAdditive(vec3 c) {
  return sqrt(clamp(c * 1.1, 0.0, 1.0));
}
`;
