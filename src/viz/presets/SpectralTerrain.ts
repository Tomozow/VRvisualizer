import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';
import { OUTPUT_GLSL } from '@/viz/shared/Shading';

const WIDTH = 60;
const DEPTH = 73.5;
const Z_CENTER = -18.25; // plane spans z = -55 .. +18.5: deep ahead (hills fade into the fog under the sun), still covered behind
const Z_MIN = Z_CENTER - DEPTH / 2;
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
  medium: [144, 216],
  high: [192, 288],
};

/** Terrain constants shared by the shaders. Age 0 = newest spectrum row. */
const TERRAIN_GLSL = /* glsl */ `
#define HALF_W ${(WIDTH / 2).toFixed(1)}
#define Z_MIN (${Z_MIN.toFixed(2)})
#define Z_MAX (${(Z_CENTER + DEPTH / 2).toFixed(2)})
#define Z_FRONT ${(DEPTH / 2 - Z_CENTER).toFixed(1)}
#define AGE_MAX 90.0
#define CEILING_Y ${CEILING_Y.toFixed(1)}
#define BEAT_RING_MAX ${BEAT_RING_MAX.toFixed(1)}
`;

/**
 * Terrain vertex stage. One geometry, two meshes: the floor and (`#define CEILING`) the same landscape rotated 180°
 * about the z axis at y = CEILING_Y (rotation, not reflection, so winding stays correct and the mirrored x is
 * invisible because the landscape is symmetric in x). Heights come from the GPU spectrogram: x -> frequency (bass in
 * the centre strip), distance from the user -> age, so the freshest audio sits near your feet (age 90 rows = 1.25 s
 * at the far end) and flows outwards in front of and behind you. One fetch from the pre-blurred spectrogram
 * (5-band box + short temporal average) keeps it rolling instead of spiky, and the amplitude fades with distance
 * so far rows never alias. The ceiling needs no normals: one height evaluation instead of three.
 */
const TERRAIN_VERTEX = /* glsl */ `
${HISTORY_GLSL}
${TERRAIN_GLSL}
uniform float uTime;
uniform float uIntensity;
uniform float uBass;
uniform float uBeatRing;
uniform float uBeatAmp;

varying vec3 vWorld;
varying float vH;
varying float vMask;
#ifndef CEILING
varying vec3 vNormal;
varying vec2 vPlane;
#endif

// 1 inside the plane, fading to 0 toward its borders
float edgeMask(vec2 xz) {
  float ex = 1.0 - smoothstep(0.62, 1.0, abs(xz.x) / HALF_W);
  float ez = smoothstep(0.0, 12.0, min(xz.y - Z_MIN, Z_MAX - xz.y));
  return ex * ez;
}

float terrainH(vec2 xz) {
  float f = clamp(abs(xz.y) / Z_FRONT, 0.0, 1.0); // user stands at z = 0
  float r = length(xz);
  float age = AGE_MAX * pow(f, 0.8); // fresh audio near the user
  float ax = sqrt(xz.x * xz.x + 4.0) - 2.0; // rounded |x|: no sharp crest along the centre line
  float u = pow(clamp(ax / (HALF_W - 2.0), 0.0, 1.0), 0.6) * 0.94 + 0.01; // mirrored: bass in the centre, treble at the edges
  // single fetch from the pre-blurred history (5 bands wide, ~3 rows deep); far hills lose their detail below
  float e = clamp(histFreqSmooth(u, age) * (0.85 + 0.6 * u), 0.0, 1.3);

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
  float lift = position.y;
  float h0 = terrainH(xz);
  #ifdef CEILING
    h0 *= 0.4; // a faint 40 %-height echo
    vec3 p = vec3(-xz.x, CEILING_Y - h0 - lift, xz.y);
  #else
    // normals from finite differences over 2 segments (0.6 m) keep the hills round instead of faceted
    const float EPS = 0.6;
    float hx = terrainH(xz + vec2(EPS, 0.0));
    float hz = terrainH(xz + vec2(0.0, EPS));
    vNormal = mat3(modelMatrix) * normalize(vec3(-(hx - h0) / EPS, 1.0, -(hz - h0) / EPS));
    vPlane = xz;
    vec3 p = vec3(xz.x, h0 + lift, xz.y);
  #endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vH = h0;
  vMask = edgeMask(xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Floor: solid shaded fill + anti-aliased procedural grids (1 m everywhere, 0.25 m minor grid near the feet) + sun
 * "road" + bass glow under the user + beat ring, one pass, fogged into the background. That pass is opaque outside
 * crossfades, so its borders dissolve by colour (towards the background), not by alpha.
 * Ceiling (`#define CEILING`, blended): a flat gradient-by-height colour at 20-40 % of the floor's body light, no
 * normals, rim or grid, alpha-faded to nothing by r = 40 m so the sun's glow shows through.
 * Stays highp: the grid lines use fract/fwidth of world coordinates.
 */
