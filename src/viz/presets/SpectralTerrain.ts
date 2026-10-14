import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const WIDTH = 60;
const DEPTH = 73.5;
const Z_CENTER = -18.25; // plane spans z = -55 .. +18.5: deep ahead (hills fade into the fog under the sun), still covered behind
const CEILING_Y = 20;
const FLOOR_LIFT = 0.03; // keeps the flat zone above the shared environment floor (y = 0)
const BEAT_RING_MAX = 50; // metres
const BEAT_RING_SPEED = 16; // metres per second
const SKY_RADIUS = 80; // sun / haze cylinder
const SKY_HEIGHT = 46; // tall enough that the sun's glow is never clipped by the cylinder rim
const SUN_Y = 17; // high enough that the striped lower third (y 6..13 m) clears the far ridge line (~5 m at 80 m)
const SUN_RADIUS = 11;

const SEGMENTS: Record<string, [number, number]> = {
  low: [96, 144],
  medium: [192, 288],
  high: [256, 384],
};

/** Terrain constants shared by the shaders. Age 0 = newest spectrum row. */
const TERRAIN_GLSL = /* glsl */ `
#define HALF_W ${(WIDTH / 2).toFixed(1)}
#define Z_MIN (${(Z_CENTER - DEPTH / 2).toFixed(1)})
#define Z_MAX (${(Z_CENTER + DEPTH / 2).toFixed(1)})
#define Z_FRONT ${(DEPTH / 2 - Z_CENTER).toFixed(1)}
#define AGE_MAX 90.0
#define CEILING_Y ${CEILING_Y.toFixed(1)}
#define BEAT_RING_MAX ${BEAT_RING_MAX.toFixed(1)}
`;

/**
 * Terrain vertex stage. One geometry, two instances: the floor and the same landscape rotated 180° about the
 * z axis at y = CEILING_Y (rotation, not reflection, so winding stays correct and the mirrored x is invisible
 * because the landscape is symmetric in x). Heights come from the GPU spectrogram: x -> frequency (bass in the
 * centre strip), distance from the user -> age, so the freshest audio sits near your feet (age 90 rows = 1.25 s
 * at the far end) and flows outwards in front of and behind you. A 5-tap blur across frequency and time keeps it
 * rolling instead of spiky; the blur widens and the amplitude fades with distance so far rows never alias.
 */
const TERRAIN_VERTEX = /* glsl */ `
${HISTORY_GLSL}
${TERRAIN_GLSL}
attribute float aCeil; // 0 = floor, 1 = ceiling
uniform float uTime;
uniform float uIntensity;
uniform float uBass;
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
  float ez = smoothstep(0.0, 12.0, min(xz.y - Z_MIN, Z_MAX - xz.y));
  return ex * ez;
}

float spectrum(float u, float age) {
  return histFreq(clamp(u, 0.0, 1.0), clamp(age, 0.0, 250.0));
}

float terrainH(vec2 xz) {
  float f = clamp(abs(xz.y) / Z_FRONT, 0.0, 1.0); // user stands at z = 0
  float r = length(xz);
  float age = AGE_MAX * pow(f, 0.8); // fresh audio near the user
  float ax = sqrt(xz.x * xz.x + 4.0) - 2.0; // rounded |x|: no sharp crest along the centre line
  float u = pow(clamp(ax / (HALF_W - 2.0), 0.0, 1.0), 0.6) * 0.94 + 0.01; // mirrored: bass in the centre, treble at the edges
  // 5-tap blur across frequency and time; low-passed harder beyond 30 m where the mesh can no longer resolve it
  float lp = smoothstep(30.0, 45.0, r);
  float du = 0.08 * (1.0 + lp);
  float da = (5.0 + 0.12 * age) * (1.0 + 1.5 * lp);
  float e = 0.3 * spectrum(u, age)
          + 0.175 * (spectrum(u - du, age) + spectrum(u + du, age) + spectrum(u, age - da) + spectrum(u, age + da));
  e = clamp(e * (0.85 + 0.6 * u), 0.0, 1.3);

  float taper = smoothstep(1.5, 6.0, r); // flat 1.5 m around the feet, full height by 6 m
  float front = mix(0.65, 1.0, 1.0 - smoothstep(-8.0, 3.0, xz.y)); // strongest ahead (-Z)
  float mask = edgeMask(xz);
  float ampFade = 1.0 - 0.7 * smoothstep(40.0, 55.0, r); // far hills lose their spectral detail

  // slow undulation so there is landscape even in quiet passages
  float roll = sin(xz.x * 0.16 + uTime * 0.10) * sin(xz.y * 0.12 - uTime * 0.08) * 0.65
             + sin(xz.x * 0.07 + xz.y * 0.10 + uTime * 0.06) * 0.35;
  float far = mix(1.0, 2.6, smoothstep(12.0, 35.0, r)); // gentle swells nearby, mountains far away
  float h = pow(e, 1.3) * 5.0 * uIntensity * front * ampFade + (0.9 + 0.9 * roll) * far;
  h += uBass * 0.5 * smoothstep(4.0, 20.0, r); // the whole landscape swells with the bass

  // swell travelling across the ground on every beat
  float sw = (r - uBeatRing) / 1.8;
  float swell = exp(-sw * sw) * (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0));
  h += swell * uBeatAmp * 0.55;
  // soft height cap: never above 2.2 m within 12 m of the user (look slightly down onto the hills), up to 4 m far away
  float cap = mix(2.2, 4.0, smoothstep(12.0, 30.0, r));
  h = cap * (1.0 - exp(-h / cap));
  return h * taper * mask;
}

void main() {
  vec2 xz = position.xz;
  // normals from finite differences over 2 segments (0.6 m) keep the hills round instead of faceted
  const float EPS = 0.6;
  float hc = mix(1.0, 0.4, aCeil); // the ceiling is a faint 40 %-height echo
  float h0 = terrainH(xz) * hc;
  float hx = terrainH(xz + vec2(EPS, 0.0)) * hc;
  float hz = terrainH(xz + vec2(0.0, EPS)) * hc;
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

/**
 * Solid shaded fill + anti-aliased procedural grids (1 m everywhere, 0.25 m minor grid near the feet) + sun
 * "road" + bass glow under the user + beat ring, one pass, fogged into the background.
 */
const TERRAIN_FRAGMENT = /* glsl */ `
${TERRAIN_GLSL}
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeatRing;
uniform float uLevel;
uniform float uBeat;
uniform float uBass;
uniform vec3 uAccent;
uniform vec3 uPrimary;
uniform vec3 uBackground;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vPlane;
varying float vH;
varying float vCeil;
varying float vMask;

