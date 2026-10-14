import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const WIDTH = 60;
const DEPTH = 45;
const Z_CENTER = -4; // plane spans z = -26.5 .. +18.5: deeper ahead, still covered behind
const CEILING_Y = 12;
const FLOOR_LIFT = 0.03; // keeps the flat zone above the shared environment floor (y = 0)
const BEAT_RING_MAX = 40; // metres
const BEAT_RING_SPEED = 16; // metres per second
const SKY_RADIUS = 80; // sun / haze cylinder
const SKY_HEIGHT = 30; // tall enough that the sun's glow is never clipped by the cylinder rim
const SUN_Y = 8.5;
const SUN_RADIUS = 9;

const SEGMENTS: Record<string, [number, number]> = {
  low: [128, 96],
  medium: [256, 192],
  high: [320, 256],
};

/** Terrain constants shared by the shaders. Age 0 = newest spectrum row. */
const TERRAIN_GLSL = /* glsl */ `
#define HALF_W ${(WIDTH / 2).toFixed(1)}
#define Z_MIN (${(Z_CENTER - DEPTH / 2).toFixed(1)})
#define Z_MAX (${(Z_CENTER + DEPTH / 2).toFixed(1)})
#define Z_FRONT ${(DEPTH / 2 - Z_CENTER).toFixed(1)}
#define AGE_MAX 230.0
#define CEILING_Y ${CEILING_Y.toFixed(1)}
#define BEAT_RING_MAX ${BEAT_RING_MAX.toFixed(1)}
`;

/**
 * Terrain vertex stage. One geometry, two instances: the floor and the same landscape rotated 180° about the
 * z axis at y = CEILING_Y (rotation, not reflection, so winding stays correct and the mirrored x is invisible
 * because the landscape is symmetric in x). Heights come from the GPU spectrogram: x -> frequency (bass in the
 * centre strip), distance from the user -> age, so the freshest audio sits near your feet and flows outwards
 * in front of and behind you. A 5-tap blur across frequency and time keeps it rolling instead of spiky.
 */
