import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, QualityLevel, VizParams } from '@/viz/types';
import { HISTORY_GLSL } from '@/viz/shared/AudioTextures';
import { OUTPUT_GLSL } from '@/viz/shared/Shading';

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
/** The half of the tube behind the listener is only drawn when the head turns away from -Z far enough to see it. */
const BACK_VISIBLE_Z = -0.35;
/** Longitudinal lines around the circumference (independent of the mesh density). */
const SEG_LINES = 48;
/** `rings` = rows per side of the listener's plane; the tube has 2 * (rings - 1) + 1 rows. */
const QUALITY: Record<QualityLevel, { rings: number; segs: number }> = {
  low: { rings: 64, segs: 96 },
  medium: { rings: 96, segs: 160 },
  high: { rings: 128, segs: 192 },
};

// Vertex stage: places row s of the single tube that runs from -L (in front) to +L (behind) through the listener's
// plane, deforms its radius with the waveform / spectrum of the row's age and hands the fragment stage grid coordinates.
// Audio comes from the pre-blurred history textures, 3 taps each (instead of 24 + 24 raw fetches per vertex).
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

// The smooth textures already hold a 12-sample (waveform) / 5-band (spectrum) box blur and ~3 rows of temporal averaging.
// Three taps one box-width apart (and +-4 frames apart in time) with 1-2-1 weights tile that gap-free into a rounded
// profile, so nothing aliases into zig-zags and the polyline has no kinks.
float waveSm(float u, float age) {
  float a = histWaveSmooth(clamp(u - 0.047, 0.01, 0.99), age + 4.0);
  float b = histWaveSmooth(clamp(u, 0.01, 0.99), age);
  float c = histWaveSmooth(clamp(u + 0.047, 0.01, 0.99), max(age - 4.0, 0.0));
  return 0.25 * (a + c) + 0.5 * b;
}
float specSm(float band, float age) {
  float a = histFreqSmooth(clamp(band - 0.039, 0.01, 0.99), age + 4.0);
  float b = histFreqSmooth(clamp(band, 0.01, 0.99), age);
  float c = histFreqSmooth(clamp(band + 0.039, 0.01, 0.99), max(age - 4.0, 0.0));
  return 0.25 * (a + c) + 0.5 * b;
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
  float w = waveSm(0.5 - 0.5 * cos(u * 3.14159265), age);
  // spectrum (lower 60 %) of the same age wrapped around the tube: bass at the sides, highs top and bottom (smooth: sin^2)
  float sn = sin(aSeg * 6.2831853);
  float band = 0.03 + 0.57 * sn * sn;
  float sp = specSm(band, age);
  float bass = histFreqSmooth(0.08, age);

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
  float gc = clamp(mix(0.88, 0.3, pow(max(jn, 0.0), 0.6)) - 0.12 * back + 0.14 * bass, 0.0, 0.8);
  vec3 gcol = texture2D(uGradient, vec2(gc, 0.5)).rgb;
  // palettes differ a lot in luminance (greens / cyans read ~2x brighter than reds / violets at the same value): partly even that out
  float lum = dot(gcol, vec3(0.2126, 0.7152, 0.0722));
  vColor = gcol * mix(1.0, clamp(0.45 / max(lum, 0.05), 0.55, 2.0), 0.6);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

// Glowing wireframe: ring lines + longitudinal lines drawn analytically with fwidth (constant pixel width), on a
// nearly black translucent volume. One premultiplied pass (dst * (1 - a) + rgb): the volume darkens what is behind the
// tube (stars, floor, aurora) so the space between the lines stays empty, and the lines are added on top.
// Stays highp: the grid is computed from fract() of ring / segment coordinates.
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
${OUTPUT_GLSL}

// thin anti-aliased line (half width hw px, edge softness px) at every integer of x, a soft ~2.5 px band around it (0.25)
// and a short tail so lines are not hard hairlines on black; everything fades out once lines get denser than ~3-5 px
// (moire)
float gridLine(float x, float hw, float soft, float glowAmt) {
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x + 0.5) - 0.5) / fw;
  float line = 1.0 - smoothstep(hw, hw + soft, d);
  float band = 0.25 * (1.0 - smoothstep(0.0, 2.5, d));
  float tail = exp(-d * 0.7) * glowAmt;
  // lines crowding together (small spacing, large fw) dim first so the converging far field stays a calm glow, then the moire fade removes them
  float crowd = 1.0 - 0.7 * smoothstep(0.02, 0.16, fw);
  return (line + band + tail) * crowd * (1.0 - smoothstep(0.18, 0.40, fw));
}

