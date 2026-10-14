import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';

const TAU = Math.PI * 2;
const EYE = 1.6;
const RING_SPACING = 0.4; // metres between rings
/** Axial offset of the first ring on either side of the listener's plane. 0 = one continuous tube (radius >= 2.4 m keeps the head clear). */
const FIRST_RING = 0;
/** Frames of audio history spread over one half of the tunnel (256 rows are available). */
const AGE_SPAN = 200;
/** Ring lines recede from the user at RING_RATE * RING_SPACING = 0.4 m/s, the same way the audio-history pattern travels. */
const RING_RATE = 1.0;
/** Twist per ring (radians): a calm base plus a little mid-range, eased over TWIST_TAU seconds. */
const TWIST_BASE = 0.008;
const TWIST_MID = 0.008;
const TWIST_TAU = 1.2;
const PULSE_SECONDS = 0.8;
/** Longitudinal lines around the circumference (independent of the mesh density). */
const SEG_LINES = 64;
/** `rings` = rows per side of the listener's plane; the tube has 2 * (rings - 1) + 1 rows. */
const QUALITY: Record<QualityLevel, { rings: number; segs: number }> = {
  low: { rings: 64, segs: 96 },
  medium: { rings: 96, segs: 160 },
  high: { rings: 128, segs: 192 },
};

// Shared vertex stage for the lines pass and the dark volume pass: places row s of the single tube that runs from
// -L (in front) to +L (behind) through the listener's plane, deforms its radius with the waveform / spectrum of the
// row's age and hands the fragment stage grid coordinates.
const vert = (rings: number, segs: number) => /* glsl */ `
${HISTORY_GLSL}
#define RINGS ${rings}.0
#define HALF ${rings - 1}.0
#define SEGS ${segs}.0
#define SEG_LINES ${SEG_LINES}.0
#define AGE_SPAN ${AGE_SPAN}.0
#define EYE ${EYE.toFixed(1)}
#define SPACING ${RING_SPACING.toFixed(2)}
#define FIRST ${FIRST_RING.toFixed(1)}
attribute float aRing; // 0 (far end in front, -Z) .. 1 (far end behind, +Z); the middle row lies in the listener's plane
attribute float aSeg;  // 0 .. 1 around the tube
uniform sampler2D uGradient;
uniform float uScrollFrac; // 0..1: ring lines recede from the user, then the pattern repeats seamlessly
uniform float uTwist;     // radians of twist per ring (driven by mid)
uniform float uRot;       // slow roll of the whole tube
uniform float uIntensity, uLevel, uBeatPos, uBeatAmp;
varying float vK;
varying float vSeg;
varying float vFade; // brightness envelope along the tunnel: dim near the user, strongest mid-way, dissolving far away
varying float vEnd;  // far-end dissolve of the dark volume
varying float vRamp; // 0 at the user .. 1 from ~9 m on: lines get thicker with distance
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
  float s = (aRing * 2.0 - 1.0) * HALF;      // signed row: negative = in front of the user, positive = behind
  float j = abs(s);                           // rows away from the listener's plane
  float ja = sqrt(s * s + 2.25) - 1.5;        // soft |s|: every profile below has zero slope at the user's plane (no crease)
  float jn = ja / HALF;
  float back = smoothstep(-1.0, 6.0, s);      // 0 in front .. 1 behind, blended through the user's plane
  // the back half hears the history slightly later so it is not an exact mirror of the front
  float age = jn * AGE_SPAN + 12.0 * smoothstep(0.0, 20.0, s);

  // waveform of this row's age, mirrored around the tube so the seam closes; the cosine remap of u gives the profile
  // zero slope on both side walls, so the mirror axis is a smooth bulge instead of a kink
  float u = abs(aSeg * 2.0 - 1.0);
  float w = waveSmooth(0.5 - 0.5 * cos(u * 3.14159265), age);
  // spectrum (lower 60 %) of the same age wrapped around the tube: bass at the sides, highs top and bottom (smooth: sin^2)
  float sn = sin(aSeg * 6.2831853);
  float band = 0.03 + 0.57 * sn * sn;
  float sp = specSmooth(band, age);
  float bass = histFreq(0.08, age);

  float dp = (jn - uBeatPos) / 0.025;
  float pulse = uBeatAmp * exp(-dp * dp);

  float calm = 0.35 + 0.65 * smoothstep(0.0, 6.0, ja);               // keep the mouth near the user round
  float flare = 1.2 * exp(-ja / 2.5);                                 // trumpet mouth: opens up around the user
  float disp = tanh((1.7 * sp * (0.7 + 1.5 * band) - 0.3 + 0.25 * w) * uIntensity) * calm * (1.0 - 0.35 * jn);
  float r = 3.4 + flare + disp + 0.2 * uLevel + 0.35 * pulse;
  r = 0.5 * (r + 2.4 + sqrt((r - 2.4) * (r - 2.4) + 0.04));          // smooth max: never closer than 2.4 m, no creases

  float th = aSeg * 6.2831853 + uRot + s * uTwist;                    // one continuous helix through the listener's plane
  vec3 p = vec3(cos(th) * r, EYE + sin(th) * r, sign(s) * (FIRST + j * SPACING));

  // near rows are dim and thin, mid/far rows carry the glow; the far end dissolves so rows never pop in or out
  vRamp = smoothstep(0.0, 22.0, ja);
  vEnd = 1.0 - smoothstep(0.45 * RINGS, 1.0 * RINGS, ja);
  vFade = (0.15 + 0.85 * vRamp) * vEnd * mix(1.0, 0.7, back);        // strongest content stays in front
  vK = j - uScrollFrac;                                                // ring lines recede from the user at a constant rate
  vSeg = aSeg * SEG_LINES;
  vBass = bass;
  vDisp = abs(disp);
  vPulse = pulse;
  // near = top of the gradient (capped below white), far = primary; bass lifts a row up the gradient
  float gc = clamp(mix(0.88, 0.3, pow(jn, 0.6)) - 0.12 * back + 0.14 * bass, 0.0, 0.8);
  vColor = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

// Glowing wireframe: ring lines + longitudinal lines drawn analytically with fwidth (constant pixel width), on a
// nearly black translucent volume. One premultiplied pass (dst * (1 - a) + rgb): the volume darkens what is behind the
// tube (stars, floor, aurora) so the space between the lines stays empty, and the lines are added on top.
const TUBE_FRAG = /* glsl */ `
uniform vec3 uAccent, uBg;
uniform float uOpacity, uBright;
varying float vK;
varying float vSeg;
varying float vFade;
varying float vEnd;
varying float vRamp;
varying float vBass;
varying float vDisp;
varying float vPulse;
varying vec3 vColor;