const TERRAIN_VERTEX = /* glsl */ `
${HISTORY_GLSL}
${TERRAIN_GLSL}
attribute float aCeil; // 0 = floor, 1 = ceiling
uniform float uTime;
uniform float uIntensity;
uniform float uBeatRing;
uniform float uBeatAmp;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vPlane;
varying float vH;
varying float vCeil;
varying float vMask;

// 1 inside the plane, fading to 0 toward its borders
float edgeMask(vec2 xz) {
  float ex = 1.0 - smoothstep(0.62, 1.0, abs(xz.x) / HALF_W);
  float ez = smoothstep(0.0, 9.0, min(xz.y - Z_MIN, Z_MAX - xz.y));
  return ex * ez;
}

float spectrum(float u, float age) {
  return histFreq(clamp(u, 0.0, 1.0), clamp(age, 0.0, 250.0));
}

float terrainH(vec2 xz) {
  float f = clamp(abs(xz.y) / Z_FRONT, 0.0, 1.0); // user stands at z = 0
  float age = AGE_MAX * pow(f, 0.85);
  float u = pow(clamp(abs(xz.x) / HALF_W, 0.0, 1.0), 0.6) * 0.94 + 0.01; // mirrored: bass in the centre, treble at the edges
  float du = 0.035;
  float da = 2.0 + 0.04 * age;
  float e = 0.4 * spectrum(u, age)
          + 0.15 * (spectrum(u - du, age) + spectrum(u + du, age) + spectrum(u, age - da) + spectrum(u, age + da));
  e = clamp(e * (0.85 + 0.6 * u), 0.0, 1.3);

  float r = length(xz);
  float taper = smoothstep(2.5, 12.0, r); // flat under the feet, nothing towers over the head
  float front = mix(0.65, 1.0, 1.0 - smoothstep(-8.0, 3.0, xz.y)); // strongest ahead (-Z)
  float mask = edgeMask(xz);

  // slow undulation so there is landscape even in quiet passages
  float roll = sin(xz.x * 0.16 + uTime * 0.10) * sin(xz.y * 0.12 - uTime * 0.08) * 0.65
             + sin(xz.x * 0.07 + xz.y * 0.10 + uTime * 0.06) * 0.35;
  float h = pow(e, 1.6) * 4.0 * uIntensity * front + 0.6 + 0.6 * roll;

  // swell travelling across the ground on every beat
  float sw = (r - uBeatRing) / 1.8;
  float swell = exp(-sw * sw) * (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0));
  h += swell * uBeatAmp * 0.8;
  return h * taper * mask;
}

void main() {
  vec2 xz = position.xz;
  const float EPS = 0.3;
  float h0 = terrainH(xz);
  float hx = terrainH(xz + vec2(EPS, 0.0));
  float hz = terrainH(xz + vec2(0.0, EPS));
  vec3 n = normalize(vec3(-(hx - h0) / EPS, 1.0, -(hz - h0) / EPS));

  float sgn = 1.0 - 2.0 * aCeil;
  float lift = position.y;
  vec3 p = vec3(xz.x * sgn, mix(h0 + lift, CEILING_Y - h0 - lift, aCeil), xz.y);
  vNormal = mat3(modelMatrix) * vec3(n.x * sgn, n.y * sgn, n.z);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vPlane = xz;
  vH = h0;
  vCeil = aCeil;
  vMask = edgeMask(xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Solid shaded fill + anti-aliased procedural grid + beat ring, one pass, fogged into the background. */
const TERRAIN_FRAGMENT = /* glsl */ `
${TERRAIN_GLSL}
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeatRing;
uniform float uLevel;
uniform float uBeat;
uniform vec3 uAccent;
uniform vec3 uBackground;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vPlane;
varying float vH;
varying float vCeil;
varying float vMask;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(vWorld - cameraPosition);
  float flip = 1.0 - 2.0 * vCeil;

  // Solid pass: gradient by height (dark base -> bright peaks) lit by a fixed key light + hemisphere fill.
  float g = clamp(0.05 + vH * 0.2, 0.0, 1.0);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;
  vec3 gradHi = texture2D(uGradient, vec2(clamp(0.35 + vH * 0.2, 0.0, 1.0), 0.5)).rgb;
  vec3 L = normalize(vec3(-0.4, 0.6 * flip, -0.7));
  float lam = clamp(dot(N, L), 0.0, 1.0);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 col = grad * 0.35 * (0.3 + 1.1 * lam + 0.3 * (0.5 + 0.5 * N.y * flip));
  col += gradHi * pow(1.0 - ndv, 3.0) * 0.22 * smoothstep(0.1, 1.2, vH); // rim on the ridges
  col += gradHi * smoothstep(1.5, 4.0, vH) * 0.3;                        // glowing peaks

  // Grid pass: 1 m cells, anti-aliased with fwidth, brighter on peaks and near rows, gone before it aliases.
  vec2 gp = vPlane;
  vec2 gw = fwidth(gp);
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-4)); // pixels to the nearest line
  vec2 gl = (1.0 - smoothstep(0.5, 1.5, gd)) * (1.0 - smoothstep(0.22, 0.55, gw));
  float lines = max(gl.x * 0.7, gl.y);
  float gain = (0.5 + 1.6 * smoothstep(0.0, 3.0, vH)) * (1.0 + 0.9 * exp(-dist / 14.0));
  col += gradHi * lines * gain;

  // Beat ring racing across the ground from the user's position.
  float r = length(vWorld.xz);
  float rd = (r - uBeatRing) / 0.3;
  float ringI = exp(-rd * rd) * (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0)) * smoothstep(1.0, 4.0, uBeatRing);
  col += mix(uAccent, gradHi, 0.5) * ringI * (0.8 + 1.5 * lines);

  col *= mix(1.0, 0.3, vCeil) * uBrightness * (0.85 + 0.3 * uLevel) * (1.0 + uBeat * 0.2);

  // exp fog into the background beyond ~20 m, so the far hills dissolve
  float fog = 1.0 - exp(-pow(max(dist - 20.0, 0.0) * 0.045, 2.0));
  col = mix(col, uBackground, fog);

  gl_FragColor = vec4(col, uOpacity * pow(vMask, 0.6));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Distant sky cylinder: a faint horizon haze (additive, <= 0.15, gone above ~3 m) that follows the live spectrum
 * all around, and a synthwave sun straight ahead (-Z) with a vertical accent -> primary gradient and scanline bands.
 */
