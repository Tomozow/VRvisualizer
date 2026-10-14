import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

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
 * Every pillar is a unit box scaled/placed here; per-instance data = (angle 0..1, ring, mirror flag, random).
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

attribute vec4 aData; // x: angle (0 = ahead, -Z), y: ring, z: mirror, w: random
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
varying float vRand;

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
  for (int j = 0; j < 13; j++) raw[j] = histFreq(u, age0 + float(j));
  float h = 1e4;
  float e = 0.0;
  for (int k = 0; k < 6; k++) {
    int j = 2 * k;
    float ek = clamp((raw[j] + raw[j + 1] + raw[j + 2]) * (1.0 / 3.0) * gain, 0.0, 1.25);
    float hk = 0.2 + pow(ek, 1.4) * 6.0 * uIntensity * (1.0 + 0.1 * ring);
    hk = hMax * tanh(hk / hMax);
    h = min(h, hk + RISE_PER_ROW * float(j));
    if (k == 0) e = ek;
  }

  float radius = 4.5 + 9.5 * pow(ring / RING_MAX, 0.85) + uBreath;
  float sway = sin(uTime * 0.7 + a * 31.4 + ring * 1.9);
  float lean = sway * (0.012 + 0.05 * uMid);
  float theta = (a + 0.004 * sin(uTime * 0.23 + ring * 1.3) * (1.0 + 4.0 * uMid)) * TAU;

  float w = TAU * radius / PILLARS * 0.4;
  float d = w * 0.8;
  float hh = h;
  #if HALO
    w *= 3.6; d *= 3.6; hh += 0.4;
  #endif

  float sgn = 1.0 - 2.0 * mirror;
  vec3 R = vec3(sin(theta), 0.0, -cos(theta));
  vec3 T = vec3(cos(theta), 0.0, sin(theta));
  float y = position.y * hh * sgn;
  vec3 p = R * (radius - position.z * d) + T * (position.x * w * sgn + lean * y) + vec3(0.0, y, 0.0);
  vec3 n = T * (normal.x * sgn) + vec3(0.0, normal.y * sgn, 0.0) - R * normal.z;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(modelMatrix) * n;
  vUv = uv;
  vLocalY = position.y;
  vTip = (1.0 - position.y) * hh;
  vEnergy = e;
  vRing = ring;
  vMirror = mirror;
  vRand = aData.w;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
}

