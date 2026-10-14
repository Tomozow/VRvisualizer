import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const TAU = Math.PI * 2;
const EYE = 1.6;
const R_MIN = 2.5;
const R_MAX = 14;
/** 0..1: how strongly the shell is concentrated in front of the user (density ratio front:back = (1+k)/(1-k)). */
const FRONT_BIAS = 0.4;
/** Speed (m/s) of the shockwave that travels through the shell after each beat. */
const WAVE_SPEED = 9;
const DUST_COUNT = 300;
const COUNTS: Record<QualityLevel, number> = { low: 25_000, medium: 60_000, high: 120_000 };

// ---------------------------------------------------------------------------------------------
// Init-time density sculpting (CPU). The nebula is stateless on the GPU, but its "home" positions
// are drawn from a noise density so the cloud has filaments and voids instead of a flat shell.
// ---------------------------------------------------------------------------------------------
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}

function cloudNoise(x: number, y: number, z: number): number {
  return 0.65 * valueNoise(x * 0.2, y * 0.2, z * 0.2) + 0.35 * valueNoise(x * 0.47 + 7.1, y * 0.47, z * 0.47 + 3.7);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------
const NOISE_GLSL = /* glsl */ `
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
`;

const NEBULA_VERT = /* glsl */ `
${HISTORY_GLSL}
${NOISE_GLSL}
#define EYE 1.6
#define R_MIN ${R_MIN.toFixed(1)}
#define R_RANGE ${(R_MAX - R_MIN).toFixed(1)}
// position = home offset from the head, aSeed = (band, phase, size, sparkle) uniform randoms
attribute vec4 aSeed;
uniform sampler2D uGradient;
uniform float uTime, uSwirl, uBass, uBurst, uTreble, uIntensity, uBright, uPixelRatio, uWaveR, uWaveAmp;
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
varying float vGas;

void main() {
  vec3 home = position;
  float r0 = length(home);
  vec3 dir = home / r0;
  float rn = clamp((r0 - R_MIN) / R_RANGE, 0.0, 1.0);
  float ph = aSeed.y * 6.2831853;
  float rA = fract(aSeed.y * 37.13);
  float rB = fract(aSeed.z * 91.7 + aSeed.x * 3.3);
  float T = uSwirl;

  // every particle listens to one band; the delay grows with radius so energy ripples outward
  float e = histFreq(aSeed.x, rn * 16.0 + rA * 4.0);
  e = clamp(e * (0.65 + 0.5 * uIntensity), 0.0, 1.2);

  // bass breathing, beat burst and a shockwave that sweeps through the shell after each beat
  float breathe = 1.0 + uBass * 0.3 * (1.0 - 0.5 * rn);
  float dW = (r0 * breathe - uWaveR) / 1.6;
  float wave = uWaveAmp * exp(-dW * dW);
  float rr = r0 * breathe + uBurst * (0.2 + 0.5 * rB) + wave * 1.1;

  // slow shear of the whole shell around the vertical axis
  float yaw = 0.2 * sin(T * 0.07 + home.y * 0.12) + 0.1 * sin(T * 0.045 + 1.3);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 p = dir * rr;
  p = vec3(cy * p.x - sy * p.z, p.y, sy * p.x + cy * p.z);

  // curl-ish flow: two octaves of sine fields (each axis driven by the other two) + a tiny per-particle orbit
  vec3 q = home;
  vec3 w1 = vec3(sin(q.y * 0.31 + T * 0.23) + sin(q.z * 0.17 - T * 0.19 + 1.7),
                 sin(q.z * 0.29 + T * 0.21 + 3.1) + sin(q.x * 0.19 + T * 0.17 + 4.2),
                 sin(q.x * 0.27 - T * 0.25 + 5.3) + sin(q.y * 0.21 + T * 0.13 + 2.5));
  vec3 w2 = vec3(sin(q.y * 1.1 + q.z * 0.7 + T * 0.8),
                 sin(q.z * 1.3 + q.x * 0.6 - T * 0.7),
                 sin(q.x * 1.2 + q.y * 0.8 + T * 0.9));
  float warp = (0.3 + 0.7 * rn) * (0.55 + 0.45 * uIntensity);
  float oa = T * (0.6 + 0.9 * rA) + ph;
  vec3 orb = vec3(cos(oa), sin(oa * 1.3 + rB * 6.0), sin(oa)) * (0.1 + 0.28 * rB) * (0.5 + 0.8 * e);
  p += (w1 * 0.75 + w2 * 0.4) * warp + orb;

  // drifting light clumps (value noise) give the cloud filaments that move through it
  float n = vnoise(p * 0.36 + vec3(0.0, T * 0.035, T * 0.025));
  float clump = 0.3 + 0.9 * smoothstep(0.22, 0.78, n);

  // soft floor (smooth max of world height) and a hard 1.8 m clearance around the head
  float wy = p.y + EYE;
  wy = 0.5 * (wy + 0.35 + sqrt((wy - 0.35) * (wy - 0.35) + 0.12));
  p.y = wy - EYE;
  float rl = length(p);
  p *= max(rl, 1.8) / rl;

  // ~8% of the particles are large faint "gas" sprites that fill the space between the stars
  float gas = 1.0 - step(0.08, aSeed.w);
  // treble sparkle: a subset of the (non-gas) particles flickers bright
  float spark = step(0.9, aSeed.w);
  float flick = pow(max(0.0, sin(uTime * (7.0 + 13.0 * rA) + ph * 9.0)), 8.0);
  float sp = spark * flick * (0.1 + 1.4 * uTreble);

  // each cloud has its own hue (noise), quiet particles sit low in the gradient, active ones climb it
  float gc = clamp(0.08 + 0.6 * smoothstep(0.25, 0.75, n) + 0.3 * e + 0.08 * rn + 0.1 * wave, 0.0, 1.0);
  vec3 gcol = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  // keep the hue but lift the dark gradient stops so they still read as glowing dust
  vColor = gcol / max(max(gcol.r, max(gcol.g, gcol.b)), 0.25);

  float sz = 0.02 + 0.1 * aSeed.z * aSeed.z * aSeed.z;
  sz *= (0.75 + 0.7 * e) * (1.0 + 0.5 * uBurst) * (1.0 + 1.2 * sp) * (1.0 + 0.6 * wave);
  sz = mix(sz, 0.5 + 0.7 * aSeed.z, gas);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = length(mv.xyz);
  // sprite = ~2.6x the particle size so the soft halo has room around the bright core
  float raw = sz * 2.6 * uPixelRatio * 300.0 / max(-mv.z, 0.1);
  gl_PointSize = clamp(raw, 1.0, 56.0);
  gl_Position = projectionMatrix * mv;

  float near = smoothstep(1.0, 3.0, dist) * mix(1.0, smoothstep(4.0, 8.0, dist), gas);
  float alpha = (0.16 + 0.84 * e) * clump + 1.3 * wave + 1.1 * sp + 0.25 * uBurst * e;
  alpha = mix(alpha, (0.12 + 0.2 * e) * clump + 0.2 * wave, gas);
  // sub-pixel sprites keep their energy but lose coverage (no shimmer); big sprites spread theirs over more pixels
  float cover = min(1.0, raw * raw) * min(1.0, 14.0 / raw);
  vAlpha = alpha * uBright * near * cover * 0.75;
  vHot = clamp(wave * 0.7 + sp * 0.7 + uBurst * 0.2 * e, 0.0, 1.0);
  vGas = gas;
}
`;

const NEBULA_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
varying float vGas;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  // two-layer falloff: tight bright core + wide soft halo (fake bloom under additive blending)
  float core = exp(-d2 * 24.0) * (1.0 - vGas);
  float halo = exp(-d2 * mix(5.0, 3.0, vGas)) * max(0.0, 1.0 - d2);
  float a = core + halo * 0.4;
  vec3 col = mix(vColor, vec3(1.0), clamp(core * 0.45 + vHot * 0.5, 0.0, 1.0));
  gl_FragColor = vec4(col * (a * vAlpha * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DUST_VERT = /* glsl */ `
${HISTORY_GLSL}
// position = offset from the head (0.55..2.2 m), aSeed = (band, phase, size, twinkle)
attribute vec4 aSeed;
uniform float uTime, uBeat, uBright, uPixelRatio, uIntensity;
varying float vAlpha;

void main() {
  float ph = aSeed.y * 6.2831853;
  // slow lazy drift: a few cm of lazy sine wander on top of the static parallax
  vec3 drift = vec3(sin(uTime * 0.11 * (0.6 + aSeed.z) + ph),
                    sin(uTime * 0.09 * (0.5 + aSeed.x) + ph * 1.7),
                    cos(uTime * 0.10 * (0.5 + aSeed.w) + ph * 0.6)) * 0.22;
  vec3 p = position + drift;
  float e = histFreq(aSeed.x, 0.0);
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + 1.6 * aSeed.w) + ph * 3.0);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = length(mv.xyz);
  float sz = 0.012 + 0.03 * aSeed.z * aSeed.z;
  float raw = sz * 2.6 * uPixelRatio * 300.0 / max(-mv.z, 0.1);
  gl_PointSize = clamp(raw, 1.0, 48.0);
  gl_Position = projectionMatrix * mv;
  float near = smoothstep(0.45, 1.1, dist);
  vAlpha = (0.1 + 0.35 * e * uIntensity + 0.12 * uBeat) * tw * near * uBright * min(1.0, raw * raw);
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  float a = exp(-d2 * 6.0) * max(0.0, 1.0 - d2);
  vec3 col = mix(vec3(1.0), uColor, 0.45);
  gl_FragColor = vec4(col * (a * vAlpha * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Uniforms = Record<string, THREE.IUniform>;

/** Stateless GPU particle nebula wrapped around the listener, plus a few parallax dust motes. */
export class NebulaParticles implements Preset {
  readonly id = 'nebula';
  readonly name = 'Nebula';
  readonly description = 'Hundreds of thousands of particles breathing with the bass';
  readonly group = new THREE.Group();

  private ctx!: PresetContext;
  private nebula!: THREE.Points;
  private dust!: THREE.Points;
  private nebulaMat!: THREE.ShaderMaterial;
  private dustMat!: THREE.ShaderMaterial;
  private nu!: Uniforms;
  private du!: Uniforms;
  private clock = 0;
  private swirl = 0;
  private beatAge = 99;

  init(ctx: PresetContext): void {
    this.ctx = ctx;
    const count = COUNTS[ctx.quality];
    const pr = ctx.renderer.getPixelRatio();

    // --- nebula ---------------------------------------------------------------------------
    const home = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; ) {
      // azimuth warped so particles concentrate around phi = 0 (the -Z direction)
      let phi = Math.random() * TAU;
      phi -= FRONT_BIAS * Math.sin(phi);
      // bell-shaped elevation => dense band around eye height with a thin halo above and below
      const el = ((Math.random() + Math.random() + Math.random()) / 3 * 2 - 1) * 1.25;
      const r = R_MIN + (R_MAX - R_MIN) * Math.pow(Math.random(), 0.8);
      const ce = Math.cos(el);
      const x = r * ce * Math.sin(phi);
      const y = r * Math.sin(el);
      const z = -r * ce * Math.cos(phi);
      if (EYE + y < 0.35) continue; // nothing below the floor (also avoids a dense line of particles at the horizon)
      const n = cloudNoise(x, y, z);
      if (Math.random() > 0.1 + 0.9 * smooth(0.36, 0.7, n)) continue; // rejection sampling: clouds + voids
      home[i * 3] = x;
      home[i * 3 + 1] = y;
      home[i * 3 + 2] = z;
      // neighbouring particles share a band (regional pulsing) with some individual scatter
      const regional = Math.min(1, Math.max(0, (n - 0.25) / 0.5));
      seed[i * 4] = Math.min(0.98, Math.max(0.02, 0.6 * regional + 0.4 * Math.random()));
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random();
      i++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(home, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

    this.nu = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uTime: { value: 0 },
      uSwirl: { value: 0 },
      uBass: { value: 0 },
      uBurst: { value: 0 },
      uTreble: { value: 0 },
      uIntensity: { value: 1 },
      uBright: { value: 0.92 },
      uPixelRatio: { value: pr },
      uWaveR: { value: -10 },
      uWaveAmp: { value: 0 },
      uOpacity: { value: 1 },
    };
    this.nebulaMat = new THREE.ShaderMaterial({
      uniforms: this.nu,
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.nebula = new THREE.Points(geo, this.nebulaMat);
    this.nebula.position.set(0, EYE, 0);
    this.nebula.frustumCulled = false;
    this.group.add(this.nebula);

    // --- dust motes -----------------------------------------------------------------------
    const dPos = new Float32Array(DUST_COUNT * 3);
    const dSeed = new Float32Array(DUST_COUNT * 4);
    const lo = 0.55 ** 3;
    const hi = 2.2 ** 3;
    for (let i = 0; i < DUST_COUNT; i++) {
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * TAU;
      const s = Math.sqrt(1 - u * u);
      const d = Math.cbrt(lo + (hi - lo) * Math.random());
      let y = u * d;
      if (y < -1.3) y = -1.3 + (-1.3 - y) * 0.5; // keep the motes above the floor
      dPos[i * 3] = d * s * Math.cos(phi);
      dPos[i * 3 + 1] = y;
      dPos[i * 3 + 2] = d * s * Math.sin(phi);
      for (let k = 0; k < 4; k++) dSeed[i * 4 + k] = Math.random();
    }
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    dGeo.setAttribute('aSeed', new THREE.BufferAttribute(dSeed, 4));
    this.du = {
      ...ctx.textures.uniforms,
      uColor: { value: ctx.palette.accent },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uBright: { value: 0.92 },
      uPixelRatio: { value: pr },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
    };
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: this.du,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.dust = new THREE.Points(dGeo, this.dustMat);
    this.dust.position.set(0, EYE, 0);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const d = Math.min(dt, 0.1);
    this.clock += d * p.speed;
    // mid-range energy spins up the swirl; integrating on the CPU keeps speed changes free of phase jumps
    this.swirl += d * p.speed * (0.35 + 1.4 * f.mid);
    if (f.beat) this.beatAge = 0;
    else this.beatAge += d;

    const pr = this.ctx.renderer.getPixelRatio();
    const bright = 0.6 + 0.4 * p.glow;
    const nu = this.nu;
    nu.uTime.value = this.clock;
    nu.uSwirl.value = this.swirl;
    nu.uBass.value = Math.min(1.3, f.bass * p.intensity);
    nu.uBurst.value = f.beatEnv * p.intensity;
    nu.uTreble.value = Math.min(1.2, f.treble);
    nu.uIntensity.value = p.intensity;
    nu.uBright.value = bright;
    nu.uPixelRatio.value = pr;
    nu.uWaveR.value = R_MIN - 0.6 + this.beatAge * WAVE_SPEED;
    nu.uWaveAmp.value = Math.exp(-this.beatAge * 1.7) * (0.5 + 0.5 * f.beatStrength) * Math.min(1, p.intensity);

    const du = this.du;
    du.uTime.value = this.clock;
    du.uBeat.value = f.beatEnv * p.intensity;
    du.uBright.value = bright;
    du.uPixelRatio.value = pr;
    du.uIntensity.value = p.intensity;
  }

  setOpacity(o: number): void {
    this.nu.uOpacity.value = o;
    this.du.uOpacity.value = o;
  }

  dispose(): void {
    this.nebula.geometry.dispose();
    this.dust.geometry.dispose();
    this.nebulaMat.dispose();
    this.dustMat.dispose();
    this.group.clear();
  }
}
