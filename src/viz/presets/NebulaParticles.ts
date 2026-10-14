import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const TAU = Math.PI * 2;
const EYE = 1.6;
const R_MIN = 3;
const R_MAX = 12;
/** Speed (m/s) of the shockwave that travels through the nebula after each beat. */
const WAVE_SPEED = 9;
const DUST_COUNT = 300;
const COUNTS: Record<QualityLevel, number> = { low: 25_000, medium: 60_000, high: 120_000 };

// Particle classes, chosen by aSeed.w: gas (large soft sprites that build the volume), dust (small coloured
// grains that trace the filaments) and sparks (tiny near-white points that twinkle with the treble).
const GAS_END = 0.55;
const SPARK_START = 0.95;
const ARM_COUNT = 6;
const HALO_FRACTION = 0.12;

// ---------------------------------------------------------------------------------------------
// Init-time structure (CPU). The nebula is stateless on the GPU, but its "home" positions are laid
// out along curved arms wrapped around the listener, so the cloud has filaments, knots and voids.
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

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const rand = (a: number, b: number) => a + (b - a) * Math.random();
/** Roughly normal (sum of three uniforms), unit variance. */
const gauss = () => ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 6;

/** A curved stream wrapped around the listener: a (tilted) circle with a spiralling radius and a wobble. */
interface Arm {
  a: THREE.Vector3; // plane basis
  b: THREE.Vector3;
  n: THREE.Vector3; // plane normal
  centerY: number;
  r0: number;
  r1: number;
  phi0: number;
  span: number;
  dir: number;
  wobAmp: number;
  wobK: number;
  wobP: number;
  omega: number; // orbital drift, rad/s around the vertical axis
}

function makeArms(): Arm[] {
  const arms: Arm[] = [];
  for (let i = 0; i < ARM_COUNT; i++) {
    // half of the arms are flat-ish spirals around eye height, the others are tilted toroidal streams
    const flat = i % 2 === 0;
    const tilt = flat ? rand(-0.12, 0.22) : (Math.random() < 0.5 ? -1 : 1) * rand(0.4, 0.8);
    const roll = rand(0, TAU);
    const n = new THREE.Vector3(Math.sin(tilt) * Math.cos(roll), Math.cos(tilt), Math.sin(tilt) * Math.sin(roll));
    const a = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 0, -1)).normalize();
    const b = new THREE.Vector3().crossVectors(n, a);
    let r0 = rand(R_MIN + 0.3, R_MAX - 2);
    let r1 = rand(R_MIN + 0.3, R_MAX);
    if (Math.abs(r1 - r0) < 2.5) r1 = r0 < 7 ? r0 + 3 : r0 - 3;
    r0 = Math.min(R_MAX, Math.max(R_MIN, r0));
    r1 = Math.min(R_MAX, Math.max(R_MIN, r1));
    arms.push({
      a, b, n,
      centerY: flat ? rand(-0.2, 0.8) : rand(0.8, 2.0),
      r0, r1,
      phi0: rand(0, TAU),
      span: rand(1.2, 2) * Math.PI,
      dir: Math.random() < 0.5 ? -1 : 1,
      wobAmp: rand(0.08, 0.3),
      wobK: rand(1.3, 3.2),
      wobP: rand(0, TAU),
      omega: (Math.random() < 0.5 ? -1 : 1) * rand(0.05, 0.2),
    });
  }
  return arms;
}

