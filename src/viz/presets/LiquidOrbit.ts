import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const EYE = 1.6;
/** Frames of band history shown along a ribbon (head = now, tail = this long ago). */
const AGE_SPAN = 90;
const CORE_Z = -3.2;
const CORE_RADIUS = 0.8; // nearest surface is 2.4 m from the head
const HALO_SIZE = 3.4; // half-size (m) of the soft halo sprite behind the core
const QUALITY: Record<QualityLevel, { main: number; outer: number; segs: number }> = {
  low: { main: 16, outer: 6, segs: 240 },
  medium: { main: 24, outer: 8, segs: 400 },
  high: { main: 24, outer: 8, segs: 600 },
};

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

// ---------------------------------------------------------------------------------------------
// Ribbons: the whole path is evaluated in the vertex shader; the ribbon is a camera-facing strip.
//  - "main" ribbons orbit the glowing core on tilted, precessing ellipses
//  - "outer" ribbons are wide faint bands that orbit the listener at 5-7 m so the sides and back are never empty
//  - one extra quad (aRibbon = -1) is the soft halo sprite behind the core, so everything is one draw call
// ---------------------------------------------------------------------------------------------
const ribbonVert = (main: number, outer: number) => /* glsl */ `
${HISTORY_GLSL}
${NOISE_GLSL}
#define EYE ${EYE.toFixed(1)}
#define MAIN ${main}.0
#define OUTER ${outer}.0
#define AGE_SPAN ${AGE_SPAN}.0
#define CORE vec3(0.0, 0.0, ${CORE_Z.toFixed(1)})
#define HALO_SIZE ${HALO_SIZE.toFixed(1)}
attribute float aRibbon; // ribbon index (main first, then outer); -1 = halo quad
attribute float aT;      // 0 at the head .. 1 at the tail (halo quad: x corner)
attribute float aSide;   // -1 / +1 across the width (halo quad: y corner)
uniform sampler2D uGradient;
uniform float uTime, uBeat, uLevel, uIntensity, uBright;
varying float vSide;
varying float vAlpha;
varying float vHead;
varying float vWide;
varying float vHalo;
varying vec2 vUv;
varying vec3 vColor;

float hash11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

// Keep a point (relative to the head) at least ~1.9 m from the head, with a smooth transition, and above the floor.
vec3 clearHeadAndFloor(vec3 P) {
  float d = max(length(P), 0.001);
  float d2 = 0.5 * (d + 1.9 + sqrt((d - 1.9) * (d - 1.9) + 0.3));
  P *= d2 / d;
  float wy = P.y + EYE;
  wy = 0.5 * (wy + 0.3 + sqrt((wy - 0.3) * (wy - 0.3) + 0.15));
  P.y = wy - EYE;
  return P;
}

// Main ribbon: tilted ellipse (semi-axes 1.4..4 m) around the core, own tilt / precession / phase, gentle noise wobble.
vec3 mainPath(float id, float th, float tm) {
  float h1 = hash11(id + 1.0), h2 = hash11(id + 17.0), h3 = hash11(id + 41.0), h4 = hash11(id + 73.0), h5 = hash11(id + 101.0), h6 = hash11(id + 131.0);
  float a = mix(1.4, 4.0, h1), b = mix(1.4, 4.0, h2);
  vec2 e = vec2(a * cos(th), b * sin(th));
  float rho = h3 * 6.2831853;
  e = vec2(cos(rho) * e.x - sin(rho) * e.y, sin(rho) * e.x + cos(rho) * e.y);   // rotate the major axis inside the plane
  float tau = mix(-1.15, 1.15, h4);
  vec3 L = vec3(e.x, e.y * cos(tau), e.y * sin(tau));                           // tilt about X
  float psi = h5 * 6.2831853 + tm * mix(0.03, 0.09, h6) * (h5 > 0.5 ? 1.0 : -1.0); // slow precession about the vertical axis
  L = vec3(cos(psi) * L.x + sin(psi) * L.z, L.y, -sin(psi) * L.x + cos(psi) * L.z);
  vec3 P = CORE + L;
  vec3 q = vec3(cos(th) * 1.1 + id * 3.7, sin(th) * 1.1, tm * 0.05);
  P += (vec3(vnoise(q), vnoise(q + vec3(17.3, 0.0, 0.0)), vnoise(q + vec3(41.7, 0.0, 0.0))) - 0.5) * 0.7;
  return clearHeadAndFloor(P);
}

// Outer ribbon: tilted great circle around the listener at 5..7 m, Lissajous wobble, slow noise.
vec3 outerPath(float oid, float s, float tm) {
  float h1 = hash11(oid + 201.0), h2 = hash11(oid + 217.0), h3 = hash11(oid + 241.0), h5 = hash11(oid + 301.0);
  float R = mix(5.0, 7.0, h1);
  float tilt = mix(-0.6, 0.7, h2);
  float roll = h3 * 6.2831853;
  vec3 n = vec3(sin(tilt) * cos(roll), cos(tilt), sin(tilt) * sin(roll));
  vec3 a = normalize(cross(n, vec3(0.0, 0.0, -1.0)));
  vec3 b = cross(n, a);
  float wobF = mix(1.3, 3.1, h5);
  vec3 d = cos(s) * a + sin(s) * b;
  d += n * 0.22 * sin(s * wobF + h3 * 9.0);
  d = normalize(d);
  vec3 P = d * R * (1.0 + 0.12 * sin(s * (wobF + 0.7) + h1 * 11.0));
  vec3 q = P * 0.25 + vec3(0.0, tm * 0.03, oid);
  P += (vec3(vnoise(q), vnoise(q + vec3(31.4, 0.0, 0.0)), vnoise(q + vec3(71.7, 0.0, 0.0))) - 0.5) * 1.2;
  return clearHeadAndFloor(P);
}

void main() {
  vSide = 0.0; vAlpha = 0.0; vHead = 0.0; vWide = 0.0; vHalo = 0.0; vUv = vec2(0.0); vColor = vec3(0.0);

  // soft halo sprite behind the core: a camera-facing quad (additive, so draw order does not matter)
  if (aRibbon < -0.5) {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 center = CORE + vec3(0.0, EYE, 0.0);
    vHalo = 1.0;
    vUv = vec2(aT, aSide);
    gl_Position = projectionMatrix * viewMatrix * vec4(center + (right * aT + up * aSide) * HALO_SIZE, 1.0);
    return;
  }

  float id = aRibbon;
  float outerLayer = step(MAIN - 0.5, id);
  float oid = id - MAIN;
  float lu = outerLayer < 0.5 ? id / max(MAIN - 1.0, 1.0) : oid / max(OUTER - 1.0, 1.0);   // 0..1 within the layer
  float h1 = hash11(id + 1.0), h2 = hash11(id + 17.0), h3 = hash11(id + 41.0), h4 = hash11(id + 73.0), h5 = hash11(id + 101.0), h6 = hash11(id + 131.0);
  float sgn = h5 > 0.5 ? 1.0 : -1.0;

  // linear speed 0.5..1.2 m/s (outer ones 0.3..0.6) => angular speed = v / mean radius
  float R0 = outerLayer < 0.5 ? 0.5 * (mix(1.4, 4.0, h1) + mix(1.4, 4.0, h2)) : mix(5.0, 7.0, hash11(oid + 201.0));
  float v = outerLayer < 0.5 ? mix(0.5, 1.2, h4) : mix(0.3, 0.6, h4);
  float omega = sgn * v / R0;
  float len = outerLayer < 0.5 ? mix(2.4, 4.6, h6) : mix(2.6, 4.2, h6);     // trail length in radians of orbit
  float th = h3 * 6.2831853 + uTime * omega - sgn * aT * len;

  vec3 P, P2;
  if (outerLayer < 0.5) {
    P = mainPath(id, th, uTime);
    P2 = mainPath(id, th + 0.02, uTime);
  } else {
    P = outerPath(oid, th, uTime);
    P2 = outerPath(oid, th + 0.02, uTime);
  }
  vec3 world = P + vec3(0.0, EYE, 0.0);
  vec3 tang = normalize(P2 - P);
  vec3 toCam = cameraPosition - world;
  vec3 side = cross(tang, toCam);
  side /= max(length(side), 1e-4);

  // the ribbon is a record of its band: history along the length drives width and brightness
  float band = lu * 0.94 + 0.03;
  float e = histFreq(band, aT * AGE_SPAN);
  e = clamp(e * (0.7 + 0.5 * uIntensity), 0.0, 1.2);

  float cap = sqrt(smoothstep(0.0, 0.015, aT));          // pointed head
  float taper = 1.0 - 0.4 * aT;
  float dist = length(toCam);
  // half-width of the quad (the bright core is about half of it): 0.05..0.12 m for main ribbons, wide soft bands for outer ones
  float hw = outerLayer < 0.5
    ? (0.05 + 0.07 * min(e, 1.0)) * (1.0 + 0.6 * uBeat) * (0.8 + 0.06 * dist)
    : (0.22 + 0.25 * min(e, 1.0)) * (1.0 + 0.3 * uBeat);
  hw *= cap * taper;
  vec3 pos = world + side * (aSide * hw);

  float tailFade = (1.0 - smoothstep(0.4, 1.0, aT)) * (1.0 - 0.35 * aT);   // fades over the last 60 %
  float headGlow = exp(-aT * 22.0);
  float front = -P.z / max(length(P), 0.001);                               // 1 straight ahead (-Z)
  float fbias = outerLayer < 0.5 ? 0.6 + 0.4 * smoothstep(-0.6, 0.9, front) : 1.0;
  float near = smoothstep(0.8, 2.2, dist);
  float alpha = (0.2 + 0.9 * e + 0.2 * uBeat) * tailFade * (1.0 + 1.6 * headGlow * (1.0 - outerLayer)) * fbias * near * uBright;
  vAlpha = alpha * mix(1.0, 0.32, outerLayer);
  vHead = headGlow * (1.0 - outerLayer);
  vSide = aSide;
  vWide = outerLayer;
  float gc = outerLayer < 0.5 ? 0.15 + 0.7 * lu + 0.15 * e : 0.2 + 0.5 * lu + 0.1 * e;
  vColor = texture2D(uGradient, vec2(clamp(gc, 0.0, 1.0), 0.5)).rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform vec3 uHaloA, uHaloB;
uniform float uOpacity, uBright, uBass, uBeat;
varying float vSide;
varying float vAlpha;
varying float vHead;
varying float vWide;
varying float vHalo;
varying vec2 vUv;
varying vec3 vColor;

void main() {
  vec3 col;
  float a;
  if (vHalo > 0.5) {
    // soft additive sun glow behind the core
    float d2 = dot(vUv, vUv);
    a = exp(-d2 * 6.0) * max(0.0, 1.0 - d2) * (0.14 + 0.35 * uBass + 0.12 * uBeat) * uBright;
    col = mix(uHaloA, uHaloB, smoothstep(0.0, 0.6, d2));
  } else {
    float s2 = vSide * vSide;
    float edge = 1.0 - s2;                  // soft edges
    float core = exp(-s2 * mix(8.0, 2.5, vWide));
    a = edge * (core + 0.28 * exp(-s2 * 2.2)) * vAlpha;
    col = mix(vColor, vec3(1.0), clamp(core * 0.25 * (1.0 - vWide) + vHead * 0.5, 0.0, 1.0));
  }
  gl_FragColor = vec4(col * (a * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Liquid core: a small glassy "sun" seen through its far wall, rippled by noise in the vertex
// shader (~2.6k vertices), marbled contour lines and an accent-coloured fresnel rim.
// ---------------------------------------------------------------------------------------------
const CORE_VERT = /* glsl */ `
${NOISE_GLSL}
uniform float uTime, uBass, uBeat;
varying float vN;
varying vec3 vNormalW;
varying vec3 vWorld;

