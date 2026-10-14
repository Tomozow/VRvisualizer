import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { OUTPUT_GLSL } from '@/viz/shared/Shading';

/** Peak linear brightness of the aurora layer (the sky must stay dark). Added on top of the palette background. */
const MAX_GAIN = 0.1;

// Quest 2 budget: the sky covers the whole stereo field, so its fragment stage must be tiny.
// Everything smooth (the domain-warped fbm, curtain strength, curtain colours incl. the base->top ramp, clouds, haze,
// the palette background and the gain/opacity scale) is evaluated per vertex of a coarse sphere (49x25 vertices) and
// interpolated. The fragment stage keeps only what needs pixel resolution: the sharp lower edge of the curtain
// (profile) and one octave of vertical rays (one sin), then the cheap output transform (~45 ALU ops, 8 varying
// components). No atan / normalize / texture fetch / uniforms per pixel.
const VERT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uTime;
uniform float uAmp;          // gain * opacity, folded into the colour varyings below
uniform vec3 uBackground;
varying float vHs;           // height above the curtain base, in units of the 0.06 edge width (fragment: profile)
varying highp float vPhase;  // ray phase incl. azimuth * 34: large argument, keep it fp32 even in a mediump fragment
varying vec3 vAur;           // curtain colour (base->top ramp x curtain strength x 0.9 x gain x opacity)
varying vec3 vBase;          // palette background + clouds + horizon haze (already scaled)

const float TAU = 6.2831853;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// 3 octaves, normalised to ~0..1
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.875;
}

void main() {
  vec3 d = normalize(position);
  float T = uTime;
  float y = d.y;
  // azimuth straight from the sphere's u coordinate: continuous over the seam (all multipliers below are integers),
  // and well defined on the pole cap triangles (three offsets the pole vertices' u), unlike atan(d.x, d.z) at (0,0)
  float az = uv.x * TAU;

  // domain warp, then the base field
  vec3 p = d * 1.8;
  vec3 warp = vec3(fbm3(p + vec3(0.0, T * 0.05, 0.0)),
                   fbm3(p + vec3(7.1, 0.0, T * 0.04)),
                   fbm3(p + vec3(3.3, T * 0.03, 5.5))) - 0.5;
  float n = fbm3(p + warp * 1.4 + vec3(0.0, 0.0, T * 0.02));

  // curtains: bands of noise along the azimuth (xz only), lifted/lowered by the field
  float curtain = smoothstep(0.38, 0.78, fbm3(vec3(d.x * 2.4, d.z * 2.4, T * 0.06) + warp * 1.2));
  float base = 0.06 + 0.16 * (n - 0.5) + 0.05 * sin(az * 3.0 + T * 0.2);
  float h = y - base;

  // low edge of a curtain is bright/hot, the top fades into the cooler part of the gradient
  // hue from the gradient, brightness normalised so dark palette stops still give a visible (but capped) aurora
  vec3 cl = texture2D(uGradient, vec2(clamp(0.62 + 0.2 * n, 0.0, 1.0), 0.5)).rgb;
  vec3 ch = texture2D(uGradient, vec2(clamp(0.28 + 0.25 * n, 0.0, 1.0), 0.5)).rgb;
  vec3 colLow = cl / max(max(cl.r, max(cl.g, cl.b)), 0.05);
  vec3 colHigh = 0.8 * ch / max(max(ch.r, max(ch.g, ch.b)), 0.05);

  // faint clouds overhead (density x fade-in with elevation x slow azimuthal modulation) and a horizon haze
  float cloud = smoothstep(0.45, 0.85, n) * smoothstep(0.15, 0.85, y)
              * (0.65 + 0.35 * sin(az * 5.0 + y * 11.0 + T * 0.15));
  float haze = exp(-abs(y) * 8.0) * (y > 0.0 ? 0.35 : 0.2);

  vAur = mix(colLow, colHigh, clamp(h * 2.5, 0.0, 1.0)) * (0.9 * uAmp * curtain);
  vBase = uBackground + uAmp * (colHigh * (0.8 * cloud) + colLow * (0.25 * haze));
  vHs = h * (1.0 / 0.06);
  // vertical rays that lean with height; the time term is wrapped (it is a pure phase) so long sessions keep precision
  vPhase = az * 34.0 + (n * 15.0 + mod(T * 0.5, TAU)) + h * 7.0;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // pin to the far plane (depth 1.0): depth-tested geometry always wins, the sky never occludes
}
`;

// mediump everywhere except vPhase (the ray sin argument reaches ~220 rad). No uniforms in this stage, so there is
// no cross-stage uniform precision mismatch to worry about.
const FRAG = /* glsl */ `
precision mediump float;
${OUTPUT_GLSL}
varying float vHs;
varying highp float vPhase;
varying vec3 vAur;
varying vec3 vBase;

void main() {
  // curtain profile: smoothstep(0, 0.06, h) (sharp lower edge) x exp(-3.2 h) (fade upwards) with h in edge widths.
  // exp(-3.2 h) = exp2(-0.277 vHs); below the base the edge term is 0, so the unclamped exponent is harmless
  float t = clamp(vHs, 0.0, 1.0);
  float prof = t * t * (3.0 - 2.0 * t) * exp2(-0.277 * vHs);
  // the one fragment-rate octave: vertical rays
  float r = 0.5 + 0.5 * sin(vPhase);
  float s = prof * (0.35 + 0.65 * r * r);
  // opaque pass: the palette background is part of vBase (this sphere covers the whole view)
  gl_FragColor = vec4(cheapOutput(vBase + vAur * s), 1.0);
}
`;

/** Always-on sky layer: slow aurora curtains near the horizon and faint nebula clouds overhead. */
export class AuroraBackground implements Preset {
  readonly id = 'aurora';
  readonly name = 'Aurora';
  readonly description = 'Sky layer';
  readonly group = new THREE.Group();

  private mesh!: THREE.Mesh;
  private material!: THREE.ShaderMaterial;
  private u!: Record<string, THREE.IUniform>;
  private clock = 0;
  private gain = MAX_GAIN * 0.3;
  private opacity = 1;

  init(ctx: PresetContext): void {
    this.u = {
      uGradient: { value: ctx.palette.gradient },
      uBackground: { value: ctx.palette.background },
      uTime: { value: 0 },
      uAmp: { value: this.gain * this.opacity }, // gain * opacity, applied in the vertex stage
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      // Pinned to the far plane in the vertex shader (gl_Position.z = w): depth-tested, never depth-writing, so any
      // opaque depth-writing geometry drawn before it rejects the sky pixels behind it (early-Z / Adreno LRZ) and
      // nothing is ever hidden by it.
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), this.material);
    // Last of the OPAQUE list (renderOrder only sorts within a list), but still before every blended/transparent draw,
    // which three always renders afterwards. Opaque depth-writing objects (controller models) therefore occlude it.
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    this.clock += Math.min(dt, 0.1) * p.speed;
    const energy = Math.min(1, f.energy * (0.6 + 0.4 * p.intensity));
    // rises with the long-term energy, pulses gently on the beat; capped so the sky stays dark
    const gain = (0.25 + 0.6 * energy + 0.15 * f.beatEnv) * (0.6 + 0.4 * p.glow);
    this.gain = Math.min(1, gain) * MAX_GAIN;
    this.u.uTime.value = this.clock;
    this.u.uAmp.value = this.gain * this.opacity;
  }

  setOpacity(o: number): void {
    this.opacity = o;
    this.u.uAmp.value = this.gain * this.opacity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