void main() {
  // fine lines near the user, more body (up to a 0.9 px half width) further down the tunnel
  float hw = mix(0.55, 0.9, vRamp);
  float soft = mix(0.6, 1.0, vRamp);
  float glowAmt = mix(0.04, 0.12, vRamp);
  float ringL = gridLine(vK, hw, soft, glowAmt);
  float segL = gridLine(vSeg, hw * 0.85, soft, glowAmt);
  float lines = max(ringL, 0.45 * segL);
  // quiet base, bass rings stand out (squared so the contrast is kept while the average comes down); about 45 % dimmer
  // than the first version, which read as a uniformly bright full-field grid
  float energy = 0.02 + 0.25 * vBass * vBass + 0.07 * vDisp;
  // the dark surface is lit at bass rings so the lines sit in light, not on black
  // only the strongest bass rows light the surface, and only faintly: the space between lines must stay near black
  float ring = smoothstep(0.72, 0.96, vBass);
  vec3 col = vColor * (lines * energy + 0.018 * (0.4 + vBass) * ring * ring);
  // beat pulse ring travelling away from the user stays the bright accent
  col += mix(vColor, uAccent, 0.5) * vPulse * (0.03 + 0.24 * lines);
  col = min(col * (vFade * uBright), vec3(0.9));   // never let a line reach full white before the output curve
  float volume = 0.7 * vEnd * uOpacity;
  gl_FragColor = vec4(cheapOutput(col * uOpacity + uBg * (0.15 * volume)), volume);
}
`;

/**
 * One continuous tube of waveform rings through the listener's plane (-L .. +L). The front half (in front of the user)
 * and the back half (behind) are two draws of one material; the back half is skipped while the head looks forward.
 */
export class WaveTunnel implements Preset {
  readonly id = 'tunnel';
  readonly name = 'Wave Tunnel';
  readonly description = 'Fly through the waveform itself';
  readonly group = new THREE.Group();

  private frontGeo!: THREE.BufferGeometry;
  private backGeo!: THREE.BufferGeometry;
  private back!: THREE.Mesh;
  private material!: THREE.ShaderMaterial;
  private uniforms!: Record<string, THREE.IUniform>;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.PerspectiveCamera;
  private readonly forward = new THREE.Vector3();
  private scroll = 0;
  private twist = TWIST_BASE;
  private rot = 0;
  private beatAge = 99;

  init(ctx: PresetContext): void {
    this.renderer = ctx.renderer;
    this.camera = ctx.camera;
    const { rings, segs } = QUALITY[ctx.quality];
    const geos = buildTubeGeometry(rings, segs);
    this.frontGeo = geos.front;
    this.backGeo = geos.back;

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
    // The listener sits inside the tube and only ever sees its inner wall, which is the front face of these triangles,
    // so one side is enough (half the vertex and raster work of DoubleSide's two passes).
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert(rings, segs),
      fragmentShader: TUBE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.CustomBlending, // premultiplied: dst * (1 - a) + rgb
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    // Sorting uses each geometry's bounding-sphere centre (19 m away), which would draw the tube BEFORE the shared floor and stars;
    // drawn after them, the dark volume dims them, so the space between the lines stays empty.
    const front = new THREE.Mesh(this.frontGeo, this.material);
    front.frustumCulled = false;
    front.renderOrder = 1;
    this.back = new THREE.Mesh(this.backGeo, this.material);
    this.back.frustumCulled = false;
    this.back.renderOrder = 1;
    this.group.add(front, this.back);
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

    // the back half is only worth drawing when the head has turned away from -Z (in XR the renderer's own camera holds the pose)
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.getWorldDirection(this.forward);
    this.back.visible = this.forward.z > BACK_VISIBLE_Z;

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
    this.frontGeo.dispose();
    this.backGeo.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

/**
 * Indexed tube: (2 * (rings - 1) + 1) x (`segs`+1) vertices (seam duplicated so aSeg runs 0..1), two triangles per quad.
 * Two geometries share the vertex attributes and the index buffer; `front` draws the rows in front of the listener's
 * plane (aRing 0 .. 0.5) and `back` the rows behind it (0.5 .. 1). They meet exactly in the listener's plane.
 */
function buildTubeGeometry(rings: number, segs: number): { front: THREE.BufferGeometry; back: THREE.BufferGeometry } {
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
  const attrs = {
    position: new THREE.BufferAttribute(position, 3),
    aRing: new THREE.BufferAttribute(aRing, 1),
    aSeg: new THREE.BufferAttribute(aSeg, 1),
  };
  const indexAttr = new THREE.BufferAttribute(index, 1);
  const half = (rings - 1) * segs * 6; // indices of the rows in front of the plane
  const make = (start: number, num: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', attrs.position);
    geo.setAttribute('aRing', attrs.aRing);
    geo.setAttribute('aSeg', attrs.aSeg);
    geo.setIndex(indexAttr);
    geo.setDrawRange(start, num);
    return geo;
  };
  return { front: make(0, half), back: make(half, index.length - half) };
}
