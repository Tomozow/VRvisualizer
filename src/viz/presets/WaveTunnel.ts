import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const TAU = Math.PI * 2;
const EYE = 1.6;
const RING_SPACING = 0.4; // metres between rings
const FIRST_RING = 0.8; // nearest ring is 0.8 m along the axis (and >= 2.4 m radially) from the head
/** Frames of audio history spread over the whole tunnel length (256 rows are available). */
const AGE_SPAN = 200;
/** Rings slide toward the user at RING_RATE * RING_SPACING m/s (kept far below the comfort limit). */
const RING_RATE = 1.6;
const PULSE_SECONDS = 0.8;
const QUALITY: Record<QualityLevel, { rings: number; segs: number }> = {
  low: { rings: 64, segs: 96 },
  medium: { rings: 96, segs: 128 },
  high: { rings: 128, segs: 160 },
};

// Shared vertex stage for the lines pass and the dark volume pass: places ring k on the tunnel, deforms
// its radius with the waveform of the ring's age and hands the fragment stage grid coordinates.
const vert = (rings: number, segs: number) => /* glsl */ `
${HISTORY_GLSL}
#define RINGS ${rings}.0
#define SEGS ${segs}.0
#define AGE_SPAN ${AGE_SPAN}.0
#define EYE ${EYE.toFixed(1)}
#define SPACING ${RING_SPACING.toFixed(2)}
#define FIRST ${FIRST_RING.toFixed(1)}
attribute float aRing; // 0 (nearest) .. 1 (farthest)
attribute float aSeg;  // 0 .. 1 around the tube
uniform sampler2D uGradient;
uniform float uFlip;      // +1: front tunnel (-Z), -1: mirrored tunnel behind the user (+Z)
uniform float uScrollFrac; // 0..1: rings slide toward the user, then the pattern repeats seamlessly
uniform float uTwist;     // radians of twist per ring (driven by mid)
uniform float uRot;       // slow roll of the whole tube
uniform float uPhase;     // static angular offset of this tube
uniform float uAgeBias;   // frames of extra delay (decorrelates the back tunnel)
uniform float uGradShift;
uniform float uIntensity, uLevel, uBeatPos, uBeatAmp;
varying float vK;
varying float vSeg;
varying float vFade;
varying float vBass;
varying float vDisp;
varying float vPulse;
varying vec3 vColor;

// Raw waveform frames decorrelate quickly (no trigger alignment) and carry far more detail than the tube can
// show, so low-pass it. The taps are spaced exactly 2 texels apart (one bilinear tap covers 2), so the box is gap-free
// and nothing aliases into zig-zags: 12 taps (~0.09 of the circle, triangular) x 2 frames.
float waveSmooth(float u, float age) {
  float s = 0.0, ws = 0.0;
  for (int i = 0; i < 12; i++) {
    float k = float(i) - 5.5;
    float wi = 6.5 - abs(k);
    float uu = clamp(u + k * 0.0078125, 0.01, 0.99);
    s += wi * (histWave(uu, age) + histWave(uu, age + 4.0));
    ws += 2.0 * wi;
  }
  return s / ws;
}
// Same idea for the spectrum: 8 taps x 2 bands = 16 bands, +-4 frames, so single hot bands become rounded bulges.
float specSmooth(float b, float age) {
  float s = 0.0, ws = 0.0;
  for (int i = 0; i < 8; i++) {
    float k = float(i) - 3.5;
    float wi = 4.5 - abs(k);
    float bb = clamp(b + k * 0.015625, 0.01, 0.99);
    s += wi * (histFreq(bb, max(age - 4.0, 0.0)) + histFreq(bb, age) + histFreq(bb, age + 4.0));
    ws += 3.0 * wi;
  }
  return s / ws;
}

void main() {
  float k = aRing * (RINGS - 1.0);
  float j = max(k - uScrollFrac, 0.0);       // ring slot after sliding; never closer than FIRST
  float jn = j / (RINGS - 1.0);
  float age = jn * AGE_SPAN + uAgeBias;

  // waveform of this ring's age, mirrored around the tube so the seam closes
  float u = abs(aSeg * 2.0 - 1.0);
  float w = waveSmooth(u, age);
  // spectrum (lower 60 %) of the same age wrapped around the tube: bass at the sides, highs top and bottom (smooth: sin^2)
  float sn = sin(aSeg * 6.2831853);
  float band = 0.03 + 0.57 * sn * sn;
  float sp = specSmooth(band, age);
  float bass = histFreq(0.08, age);

  float dp = (jn - uBeatPos) / 0.04;
  float pulse = uBeatAmp * exp(-dp * dp);

  float calm = 0.35 + 0.65 * smoothstep(0.0, 6.0, j);                // keep the mouth near the user round
  float flare = 1.2 * exp(-j / 2.5);                                  // trumpet mouth: opens up toward the user
  float disp = tanh((1.7 * sp * (0.7 + 1.5 * band) - 0.3 + 0.25 * w) * uIntensity) * calm * (1.0 - 0.35 * jn);
  float r = 3.4 + flare + disp + 0.2 * uLevel + 0.35 * pulse;
  r = max(r, 2.4);

  float th = aSeg * 6.2831853 + uRot + uPhase + j * uTwist;
  vec3 p = vec3(cos(th) * r, EYE + sin(th) * r, -(FIRST + j * SPACING) * uFlip);

  // near-end and far-end dissolve so rings never pop in or out
  vFade = (0.3 + 0.7 * smoothstep(0.0, 8.0, j)) * (1.0 - smoothstep(0.6 * RINGS, 1.0 * RINGS, j));
  vK = k;
  vSeg = aSeg * SEGS;
  vBass = bass;
  vDisp = abs(disp);
  vPulse = pulse;
  // near = accent end of the gradient, far = primary; bass lifts a ring up the gradient
  float gc = clamp(mix(0.88, 0.3, pow(jn, 0.6)) + uGradShift + 0.14 * bass, 0.0, 1.0);
  vColor = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

// Glowing wireframe: ring lines + longitudinal lines drawn analytically with fwidth (constant pixel width).
const LINES_FRAG = /* glsl */ `
uniform float uOpacity, uBright, uGain;
varying float vK;
varying float vSeg;
varying float vFade;
varying float vBass;
varying float vDisp;
varying float vPulse;
varying vec3 vColor;

