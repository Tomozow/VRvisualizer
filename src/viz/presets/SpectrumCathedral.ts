import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';
import { OUTPUT_GLSL } from '@/viz/shared/Shading';

/** Frames between neighbouring history rings (≈83 ms at 72 Hz): the spectrum "echoes" outwards. */
const HISTORY_STEP = 6;
const BACK_DELAY = 3; // extra frames of history delay behind the listener
const RISE_RATE = 25; // m/s: pillars may not rise faster than this
const WAVE_SPEED = 1.25; // beat-wave phase units per second
const WAVE_HEIGHT = 10; // metres the beat wave travels over one phase unit
const BREATH_M = 0.1; // ± ring radius breathing on the bass follower
const BREATH_ATTACK = 0.09; // s
const BREATH_RELEASE = 0.4; // s
/** Rings below this index are solid glass pillars; the rest are halo-only ghosts. */
const SOLID_RINGS = 2;
/** Halo pillars quieter than this (energy of the newest rows) are moved off-screen: their glow is zero anyway. */
const HALO_MIN_ENERGY = 0.12;

interface CathedralLayout {
  pillars: number;
  rings: number;
}

const LAYOUT: Record<string, CathedralLayout> = {
  low: { pillars: 64, rings: 5 },
  medium: { pillars: 96, rings: 7 },
  high: { pillars: 128, rings: 7 },
};

/**
 * Vertex stage shared by the solid pillars and the additive halo pass.
 * Every pillar is a unit box scaled/placed here; per-instance data = (angle 0..1, ring, mirror flag).
 * The floor reflection is a 180° rotation about the pillar's radial axis (so triangle winding survives).
 *
 * Height = spectrum energy averaged over 3 history rows, soft-limited with tanh (tips stay in view), and
 * rise-limited: the minimum over several look-backs of (height back then + RISE * elapsed) is a stateless
 * slew limiter, so a kick makes the pillars surge instead of teleport.
 */