const SOLID_FRAGMENT = /* glsl */ `
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
varying float vMirror;
varying float vRand;

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
  float up = pow(vLocalY, 1.3);
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

  // Fresnel rim.
  col += grad * pow(1.0 - ndv, 3.0) * 0.35;

  // Beat wave climbing the pillars, delayed on the outer rings.
  float ph = uBeatWave - vRing * 0.07;
  float wy = ph * ${WAVE_HEIGHT.toFixed(1)};
  float wd = (y - wy) / 0.3;
  float wave = exp(-wd * wd) * (1.0 - smoothstep(0.45, 1.1, ph)) * step(0.0, ph) / (1.0 + vRing * 0.8);
  col += mix(texture2D(uGradient, vec2(0.7, 0.5)).rgb, uAccent, 0.25) * wave * 0.55;

  // Rings further out are dimmer and dissolve into the dark with distance.
  float fade = exp(-pow(dist * 0.045, 2.0)) / (1.0 + 0.4 * vRing);
  col *= fade * 0.7 * uBrightness * (1.0 + uBeat * 0.3);
  // keep the brightest channel under 0.85 so lit tips stay saturated instead of blowing out to white
  col *= min(1.0, 0.85 / max(max(col.r, col.g), max(col.b, 1e-4)));

  float mirrorFade = mix(1.0, 0.3 * exp(-y * 0.6), vMirror);
  gl_FragColor = vec4(col, uOpacity * mirrorFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const HALO_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeat;

varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
varying float vLocalY;
varying float vTip;
varying float vEnergy;
varying float vRing;
varying float vMirror;
varying float vRand;

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
  float amt = fx * ndv * pow(vLocalY, mix(2.2, 1.3, ghostRing)) * smoothstep(0.2, 0.9, vEnergy);

  float g = clamp(0.18 + y * 0.05 + vEnergy * 0.30 - vRing * 0.06, 0.0, 0.82);
  vec3 col = texture2D(uGradient, vec2(g, 0.5)).rgb * amt * alpha * 1.0 * uBrightness * (1.0 + uBeat * 0.35);
  col *= mix(1.0, 0.3 * exp(-y * 0.5), vMirror) * uOpacity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Instance spec: which rings to emit and whether each gets its floor reflection too. */
interface InstanceSpec {
  ring: number;
  mirror: boolean;
}

/**
 * A cylindrical cathedral of spectrum pillars: the live spectrum on the two inner rings as solid glass, the
 * deeper history rings as faint halo ghosts so the spectrum ripples outwards into the dark, the front rings
 * reflected in the floor.
 * Draw calls: 1 solid InstancedMesh (rings 0-1 + reflections) + 1 additive halo mesh (ring 0 + ghost rings).
 * Vertices (medium): (4 x 96 solid + 2 x 96 + 5 x 96 halo) x 24 = ~25k.
 */
export class SpectrumCathedral implements Preset {
  readonly id = 'spectrum';
  readonly name = 'Spectrum Cathedral';
  readonly description = 'Rings of spectrum pillars rising around you';
  readonly group = new THREE.Group();

  private uniforms!: Record<string, THREE.IUniform>;
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

    // Solid pass: inner rings only, far -> near so alpha-blended crossfades composite back to front.
    const solidSpec: InstanceSpec[] = [];
    for (let ring = SOLID_RINGS - 1; ring >= 0; ring--) solidSpec.push({ ring, mirror: true });
    const solidGeo = box.clone();
    const solidCount = this.addInstances(solidGeo, layout, solidSpec);
    const solid = new THREE.InstancedMesh(
      solidGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: pillarVertex(layout, false),
        fragmentShader: SOLID_FRAGMENT,
        transparent: true,
        depthWrite: true,
      }),
      solidCount,
    );

    // Halo pass: the live ring (wider soft boxes, reflected) plus the ghost rings (no reflection), additive.
    const haloSpec: InstanceSpec[] = [{ ring: 0, mirror: true }];
    for (let ring = SOLID_RINGS; ring < layout.rings; ring++) haloSpec.push({ ring, mirror: false });
    const haloGeo = box.clone();
    const haloCount = this.addInstances(haloGeo, layout, haloSpec);
    const halo = new THREE.InstancedMesh(
      haloGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: pillarVertex(layout, true),
        fragmentShader: HALO_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      haloCount,
    );
    box.dispose();

    for (const m of [solid, halo]) {
      m.frustumCulled = false; // placement happens entirely in the vertex shader
      this.group.add(m);
      this.meshes.push(m);
      this.disposables.push(m.geometry, m.material as THREE.Material, m);
    }
    halo.renderOrder = 1;
  }

  /** Adds the per-instance `aData` attribute for the given rings (in order) and returns the instance count. */
  private addInstances(geo: THREE.BufferGeometry, layout: CathedralLayout, spec: InstanceSpec[]): number {
    let total = 0;
    for (const s of spec) total += layout.pillars * (s.mirror ? 2 : 1);
    const data = new Float32Array(total * 4);
    let o = 0;
    for (const { ring, mirror: withMirror } of spec) {
      // Odd rings are staggered by half a pillar so history shows through the gaps of the ring in front.
      const offset = ring % 2 === 1 ? 0.5 : 0;
      for (let i = 0; i < layout.pillars; i++) {
        const a = ((i + 0.5 + offset) / layout.pillars) % 1;
        const rnd = (Math.sin(i * 12.9898 + ring * 78.233) * 43758.5453) % 1;
        for (let mirror = 0; mirror < (withMirror ? 2 : 1); mirror++) {
          data[o++] = a;
          data[o++] = ring;
          data[o++] = mirror;
          data[o++] = Math.abs(rnd);
        }
      }
    }
    geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
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
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.meshes.length = 0;
    this.group.clear();
  }
}