/** Point on the arm at u in 0..1 (relative to the head). */
function armPoint(arm: Arm, u: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = arm.phi0 + arm.dir * arm.span * u;
  const wob = arm.wobAmp * Math.sin(arm.wobK * phi + arm.wobP);
  const c = Math.cos(phi), s = Math.sin(phi);
  out.set(
    c * arm.a.x + s * arm.b.x + wob * arm.n.x,
    c * arm.a.y + s * arm.b.y + wob * arm.n.y,
    c * arm.a.z + s * arm.b.z + wob * arm.n.z,
  ).normalize();
  const r = (arm.r0 + (arm.r1 - arm.r0) * smooth(0, 1, u)) * (1 + 0.08 * Math.sin(2.3 * phi + arm.wobP));
  out.multiplyScalar(r);
  out.y += arm.centerY;
  return out;
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
#define GAS_END ${GAS_END.toFixed(2)}
#define SPARK_START ${SPARK_START.toFixed(2)}
#define GAS_GAIN 0.3
#define DUST_GAIN 0.2
// position = home offset from the head. aSeed = (band, phase, size, class), aArm = (drift rad/s, arm hue, random)
attribute vec4 aSeed;
attribute vec3 aArm;
uniform sampler2D uGradient;
uniform float uTime, uSwirl, uDrift, uBass, uBurst, uTreble, uIntensity, uBright, uPixelRatio, uWaveR, uWaveAmp;
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
varying vec2 vClass; // x: gas, y: spark

void main() {
  float gas = 1.0 - step(GAS_END, aSeed.w);
  float spark = step(SPARK_START, aSeed.w);
  float dust = 1.0 - gas - spark;

  // slow orbital drift around the listener, each arm at its own speed
  float ang = aArm.x * uDrift;
  float ca = cos(ang), sa = sin(ang);
  vec3 home = vec3(ca * position.x - sa * position.z, position.y, sa * position.x + ca * position.z);
  float r0 = length(home);
  vec3 dir = home / r0;
  float rn = clamp((r0 - R_MIN) / R_RANGE, 0.0, 1.0);
  float ph = aSeed.y * 6.2831853;
  float rA = fract(aSeed.y * 37.13);
  float rB = aArm.z;
  float T = uSwirl;

  // every particle listens to one band (arms own a frequency range); the delay grows with radius so energy ripples outward
  float e = histFreq(aSeed.x, rn * 14.0 + rA * 4.0);
  e = clamp(e * (0.65 + 0.5 * uIntensity), 0.0, 1.2);

  // bass breathing of the whole shell, beat burst, and a shockwave sweeping outward after each beat
  float breathe = 1.0 + uBass * 0.22 * (1.0 - 0.4 * rn);
  float dW = (r0 * breathe - uWaveR) / 1.6;
  float wave = uWaveAmp * exp(-dW * dW);
  float rr = r0 * breathe + uBurst * (0.15 + 0.45 * rB) + wave * 1.1;
  vec3 p = dir * rr;

  // curl-ish flow: two octaves of sine fields (mid speeds them up through uSwirl) + a tiny orbit for the small grains
  vec3 q = home;
  vec3 w1 = vec3(sin(q.y * 0.31 + T * 0.23) + sin(q.z * 0.17 - T * 0.19 + 1.7),
                 sin(q.z * 0.29 + T * 0.21 + 3.1) + sin(q.x * 0.19 + T * 0.17 + 4.2),
                 sin(q.x * 0.27 - T * 0.25 + 5.3) + sin(q.y * 0.21 + T * 0.13 + 2.5));
  vec3 w2 = vec3(sin(q.y * 1.1 + q.z * 0.7 + T * 0.8),
                 sin(q.z * 1.3 + q.x * 0.6 - T * 0.7),
                 sin(q.x * 1.2 + q.y * 0.8 + T * 0.9));
  float warp = (0.25 + 0.55 * rn) * (0.5 + 0.5 * uIntensity);
  float oa = T * (0.6 + 0.9 * rA) + ph;
  vec3 orb = vec3(cos(oa), sin(oa * 1.3 + rB * 6.0), sin(oa)) * (0.08 + 0.2 * rB) * (0.5 + 0.8 * e) * (1.0 - gas);
  p += (w1 * 0.7 + w2 * 0.3) * warp + orb;

  // drifting light clumps (value noise) carve the gas into billows
  float n = vnoise(p * 0.3 + vec3(0.0, T * 0.03, T * 0.02));
  float clump = 0.35 + 0.9 * smoothstep(0.2, 0.8, n);

  // soft floor (smooth max of world height) and a hard 1.8 m clearance around the head
  float wy = p.y + EYE;
  wy = 0.5 * (wy + 0.35 + sqrt((wy - 0.35) * (wy - 0.35) + 0.12));
  p.y = wy - EYE;
  float rl = length(p);
  p *= max(rl, 1.8) / rl;
  float front = -p.z / max(length(p), 0.001); // 1 straight ahead (-Z)
  float fw = 0.5 + 0.5 * smoothstep(-0.7, 0.9, front);

  // colour: gas takes saturated palette hues by radius, dust the same hue but brighter with its band, sparks are near white
  float hueMix = 0.95 * rn + 0.4 * (aArm.y - 0.5) + 0.4 * (n - 0.5);
  float gc = clamp(0.5 + 1.5 * (hueMix - 0.48) + 0.14 * e + 0.1 * wave, 0.0, 1.0);
  vec3 gcol = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  vColor = gcol / max(max(gcol.r, max(gcol.g, gcol.b)), 0.25);

  // treble sparkle
  float flick = pow(max(0.0, sin(uTime * (7.0 + 13.0 * rA) + ph * 9.0)), 8.0);
  float sp = flick * (0.15 + 1.5 * uTreble * uIntensity);

  // sizes: gas 0.25-0.9 m (sprite = diameter), dust 0.03-0.08 m, sparks 0.02-0.045 m (small ones get a 3x glow sprite)
  float sz = gas * (0.25 + 0.65 * aSeed.z) + dust * (0.03 + 0.05 * aSeed.z) + spark * (0.02 + 0.025 * aSeed.z);
  sz *= gas * (0.85 + 0.3 * fw + 0.25 * uBass) + dust * (0.75 + 0.7 * e) + spark * (1.0 + 1.2 * sp);
  sz *= 1.0 + 0.4 * uBurst * (1.0 - gas) + 0.5 * wave;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = length(mv.xyz);
  float raw = sz * mix(3.0, 1.0, gas) * uPixelRatio * 300.0 / max(-mv.z, 0.1);
  gl_PointSize = clamp(raw, 1.0, 56.0);
  gl_Position = projectionMatrix * mv;

  // gas also fades out toward the floor so the cloud does not end in a hard edge
  float near = smoothstep(1.0, 3.0, dist) * mix(1.0, smoothstep(3.0, 6.5, dist) * smoothstep(0.3, 1.6, p.y + EYE), gas);
  float aGas = (0.03 + 0.05 * rB) * (0.5 + 1.0 * e) * clump * GAS_GAIN;
  float aDust = (0.25 + 0.4 * rB) * (0.35 + 0.9 * e) * clump * DUST_GAIN;
  float aSpark = 0.15 + 0.9 * sp;
  float alpha = (gas * aGas + dust * aDust + spark * aSpark) * fw + wave * (0.12 * gas + 0.9 * (1.0 - gas)) + 0.1 * uBurst * e;
  // sub-pixel sprites keep their energy but lose coverage (no shimmer); big sprites spread theirs over more pixels
  float cover = min(1.0, raw * raw) * min(1.0, 48.0 / raw);
  vAlpha = alpha * uBright * near * cover;
  vHot = clamp(wave * 0.7 + uBurst * 0.2 * e, 0.0, 1.0);
  vClass = vec2(gas, spark);
}
`;

const NEBULA_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
varying vec2 vClass;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  float edge = max(0.0, 1.0 - d2);
  float gasShape = exp(-d2 * 3.2) * edge;                           // soft, no core
  float dustShape = exp(-d2 * 16.0) + 0.45 * exp(-d2 * 5.0) * edge;  // coloured core + halo
  float sparkShape = exp(-d2 * 34.0) + 0.3 * exp(-d2 * 7.0) * edge;  // tight bright point
  float a = mix(mix(dustShape, sparkShape, vClass.y), gasShape, vClass.x);
  // white only on sparks; beats just push the palette colour brighter
  vec3 col = mix(vColor * (1.0 + 0.6 * vHot), vec3(1.0), vClass.y * 0.85);
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
  // a few cm of lazy sine wander on top of the static parallax
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
  vAlpha = (0.08 + 0.25 * e * uIntensity + 0.08 * uBeat) * tw * near * uBright * min(1.0, raw * raw);
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  float a = exp(-d2 * 5.0) * max(0.0, 1.0 - d2);
  gl_FragColor = vec4(uColor * (a * vAlpha * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Uniforms = Record<string, THREE.IUniform>;

/** Stateless GPU particle nebula: gas / dust / spark classes laid out along curved arms around the listener. */
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
  private drift = 0;
  private beatAge = 99;

  init(ctx: PresetContext): void {
    this.ctx = ctx;
    const count = COUNTS[ctx.quality];
    const pr = ctx.renderer.getPixelRatio();

    // --- nebula ---------------------------------------------------------------------------
    const arms = makeArms();
    const home = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    const armData = new Float32Array(count * 3);
    const pt = new THREE.Vector3();
    for (let i = 0; i < count; ) {
      const cls = Math.random();
      const gas = cls < GAS_END;
      const spark = cls >= SPARK_START;
      let band: number;
      let omega: number;
      let hue: number;
      if (Math.random() < HALO_FRACTION) {
        // sparse halo: bell-shaped elevation, denser in front
        let phi = Math.random() * TAU;
        phi -= 0.4 * Math.sin(phi);
        const el = ((Math.random() + Math.random() + Math.random()) / 3 * 2 - 1) * 1.1;
        const r = R_MIN + 1 + (R_MAX + 2 - R_MIN - 1) * Math.pow(Math.random(), 0.8);
        const ce = Math.cos(el);
        pt.set(r * ce * Math.sin(phi), r * Math.sin(el), -r * ce * Math.cos(phi));
        band = Math.random();
        omega = (Math.random() < 0.5 ? -1 : 1) * rand(0.01, 0.04);
        hue = 0.5;
      } else {
        const ai = Math.floor(Math.random() * ARM_COUNT);
        const arm = arms[ai];
        const u = Math.random();
        if (Math.random() > Math.pow(Math.sin(Math.PI * u), 0.6)) continue; // taper toward both ends
        armPoint(arm, u, pt);
        // cross-section: wide for gas, tight for the dust that traces the filament, pinching and swelling along the arm
        const pinch = 0.6 + 0.8 * valueNoise(u * 5 + ai * 7.3, ai * 3.1, 1.7);
        const sigma = (gas ? rand(0.8, 1.3) : spark ? 0.7 : rand(0.25, 0.5)) * pinch;
        pt.x += gauss() * sigma;
        pt.y += gauss() * sigma * 0.8;
        pt.z += gauss() * sigma;
        band = (ai + u) / ARM_COUNT;
        omega = arm.omega;
        hue = ai / (ARM_COUNT - 1);
      }
      // nothing below the floor or on top of the head; thin out smoothly toward the floor
      if (EYE + pt.y < 0.3 || pt.length() < 2 || Math.random() > smooth(0.3, 1.8, EYE + pt.y)) continue;
      const n = 0.65 * valueNoise(pt.x * 0.2, pt.y * 0.2, pt.z * 0.2) + 0.35 * valueNoise(pt.x * 0.47 + 7.1, pt.y * 0.47, pt.z * 0.47 + 3.7);
      if (Math.random() > 0.35 + 0.65 * smooth(0.3, 0.7, n)) continue; // extra clumping: voids inside the arms
      home[i * 3] = pt.x;
      home[i * 3 + 1] = pt.y;
      home[i * 3 + 2] = pt.z;
      seed[i * 4] = Math.min(0.98, Math.max(0.02, band + rand(-0.04, 0.04)));
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = cls;
      armData[i * 3] = omega;
      armData[i * 3 + 1] = hue;
      armData[i * 3 + 2] = Math.random();
      i++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(home, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aArm', new THREE.BufferAttribute(armData, 3));

    this.nu = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uTime: { value: 0 },
      uSwirl: { value: 0 },
      uDrift: { value: 0 },
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

    // --- dust motes (sparse, soft, for parallax) -------------------------------------------
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
    this.drift += d * p.speed;
    // mid-range energy spins up the swirl; integrating on the CPU keeps speed changes free of phase jumps
    this.swirl += d * p.speed * (0.35 + 1.4 * f.mid);
    if (f.beat) this.beatAge = 0;
    else this.beatAge += d;

    const pr = this.ctx.renderer.getPixelRatio();
    const bright = 0.6 + 0.4 * p.glow;
    const nu = this.nu;
    nu.uTime.value = this.clock;
    nu.uSwirl.value = this.swirl;
    nu.uDrift.value = this.drift;
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