// thin anti-aliased line (half width hw px, edge softness px) at every integer of x plus a tight halo and a second,
// wider soft band (~2.5 px, 0.25) so lines are not hard hairlines on black; everything fades out once lines get
// denser than ~3-5 px (moire)
float gridLine(float x, float hw, float soft, float glowAmt) {
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x + 0.5) - 0.5) / fw;
  float line = 1.0 - smoothstep(hw, hw + soft, d);
  float glow = exp(-d * 0.6) * glowAmt + 0.25 * exp(-d * d * 0.16);
  return (line + glow) * (1.0 - smoothstep(0.18, 0.40, fw));
}

void main() {
  // hairlines near the user, more body (up to a 0.9 px half width) further down the tunnel
  float hw = mix(0.25, 0.9, vRamp);
  float soft = mix(0.6, 1.0, vRamp);
  float glowAmt = mix(0.06, 0.2, vRamp);
  float ringL = gridLine(vK, hw, soft, glowAmt);
  float segL = gridLine(vSeg, hw * 0.85, soft, glowAmt);
  float lines = max(ringL, 0.7 * segL);
  // quiet base, bass rings stand out (squared so the contrast is kept while the average comes down)
  float energy = 0.08 + 0.55 * vBass * vBass + 0.2 * vDisp;
  // the surface itself glows faintly (stronger at bass rings) so the lines sit in light, not on black
  vec3 col = vColor * (lines * energy + 0.03 * (0.4 + vBass));
  // beat pulse ring travelling away from the user stays the bright accent
  col += mix(vColor, uAccent, 0.5) * vPulse * (0.04 + 0.32 * lines);
  col = min(col * (vFade * uBright), vec3(0.9));   // never let a line reach full white before tone mapping
  float volume = 0.55 * vEnd * uOpacity;
  gl_FragColor = vec4(col * uOpacity + uBg * (0.15 * volume), volume);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** One continuous tube of waveform rings through the listener's plane (-L .. +L), a single draw call. */
export class WaveTunnel implements Preset {
  readonly id = 'tunnel';
  readonly name = 'Wave Tunnel';
  readonly description = 'Fly through the waveform itself';
  readonly group = new THREE.Group();

  private geometry!: THREE.BufferGeometry;
  private material!: THREE.ShaderMaterial;
  private uniforms!: Record<string, THREE.IUniform>;
  private scroll = 0;
  private twist = TWIST_BASE;
  private rot = 0;
  private beatAge = 99;

  init(ctx: PresetContext): void {
    const { rings, segs } = QUALITY[ctx.quality];
    this.geometry = buildTubeGeometry(rings, segs);

    this.uniforms = {
      ...ctx.textures.uniforms,
      uGradient: { value: ctx.palette.gradient },
      uAccent: { value: ctx.palette.accent },
      uBg: { value: ctx.palette.background },
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
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert(rings, segs),
      fragmentShader: TUBE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending, // premultiplied: dst * (1 - a) + rgb
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  update(f: AudioFeatures, dt: number, _t: number, p: VizParams): void {
    const d = Math.min(dt, 0.1);
    this.scroll = (this.scroll + d * p.speed * RING_RATE) % 1;
    // mid-range twists the tube; eased with a long time constant so the far end never whips around
    const twistTarget = TWIST_BASE + TWIST_MID * Math.min(1, f.mid * p.intensity);
    this.twist += (twistTarget - this.twist) * (1 - Math.exp(-d / TWIST_TAU));
    this.rot += d * p.speed * 0.015;
    if (f.beat) this.beatAge = 0;
    else this.beatAge += d;

    const s = this.uniforms;
    s.uScrollFrac.value = this.scroll;
    s.uTwist.value = this.twist;
    s.uRot.value = this.rot;
    s.uIntensity.value = p.intensity;
    s.uLevel.value = f.level;
    s.uBright.value = 0.6 + 0.4 * p.glow;
    if (this.beatAge < PULSE_SECONDS) {
      s.uBeatPos.value = 1.02 * (this.beatAge / PULSE_SECONDS); // starts at the user and runs outward with the history
      s.uBeatAmp.value = (0.55 + 0.45 * f.beatStrength) * Math.min(1, p.intensity);
    } else {
      s.uBeatPos.value = 2;
      s.uBeatAmp.value = 0;
    }
  }

  setOpacity(o: number): void {
    this.uniforms.uOpacity.value = o;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

/** Indexed tube: (2 * (rings - 1) + 1) x (`segs`+1) vertices (seam duplicated so aSeg runs 0..1), two triangles per quad. */
function buildTubeGeometry(rings: number, segs: number): THREE.BufferGeometry {
  const rows = 2 * (rings - 1) + 1;
  const cols = segs + 1;
  const count = rows * cols;
  const position = new Float32Array(count * 3);
  const aRing = new Float32Array(count);
  const aSeg = new Float32Array(count);
  for (let r = 0; r < rows; r++) {
    const s = r - (rings - 1);
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const a = (c / segs) * TAU;
      // undeformed tube (the vertex shader recomputes it; kept so bounds / tooling stay valid)
      position[i * 3] = Math.cos(a) * 3;
      position[i * 3 + 1] = EYE + Math.sin(a) * 3;
      position[i * 3 + 2] = Math.sign(s) * (FIRST_RING + Math.abs(s) * RING_SPACING);
      aRing[i] = r / (rows - 1);
      aSeg[i] = c / segs;
    }
  }
  const quads = (rows - 1) * segs;
  const index = count > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let n = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < segs; c++) {
      const a = r * cols + c;
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
