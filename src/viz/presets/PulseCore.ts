import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, VizParams } from '@/viz/types';

const CORE_POS = new THREE.Vector3(0, 1.6, -6); // 6 m ahead at eye height: the nearest surface is > 3.4 m from the head
const CORE_RADIUS = 2.0;
const SHOCK_SLOTS = 6;
const SHOCK_LIFE = 1.2; // seconds
const SHOCK_R0 = 2.2;
const SHOCK_R_WALL = 16; // upright ring facing the user
const SHOCK_R_FLOOR = 24; // ring on the floor, so the room behind you pulses too
const RING_RADII = [3.3, 3.9, 4.5];
const BACK_CORONA_POS = new THREE.Vector3(0, 1.6, 8); // dim glow behind the listener so the back is never empty
const BURST_LIFE = 0.6; // seconds a beat burst of sparks lives
const CLEAR_NEAR = 1.2; // metres: nothing is drawn closer to the head than this
const CLEAR_FAR = 2.4; // ... and everything is fully visible beyond this

const QUALITY = {
  low: { freq: 24, swarm: 1500, sparks: 100 },
  medium: { freq: 48, swarm: 3000, sparks: 150 },
  high: { freq: 64, swarm: 4500, sparks: 220 },
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
// Core: a smooth breathing sphere. One low-frequency noise (2-3 lobes, bass) plus a very fine ripple (treble).
// Normals come from displacing two neighbouring points, so shading stays smooth.
// ---------------------------------------------------------------------------------------------
const CORE_VERTEX = /* glsl */ `
${SIMPLEX_GLSL}
uniform float uTime;
uniform float uBass;
uniform float uTreble;
uniform float uBeat;
uniform float uLevel;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vDir;
varying vec3 vBase;
varying float vDisp;

// radial displacement relative to the core radius
float displace(vec3 n) {
  float t = uTime;
  float lobes = snoise(n * 1.1 + vec3(0.0, t * 0.16, t * 0.10));
  float ripple = snoise(n * 9.0 + vec3(0.0, t * 1.5, t * 1.1));
  float d = lobes * (0.035 + 0.125 * uBass + 0.04 * uBeat) + ripple * (0.002 + 0.017 * min(uTreble, 1.0));
  return clamp(d, -0.17, 0.17); // keeps the surface > 3 m from the listener
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
  vec3 p0 = n * R * (1.0 + d0);
  vec3 p1 = n1 * R * (1.0 + displace(n1));
  vec3 p2 = n2 * R * (1.0 + displace(n2));
  vec3 nrm = normalize(cross(p1 - p0, p2 - p0));

  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(modelMatrix) * nrm;
  vDir = n;
  vBase = mat3(modelMatrix) * n;
  vDisp = d0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CORE_FRAGMENT = /* glsl */ `
${SIMPLEX_GLSL}
uniform sampler2D uGradient;
uniform vec3 uAccent;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uTime;
uniform float uOpacity;
uniform float uBrightness;
uniform float uBeat;
uniform float uBass;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vDir;
varying vec3 vBase;
varying float vDisp;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  // rim from mostly-detailed normals (the smooth sphere normal alone would light the whole outer lumps)
  vec3 Nb = normalize(vBase);
  float ndv = clamp(dot(normalize(mix(Nb, N, 0.75)), V), 0.0, 1.0);
  vec3 L = normalize(vec3(0.4, 0.7, 0.6));

  // Dark glass sphere of energy: the body is the violet-to-pink part of the gradient (0.15..0.55) with its
  // luminance capped at 0.10 and no neutral tint; the veins, the inner light and the rim carry all the brightness.
  float dn = clamp(vDisp * 2.6 + 0.5, 0.0, 1.0);
  vec3 grad = texture2D(uGradient, vec2(0.15 + 0.40 * dn, 0.5)).rgb;
  vec3 body = grad * (0.35 + 0.65 * max(dot(N, L), 0.0)) * (0.3 + 0.7 * dn) * (0.8 + 0.8 * uBass);
  float lum = dot(body, vec3(0.2126, 0.7152, 0.0722));
  vec3 col = body * min(1.0, 0.10 / max(lum, 1e-4));

  // veins: zero set of a low-frequency noise -> a few thin arcs (~10 % of the surface) with a soft glow falloff
  float vn = abs(snoise(vDir * 2.0 + vec3(0.0, uTime * 0.12, uTime * 0.07)));
  float vein = min((1.0 - smoothstep(0.0, 0.045, vn)) + exp(-vn * 14.0) * 0.3, 1.0);
  vec3 veinCol = texture2D(uGradient, vec2(0.45 + 0.3 * dn, 0.5)).rgb;
  col += veinCol * vein * (1.2 + 0.6 * min(uBass + 0.5 * uBeat, 1.0)); // up to 1.8

  // inner emissive light shining through the glass, strongest face-on, breathing with the bass
  col += texture2D(uGradient, vec2(0.6 + 0.3 * dn, 0.5)).rgb * (0.25 + 0.8 * uBass) * pow(ndv, 4.0) * 0.16;

  // Fresnel rim tinted with the palette's secondary colour, small specular
  col += uSecondary * pow(1.0 - ndv, 3.0) * 1.2;
  vec3 H = normalize(L + V);
  col += mix(uAccent, uPrimary, 0.3) * pow(max(dot(N, H), 0.0), 32.0) * 0.3;

  gl_FragColor = vec4(col * uBrightness, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Corona: camera-facing quads, two instances (behind the core, and a dim one behind the listener).
// (A single huge gl_PointSize would be clamped by many GPUs.) aCor = (width in m, gain, bass pulse amount).
// ---------------------------------------------------------------------------------------------
const CORONA_VERTEX = /* glsl */ `
attribute vec3 aCor;
uniform float uSizeBoost;
varying vec2 vUv;
varying vec3 vCor;
void main() {
  vUv = position.xy * 2.0;
  vCor = aCor;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // push the quad 2.6 m further away along the view ray: behind the whole displaced core, so depth testing
  // keeps it off the core's surface while its projected centre and angular size stay unchanged
  float k = (length(mv.xyz) + 2.6) / length(mv.xyz);
  mv.xyz *= k;
  mv.xy += position.xy * (aCor.x + uSizeBoost) * k;
  gl_Position = projectionMatrix * mv;
}`;

const CORONA_FRAGMENT = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uOpacity;
uniform float uBrightness;
uniform float uLevel;
uniform float uBeat;
uniform float uBass;
varying vec2 vUv;
varying vec3 vCor;
void main() {
  float d = length(vUv);
  float fall = 1.0 - smoothstep(0.0, 1.0, d);
  float glow = pow(fall, 2.4);
  float pulse = mix(1.0, 0.45 + 1.1 * uBass, vCor.z); // the back corona swells with the bass
  vec3 col = uPrimary * glow * (0.3 + 0.4 * uLevel) * vCor.y * pulse;
  col += mix(uAccent, uPrimary, 0.3) * pow(fall, 4.0) * uBeat * 0.35 * vCor.y; // inner flash on the beat
  gl_FragColor = vec4(col * uBrightness * uOpacity, 1.0);
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
  float seg = fract(vUv.x * (3.0 + k) - uTime * dir * (0.07 + 0.04 * k));
  float comet = pow(seg, 10.0) + 0.3 * pow(seg, 1.6);
  vec3 col = texture2D(uGradient, vec2(0.4 + 0.15 * k + 0.35 * comet, 0.5)).rgb;
  col *= (0.08 + comet) * (0.5 + 1.8 * uMid + 0.8 * uBeat);
  // never draw close to the listener's head
  col *= smoothstep(${CLEAR_NEAR.toFixed(1)}, ${CLEAR_FAR.toFixed(1)}, distance(vWorld, cameraPosition));
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
uniform vec3 uAccent;
uniform float uOpacity;
uniform float uBrightness;
varying float vRho;
varying float vScale;
varying float vAge;
varying float vPower;
varying vec3 vWorld;
void main() {
  float d = (1.0 - vRho) * vScale;   // metres behind the leading edge
  // thin (~12 cm) bright ring at the leading edge + a faint wake
  float ed = (d - 0.08) / 0.055;
  float ring = exp(-ed * ed);
  float wake = smoothstep(0.0, 0.06, d) * exp(-d * 4.0) * 0.06;
  float life = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.3);
  vec3 col = uAccent * (ring * 1.9 + wake);
  col *= min(1.0, 1.1 / max(max(col.r, max(col.g, col.b)), 1e-4)); // stay saturated instead of washing out to white
  col *= life * vPower * uBrightness * uOpacity * smoothstep(${CLEAR_NEAR.toFixed(1)}, ${CLEAR_FAR.toFixed(1)}, distance(vWorld, cameraPosition));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Swarm: 55 % of the points orbit the core on noise-perturbed, tilted orbits; 45 % is dust that fills the whole
// room (including behind the listener). A few points of each are larger "hero" sprites. The first `sparks`
// points (position.x < 0) are the beat burst: they live ~0.6 s after every beat, computed statelessly from
// uBurstTime and a per-beat seed, so the burst costs no extra draw call. Everything is computed on the GPU.
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
uniform float uBurstTime;  // seconds since the last beat
uniform float uBurstSeed;  // 0..1, changes with every beat so successive bursts differ
uniform float uBurstPower; // 0.55..1 from the beat strength
varying vec3 vColor;
const float TAU = 6.28318530718;
const vec3 CORE = vec3(${CORE_POS.x.toFixed(1)}, ${CORE_POS.y.toFixed(1)}, ${CORE_POS.z.toFixed(1)});

void main() {
  vec3 r = position; // per-point random numbers (x < 0 marks a spark)
  vec4 s = aSeed;
  vec3 p;
  float size;
  float tint;
  float gain;
  if (r.x < 0.0) {
    // beat spark: radial burst with a fast start and slow finish, a little sag, shrinking and fading out
    float life = uBurstTime / ${BURST_LIFE.toFixed(2)};
    if (life >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
      gl_PointSize = 0.0;
      vColor = vec3(0.0);
      return;
    }
    vec3 q = fract(s.xyz + uBurstSeed * vec3(1.0, 1.7, 2.3));
    float cu = q.x * 2.0 - 1.0;
    float ph = q.y * TAU;
    float sr = sqrt(1.0 - cu * cu);
    vec3 dir = vec3(sr * cos(ph), cu, sr * sin(ph));
    float travel = (3.0 + 6.0 * q.z) * (1.0 - 0.7 * smoothstep(0.0, 0.9, dir.z)); // the burst never rushes the listener
    float ease = 1.0 - pow(1.0 - life, 2.2);
    p = CORE + dir * (${CORE_RADIUS.toFixed(2)} * 1.02 + travel * ease) - vec3(0.0, 0.8 * life * life, 0.0);
    size = (0.08 + 0.09 * s.w) * (1.0 - 0.5 * life);
    tint = 0.82 + 0.16 * s.w;
    gain = 3.0 * uBurstPower * pow(1.0 - life, 1.2);
  } else if (r.x < 0.55) {
    // orbiting swarm, radius 3.2 .. 8.9 m around the core
    float R = 3.2 + 5.7 * pow(r.y, 1.4);
    float ang = s.x * TAU + uOrbit * (0.45 + 0.9 * s.y) / pow(R, 0.7);
    vec3 q = vec3(cos(ang), (s.z - 0.5) * 0.35, sin(ang)) * R;
    float incl = (r.z - 0.5) * 2.2;
    float ci = cos(incl), si = sin(incl);
    q = vec3(q.x, q.y * ci - q.z * si, q.y * si + q.z * ci);
    float node = s.w * TAU;
    float cn = cos(node), sn = sin(node);
    q = vec3(q.x * cn + q.z * sn, q.y, -q.x * sn + q.z * cn);
    vec3 nq = q * 0.3;
    q += 0.5 * vec3(snoise(nq + vec3(0.0, uTime * 0.17, 0.0)),
                    snoise(nq + vec3(11.0, uTime * 0.13, 3.0)),
                    snoise(nq + vec3(5.0, uTime * 0.11, -7.0)));
    q *= 1.0 + 0.16 * uBeat + 0.05 * uBass;
    p = CORE + q;
    float hero = step(0.985, fract(sin(dot(s.xy, vec2(12.9898, 78.233))) * 43758.5453));
    size = mix(0.02 + 0.10 * s.y * s.y * s.y, 0.18, hero);
    tint = 0.3 + 0.55 * s.y + 0.12 * uTreble;
    gain = 1.0 + 0.4 * hero;
  } else {
    // ambient dust on a shell around the listener
    float cu = r.y * 2.0 - 1.0;
    float ph = r.z * TAU + uTime * 0.02;
    float sr = sqrt(1.0 - cu * cu);
    vec3 dir = vec3(sr * cos(ph), cu, sr * sin(ph));
    if (s.w < 0.35) dir.z = abs(dir.z); // a third of the dust is folded behind the listener: ~2/3 of it fills the back
    float rad = (5.0 + 17.0 * s.x) * (1.0 + 0.03 * uBass + 0.04 * uBeat);
    p = vec3(0.0, 1.6, 0.0) + dir * rad;
    p.y = abs(p.y - 0.3) + 0.3; // stay above the floor
    vec3 np = p * 0.12;
    p += 1.1 * vec3(snoise(np + vec3(0.0, uTime * 0.05, 0.0)),
                    snoise(np + vec3(9.0, uTime * 0.04, 2.0)),
                    snoise(np + vec3(4.0, uTime * 0.045, -5.0)));
    float hero = step(0.985, fract(sin(dot(s.xy, vec2(39.346, 11.135))) * 43758.5453));
    size = mix(0.04 + 0.10 * s.y * s.y, 0.18, hero);
    tint = 0.2 + 0.4 * s.y + 0.1 * uTreble;
    gain = 1.05 + 0.3 * hero;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  float px = size * (1.0 + 0.6 * uTreble) * 0.5 * uViewportH * projectionMatrix[1][1] / dist;
  gl_PointSize = clamp(px, 1.5, 26.0);
  // fade out anything that would pass close to the listener's eyes: nothing is drawn within 1.2 m
  float near = smoothstep(${CLEAR_NEAR.toFixed(1)}, ${CLEAR_FAR.toFixed(1)}, length(mv.xyz));
  float twinkle = r.x < 0.0 ? 1.0 : 0.65 + 0.35 * sin(uTime * (1.0 + 2.0 * s.z) + s.w * 40.0);
  float depthFade = r.x < 0.0 ? 1.0 : exp(-dist * 0.05); // distant points dim out
  vColor = texture2D(uGradient, vec2(clamp(tint, 0.0, 1.0), 0.5)).rgb * gain * near * twinkle * depthFade;
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
 * A living core 6 m ahead of the listener, with a corona (plus a dim one behind the listener), three orbit rings,
 * beat shockwaves (upright rings + floor rings) and a 3000-point orbiting swarm / room dust that also carries the
 * 150 sparks of the beat burst.
 * Draw calls: core, corona (instanced x2), rings (instanced), shockwaves (instanced, 12 slots), swarm + sparks = 5.
 * Vertices (medium): core 23k indexed, swarm 3.15k points, everything else < 3k.
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
  private allUniforms: Record<string, THREE.IUniform>[] = [];

  private time = 0;
  private orbit = 0;
  private nextSlot = 0;
  private readonly age = new Float32Array(SHOCK_SLOTS).fill(1);
  private readonly power = new Float32Array(SHOCK_SLOTS);
  private readonly tilt = new Float32Array(SHOCK_SLOTS * 2);
  private burstTime = 99; // seconds since the last beat (>= BURST_LIFE: no sparks)
  private burstSeed = 0;
  private burstPower = 0.55;
  private readonly dummy = new THREE.Object3D();
  private readonly sizeTmp = new THREE.Vector2();

  init(ctx: PresetContext): void {
    const q = QUALITY[ctx.quality] ?? QUALITY.medium;
    const { palette } = ctx;
    this.renderer = ctx.renderer;

    const shared = () => ({
      uGradient: { value: palette.gradient },
      uAccent: { value: palette.accent },
      uPrimary: { value: palette.primary },
      uSecondary: { value: palette.secondary },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBeat: { value: 0 },
      uOpacity: { value: 1 },
      uBrightness: { value: 1 },
    });

    // --- core ---
    this.coreU = { ...shared(), uBass: { value: 0 }, uTreble: { value: 0 } };
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
    this.coronaU = { ...shared(), uSizeBoost: { value: 0 }, uBass: { value: 0 } };
    const coronaGeo = new THREE.PlaneGeometry(1, 1);
    // instance 0: behind the core (11 m wide); instance 1: dim and bass-pulsed behind the listener (9 m, 0.35x)
    coronaGeo.setAttribute('aCor', new THREE.InstancedBufferAttribute(new Float32Array([11, 0.75, 0, 9, 0.35 * 0.75, 1]), 3));
    const coronaMat = new THREE.ShaderMaterial({
      uniforms: this.coronaU,
      vertexShader: CORONA_VERTEX,
      fragmentShader: CORONA_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const corona = new THREE.InstancedMesh(coronaGeo, coronaMat, 2);
    corona.setMatrixAt(0, this.dummy.matrix.makeTranslation(CORE_POS.x, CORE_POS.y, CORE_POS.z));
    corona.setMatrixAt(1, this.dummy.matrix.makeTranslation(BACK_CORONA_POS.x, BACK_CORONA_POS.y, BACK_CORONA_POS.z));
    corona.instanceMatrix.needsUpdate = true;
    corona.frustumCulled = false;
    corona.renderOrder = 1;

    // --- orbit rings ---
    this.ringU = { ...shared(), uMid: { value: 0 } };
    const ringGeo = new THREE.TorusGeometry(1, 0.0055, 6, 220);
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
    this.swarmU = {
      ...shared(),
      uOrbit: { value: 0 },
      uBass: { value: 0 },
      uTreble: { value: 0 },
      uViewportH: { value: 1080 },
      uBurstTime: { value: this.burstTime },
      uBurstSeed: { value: 0 },
      uBurstPower: { value: this.burstPower },
    };
    const swarmGeo = new THREE.BufferGeometry();
    const total = q.swarm + q.sparks;
    const rnd = new Float32Array(total * 3);
    const seed = new Float32Array(total * 4);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random();
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    for (let i = 0; i < q.sparks; i++) rnd[i * 3] = -1; // the first points are the beat sparks
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
    this.allUniforms = [this.coreU, this.coronaU, this.ringU, this.shockU, this.swarmU];
    this.disposables.push(coreGeo, coreMat, coronaGeo, coronaMat, corona, ringGeo, ringMat, shockGeo, shockMat, swarmGeo, swarmMat, this.rings, this.shock);
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

    for (const u of this.allUniforms) {
      u.uTime.value = this.time;
      u.uLevel.value = level;
      u.uBeat.value = beat;
      u.uBrightness.value = bright;
    }
    this.coreU.uBass.value = bass;
    this.coreU.uTreble.value = treble;
    this.coronaU.uSizeBoost.value = 1.2 * level + 0.8 * beat;
    this.coronaU.uBass.value = Math.min(1, bass);
    this.ringU.uMid.value = Math.min(1, mid);
    this.swarmU.uOrbit.value = this.orbit;
    this.swarmU.uBass.value = Math.min(1, bass);
    this.swarmU.uTreble.value = Math.min(1, treble);
    this.swarmU.uViewportH.value = this.viewportHeight();

    this.core.rotation.y += dt * 0.12 * p.speed;
    this.updateRings();

    if (f.beat) {
      this.spawnShockwave(f);
      this.burstTime = 0;
      this.burstSeed = (f.beatCount * 0.6180339887) % 1;
      this.burstPower = 0.55 + 0.45 * Math.min(1, f.beatStrength);
    } else if (this.burstTime < 9) {
      this.burstTime += dt;
    }
    this.swarmU.uBurstTime.value = this.burstTime;
    this.swarmU.uBurstSeed.value = this.burstSeed;
    this.swarmU.uBurstPower.value = this.burstPower * k;
    this.advanceShockwaves(dt * p.speed);
  }

  setOpacity(o: number): void {
    for (const u of this.allUniforms) u.uOpacity.value = o;
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
