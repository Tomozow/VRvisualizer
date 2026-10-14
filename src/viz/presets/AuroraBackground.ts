import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';

/** Peak linear brightness of the aurora layer (the sky must stay dark). Added on top of the palette background. */
const MAX_GAIN = 0.07;

// All the expensive noise (domain-warped fbm) runs per vertex of a coarse sphere (49x25 vertices) and is
// interpolated; the fragment stage only adds one cheap analytic octave of vertical rays.
const VERT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uTime;
uniform vec3 uBackground;
varying vec3 vDir;
varying vec4 vField;   // x: curtain strength, y: curtain base elevation, z: cloud density, w: ray phase
varying vec3 vColLow;
varying vec3 vColHigh;
varying vec3 vBg;

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
  vDir = d;
  float T = uTime;

  // domain warp, then the base field
  vec3 p = d * 1.8;
  vec3 warp = vec3(fbm3(p + vec3(0.0, T * 0.05, 0.0)),
                   fbm3(p + vec3(7.1, 0.0, T * 0.04)),
                   fbm3(p + vec3(3.3, T * 0.03, 5.5))) - 0.5;
  float n = fbm3(p + warp * 1.4 + vec3(0.0, 0.0, T * 0.02));

  // curtains: bands of noise along the azimuth (xz only), lifted/lowered by the field
  float curtain = smoothstep(0.38, 0.78, fbm3(vec3(d.x * 2.4, d.z * 2.4, T * 0.06) + warp * 1.2));
  float base = 0.06 + 0.16 * (n - 0.5) + 0.05 * sin(atan(d.x, d.z) * 3.0 + T * 0.2);
  float cloud = smoothstep(0.45, 0.85, n);
  vField = vec4(curtain, base, cloud, n * 3.0 + T * 0.1);

  // low edge of a curtain is bright/hot, the top fades into the cooler part of the gradient
  // hue from the gradient, brightness normalised so dark palette stops still give a visible (but capped) aurora
  vec3 cl = texture2D(uGradient, vec2(clamp(0.62 + 0.2 * n, 0.0, 1.0), 0.5)).rgb;
  vec3 ch = texture2D(uGradient, vec2(clamp(0.28 + 0.25 * n, 0.0, 1.0), 0.5)).rgb;
  vColLow = cl / max(max(cl.r, max(cl.g, cl.b)), 0.05);
  vColHigh = 0.8 * ch / max(max(ch.r, max(ch.g, ch.b)), 0.05);
  vBg = uBackground;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime, uGain, uOpacity;
varying vec3 vDir;
varying vec4 vField;
varying vec3 vColLow;
varying vec3 vColHigh;
varying vec3 vBg;

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float az = atan(d.x, d.z);
  float h = y - vField.y;                                   // height above the curtain base
  float prof = smoothstep(0.0, 0.06, h) * exp(-max(h, 0.0) * 3.2);
  // the one fragment-rate octave: vertical rays that lean with height
  float rays = 0.5 + 0.5 * sin(az * 34.0 + vField.w * 5.0 + h * 7.0);
  rays = 0.35 + 0.65 * rays * rays;
  float cur = vField.x * prof * rays;
  float sky = smoothstep(0.15, 0.85, y);
  float cloud = vField.z * sky * (0.65 + 0.35 * sin(az * 5.0 + y * 11.0 + uTime * 0.15));
  float haze = exp(-abs(y) * 8.0) * (y > 0.0 ? 0.35 : 0.2);

  vec3 aur = mix(vColLow, vColHigh, clamp(h * 2.5, 0.0, 1.0)) * cur * 0.9;
  vec3 neb = vColHigh * cloud * 0.8;
  vec3 hz = vColLow * haze * 0.25;
  // opaque pass: the palette background is part of the output (this sphere covers the whole view)
  gl_FragColor = vec4(vBg + (aur + neb + hz) * (uGain * uOpacity), 1.0);
  #include <colorspace_fragment>
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

  init(ctx: PresetContext): void {
    this.u = {
      uGradient: { value: ctx.palette.gradient },
      uBackground: { value: ctx.palette.background },
      uTime: { value: 0 },
      uGain: { value: MAX_GAIN * 0.3 },
      uOpacity: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), this.material);
    this.mesh.renderOrder = -10; // first in the opaque pass: everything else draws over it
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    this.clock += Math.min(dt, 0.1) * p.speed;
    const energy = Math.min(1, f.energy * (0.6 + 0.4 * p.intensity));
    // rises with the long-term energy, pulses gently on the beat; capped so the sky stays dark
    const gain = (0.25 + 0.6 * energy + 0.15 * f.beatEnv) * (0.6 + 0.4 * p.glow);
    this.u.uTime.value = this.clock;
    this.u.uGain.value = Math.min(1, gain) * MAX_GAIN;
  }

  setOpacity(o: number): void {
    this.u.uOpacity.value = o;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
