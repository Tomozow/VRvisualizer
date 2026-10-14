import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';

const CORE_POS = new THREE.Vector3(0, 1.6, -3); // 3 m ahead at eye height
const CORE_RADIUS = 1.2;
const SHOCK_SLOTS = 6;
const SHOCK_LIFE = 1.4; // seconds
const SHOCK_R0 = 1.3;
const SHOCK_R_WALL = 10; // upright ring facing the user
const SHOCK_R_FLOOR = 24; // ring on the floor, so the room behind you pulses too
const RING_RADII = [1.95, 2.3, 2.65];

const QUALITY = {
  low: { freq: 24, swarm: 1000 },
  medium: { freq: 48, swarm: 2000 },
  high: { freq: 64, swarm: 3500 },
} as const;

/** Compact 3D simplex noise (Ashima / Ian McEwan, MIT). Returns roughly -1..1. */
const SIMPLEX_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// ---------------------------------------------------------------------------------------------
// Core: noise-displaced sphere. Large slow lobes (bass), body wobble (mid), fine fast ripples (treble),
// a spike on the beat. Normals come from displacing two neighbouring points, so shading stays smooth.
// ---------------------------------------------------------------------------------------------
const CORE_VERTEX = /* glsl */ `
${SIMPLEX_GLSL}
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uLevel;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vDisp;

float displace(vec3 n) {
  float t = uTime;
  float lobes = snoise(n * 1.25 + vec3(0.0, t * 0.16, t * 0.10));
  float body = snoise(n * 2.6 + vec3(t * 0.28, -t * 0.20, 3.7));
  float ripple = snoise(n * 8.5 + vec3(0.0, t * 1.5, t * 1.1));
  float spike = pow(max(snoise(n * 3.2 + vec3(t * 0.5)), 0.0), 2.0);
  float d = lobes * (0.07 + 0.30 * uBass) + body * (0.03 + 0.08 * uMid)
          + ripple * (0.008 + 0.055 * uTreble) + spike * uBeat * 0.22;
  return clamp(d, -0.45, 0.55); // keeps the surface > 1 m from the listener
}

void main() {
  vec3 n = normalize(position);
  float R = ${CORE_RADIUS.toFixed(2)} * (1.0 + 0.04 * uLevel + 0.05 * uBeat);
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(n, up));
  vec3 t2 = cross(n, t1);
  const float E = 0.02;
  vec3 n1 = normalize(n + t1 * E);
  vec3 n2 = normalize(n + t2 * E);
  float d0 = displace(n);
  vec3 p0 = n * (R + d0);
  vec3 p1 = n1 * (R + displace(n1));
  vec3 p2 = n2 * (R + displace(n2));
  vec3 nrm = normalize(cross(p1 - p0, p2 - p0));

  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(modelMatrix) * nrm;
  vDisp = d0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CORE_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform vec3 uAccent;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeat;
uniform float uLevel;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vDisp;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.6);

  // Displacement drives the colour: valleys cool and dark, ridges hot.
  float dn = clamp(vDisp * 1.6 + 0.5, 0.0, 1.0);
  vec3 base = texture2D(uGradient, vec2(clamp(0.08 + 0.8 * dn + 0.1 * uLevel, 0.0, 1.0), 0.5)).rgb;
  vec3 hot = texture2D(uGradient, vec2(clamp(0.6 + 0.4 * dn, 0.0, 1.0), 0.5)).rgb;

  vec3 L = normalize(vec3(0.4, 0.7, 0.6));
  float lam = 0.5 + 0.5 * dot(N, L);
  // fake subsurface: light bleeding through the body where we look straight at it
  float sss = pow(1.0 - fres, 3.0) * (0.3 + 0.7 * dn);
  vec3 col = base * (0.16 + 0.5 * lam) + base * sss * 0.8;

  // iso-displacement contour lines
  float ch = vDisp * 16.0;
  float cw = fwidth(ch);
  float contour = (1.0 - smoothstep(0.0, cw * 1.5 + 0.03, min(fract(ch), 1.0 - fract(ch)))) * (1.0 - smoothstep(0.4, 1.0, cw));
  col += hot * contour * 0.5;

  col += hot * pow(dn, 3.0) * 0.9;
  col += mix(uAccent, vec3(1.0), 0.3) * fres * (1.0 + 1.6 * uBeat);

  gl_FragColor = vec4(col * uBrightness, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Corona: a camera-facing quad behind the core. (A single huge gl_PointSize would be clamped by many GPUs.)
// ---------------------------------------------------------------------------------------------
const CORONA_VERTEX = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}`;

