import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const WIDTH = 60;
const DEPTH = 45;
const Z_CENTER = -4; // plane spans z = -26.5 .. +18.5: deeper ahead, still covered behind
const CEILING_Y = 9;
const BEAT_RING_MAX = 40; // metres
const BEAT_RING_SPEED = 15; // metres per second

const SEGMENTS: Record<string, [number, number]> = {
  low: [128, 96],
  medium: [256, 192],
  high: [320, 256],
};

/** Terrain constants shared by the vertex shader. Age 0 = newest spectrum row. */
const TERRAIN_GLSL = /* glsl */ `
#define HALF_W ${(WIDTH / 2).toFixed(1)}
#define Z_MIN (${(Z_CENTER - DEPTH / 2).toFixed(1)})
#define Z_MAX (${(Z_CENTER + DEPTH / 2).toFixed(1)})
#define Z_FRONT ${(DEPTH / 2 - Z_CENTER).toFixed(1)}
#define AGE_MAX 235.0
#define CEILING_Y ${CEILING_Y.toFixed(1)}
#define BEAT_RING_MAX ${BEAT_RING_MAX.toFixed(1)}
`;

/**
 * Terrain vertex stage. One geometry, two instances: the floor and the same landscape rotated 180° about the
 * z axis at y = CEILING_Y (rotation, not reflection, so winding stays correct and the mirrored x is invisible
 * because the landscape is symmetric in x). Heights are read from the GPU spectrogram: x -> frequency
 * (bass in the centre strip), distance from the user -> age, so the freshest audio sits near your feet and
 * flows outwards in front of and behind you.
 */
const TERRAIN_VERTEX = /* glsl */ `
${HISTORY_GLSL}
${TERRAIN_GLSL}
attribute float aCeil; // 0 = floor, 1 = ceiling
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

float terrainH(vec2 xz) {
  float d = abs(xz.y); // user stands at z = 0
  float age = AGE_MAX * pow(clamp(d / Z_FRONT, 0.0, 1.0), 0.85);
  float u = pow(clamp(abs(xz.x) / HALF_W, 0.0, 1.0), 0.6) * 0.94 + 0.01; // mirrored: bass in the centre, treble at the edges
  float e = clamp(histFreq(u, age) * (0.85 + 0.6 * u), 0.0, 1.25);
  float r = length(xz);
  float dip = smoothstep(2.5, 7.0, r); // flat ground under the feet
  float front = mix(0.65, 1.0, 1.0 - smoothstep(-8.0, 3.0, xz.y)); // strongest ahead (-Z)
  float mask = edgeMask(xz);
  float h = pow(e, 1.5) * 4.0 * uIntensity * front * dip * mask;
  // swell travelling across the ground on every beat
  float swell = exp(-pow((r - uBeatRing) / 1.4, 2.0)) * (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0));
  return h + swell * uBeatAmp * 0.7 * smoothstep(1.0, 3.0, r) * mask;
}

void main() {
  vec2 xz = position.xz;
  const float EPS = 0.25;
  float h0 = terrainH(xz);
  float hx = terrainH(xz + vec2(EPS, 0.0));
  float hz = terrainH(xz + vec2(0.0, EPS));
  vec3 n = normalize(vec3(-(hx - h0) / EPS, 1.0, -(hz - h0) / EPS));

  float sgn = 1.0 - 2.0 * aCeil;
  vec3 p = vec3(xz.x * sgn, mix(h0, CEILING_Y - h0, aCeil), xz.y);
  vNormal = mat3(modelMatrix) * vec3(n.x * sgn, n.y * sgn, n.z);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vPlane = xz;
  vH = h0;
  vCeil = aCeil;
  vMask = edgeMask(xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Dark solid fill + anti-aliased procedural grid + faint contour lines + beat ring, all in one pass. */
const TERRAIN_FRAGMENT = /* glsl */ `
${TERRAIN_GLSL}
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeatRing;
uniform float uLevel;
uniform float uBeat;
uniform vec3 uAccent;

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

  float g = clamp(vH * 0.22 + 0.06, 0.0, 1.0);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;

  // Solid pass: gradient(height) * 0.35 with a little directional shading so slopes read.
  vec3 L = normalize(vec3(0.3, 0.75 * (1.0 - 2.0 * vCeil), -0.6));
  float lam = max(dot(N, L), 0.0);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  vec3 col = grad * 0.35 * (0.45 + 0.8 * lam) + grad * rim * 0.12;

  // Grid pass: 1.25 m cells, constant-z lines slightly brighter, faded out before they alias.
  vec2 gp = vPlane / 1.25;
  vec2 gw = fwidth(gp);
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-4));
  vec2 gl = (1.0 - smoothstep(0.5, 1.5, gd)) * (1.0 - smoothstep(0.22, 0.55, gw));
  float lines = max(gl.x * 0.7, gl.y);
  vec3 lineCol = texture2D(uGradient, vec2(clamp(g + 0.3, 0.0, 1.0), 0.5)).rgb;
  col += lineCol * lines * (0.9 + 1.4 * smoothstep(0.1, 2.5, vH));

  // Topographic contour lines every 0.4 m of height.
  float ch = vH * 2.5;
  float cw = fwidth(ch);
  float contour = (1.0 - smoothstep(0.0, cw * 1.5 + 0.02, min(fract(ch), 1.0 - fract(ch)))) * (1.0 - smoothstep(0.3, 0.8, cw)) * smoothstep(0.15, 0.6, vH);
  col += lineCol * contour * 0.28;

  // Beat ring racing across the ground from the user's position.
  float r = length(vWorld.xz);
  float ringI = exp(-pow((r - uBeatRing) / 0.5, 2.0)) * (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0));
  col += mix(uAccent, vec3(1.0), 0.35) * ringI * (0.35 + 1.8 * lines + 0.6 * contour);

  col *= exp(-pow(dist * 0.038, 2.0)) * mix(1.0, 0.5, vCeil) * uBrightness * (0.85 + 0.3 * uLevel) * (1.0 + uBeat * 0.2);

  gl_FragColor = vec4(col, uOpacity * pow(vMask, 0.6));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Horizon glow: a cylinder at the edge of the terrain whose floor and ceiling rims pulse with the live spectrum all around you. */