// thin anti-aliased line (half width hw px) at every integer of x plus a soft halo; fades out once lines get denser than ~2 px
float gridLine(float x, float hw) {
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x + 0.5) - 0.5) / fw;
  float line = 1.0 - smoothstep(hw, hw + 1.0, d);
  float glow = exp(-d * 0.45) * 0.35;
  return (line + glow) * (1.0 - smoothstep(0.3, 0.55, fw));
}

void main() {
  float ringL = gridLine(vK, 0.6);
  float segL = gridLine(vSeg * 0.5, 0.5);
  float lines = max(ringL, 0.7 * segL);
  float energy = 0.35 + 1.3 * vBass + 0.6 * vDisp;
  vec3 col = vColor * (lines * energy + 0.012 + 0.06 * vBass);
  // beat pulse ring travelling from far to near
  col += mix(vColor, vec3(1.0), 0.55) * vPulse * (0.25 + 1.3 * lines);
  gl_FragColor = vec4(col * (vFade * uBright * uGain * uOpacity), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Dark translucent volume behind the lines: gives the tube depth against the sky layer.
const DARK_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform float uOpacity;
varying float vFade;
varying float vBass;
varying vec3 vColor;

void main() {
  gl_FragColor = vec4(uBg * 0.4 + vColor * (0.02 + 0.05 * vBass), 0.32 * vFade * uOpacity);
}
`;

/** Tube of waveform rings in front of the user, mirrored behind. 4 draw calls (2 volumes + 2 line meshes). */
export class WaveTunnel implements Preset {
  readonly id = 'tunnel';
  readonly name = 'Wave Tunnel';
  readonly description = 'Fly through the waveform itself';
  readonly group = new THREE.Group();

  private geometry!: THREE.BufferGeometry;
  private materials: THREE.ShaderMaterial[] = [];
  private shared!: Record<string, THREE.IUniform>;
  private scroll = 0;
  private twist = 0.008;
  private rot = 0;
  private beatAge = 99;

  init(ctx: PresetContext): void {
    const { rings, segs } = QUALITY[ctx.quality];
    this.geometry = buildTubeGeometry(rings, segs);

    // uniform value objects shared by all four materials (updated once per frame)
    this.shared = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uScrollFrac: { value: 0 },
      uTwist: { value: this.twist },
      uRot: { value: 0 },
      uIntensity: { value: 1 },
      uLevel: { value: 0 },
      uBeatPos: { value: 2 },
      uBeatAmp: { value: 0 },
      uBright: { value: 0.92 },
      uOpacity: { value: 1 },
    };

    const make = (flip: number, dark: boolean): THREE.ShaderMaterial => {
      const back = flip < 0;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...this.shared,
          uFlip: { value: flip },
          uPhase: { value: back ? Math.PI / 2 : 0 },
          uAgeBias: { value: back ? 9 : 0 },
          uGradShift: { value: back ? -0.12 : 0 },
          uGain: { value: back ? 0.7 : 1 }, // strongest content stays in front
          uBg: { value: ctx.palette.background },
        },
        vertexShader: vert(rings, segs),
        fragmentShader: dark ? DARK_FRAG : LINES_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
        fog: false,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = dark ? -1 : 0; // volumes first, then the additive lines
      this.group.add(mesh);
      return mat;
    };
    make(1, true);
    make(-1, true);
    make(1, false);
    make(-1, false);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const d = Math.min(dt, 0.1);
    this.scroll = (this.scroll + d * p.speed * RING_RATE) % 1;
    // mid-range twists the tube; eased so it never snaps
    const twistTarget = 0.008 + 0.018 * Math.min(1, f.mid * p.intensity);
    this.twist += (twistTarget - this.twist) * Math.min(1, d * 2.5);
    this.rot += d * p.speed * 0.015;
    if (f.beat) this.beatAge = 0;
    else this.beatAge += d;

    const s = this.shared;
    s.uScrollFrac.value = this.scroll;
    s.uTwist.value = this.twist;
    s.uRot.value = this.rot;
    s.uIntensity.value = p.intensity;
    s.uLevel.value = f.level;
    s.uBright.value = 0.6 + 0.4 * p.glow;
    if (this.beatAge < PULSE_SECONDS) {
      s.uBeatPos.value = 1.02 * (1 - this.beatAge / PULSE_SECONDS);
      s.uBeatAmp.value = (0.55 + 0.45 * f.beatStrength) * Math.min(1, p.intensity);
    } else {
      s.uBeatPos.value = 2;
      s.uBeatAmp.value = 0;
    }
  }

  setOpacity(o: number): void {
    this.shared.uOpacity.value = o;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.group.clear();
  }
}

/** Indexed tube: `rings` x (`segs`+1) vertices (seam duplicated so aSeg runs 0..1), two triangles per quad. */
function buildTubeGeometry(rings: number, segs: number): THREE.BufferGeometry {
  const cols = segs + 1;
  const count = rings * cols;
  const position = new Float32Array(count * 3);
  const aRing = new Float32Array(count);
  const aSeg = new Float32Array(count);
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < cols; s++) {
      const i = r * cols + s;
      const a = (s / segs) * TAU;
      // undeformed tube (the vertex shader recomputes it; kept so bounds / tooling stay valid)
      position[i * 3] = Math.cos(a) * 3;
      position[i * 3 + 1] = EYE + Math.sin(a) * 3;
      position[i * 3 + 2] = -(FIRST_RING + r * RING_SPACING);
      aRing[i] = r / (rings - 1);
      aSeg[i] = s / segs;
    }
  }
  const quads = (rings - 1) * segs;
  const index = count > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let n = 0;
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * cols + s;
      const b = a + cols;
      index[n++] = a;
      index[n++] = b;
      index[n++] = a + 1;
      index[n++] = a + 1;
      index[n++] = b;
      index[n++] = b + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
  geo.setAttribute('aSeg', new THREE.BufferAttribute(aSeg, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}