const CORONA_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uOpacity;
uniform float uBrightness;
uniform float uLevel;
uniform float uBeat;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float fall = 1.0 - smoothstep(0.0, 1.0, d);
  float glow = pow(fall, 2.6) * 0.7 + pow(fall, 7.0) * 1.3;
  vec3 col = texture2D(uGradient, vec2(0.5 + 0.35 * uLevel, 0.5)).rgb;
  col *= glow * (0.3 + 0.8 * uLevel + 0.5 * uBeat) * uBrightness * uOpacity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Orbit rings: one instanced torus, three instances with their own tilt / speed / dash pattern.
// ---------------------------------------------------------------------------------------------
const RING_VERTEX = /* glsl */ `
attribute float aRing;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRing;
void main() {
  vUv = uv;
  vRing = aRing;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const RING_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform float uTime;
uniform float uMid;
uniform float uBeat;
uniform float uOpacity;
uniform float uBrightness;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRing;
void main() {
  float k = vRing;
  float dir = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  // comet-like dashes running around the ring: bright head, long tail
  float seg = fract(vUv.x * (3.0 + k) + uTime * dir * (0.07 + 0.04 * k));
  float comet = pow(seg, 4.0);
  vec3 col = texture2D(uGradient, vec2(0.4 + 0.15 * k + 0.35 * comet, 0.5)).rgb;
  col *= (0.1 + 0.9 * comet) * (0.5 + 1.8 * uMid + 0.8 * uBeat);
  // never draw close to the listener's head
  col *= smoothstep(0.8, 1.9, distance(vWorld, cameraPosition));
  gl_FragColor = vec4(col * uBrightness * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Shockwaves: instances 0..5 are upright rings facing the user, 6..11 lie on the floor.
// Radius / orientation come from the instance matrix, age + power from `aWave`.
// ---------------------------------------------------------------------------------------------
const SHOCK_VERTEX = /* glsl */ `
attribute vec2 aWave; // x: age 0..1 (>= 1 = inactive), y: power
varying float vRho;
varying float vScale;
varying float vAge;
varying float vPower;
varying vec3 vWorld;
void main() {
  vRho = length(position.xy);
  vScale = length(instanceMatrix[0].xyz);
  vAge = aWave.x;
  vPower = aWave.y;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SHOCK_FRAGMENT = /* glsl */ `
uniform sampler2D uGradient;
uniform vec3 uAccent;
uniform float uOpacity;
uniform float uBrightness;
varying float vRho;
varying float vScale;
varying float vAge;
varying float vPower;
varying vec3 vWorld;
void main() {
  float t = (1.0 - vRho) / 0.5;      // 0 at the leading edge .. 1 at the inner edge
  float d = (1.0 - vRho) * vScale;   // metres behind the leading edge
  float trail = smoothstep(0.0, 0.05, d) * exp(-d * 3.2) * (1.0 - t);
  float ed = (d - 0.07) / 0.045;
  float edge = exp(-ed * ed);
  float life = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.6);
  vec3 tint = texture2D(uGradient, vec2(0.65 + 0.25 * (1.0 - vAge), 0.5)).rgb;
  vec3 col = tint * trail * 1.3 + mix(uAccent, vec3(1.0), 0.5) * edge * 1.6;
  col *= life * vPower * uBrightness * uOpacity * smoothstep(0.8, 2.0, distance(vWorld, cameraPosition));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Swarm: 78 % of the points orbit the core on noise-perturbed, tilted orbits; the rest is dust that
// fills the whole room (including behind the listener). Positions are computed entirely on the GPU.
// ---------------------------------------------------------------------------------------------
const SWARM_VERTEX = /* glsl */ `
${SIMPLEX_GLSL}
attribute vec4 aSeed;
uniform sampler2D uGradient;
uniform float uTime;
uniform float uOrbit;
uniform float uBass;
uniform float uTreble;
uniform float uBeat;
uniform float uViewportH;
varying vec3 vColor;
const float TAU = 6.28318530718;

void main() {
  vec3 r = position; // per-point random numbers
  vec4 s = aSeed;
  vec3 p;
  float size;
  float tint;
  float gain;
  if (r.x < 0.78) {
    // orbiting swarm
    float R = 1.9 + 3.3 * pow(r.y, 1.4);
    float ang = s.x * TAU + uOrbit * (0.45 + 0.9 * s.y) / pow(R, 0.7);
    vec3 q = vec3(cos(ang), (s.z - 0.5) * 0.35, sin(ang)) * R;
    float incl = (r.z - 0.5) * 2.2;
    float ci = cos(incl), si = sin(incl);
    q = vec3(q.x, q.y * ci - q.z * si, q.y * si + q.z * ci);
    float node = s.w * TAU;
    float cn = cos(node), sn = sin(node);
    q = vec3(q.x * cn + q.z * sn, q.y, -q.x * sn + q.z * cn);
    vec3 nq = q * 0.55;
    q += 0.32 * vec3(snoise(nq + vec3(0.0, uTime * 0.17, 0.0)),
                     snoise(nq + vec3(11.0, uTime * 0.13, 3.0)),
                     snoise(nq + vec3(5.0, uTime * 0.11, -7.0)));
    q *= 1.0 + 0.16 * uBeat + 0.05 * uBass;
    p = vec3(${CORE_POS.x.toFixed(1)}, ${CORE_POS.y.toFixed(1)}, ${CORE_POS.z.toFixed(1)}) + q;
    size = 0.03 + 0.05 * s.y;
    tint = 0.3 + 0.55 * s.y + 0.12 * uTreble;
    gain = 1.0;
  } else {
    // ambient dust on a shell around the listener
    float cu = r.y * 2.0 - 1.0;
    float ph = r.z * TAU + uTime * 0.02;
    float sr = sqrt(1.0 - cu * cu);
    vec3 dir = vec3(sr * cos(ph), cu, sr * sin(ph));
    float rad = (7.0 + 17.0 * s.x) * (1.0 + 0.03 * uBass + 0.04 * uBeat);
    p = vec3(0.0, 1.6, 0.0) + dir * rad;
    p.y = abs(p.y - 0.3) + 0.3; // stay above the floor
    vec3 np = p * 0.12;
    p += 1.1 * vec3(snoise(np + vec3(0.0, uTime * 0.05, 0.0)),
                    snoise(np + vec3(9.0, uTime * 0.04, 2.0)),
                    snoise(np + vec3(4.0, uTime * 0.045, -5.0)));
    size = 0.05 + 0.09 * s.y;
    tint = 0.2 + 0.4 * s.y + 0.1 * uTreble;
    gain = 0.45;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  float px = size * (1.0 + 0.6 * uTreble) * 0.5 * uViewportH * projectionMatrix[1][1] / dist;
  gl_PointSize = clamp(px, 1.5, 26.0);
  // fade out anything that would pass close to the listener's eyes
  float near = smoothstep(0.7, 1.8, length(mv.xyz));
  float twinkle = 0.65 + 0.35 * sin(uTime * (1.0 + 2.0 * s.z) + s.w * 40.0);
  vColor = texture2D(uGradient, vec2(clamp(tint, 0.0, 1.0), 0.5)).rgb * gain * near * twinkle;
  gl_Position = projectionMatrix * mv;
}`;

const SWARM_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uBrightness;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.0) * (1.0 - smoothstep(0.8, 1.0, d));
  gl_FragColor = vec4(vColor * a * 1.5 * uBrightness * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Indexed unit icosphere (PolyhedronGeometry is non-indexed: detail 48 would be 144k vertices instead of 23k). */
function createIcoSphere(freq: number): THREE.BufferGeometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  const cache = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      cache.set(key, idx);
    }
    return idx;
  };
  for (const [a, b, c] of faces) {
    const A = base[a], B = base[b], C = base[c];
    const grid: number[][] = [];
    for (let i = 0; i <= freq; i++) {
      const row: number[] = [];
      for (let j = 0; j <= freq - i; j++) {
        const k = freq - i - j;
        row.push(vertex(A[0] * k + B[0] * i + C[0] * j, A[1] * k + B[1] * i + C[1] * j, A[2] * k + B[2] * i + C[2] * j));
      }
      grid.push(row);
    }
    for (let i = 0; i < freq; i++) {
      for (let j = 0; j < freq - i; j++) {
        indices.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (j < freq - i - 1) indices.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * A living core 3 m ahead of the listener, with a corona, three orbit rings, beat shockwaves
 * (upright rings + floor rings) and a 2000-point orbiting swarm / room dust.
 * Draw calls: core, corona, rings (instanced), shockwaves (instanced, 12 slots), swarm = 5.
 * Vertices (medium): core 23k indexed, everything else < 3k.
 */
export class PulseCore implements Preset {
  readonly id = 'pulse';
  readonly name = 'Pulse Core';
  readonly description = 'A living core that shatters on every beat';
  readonly group = new THREE.Group();

  private renderer!: THREE.WebGLRenderer;
  private core!: THREE.Mesh;
  private rings!: THREE.InstancedMesh;
  private shock!: THREE.InstancedMesh;
  private waveAttr!: THREE.InstancedBufferAttribute;
  private coreU!: Record<string, THREE.IUniform>;
  private coronaU!: Record<string, THREE.IUniform>;
  private ringU!: Record<string, THREE.IUniform>;
  private shockU!: Record<string, THREE.IUniform>;
  private swarmU!: Record<string, THREE.IUniform>;
  private disposables: { dispose(): void }[] = [];

  private time = 0;
  private orbit = 0;
  private nextSlot = 0;
  private readonly age = new Float32Array(SHOCK_SLOTS).fill(1);
  private readonly power = new Float32Array(SHOCK_SLOTS);
  private readonly tilt = new Float32Array(SHOCK_SLOTS * 2);
  private readonly dummy = new THREE.Object3D();
  private readonly sizeTmp = new THREE.Vector2();

  init(ctx: PresetContext): void {
    const q = QUALITY[ctx.quality] ?? QUALITY.medium;
    const { palette } = ctx;
    this.renderer = ctx.renderer;

    const shared = () => ({
      uGradient: { value: palette.gradient },
      uAccent: { value: palette.accent },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBeat: { value: 0 },
      uOpacity: { value: 1 },
      uBrightness: { value: 1 },
    });

    // --- core ---
    this.coreU = { ...shared(), uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 } };
    const coreGeo = createIcoSphere(q.freq);
    const coreMat = new THREE.ShaderMaterial({
      uniforms: this.coreU,
      vertexShader: CORE_VERTEX,
      fragmentShader: CORE_FRAGMENT,
      transparent: true,
      depthWrite: true,
    });
    this.core = new THREE.Mesh(coreGeo, coreMat);
    this.core.position.copy(CORE_POS);
    this.core.frustumCulled = false; // displaced in the vertex shader
    this.core.renderOrder = 0;

    // --- corona ---
    this.coronaU = { ...shared(), uSize: { value: 3.4 } };
    const coronaGeo = new THREE.PlaneGeometry(1, 1);
    const coronaMat = new THREE.ShaderMaterial({
      uniforms: this.coronaU,
      vertexShader: CORONA_VERTEX,
      fragmentShader: CORONA_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const corona = new THREE.Mesh(coronaGeo, coronaMat);
    corona.position.copy(CORE_POS);
    corona.frustumCulled = false;
    corona.renderOrder = 1;

    // --- orbit rings ---
    this.ringU = { ...shared(), uMid: { value: 0 } };
    const ringGeo = new THREE.TorusGeometry(1, 0.009, 6, 220);
    ringGeo.setAttribute('aRing', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 2]), 1));
    const ringMat = new THREE.ShaderMaterial({
      uniforms: this.ringU,
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.rings = new THREE.InstancedMesh(ringGeo, ringMat, RING_RADII.length);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 2;

    // --- shockwaves ---
    this.shockU = { ...shared() };
    const shockGeo = new THREE.RingGeometry(0.5, 1, 160, 1);
    this.waveAttr = new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_SLOTS * 2 * 2).fill(1), 2);
    this.waveAttr.setUsage(THREE.DynamicDrawUsage);
    shockGeo.setAttribute('aWave', this.waveAttr);
    const shockMat = new THREE.ShaderMaterial({
      uniforms: this.shockU,
      vertexShader: SHOCK_VERTEX,
      fragmentShader: SHOCK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.shock = new THREE.InstancedMesh(shockGeo, shockMat, SHOCK_SLOTS * 2);
    this.shock.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shock.frustumCulled = false;
    this.shock.renderOrder = 2;
    this.writeShockMatrices();

    // --- swarm ---
    this.swarmU = { ...shared(), uOrbit: { value: 0 }, uBass: { value: 0 }, uTreble: { value: 0 }, uViewportH: { value: 1080 } };
    const swarmGeo = new THREE.BufferGeometry();
    const rnd = new Float32Array(q.swarm * 3);
    const seed = new Float32Array(q.swarm * 4);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random();
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    swarmGeo.setAttribute('position', new THREE.BufferAttribute(rnd, 3)); // random numbers, not positions
    swarmGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    const swarmMat = new THREE.ShaderMaterial({
      uniforms: this.swarmU,
      vertexShader: SWARM_VERTEX,
      fragmentShader: SWARM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const swarm = new THREE.Points(swarmGeo, swarmMat);
    swarm.frustumCulled = false;
    swarm.renderOrder = 3;

    this.group.add(this.core, corona, this.rings, this.shock, swarm);
    this.disposables.push(coreGeo, coreMat, coronaGeo, coronaMat, ringGeo, ringMat, shockGeo, shockMat, swarmGeo, swarmMat);
    this.updateRings();
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    this.time += dt * p.speed;
    const k = Math.min(1, p.intensity);
    const bass = Math.min(1.2, f.bass * p.intensity);
    const mid = Math.min(1.2, f.mid * p.intensity);
    const treble = Math.min(1.2, f.treble * p.intensity);
    const level = Math.min(1, f.level);
    const beat = f.beatEnv * k;
    const bright = 0.6 + 0.4 * p.glow;
    this.orbit += dt * p.speed * (0.35 + 1.8 * Math.min(1, f.highMid * p.intensity));

    for (const u of [this.coreU, this.coronaU, this.ringU, this.shockU, this.swarmU]) {
      u.uTime.value = this.time;
      u.uLevel.value = level;
      u.uBeat.value = beat;
      u.uBrightness.value = bright;
    }
    this.coreU.uBass.value = bass;
    this.coreU.uMid.value = mid;
    this.coreU.uTreble.value = treble;
    this.coronaU.uSize.value = 3.4 + 1.4 * level + 0.9 * beat;
    this.ringU.uMid.value = Math.min(1, mid);
    this.swarmU.uOrbit.value = this.orbit;
    this.swarmU.uBass.value = Math.min(1, bass);
    this.swarmU.uTreble.value = Math.min(1, treble);
    this.swarmU.uViewportH.value = this.viewportHeight();

    this.core.rotation.y += dt * 0.12 * p.speed;
    this.updateRings();

    if (f.beat) this.spawnShockwave(f);
    this.advanceShockwaves(dt * p.speed);
  }

  setOpacity(o: number): void {
    for (const u of [this.coreU, this.coronaU, this.ringU, this.shockU, this.swarmU]) u.uOpacity.value = o;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  /** Height in pixels of one eye's viewport, for point-size attenuation (differs between XR and the page). */
  private viewportHeight(): number {
    const xr = this.renderer.xr;
    if (xr.isPresenting) {
      const cams = xr.getCamera().cameras;
      if (cams.length > 0 && cams[0].viewport.w > 0) return cams[0].viewport.w;
    }
    return this.renderer.getDrawingBufferSize(this.sizeTmp).y;
  }

  private updateRings(): void {
    const d = this.dummy;
    const t = this.time;
    for (let k = 0; k < RING_RADII.length; k++) {
      d.position.copy(CORE_POS);
      d.rotation.set(
        0.9 + 0.5 * k + 0.25 * Math.sin(t * 0.21 * (1 + k * 0.4) + k),
        t * (0.1 + 0.06 * k) * (k === 1 ? -1 : 1),
        0.35 * k + 0.2 * Math.sin(t * 0.17 + k * 2),
      );
      d.scale.setScalar(RING_RADII[k]);
      d.updateMatrix();
      this.rings.setMatrixAt(k, d.matrix);
    }
    this.rings.instanceMatrix.needsUpdate = true;
  }

  private spawnShockwave(f: AudioFeatures): void {
    const slot = this.nextSlot;
    this.nextSlot = (slot + 1) % SHOCK_SLOTS;
    this.age[slot] = 0;
    this.power[slot] = 0.55 + 0.45 * Math.min(1, f.beatStrength);
    // small deterministic wobble so successive rings are not perfectly concentric
    const h = Math.sin(f.beatCount * 12.9898) * 43758.5453;
    const r1 = h - Math.floor(h);
    const h2 = Math.sin(f.beatCount * 78.233) * 12543.1357;
    const r2 = h2 - Math.floor(h2);
    this.tilt[slot * 2] = (r1 - 0.5) * 0.5;
    this.tilt[slot * 2 + 1] = (r2 - 0.5) * 0.5;
  }

  private advanceShockwaves(dt: number): void {
    let any = false;
    for (let i = 0; i < SHOCK_SLOTS; i++) {
      if (this.age[i] < 1) {
        this.age[i] = Math.min(1, this.age[i] + dt / SHOCK_LIFE);
        any = true;
      }
    }
    if (any) this.writeShockMatrices();
  }

  private writeShockMatrices(): void {
    const d = this.dummy;
    const wave = this.waveAttr.array as Float32Array;
    for (let i = 0; i < SHOCK_SLOTS; i++) {
      const a = this.age[i];
      const live = a < 1;
      const e = 1 - Math.pow(1 - a, 2.2); // fast start, slow finish
      // upright ring facing the user
      d.position.copy(CORE_POS);
      d.rotation.set(this.tilt[i * 2], this.tilt[i * 2 + 1], 0);
      d.scale.setScalar(live ? SHOCK_R0 + (SHOCK_R_WALL - SHOCK_R0) * e : 0);
      d.updateMatrix();
      this.shock.setMatrixAt(i, d.matrix);
      // ring on the floor, centred under the core
      d.position.set(CORE_POS.x, 0.03, CORE_POS.z);
      d.rotation.set(-Math.PI / 2, 0, 0);
      d.scale.setScalar(live ? SHOCK_R0 + (SHOCK_R_FLOOR - SHOCK_R0) * e : 0);
      d.updateMatrix();
      this.shock.setMatrixAt(SHOCK_SLOTS + i, d.matrix);
      wave[i * 2] = a;
      wave[i * 2 + 1] = this.power[i];
      wave[(SHOCK_SLOTS + i) * 2] = a;
      wave[(SHOCK_SLOTS + i) * 2 + 1] = this.power[i] * 0.7;
    }
    this.shock.instanceMatrix.needsUpdate = true;
    this.waveAttr.needsUpdate = true;
  }
}