const SKY_VERTEX = /* glsl */ `
${HISTORY_GLSL}
varying vec3 vPos;
varying float vEnergy;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float phi = abs(atan(wp.x, -wp.z)) / 3.14159265; // 0 ahead, 1 behind
  float u = pow(phi, 0.8) * 0.94 + 0.01;
  vEnergy = clamp(max(histFreq(u, 0.0), histFreq(u, 6.0)) * (0.85 + 0.6 * u), 0.0, 1.2);
  vPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uBass;
uniform float uOpacity;
uniform float uBrightness;
varying vec3 vPos;
varying float vEnergy;
void main() {
  // horizon haze
  vec3 col = uPrimary * exp(-vPos.y * 0.9) * (0.05 + 0.1 * vEnergy);

  // sun
  float pulse = 1.0 + 0.05 * uBass;
  vec2 p = vec2(vPos.x, vPos.y - ${SUN_Y.toFixed(1)}) / (${SUN_RADIUS.toFixed(1)} * pulse);
  float dd = length(p);
  float disc = (1.0 - smoothstep(0.96, 1.0, dd)) * step(vPos.z, 0.0);
  float yy = clamp(0.5 - p.y * 0.5, 0.0, 1.0); // 0 at the top .. 1 at the bottom
  float thick = smoothstep(0.38, 0.95, yy) * 0.7; // dark bands thicken toward the bottom
  float stripe = mix(1.0, smoothstep(thick - 0.04, thick + 0.04, fract(yy * 9.0)), step(0.01, thick));
  vec3 sunCol = mix(uPrimary, uAccent, smoothstep(0.15, 1.0, p.y * 0.5 + 0.5));
  col += sunCol * disc * stripe * (0.75 + 0.45 * uBass);
  col += uPrimary * exp(-max(dd - 1.0, 0.0) * 2.2) * 0.12 * step(vPos.z, 0.0) * (1.0 - disc) * (1.0 - smoothstep(1.0, 2.6, dd));

  gl_FragColor = vec4(col * uBrightness * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A spectrogram landscape that encloses the listener: floor and (inverted) ceiling are the same displaced
 * grid drawn as one InstancedMesh, plus one sky cylinder (haze + sun). 2 draw calls.
 * Vertices (medium): 2 x 257 x 193 = ~99k for the terrain.
 */
export class SpectralTerrain implements Preset {
  readonly id = 'terrain';
  readonly name = 'Spectral Terrain';
  readonly description = 'A landscape sculpted by the spectrogram';
  readonly group = new THREE.Group();

  private uniforms!: Record<string, THREE.IUniform>;
  private disposables: { dispose(): void }[] = [];
  private beatRing = 999;
  private time = 0;

  init(ctx: PresetContext): void {
    const { palette, textures } = ctx;
    const [sx, sz] = SEGMENTS[ctx.quality] ?? SEGMENTS.medium;

    this.uniforms = {
      ...textures.uniforms,
      uGradient: { value: palette.gradient },
      uAccent: { value: palette.accent },
      uPrimary: { value: palette.primary },
      uBackground: { value: palette.background },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uBrightness: { value: 1 },
      uLevel: { value: 0 },
      uBass: { value: 0 },
      uBeat: { value: 0 },
      uBeatRing: { value: this.beatRing },
      uBeatAmp: { value: 1 },
      uOpacity: { value: 1 },
    };

    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, sx, sz);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, FLOOR_LIFT, Z_CENTER);
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    geo.setAttribute('aCeil', new THREE.InstancedBufferAttribute(new Float32Array([0, 1]), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      transparent: true,
      depthWrite: true,
    });
    const terrain = new THREE.InstancedMesh(geo, mat, 2);
    terrain.frustumCulled = false; // displaced in the vertex shader

    const skyGeo = new THREE.CylinderGeometry(SKY_RADIUS, SKY_RADIUS, SKY_HEIGHT, 128, 1, true);
    skyGeo.translate(0, SKY_HEIGHT / 2, 0);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1; // behind the terrain, so the (alpha-faded) terrain edges blend over it

    this.group.add(sky, terrain);
    this.disposables.push(geo, mat, terrain, skyGeo, skyMat);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const u = this.uniforms;
    this.time += dt * p.speed;
    u.uTime.value = this.time;
    u.uIntensity.value = p.intensity;
    u.uBrightness.value = 0.6 + 0.4 * p.glow;
    u.uLevel.value = Math.min(1, f.level);
    u.uBass.value = Math.min(1, f.bass * p.intensity);
    u.uBeat.value = f.beatEnv * Math.min(1, p.intensity);
    u.uBeatAmp.value = Math.min(1.5, p.intensity);
    if (f.beat) this.beatRing = 0.5;
    else if (this.beatRing < BEAT_RING_MAX) this.beatRing += dt * BEAT_RING_SPEED * p.speed;
    u.uBeatRing.value = this.beatRing;
  }

  setOpacity(o: number): void {
    this.uniforms.uOpacity.value = o;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }
}