// anti-aliased grid lines with cell size 1/scale metres: 1 on a line, gone before the lines would alias
vec2 gridLines(vec2 p, float scale) {
  vec2 gp = p * scale;
  vec2 gw = fwidth(gp);
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-4)); // pixels to the nearest line
  return (1.0 - smoothstep(0.5, 1.5, gd)) * (1.0 - smoothstep(0.22, 0.55, gw));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(vWorld - cameraPosition);
  float flip = 1.0 - 2.0 * vCeil;
  float r = length(vWorld.xz);
  float floorOnly = 1.0 - vCeil;

  // Solid pass: gradient by height (dark base -> bright peaks) lit by a fixed key light + hemisphere fill.
  float g = clamp(0.05 + vH * 0.2, 0.0, 0.85);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;
  vec3 gradHi = texture2D(uGradient, vec2(clamp(0.35 + vH * 0.2, 0.0, 0.85), 0.5)).rgb;
  vec3 L = normalize(vec3(-0.4, 0.6 * flip, -0.7));
  float lam = clamp(dot(N, L), 0.0, 1.0);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 col = grad * 0.35 * (0.3 + 1.1 * lam + 0.3 * (0.5 + 0.5 * N.y * flip));
  col += gradHi * pow(1.0 - ndv, 3.0) * 0.22 * smoothstep(0.1, 1.2, vH); // rim on the ridges
  col += gradHi * smoothstep(1.5, 4.0, vH) * 0.3;                        // glowing peaks

  // Grid pass: 1 m cells, brighter on peaks and near rows.
  vec2 gl = gridLines(vPlane, 1.0);
  float lines = max(gl.x * 0.7, gl.y);
  float gain = (0.5 + 1.6 * smoothstep(0.0, 3.0, vH)) * (1.0 + 0.9 * exp(-dist / 14.0));
  col += gradHi * lines * gain;

  // Near floor (never black): 0.25 m minor grid fading out by 4 m, a sun-reflection road running ahead (-Z),
  // and a bass-pulsed glow right under the user.
  vec2 ml = gridLines(vPlane, 4.0);
  float minor = max(ml.x, ml.y) * (1.0 - smoothstep(1.5, 4.0, r)) * 0.15;
  float zAhead = max(-vPlane.y, 0.0);
  float road = exp(-vPlane.x * vPlane.x / (0.05 * zAhead + 0.02)) * smoothstep(1.0, 6.0, zAhead) * 0.15;
  float under = pow(1.0 - smoothstep(0.0, 1.2, r), 2.0) * (0.10 + 0.30 * uBass);
  vec3 sunTint = mix(uPrimary, uAccent, 0.5);
  col += (gradHi * minor + sunTint * road * (0.7 + 0.6 * uBass) + mix(uPrimary, uAccent, 0.25) * under) * floorOnly;

  col *= uBrightness * (0.85 + 0.3 * uLevel) * (1.0 + uBeat * 0.2);
  // lit faces and crests stay saturated: cap the brightest channel at 0.9 (before tonemapping)
  col *= min(1.0, 0.9 / max(max(col.r, max(col.g, col.b)), 1e-4));
  // the ceiling is a faint echo that dissolves completely by 40 m
  float ceilFade = mix(1.0, 0.2 * (1.0 - smoothstep(12.0, 40.0, r)), vCeil);
  col *= ceilFade;

  // Beat ring racing across the ground: a 12 cm bright line in gradient(0.85) with a 1.5 m primary trail,
  // riding on the grid lines rather than smearing across the floor.
  float dr = r - uBeatRing;
  float lw = max(0.072, 1.2 * fwidth(r)); // 12 cm full width at half maximum, never thinner than a pixel
  float lineI = exp(-dr * dr / (lw * lw)) * mix(1.0, 0.072 / lw, 0.5);
  float trailI = (1.0 - smoothstep(0.0, 0.25, dr)) * exp(min(dr, 0.0) / 1.5) * 0.35;
  float life = (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0)) * smoothstep(0.5, 2.5, uBeatRing);
  vec3 ringCol = texture2D(uGradient, vec2(0.85, 0.5)).rgb * lineI * 2.4 + uPrimary * trailI;
  col += ringCol * life * (0.25 + 0.75 * lines) * floorOnly;

  // fog into the background from 25 m, complete by 55 m: the far hills stay faintly visible under the sun
  float fog = smoothstep(25.0, 55.0, dist);
  col = mix(col, uBackground, fog);

  gl_FragColor = vec4(col, uOpacity * pow(vMask, 0.6) * mix(1.0, 1.0 - smoothstep(12.0, 40.0, r), vCeil));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Distant sky cylinder: a faint horizon haze (additive, <= 0.15, gone above ~3 m) that follows the live spectrum
 * all around, and a synthwave sun straight ahead (-Z): a radial gradient (bright core -> dim primary rim),
 * scanline bands in its lower third only, and a wide soft corona.
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
uniform sampler2D uGradient;
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uBass;
uniform float uBeat;
uniform float uOpacity;
uniform float uBrightness;
varying vec3 vPos;
varying float vEnergy;
void main() {
  // horizon haze
  vec3 col = uPrimary * exp(-vPos.y * 0.9) * (0.05 + 0.1 * vEnergy);

  // sun
  float pulse = 1.0 + 0.12 * uBass + 0.06 * uBeat;
  vec2 p = vec2(vPos.x, vPos.y - ${SUN_Y.toFixed(1)}) / (${SUN_RADIUS.toFixed(1)} * pulse);
  float dd = length(p);
  float ahead = step(vPos.z, 0.0);
  float disc = (1.0 - smoothstep(0.96, 1.0, dd)) * ahead;
  float yy = clamp(0.5 - p.y * 0.5, 0.0, 1.0); // 0 at the top .. 1 at the bottom
  float thick = 0.8 * smoothstep(0.55, 0.95, yy); // dark bands thicken downwards, up to 80 % of a period
  float stripe = mix(1.0, smoothstep(thick - 0.04, thick + 0.04, fract(yy * 7.0)), step(0.667, yy)); // lower third only
  // radial gradient: a warm core (tinted toward the accent so it is never white) falling to a dim primary rim
  vec3 core = mix(texture2D(uGradient, vec2(1.0, 0.5)).rgb, uAccent, 0.5);
  vec3 sunCol = mix(core, uPrimary * 0.45, smoothstep(0.1, 1.0, dd)) * (0.8 + 0.2 * uBass);
  sunCol *= min(1.0, 0.9 / max(dot(sunCol, vec3(0.2126, 0.7152, 0.0722)), 1e-4)); // luma <= 0.9
  col += sunCol * disc * stripe;
  col += uPrimary * 0.35 * exp(-max(dd - 1.0, 0.0) * 1.6) * ahead * (1.0 - disc) * (1.0 - smoothstep(1.0, 2.0, dd));

  gl_FragColor = vec4(col * uBrightness * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A spectrogram landscape that encloses the listener: floor and (inverted) ceiling are the same displaced
 * grid drawn as one InstancedMesh, plus one sky cylinder (haze + sun). 2 draw calls.
 * Vertices (medium): 2 x 193 x 289 = ~112k for the terrain.
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