const TERRAIN_FRAGMENT = /* glsl */ `
${OUTPUT_GLSL}
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
varying float vH;
varying float vMask;
#ifndef CEILING
varying vec3 vNormal;
varying vec2 vPlane;
#endif

// anti-aliased grid lines with cell size 1/scale metres: 1 on a line, gone before the lines would alias
vec2 gridLines(vec2 p, float scale) {
  vec2 gp = p * scale;
  vec2 gw = fwidth(gp);
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-4)); // pixels to the nearest line
  return (1.0 - smoothstep(0.5, 1.5, gd)) * (1.0 - smoothstep(0.22, 0.55, gw));
}

void main() {
  float dist = length(vWorld - cameraPosition);
  float r = length(vWorld.xz);
  // fog into the background from 25 m, complete by 55 m: the far hills stay faintly visible under the sun
  float fog = smoothstep(25.0, 55.0, dist);
  float g = clamp(0.05 + vH * 0.2, 0.0, 0.85);
  vec3 grad = texture2D(uGradient, vec2(g, 0.5)).rgb;

#ifdef CEILING
  // mid-gradient colour, valleys at 20 % and crests at 40 % of a 0.18 base (the floor's body light is ~0.4)
  vec3 col = texture2D(uGradient, vec2(clamp(0.3 + vH * 0.4, 0.0, 0.85), 0.5)).rgb * (0.18 * mix(0.2, 0.4, smoothstep(0.0, 1.2, vH)));
  col *= uBrightness * (0.85 + 0.3 * uLevel) * (1.0 + uBeat * 0.2);
  col = mix(col, uBackground, fog);
  float vis = 1.0 - smoothstep(12.0, 40.0, r);
  gl_FragColor = vec4(cheapOutput(col), uOpacity * vis * vis * sqrt(max(vMask, 0.0)));
#else
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);

  // Solid pass: gradient by height (dark base -> bright peaks) lit by a fixed key light + hemisphere fill.
  vec3 gradHi = texture2D(uGradient, vec2(clamp(0.35 + vH * 0.2, 0.0, 0.85), 0.5)).rgb;
  vec3 L = normalize(vec3(-0.4, 0.6, -0.7));
  float lam = clamp(dot(N, L), 0.0, 1.0);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 col = grad * 0.35 * (0.3 + 1.1 * lam + 0.3 * (0.5 + 0.5 * N.y));
  float rim = 1.0 - ndv;
  col += gradHi * (rim * rim * rim) * 0.22 * smoothstep(0.1, 1.2, vH); // rim on the ridges
  col += gradHi * smoothstep(1.5, 4.0, vH) * 0.3;                      // glowing peaks

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
  float under = 1.0 - smoothstep(0.0, 1.2, r);
  under *= under * (0.10 + 0.30 * uBass);
  vec3 sunTint = mix(uPrimary, uAccent, 0.5);
  col += gradHi * minor + sunTint * road * (0.7 + 0.6 * uBass) + mix(uPrimary, uAccent, 0.25) * under;

  col *= uBrightness * (0.85 + 0.3 * uLevel) * (1.0 + uBeat * 0.2);
  // lit faces and crests stay saturated: cap the brightest channel at 0.9 (before tonemapping)
  col *= min(1.0, 0.9 / max(max(col.r, max(col.g, col.b)), 1e-4));

  // Beat ring racing across the ground: a 12 cm bright line in gradient(0.85) with a 1.5 m primary trail,
  // riding on the grid lines rather than smearing across the floor.
  float dr = r - uBeatRing;
  float lw = max(0.072, 1.2 * fwidth(r)); // 12 cm full width at half maximum, never thinner than a pixel
  float lineI = exp(-dr * dr / (lw * lw)) * mix(1.0, 0.072 / lw, 0.5);
  float trailI = (1.0 - smoothstep(0.0, 0.25, dr)) * exp(min(dr, 0.0) / 1.5) * 0.35;
  float life = (1.0 - clamp(uBeatRing / BEAT_RING_MAX, 0.0, 1.0)) * smoothstep(0.5, 2.5, uBeatRing);
  vec3 ringCol = texture2D(uGradient, vec2(0.85, 0.5)).rgb * lineI * 2.4 + uPrimary * trailI;
  col += ringCol * life * (0.25 + 0.75 * lines);

  col = mix(col, uBackground, fog);
  col = mix(uBackground, col, sqrt(max(vMask, 0.0))); // plane borders dissolve into the background
  gl_FragColor = vec4(cheapOutput(col), uOpacity);
#endif
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

// highp: the sun's scanline bands are fract() of a world-space height
const SKY_FRAGMENT = /* glsl */ `
${OUTPUT_GLSL}
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

  // tone curve kept (not the additive variant): the sun's luma cap is designed around it
  gl_FragColor = vec4(cheapOutput(col * uBrightness * uOpacity), 1.0);
}`;

/**
 * Re-orders the quad rows of a PlaneGeometry (rotated to lie in xz, spanning Z_MIN..Z_MIN + DEPTH) by distance from
 * the user (z = 0): the near rows, which occlude the hills behind them, are drawn first and early-Z rejects the rest.
 */
function sortRowsNearFirst(geo: THREE.BufferGeometry, rows: number): void {
  const index = geo.getIndex()!;
  const idx = index.array as Uint16Array | Uint32Array;
  const perRow = idx.length / rows;
  const zRow = (i: number) => Math.abs(Z_MIN + ((i + 0.5) * DEPTH) / rows);
  const order = Array.from({ length: rows }, (_, i) => i).sort((a, b) => zRow(a) - zRow(b));
  const src = idx.slice();
  order.forEach((row, k) => idx.set(src.subarray(row * perRow, (row + 1) * perRow), k * perRow));
  index.needsUpdate = true;
}

/**
 * A spectrogram landscape that encloses the listener: floor and (inverted) ceiling are the same displaced grid
 * drawn as two meshes (opaque floor with rows ordered near -> far for early-Z, a cheap flat-shaded blended ceiling),
 * plus one sky cylinder (haze + sun). 3 draw calls.
 * Vertices (medium): 2 x 145 x 217 = ~63k for the terrain.
 */
export class SpectralTerrain implements Preset {
  readonly id = 'terrain';
  readonly name = 'Spectral Terrain';
  readonly description = 'A landscape sculpted by the spectrogram';
  readonly group = new THREE.Group();

  private uniforms!: Record<string, THREE.IUniform>;
  private terrainMat!: THREE.ShaderMaterial;
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
    sortRowsNearFirst(geo, sz);
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      transparent: false,
      depthWrite: true,
    });
    this.terrainMat = mat;
    const floor = new THREE.Mesh(geo, mat);
    floor.frustumCulled = false; // displaced in the vertex shader

    // The ceiling shares the geometry but is its own (blended, flat-shaded) pass: it must fade out to reveal the sun.
    const ceilMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      defines: { CEILING: 1 },
      transparent: true,
      depthWrite: true,
    });
    const ceiling = new THREE.Mesh(geo, ceilMat);
    ceiling.frustumCulled = false;

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
    sky.renderOrder = -1; // behind the terrain while the terrain is blended during a crossfade

    this.group.add(sky, floor, ceiling);
    this.disposables.push(geo, mat, ceilMat, skyGeo, skyMat);
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
    // fully opaque outside crossfades: no blending, early-Z friendly
    this.terrainMat.transparent = o < 0.999;
    this.terrainMat.depthWrite = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }
}