const HORIZON_VERTEX = /* glsl */ `
${HISTORY_GLSL}
varying float vEnergy;
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float phi = abs(atan(wp.x, -wp.z)) / 3.14159265; // 0 ahead, 1 behind
  float u = pow(phi, 0.8) * 0.94 + 0.01;
  vEnergy = clamp(max(histFreq(u, 0.0), histFreq(u, 5.0)) * (0.85 + 0.6 * u), 0.0, 1.2);
  vY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HORIZON_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
varying float vEnergy;
varying float vY;
void main() {
  float rim = exp(-vY * 0.45) + exp(-(${CEILING_Y.toFixed(1)} - vY) * 0.45);
  vec3 col = texture2D(uGradient, vec2(0.4 + 0.45 * vEnergy, 0.5)).rgb * rim * (0.05 + 0.5 * vEnergy);
  gl_FragColor = vec4(col * uBrightness * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A spectrogram landscape that encloses the listener: floor and (inverted) ceiling are the same displaced
 * grid drawn as one InstancedMesh, plus a thin horizon-glow cylinder. 2 draw calls.
 * Vertices (medium): 2 x 257 x 193 = ~99k.
 */
export class SpectralTerrain implements Preset {
  readonly id = 'terrain';
  readonly name = 'Spectral Terrain';
  readonly description = 'A landscape sculpted by the spectrogram';
  readonly group = new THREE.Group();

  private uniforms!: Record<string, THREE.IUniform>;
  private disposables: { dispose(): void }[] = [];
  private beatRing = 999;

  init(ctx: PresetContext): void {
    const { palette, textures } = ctx;
    const [sx, sz] = SEGMENTS[ctx.quality] ?? SEGMENTS.medium;

    this.uniforms = {
      ...textures.uniforms,
      uGradient: { value: palette.gradient },
      uAccent: { value: palette.accent },
      uIntensity: { value: 1 },
      uBrightness: { value: 1 },
      uLevel: { value: 0 },
      uBeat: { value: 0 },
      uBeatRing: { value: this.beatRing },
      uBeatAmp: { value: 1 },
      uOpacity: { value: 1 },
    };

    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, sx, sz);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, Z_CENTER);
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

    const horizonGeo = new THREE.CylinderGeometry(40, 40, CEILING_Y, 128, 1, true);
    horizonGeo.translate(0, CEILING_Y / 2, 0);
    const horizonMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: HORIZON_VERTEX,
      fragmentShader: HORIZON_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const horizon = new THREE.Mesh(horizonGeo, horizonMat);
    horizon.frustumCulled = false;
    horizon.renderOrder = -1; // behind the terrain, so the (alpha-faded) terrain edges blend over it

    this.group.add(horizon, terrain);
    this.disposables.push(geo, mat, horizonGeo, horizonMat);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const u = this.uniforms;
    u.uIntensity.value = p.intensity;
    u.uBrightness.value = 0.6 + 0.4 * p.glow;
    u.uLevel.value = Math.min(1, f.level);
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
