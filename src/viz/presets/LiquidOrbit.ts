import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const EYE = 1.6;
/** Frames of band history shown along a ribbon (head = now, tail = this long ago). */
const AGE_SPAN = 90;
const CORE_CENTER = new THREE.Vector3(0, EYE, -2.6);
const CORE_RADIUS = 1.5; // nearest surface is 1.1 m from the head
const QUALITY: Record<QualityLevel, { ribbons: number; segs: number }> = {
  low: { ribbons: 16, segs: 240 },
  medium: { ribbons: 24, segs: 400 },
  high: { ribbons: 24, segs: 600 },
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
// ---------------------------------------------------------------------------------------------
const ribbonVert = (ribbons: number) => /* glsl */ `
${HISTORY_GLSL}
${NOISE_GLSL}
#define EYE ${EYE.toFixed(1)}
#define RIBBONS ${ribbons}.0
#define AGE_SPAN ${AGE_SPAN}.0
attribute float aRibbon; // 0..1 across ribbons (also the band the ribbon listens to)
attribute float aT;      // 0 at the head .. 1 at the tail
attribute float aSide;   // -1 / +1 across the width
uniform sampler2D uGradient;
uniform float uTime, uBeat, uLevel, uIntensity, uBright;
varying float vSide;
varying float vAlpha;
varying float vHead;
varying vec3 vColor;

float hash11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

// Position (relative to the head) on ribbon id's orbit at azimuth parameter s.
// A tilted great circle + Lissajous wobble + slowly evolving noise; a function of s only, so the
// ribbon tail traces exactly the path the head took.
vec3 pathPos(float id, float s, float tm) {
  float h1 = hash11(id + 1.0), h2 = hash11(id + 17.0), h3 = hash11(id + 41.0), h5 = hash11(id + 101.0);
  float R = mix(3.2, 6.8, h1) * (1.0 + 0.1 * uLevel);
  float tilt = mix(-0.5, 0.7, h2);
  float roll = h3 * 6.2831853;
  vec3 n = vec3(sin(tilt) * cos(roll), cos(tilt), sin(tilt) * sin(roll));
  vec3 a = normalize(cross(n, vec3(0.0, 0.0, -1.0)));
  vec3 b = cross(n, a);
  float wobF = mix(1.3, 3.1, h5);
  vec3 d = cos(s) * a + sin(s) * b;
  d += n * 0.22 * sin(s * wobF + h3 * 9.0);
  d = normalize(d);
  float rr = R * (1.0 + 0.14 * sin(s * (wobF + 0.7) + h1 * 11.0));
  vec3 P = d * rr;
  vec3 q = P * 0.33 + vec3(0.0, tm * 0.04, id);
  P += (vec3(vnoise(q), vnoise(q + vec3(31.4, 0.0, 0.0)), vnoise(q + vec3(71.7, 0.0, 0.0))) - 0.5) * 1.4;
  // soft floor: smooth max of world height
  float wy = P.y + EYE;
  wy = 0.5 * (wy + 0.3 + sqrt((wy - 0.3) * (wy - 0.3) + 0.15));
  P.y = wy - EYE;
  return P;
}

void main() {
  float id = floor(aRibbon * (RIBBONS - 1.0) + 0.5);
  float h1 = hash11(id + 1.0), h3 = hash11(id + 41.0), h4 = hash11(id + 73.0), h5 = hash11(id + 101.0), h6 = hash11(id + 131.0);
  float sgn = h5 > 0.5 ? 1.0 : -1.0;
  float R0 = mix(3.2, 6.8, h1);
  // linear speed 0.45..1.2 m/s => angular speed = v / R (comfortable, slower on the big orbits)
  float omega = sgn * mix(0.45, 1.2, h4) / R0;
  float len = mix(1.3, 2.4, h6);
  float s = uTime * omega + h3 * 6.2831853 - sgn * aT * len;

  vec3 P = pathPos(id, s, uTime);
  vec3 P2 = pathPos(id, s + 0.02, uTime);
  vec3 world = P + vec3(0.0, EYE, 0.0);
  vec3 tang = normalize(P2 - P);
  vec3 toCam = cameraPosition - world;
  vec3 side = cross(tang, toCam);
  side /= max(length(side), 1e-4);

  // the ribbon is a record of its band: history along the length drives width and brightness
  float band = aRibbon * 0.94 + 0.03;
  float e = histFreq(band, aT * AGE_SPAN);
  e = clamp(e * (0.7 + 0.5 * uIntensity), 0.0, 1.2);

  float cap = sqrt(smoothstep(0.0, 0.015, aT));          // pointed head
  float taper = 1.0 - 0.6 * aT;                           // thinning tail
  float dist = length(toCam);
  // quad is ~2x wider than the bright core so the soft glow has room
  float hw = 0.08 * (0.6 + 1.1 * e) * (1.0 + 0.8 * uBeat) * cap * taper * (0.75 + 0.1 * dist);
  vec3 pos = world + side * (aSide * hw);

  float tail = pow(1.0 - aT, 1.4);
  float headGlow = exp(-aT * 26.0);
  float front = -P.z / max(length(P), 0.001);             // 1 straight ahead (-Z), -1 behind
  float fbias = 0.6 + 0.4 * smoothstep(-0.6, 0.9, front);
  float near = smoothstep(0.8, 2.2, dist);
  vAlpha = (0.18 + 0.9 * e + 0.2 * uBeat) * tail * (1.0 + 1.6 * headGlow) * fbias * near * uBright;
  vHead = headGlow;
  vSide = aSide;
  float gc = clamp(0.3 + 0.55 * aRibbon + 0.2 * e, 0.0, 1.0);
  vColor = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform float uOpacity;
varying float vSide;
varying float vAlpha;
varying float vHead;
varying vec3 vColor;

void main() {
  float s2 = vSide * vSide;
  float edge = 1.0 - s2;                   // soft edges
  float core = exp(-s2 * 12.0);
  float a = edge * (core + 0.28 * exp(-s2 * 2.2));
  vec3 col = mix(vColor, vec3(1.0), clamp(core * 0.3 + vHead * 0.5, 0.0, 1.0));
  gl_FragColor = vec4(col * (a * vAlpha * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Liquid core: a glassy sphere seen from the outside through its far wall, rippled by noise in the
// vertex shader (cheap: ~2.6k vertices) with a fresnel rim that brightens with the bass.
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
  // wobble inward freely, outward at most 6 cm: the nearest surface stays > 1 m from the head
  float disp = min((n - 0.5) * 0.16 * (0.35 + uBass + 0.4 * uBeat), 0.06);
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
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), V)), 2.2);
  // marbled "liquid": contour lines of the vertex-resolution noise field, shimmering with one cheap extra octave
  float swirl = 0.5 + 0.5 * sin(vNormalW.y * 9.0 + vN * 7.0 + uTime * 0.4 + vNormalW.x * 3.0);
  float c = abs(fract(vN * 4.0 + uTime * 0.03) - 0.5) * 2.0;
  float line = 1.0 - smoothstep(0.0, 0.3, c);
  vec3 col = mix(uPrimary, uSecondary, smoothstep(0.35, 0.7, vN));
  col = mix(col, uAccent, fres * (0.3 + 0.7 * uBeat));
  float pulse = 0.3 + 0.9 * uBass + 0.3 * uBeat;
  float a = (0.012 + 0.2 * line * (0.4 + 0.6 * swirl) + 0.4 * fres) * pulse;
  gl_FragColor = vec4(col * (a * uBright * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Uniforms = Record<string, THREE.IUniform>;

/** 24 ribbons of light orbiting the listener around a liquid glass core. 2 draw calls. */
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
    const { ribbons, segs } = QUALITY[ctx.quality];
    this.ribbonGeo = buildRibbonGeometry(ribbons, segs);
    this.ru = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uLevel: { value: 0 },
      uIntensity: { value: 1 },
      uBright: { value: 0.92 },
      uOpacity: { value: 1 },
    };
    this.ribbonMat = new THREE.ShaderMaterial({
      uniforms: this.ru,
      vertexShader: ribbonVert(ribbons),
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
    core.position.copy(CORE_CENTER);
    core.frustumCulled = false;
    this.group.add(core);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const d = Math.min(dt, 0.1);
    this.clock += d * p.speed;
    // bass eased a little more so the core swells rather than flickers
    this.bass += (Math.min(1.2, f.bass * p.intensity) - this.bass) * Math.min(1, d * 12);
    const bright = 0.6 + 0.4 * p.glow;

    const ru = this.ru;
    ru.uTime.value = this.clock;
    ru.uBeat.value = f.beatEnv * Math.min(1, p.intensity);
    ru.uLevel.value = Math.min(1, f.level) * Math.min(1.5, p.intensity);
    ru.uIntensity.value = p.intensity;
    ru.uBright.value = bright;

    const cu = this.cu;
    cu.uTime.value = this.clock;
    cu.uBass.value = this.bass;
    cu.uBeat.value = f.beatEnv * Math.min(1, p.intensity);
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

/** All ribbons in one indexed geometry: (segs+1) cross-sections of 2 vertices (aSide -1 / +1) per ribbon. */
function buildRibbonGeometry(ribbons: number, segs: number): THREE.BufferGeometry {
  const perRibbon = (segs + 1) * 2;
  const count = ribbons * perRibbon;
  const aRibbon = new Float32Array(count);
  const aT = new Float32Array(count);
  const aSide = new Float32Array(count);
  for (let r = 0; r < ribbons; r++) {
    for (let s = 0; s <= segs; s++) {
      for (let k = 0; k < 2; k++) {
        const i = r * perRibbon + s * 2 + k;
        aRibbon[i] = r / (ribbons - 1);
        aT[i] = s / segs;
        aSide[i] = k === 0 ? -1 : 1;
      }
    }
  }
  const index = count > 65535 ? new Uint32Array(ribbons * segs * 6) : new Uint16Array(ribbons * segs * 6);
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
  const geo = new THREE.BufferGeometry();
  // positions are computed in the vertex shader; the attribute only exists so the geometry is valid
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aRibbon', new THREE.BufferAttribute(aRibbon, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}