void main() {
  vec3 q = normal * 1.7;
  vec3 warp = vec3(vnoise(q + vec3(0.0, uTime * 0.11, 0.0)), vnoise(q + vec3(5.2, 0.0, uTime * 0.09)), vnoise(q + vec3(0.0, 9.1, 3.3))) - 0.5;
  float n = 0.6 * vnoise(q + warp * 1.6 + vec3(0.0, uTime * 0.07, 0.0)) + 0.4 * vnoise(q * 2.1 - warp * 1.2 + vec3(uTime * 0.05, 3.0, 0.0));
  // wobble inward freely, outward at most 3 cm
  float disp = min((n - 0.5) * 0.12 * (0.35 + uBass + 0.4 * uBeat), 0.03);
  vec3 pos = position + normal * disp;
  vec4 w = modelMatrix * vec4(pos, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vN = n;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CORE_FRAG = /* glsl */ `
uniform vec3 uPrimary, uSecondary, uAccent;
uniform float uTime, uBass, uBeat, uBright, uOpacity;
varying float vN;
varying vec3 vNormalW;
varying vec3 vWorld;

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), V)), 2.4);
  // marbled "liquid": contour lines of the vertex-resolution noise field, shimmering with one cheap extra octave
  float swirl = 0.5 + 0.5 * sin(vNormalW.y * 9.0 + vN * 7.0 + uTime * 0.4 + vNormalW.x * 3.0);
  float c = abs(fract(vN * 4.0 + uTime * 0.03) - 0.5) * 2.0;
  float line = 1.0 - smoothstep(0.0, 0.3, c);
  vec3 col = mix(uPrimary, uSecondary, smoothstep(0.35, 0.7, vN));
  col = mix(col, uAccent, clamp(fres * 1.4, 0.0, 1.0));                // accent-coloured rim
  float pulse = 0.5 + 0.8 * uBass + 0.3 * uBeat;
  float a = 0.18 * (0.18 + 0.7 * line * (0.4 + 0.6 * swirl) + 1.6 * fres) * pulse;
  gl_FragColor = vec4(col * (a * uBright * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Uniforms = Record<string, THREE.IUniform>;

/** Ribbons of light orbiting a small liquid "sun" in front of the listener, plus faint bands around the listener. 2 draw calls. */
export class LiquidOrbit implements Preset {
  readonly id = 'orbit';
  readonly name = 'Liquid Orbit';
  readonly description = 'Ribbons of light orbiting in liquid motion';
  readonly group = new THREE.Group();

  private ribbonGeo!: THREE.BufferGeometry;
  private ribbonMat!: THREE.ShaderMaterial;
  private coreGeo!: THREE.SphereGeometry;
  private coreMat!: THREE.ShaderMaterial;
  private ru!: Uniforms;
  private cu!: Uniforms;
  private clock = 0;
  private bass = 0;

  init(ctx: PresetContext): void {
    const { main, outer, segs } = QUALITY[ctx.quality];
    this.ribbonGeo = buildRibbonGeometry(main + outer, segs);
    this.ru = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uHaloA: { value: ctx.palette.primary },
      uHaloB: { value: ctx.palette.secondary },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uBass: { value: 0 },
      uLevel: { value: 0 },
      uIntensity: { value: 1 },
      uBright: { value: 0.92 },
      uOpacity: { value: 1 },
    };
    this.ribbonMat = new THREE.ShaderMaterial({
      uniforms: this.ru,
      vertexShader: ribbonVert(main, outer),
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const ribbonMesh = new THREE.Mesh(this.ribbonGeo, this.ribbonMat);
    ribbonMesh.frustumCulled = false;
    this.group.add(ribbonMesh);

    this.coreGeo = new THREE.SphereGeometry(CORE_RADIUS, 64, 40);
    this.cu = {
      uPrimary: { value: ctx.palette.primary },
      uSecondary: { value: ctx.palette.secondary },
      uAccent: { value: ctx.palette.accent },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uBeat: { value: 0 },
      uBright: { value: 0.92 },
      uOpacity: { value: 1 },
    };
    this.coreMat = new THREE.ShaderMaterial({
      uniforms: this.cu,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const core = new THREE.Mesh(this.coreGeo, this.coreMat);
    core.position.set(0, EYE, CORE_Z);
    core.frustumCulled = false;
    this.group.add(core);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const d = Math.min(dt, 0.1);
    this.clock += d * p.speed;
    // bass eased a little more so the core swells rather than flickers
    this.bass += (Math.min(1.2, f.bass * p.intensity) - this.bass) * Math.min(1, d * 12);
    const bright = 0.6 + 0.4 * p.glow;
    const beat = f.beatEnv * Math.min(1, p.intensity);

    const ru = this.ru;
    ru.uTime.value = this.clock;
    ru.uBeat.value = beat;
    ru.uBass.value = this.bass;
    ru.uLevel.value = Math.min(1, f.level) * Math.min(1.5, p.intensity);
    ru.uIntensity.value = p.intensity;
    ru.uBright.value = bright;

    const cu = this.cu;
    cu.uTime.value = this.clock;
    cu.uBass.value = this.bass;
    cu.uBeat.value = beat;
    cu.uBright.value = bright;
  }

  setOpacity(o: number): void {
    this.ru.uOpacity.value = o;
    this.cu.uOpacity.value = o;
  }

  dispose(): void {
    this.ribbonGeo.dispose();
    this.coreGeo.dispose();
    this.ribbonMat.dispose();
    this.coreMat.dispose();
    this.group.clear();
  }
}

/**
 * All ribbons in one indexed geometry: (segs+1) cross-sections of 2 vertices (aSide -1 / +1) per ribbon,
 * followed by a 4-vertex quad (aRibbon = -1) that the vertex shader turns into the halo sprite.
 */
function buildRibbonGeometry(ribbons: number, segs: number): THREE.BufferGeometry {
  const perRibbon = (segs + 1) * 2;
  const ribbonVerts = ribbons * perRibbon;
  const count = ribbonVerts + 4;
  const aRibbon = new Float32Array(count);
  const aT = new Float32Array(count);
  const aSide = new Float32Array(count);
  for (let r = 0; r < ribbons; r++) {
    for (let s = 0; s <= segs; s++) {
      for (let k = 0; k < 2; k++) {
        const i = r * perRibbon + s * 2 + k;
        aRibbon[i] = r;
        aT[i] = s / segs;
        aSide[i] = k === 0 ? -1 : 1;
      }
    }
  }
  for (let k = 0; k < 4; k++) {
    aRibbon[ribbonVerts + k] = -1;
    aT[ribbonVerts + k] = k % 2 === 0 ? -1 : 1;
    aSide[ribbonVerts + k] = k < 2 ? -1 : 1;
  }
  const index = count > 65535 ? new Uint32Array(ribbons * segs * 6 + 6) : new Uint16Array(ribbons * segs * 6 + 6);
  let n = 0;
  for (let r = 0; r < ribbons; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * perRibbon + s * 2;
      index[n++] = a;
      index[n++] = a + 1;
      index[n++] = a + 2;
      index[n++] = a + 1;
      index[n++] = a + 3;
      index[n++] = a + 2;
    }
  }
  const q = ribbonVerts;
  index[n++] = q;
  index[n++] = q + 1;
  index[n++] = q + 2;
  index[n++] = q + 1;
  index[n++] = q + 3;
  index[n++] = q + 2;
  const geo = new THREE.BufferGeometry();
  // positions are computed in the vertex shader; the attribute only exists so the geometry is valid
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aRibbon', new THREE.BufferAttribute(aRibbon, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}