function pillarVertex(layout: CathedralLayout, halo: boolean): string {
  return /* glsl */ `
${HISTORY_GLSL}
#define PILLARS ${layout.pillars.toFixed(1)}
#define RING_MAX ${(layout.rings - 1).toFixed(1)}
#define HIST_STEP ${HISTORY_STEP.toFixed(1)}
#define BACK_DELAY ${BACK_DELAY.toFixed(1)}
#define RISE_PER_ROW ${(RISE_RATE / 72).toFixed(4)}
#define HALO ${halo ? 1 : 0}
const float TAU = 6.28318530718;

attribute vec3 aData; // x: angle (0 = ahead, -Z), y: ring, z: mirror
uniform float uTime;
uniform float uIntensity;
uniform float uMid;
uniform float uBreath; // metres, ± ring radius breathing

varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
varying float vLocalY;
varying float vTip; // metres below the pillar tip
varying float vEnergy;
varying float vRing;
varying float vMirror;
varying float vCeil;

void main() {
  float ring = aData.y;
  float mirror = aData.z;
  float a = aData.x;

  // Band mapping: bass at 0° and 180°, treble at ±90° (symmetric left/right and front/back).
  float s = abs(sin(a * TAU));
  float u = pow(s, 0.8) * 0.94 + 0.01;
  float back = 1.0 - smoothstep(-0.35, 0.35, cos(a * TAU)); // 0 ahead .. 1 behind
  float age0 = ring * HIST_STEP + BACK_DELAY * back;
  // gentle tilt keeps the highs lively; bass ahead is pushed up; behind the listener everything is calmer
  float gain = (0.85 + 0.6 * u) * mix(1.15 - 0.35 * u, 1.0, smoothstep(0.2, 0.3, u)) * mix(1.0, 0.7, back);

  float hMax = 8.0 + 0.9 * ring;
  float raw[13];
  for (int j = 0; j < 3; j++) raw[j] = histFreq(u, age0 + float(j));
  float e = clamp((raw[0] + raw[1] + raw[2]) * (1.0 / 3.0) * gain, 0.0, 1.25);
  #if HALO
    // the halo is invisible below this energy (its fragment ramp starts at 0.2): skip the rest of the work too
    if (e < ${HALO_MIN_ENERGY.toFixed(2)}) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  #endif
  for (int j = 3; j < 13; j++) raw[j] = histFreq(u, age0 + float(j));
  float h = 1e4;
  for (int k = 0; k < 6; k++) {
    int j = 2 * k;
    float ek = k == 0 ? e : clamp((raw[j] + raw[j + 1] + raw[j + 2]) * (1.0 / 3.0) * gain, 0.0, 1.25);
    float hk = 0.2 + pow(max(ek, 0.3), 1.4) * 6.0 * uIntensity * (1.0 + 0.1 * ring);
    hk = hMax * tanh(hk / hMax);
    h = min(h, hk + RISE_PER_ROW * float(j));
  }

  float radius = 4.5 + 9.5 * pow(ring / RING_MAX, 0.85) + uBreath;
  float sway = sin(uTime * 0.7 + a * 31.4 + ring * 1.9);
  float lean = sway * (0.012 + 0.05 * uMid);
  float theta = (a + 0.004 * sin(uTime * 0.23 + ring * 1.3) * (1.0 + 4.0 * uMid)) * TAU;

  float w = TAU * radius / PILLARS * 0.4;
  float d = w * 0.8;
  float hh = h;
  #if HALO
    w *= 2.2; d *= 2.2; hh += 0.4;
  #endif

  float sgn = mirror > 1.5 ? 1.0 : 1.0 - 2.0 * mirror;
  vec3 R = vec3(sin(theta), 0.0, -cos(theta));
  vec3 T = vec3(cos(theta), 0.0, sin(theta));
  float y = position.y * hh * sgn;
  vec3 p = R * (radius - position.z * d - 0.18 * abs(y)) + T * (position.x * w * sgn + lean * y) + vec3(0.0, y, 0.0);
  // mirror 2: a ceiling echo hanging from a 16 m vault at 40 % height (halo pass only)
  if (mirror > 1.5) p.y = 16.0 - position.y * hh * 0.4;
  vec3 n = T * (normal.x * sgn) + vec3(0.0, normal.y * sgn, 0.0) - R * normal.z;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(modelMatrix) * n;
  vUv = uv;
  vLocalY = position.y;
  vTip = (1.0 - position.y) * hh;
  vEnergy = e;
  vRing = ring;
  vMirror = mirror > 1.5 ? 0.0 : mirror;
  vCeil = step(1.5, mirror);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
}

/**
 * Opaque pillar pass (`reflect = false`) and blended floor-reflection pass (`reflect = true`) share this body.
 * Stays highp: the LED rows use fract/fwidth of the world height.
 */
function solidFragment(reflect: boolean): string {
  return /* glsl */ `
${OUTPUT_GLSL}
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeat;
uniform float uBeatWave;
uniform vec3 uAccent;

varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
varying float vLocalY;
varying float vTip;
varying float vEnergy;
varying float vRing;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = abs(dot(N, V));
  float y = abs(vWorld.y);
  float dist = length(vWorld - cameraPosition);

  // Colour follows height and energy; the history rings slide from the warm end toward violet with depth.
  float g = clamp(0.18 + y * 0.05 + vEnergy * 0.30 - vRing * 0.06, 0.0, 0.82);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;
  vec3 hot = texture2D(uGradient, vec2(min(g + 0.22, 1.0), 0.5)).rgb;
  hot = mix(hot, vec3(1.0), 0.35 * uBeat); // white only on beat peaks

  // Dark glass body that brightens toward the top of each pillar.
  float up = pow(max(vLocalY, 0.0), 1.3); // varyings can extrapolate slightly below 0 under MSAA
  vec3 col = grad * (0.2 + 0.55 * up) * (0.55 + 0.45 * ndv);

  // Luminous vertical edges.
  float edge = 1.0 - smoothstep(0.0, 0.11, min(vUv.x, 1.0 - vUv.x));
  col += grad * edge * (0.15 + 0.55 * up);

  // LED rows every 25 cm, faded out when they would alias.
  float yy = y * 4.0;
  float fw = fwidth(yy);
  float row = (1.0 - smoothstep(0.0, 0.10 + fw, abs(fract(yy + 0.5) - 0.5))) * (1.0 - smoothstep(0.3, 0.7, fw));
  col += grad * row * (0.10 + 0.35 * vEnergy);

  // Hot cap: a 35 cm tip region in world space, so tall and short pillars carry the same jewel.
  float cap = 1.0 - smoothstep(0.0, 0.35, vTip);
  col += hot * cap * (0.35 + 0.9 * vEnergy);

  // Fresnel rim (ndv can exceed 1 by an ulp: keep the pow base non-negative).
  float rim = max(1.0 - ndv, 0.0);
  col += grad * (rim * rim * rim) * 0.35;

  // Beat wave climbing the pillars, delayed on the outer rings.
  float ph = uBeatWave - vRing * 0.07;
  float wy = ph * ${WAVE_HEIGHT.toFixed(1)};
  float wd = (y - wy) / 0.3;
  float wave = exp(-wd * wd) * (1.0 - smoothstep(0.45, 1.1, ph)) * step(0.0, ph) / (1.0 + vRing * 0.8);
  col += mix(texture2D(uGradient, vec2(0.7, 0.5)).rgb, uAccent, 0.25) * wave * 0.55;

  // Rings further out are dimmer and dissolve into the dark with distance.
  float dn = dist * 0.045;
  float fade = exp(-dn * dn) / (1.0 + 0.4 * vRing);
  col *= fade * 0.7 * uBrightness * (1.0 + uBeat * 0.3);
  // keep the brightest channel under 0.85 so lit tips stay saturated instead of blowing out to white
  col *= min(1.0, 0.85 / max(max(col.r, col.g), max(col.b, 1e-4)));

  ${reflect ? 'float mirrorFade = 0.3 * exp(-y * 0.6);' : 'float mirrorFade = 1.0;'}
  gl_FragColor = vec4(cheapOutput(col), uOpacity * mirrorFade);
}`;
}

/** Additive halo: no grid / fract maths, so mediump is enough. */
const HALO_FRAGMENT = /* glsl */ `
precision mediump float;
${OUTPUT_GLSL}
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeat;

varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
varying float vLocalY;
varying float vEnergy;
varying float vRing;
varying float vMirror;
varying float vCeil;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = abs(dot(N, V));
  float y = abs(vWorld.y);

  // Ring 0 is the live halo; rings >= 2 are ghosts (alpha 0.35 / (1 + ring)) with a taller, softer column.
  float ghostRing = step(0.5, vRing);
  float alpha = mix(1.0, 0.35 / (1.0 + vRing), ghostRing);

  // Soft vertical band: bright at the centre of each face, zero at the box edges, strongest near the tip.
  float fx = 1.0 - abs(vUv.x * 2.0 - 1.0);
  fx *= fx;
  float amt = fx * ndv * pow(max(vLocalY, 0.0), mix(2.2, 1.3, ghostRing)) * smoothstep(0.2, 0.9, vEnergy);

  float g = clamp(0.18 + y * 0.05 + vEnergy * 0.30 - vRing * 0.06, 0.0, 0.82);
  vec3 col = texture2D(uGradient, vec2(g, 0.5)).rgb * amt * alpha * uBrightness * (1.0 + uBeat * 0.35);
  col *= mix(1.0, 0.3 * exp(-y * 0.5), vMirror) * mix(1.0, 0.5, vCeil) * uOpacity;
  gl_FragColor = vec4(cheapOutputAdditive(col), 1.0);
}`;

/** One block of instances: a ring, drawn either upright (mirror 0) or as its floor reflection (mirror 1). */
interface InstanceSpec {
  ring: number;
  /** 0 upright, 1 floor reflection, 2 ceiling echo (halo pass only) */
  mirror: 0 | 1 | 2;
}

/**
 * A cylindrical cathedral of spectrum pillars: the live spectrum on the two inner rings as solid glass, the
 * deeper history rings as faint halo ghosts so the spectrum ripples outwards into the dark, the front rings
 * reflected in the floor.
 * Draw calls (3): opaque InstancedMesh with the upright pillars of rings 0-1, drawn near -> far for early-Z; a
 * blended InstancedMesh with their reflections; one additive halo mesh (ring 0 + reflection + ghost rings).
 * Vertices (medium): (2 x 96 opaque + 2 x 96 reflected + up to 8 x 96 halo) x 24 = ~29k, the halo mostly culled
 * in the vertex shader while quiet.
 */
export class SpectrumCathedral implements Preset {
  readonly id = 'spectrum';
  readonly name = 'Spectrum Cathedral';
  readonly description = 'Rings of spectrum pillars rising around you';
  readonly group = new THREE.Group();

  private uniforms!: Record<string, THREE.IUniform>;
  private solidMat!: THREE.ShaderMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private disposables: { dispose(): void }[] = [];
  private time = 0;
  private beatWave = 3;
  private breath = 0; // bass follower 0..1

  init(ctx: PresetContext): void {
    const layout = LAYOUT[ctx.quality] ?? LAYOUT.medium;
    const { palette, textures } = ctx;

    this.uniforms = {
      ...textures.uniforms,
      uGradient: { value: palette.gradient },
      uAccent: { value: palette.accent },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uMid: { value: 0 },
      uBeat: { value: 0 },
      uBeatWave: { value: this.beatWave },
      uBreath: { value: 0 },
      uBrightness: { value: 1 },
      uOpacity: { value: 1 },
    };

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0); // grow from the floor

    const make = (spec: InstanceSpec[], mat: THREE.ShaderMaterial): THREE.InstancedMesh => {
      const geo = box.clone();
      const count = this.addInstances(geo, layout, spec);
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false; // placement happens entirely in the vertex shader
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.disposables.push(geo, mat, mesh);
      return mesh;
    };

    // Opaque pass: upright pillars of the solid rings, nearest ring first so early-Z rejects what is behind it.
    const solidSpec: InstanceSpec[] = [];
    for (let ring = 0; ring < SOLID_RINGS; ring++) solidSpec.push({ ring, mirror: 0 });
    this.solidMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: pillarVertex(layout, false),
      fragmentShader: solidFragment(false),
      transparent: false,
      depthWrite: true,
    });
    make(solidSpec, this.solidMat);

    // Reflection pass: far -> near so the blend composites back to front.
    const reflectSpec: InstanceSpec[] = [];
    for (let ring = SOLID_RINGS - 1; ring >= 0; ring--) reflectSpec.push({ ring, mirror: 1 });
    make(reflectSpec, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: pillarVertex(layout, false),
      fragmentShader: solidFragment(true),
      transparent: true,
      depthWrite: true,
    }));

    // Halo pass: the live ring (wider soft boxes, reflected) plus the ghost rings (no reflection), additive.
    const haloSpec: InstanceSpec[] = [{ ring: 0, mirror: 0 }, { ring: 0, mirror: 1 }, { ring: 0, mirror: 2 }];
    for (let ring = SOLID_RINGS; ring < layout.rings; ring++) haloSpec.push({ ring, mirror: 0 });
    const halo = make(haloSpec, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: pillarVertex(layout, true),
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    halo.renderOrder = 1;
    box.dispose();
  }

  /** Adds the per-instance `aData` attribute for the given blocks (in order) and returns the instance count. */
  private addInstances(geo: THREE.BufferGeometry, layout: CathedralLayout, spec: InstanceSpec[]): number {
    const total = layout.pillars * spec.length;
    const data = new Float32Array(total * 3);
    let o = 0;
    for (const { ring, mirror } of spec) {
      // Odd rings are staggered by half a pillar so history shows through the gaps of the ring in front.
      const offset = ring % 2 === 1 ? 0.5 : 0;
      for (let i = 0; i < layout.pillars; i++) {
        data[o++] = ((i + 0.5 + offset) / layout.pillars) % 1;
        data[o++] = ring;
        data[o++] = mirror;
      }
    }
    geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 3));
    return total;
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const u = this.uniforms;
    this.time += dt * p.speed;
    u.uTime.value = this.time;
    u.uIntensity.value = p.intensity;
    u.uMid.value = Math.min(1, f.mid);
    u.uBeat.value = f.beatEnv * Math.min(1, p.intensity);
    u.uBrightness.value = 0.6 + 0.4 * p.glow;
    if (f.beat) this.beatWave = 0;
    else if (this.beatWave < 3) this.beatWave += dt * WAVE_SPEED * p.speed;
    u.uBeatWave.value = this.beatWave;

    // Ring radius breathes with the bass: fast attack, slow release, so it swells on the kick and settles.
    const target = Math.min(1, f.bass * p.intensity);
    const tau = target > this.breath ? BREATH_ATTACK : BREATH_RELEASE;
    this.breath += (target - this.breath) * (1 - Math.exp(-dt / tau));
    u.uBreath.value = (this.breath * 2 - 1) * BREATH_M;
  }

  setOpacity(o: number): void {
    this.uniforms.uOpacity.value = o;
    // the pillar pass is fully opaque (no blending, early-Z) except while a crossfade is running
    this.solidMat.transparent = o < 0.999;
    this.solidMat.depthWrite = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.meshes.length = 0;
    this.group.clear();
  }
}
