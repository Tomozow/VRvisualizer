import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

/** Frames between neighbouring history rings (≈83 ms at 72 Hz): the spectrum "echoes" outwards. */
const HISTORY_STEP = 6;
const WAVE_SPEED = 1.25; // beat-wave phase units per second
const WAVE_HEIGHT = 10; // metres the beat wave travels over one phase unit

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
 */
function pillarVertex(layout: CathedralLayout, halo: boolean): string {
  return /* glsl */ `
${HISTORY_GLSL}
#define PILLARS ${layout.pillars.toFixed(1)}
#define RING_MAX ${(layout.rings - 1).toFixed(1)}
#define HIST_STEP ${HISTORY_STEP.toFixed(1)}
#define HALO ${halo ? 1 : 0}
const float TAU = 6.28318530718;

attribute vec4 aData; // x: angle (0 = ahead, -Z), y: ring, z: mirror, w: random
uniform float uTime;
uniform float uIntensity;
uniform float uMid;

varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
varying float vLocalY;
varying float vEnergy;
varying float vRing;
varying float vMirror;
varying float vRand;

void main() {
  float ring = aData.y;
  float mirror = aData.z;
  float a = aData.x;

  // Mirrored band mapping: bass straight ahead, treble behind, symmetric left/right.
  float phi = min(a, 1.0 - a) * 2.0;
  float u = pow(phi, 0.8) * 0.94 + 0.01;
  float e = histFreq(u, ring * HIST_STEP);
  e = clamp(e * (0.85 + 0.6 * u), 0.0, 1.25); // gentle tilt so the highs stay lively
  float h = min(0.2 + pow(e, 1.4) * 6.0 * uIntensity * (1.0 + 0.1 * ring), 16.0);

  float radius = 4.5 + 9.5 * pow(ring / RING_MAX, 0.85);
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

  // Colour follows height (hot at the tips); history rings drift toward the cool end of the gradient.
  float g = clamp(0.3 + y * 0.07 + vEnergy * 0.28 - vRing * 0.02, 0.0, 0.9);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;
  vec3 hot = mix(texture2D(uGradient, vec2(min(g + 0.22, 1.0), 0.5)).rgb, vec3(1.0), 0.3);

  // Dark glass body that brightens toward the top of each pillar.
  float up = pow(vLocalY, 1.3);
  vec3 col = grad * (0.2 + 0.55 * up) * (0.55 + 0.45 * ndv);

  // Luminous vertical edges.
  float edge = 1.0 - smoothstep(0.0, 0.11, min(vUv.x, 1.0 - vUv.x));
  col += grad * edge * (0.25 + 0.9 * up);

  // LED rows every 25 cm, faded out when they would alias.
  float yy = y * 4.0;
  float fw = fwidth(yy);
  float row = (1.0 - smoothstep(0.0, 0.10 + fw, abs(fract(yy + 0.5) - 0.5))) * (1.0 - smoothstep(0.3, 0.7, fw));
  col += grad * row * (0.10 + 0.35 * vEnergy);

  // Hot cap on every pillar tip.
  float cap = smoothstep(0.93, 1.0, vLocalY);
  col += hot * cap * (0.6 + 1.6 * vEnergy);

  // Fresnel rim.
  col += grad * pow(1.0 - ndv, 3.0) * 0.35;

  // Beat wave climbing the pillars, delayed on the outer rings.
  float ph = uBeatWave - vRing * 0.07;
  float wy = ph * ${WAVE_HEIGHT.toFixed(1)};
  float wd = (y - wy) / 0.3;
  float wave = exp(-wd * wd) * (1.0 - smoothstep(0.45, 1.1, ph)) * step(0.0, ph) / (1.0 + vRing * 0.8);
  col += mix(texture2D(uGradient, vec2(0.8, 0.5)).rgb, uAccent, 0.25) * wave * 0.9;

  // Rings further out are dimmer and dissolve into the dark with distance.
  float fade = exp(-pow(dist * 0.045, 2.0)) / (1.0 + 0.4 * vRing);
  col *= fade * uBrightness * (1.0 + uBeat * 0.2);

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
varying float vEnergy;
varying float vRing;
varying float vMirror;
varying float vRand;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = abs(dot(N, V));
  float y = abs(vWorld.y);

  // Soft vertical band: bright at the centre of each face, zero at the box edges, strongest near the tip.
  float fx = 1.0 - abs(vUv.x * 2.0 - 1.0);
  fx *= fx;
  float amt = fx * ndv * pow(vLocalY, 2.2) * smoothstep(0.12, 0.85, vEnergy);

  float g = clamp(y * 0.115 + vEnergy * 0.28 + 0.1, 0.0, 1.0);
  vec3 col = texture2D(uGradient, vec2(g, 0.5)).rgb * amt * 1.4 * uBrightness * (1.0 + uBeat * 0.35);
  col *= mix(1.0, 0.3 * exp(-y * 0.5), vMirror) * uOpacity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A cylindrical cathedral of spectrum pillars: the live spectrum on the inner ring, six history rings
 * behind it so the spectrum appears to ripple outwards, everything reflected in the floor.
 * Draw calls: 1 solid InstancedMesh (pillars + reflections of every ring) + 1 additive halo mesh.
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
      uBrightness: { value: 1 },
      uOpacity: { value: 1 },
    };

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0); // grow from the floor

    // Solid pass: rings far -> near so alpha-blended crossfades composite back to front.
    const solidGeo = box.clone();
    const solidCount = this.addInstances(solidGeo, layout, layout.rings - 1, 0);
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

    // Halo pass: live ring only, wider soft boxes, additive.
    const haloGeo = box.clone();
    const haloCount = this.addInstances(haloGeo, layout, 0, 0);
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
      this.disposables.push(m.geometry, m.material as THREE.Material);
    }
    halo.renderOrder = 1;
  }

  /** Adds the per-instance `aData` attribute for rings [from .. to] (iterating from -> to) and returns the instance count. */
  private addInstances(geo: THREE.BufferGeometry, layout: CathedralLayout, fromRing: number, toRing: number): number {
    const step = fromRing >= toRing ? -1 : 1;
    const ringCount = Math.abs(fromRing - toRing) + 1;
    const total = ringCount * layout.pillars * 2;
    const data = new Float32Array(total * 4);
    let o = 0;
    for (let k = 0, ring = fromRing; k < ringCount; k++, ring += step) {
      // Odd rings are staggered by half a pillar so history shows through the gaps of the ring in front.
      const offset = ring % 2 === 1 ? 0.5 : 0;
      for (let i = 0; i < layout.pillars; i++) {
        const a = ((i + 0.5 + offset) / layout.pillars) % 1;
        const rnd = (Math.sin(i * 12.9898 + ring * 78.233) * 43758.5453) % 1;
        for (let mirror = 0; mirror < 2; mirror++) {
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
