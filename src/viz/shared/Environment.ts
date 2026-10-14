import * as THREE from 'three';
import type { AudioFeatures, } from '@/audio/types';
import type { PaletteState, QualityLevel, VizParams } from '@/viz/types';
import { OUTPUT_GLSL } from '@/viz/shared/Shading';

/**
 * Persistent environment shared by all presets: a distant star field and a subtle floor grid that
 * pulses with the beat. Kept deliberately understated so presets stay the focus.
 */
export class Environment {
  readonly group = new THREE.Group();
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private floor: THREE.Mesh;
  private floorMat: THREE.ShaderMaterial;

  constructor(private palette: PaletteState, quality: QualityLevel) {
    const starCount = quality === 'low' ? 1500 : quality === 'medium' ? 3000 : 5000;
    const pos = new Float32Array(starCount * 3);
    const seed = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      // uniform on a sphere shell between 60 and 120 m
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 60;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(phi);
      pos[i * 3 + 1] = Math.abs(r * u) * 0.9 + 2; // keep stars above the horizon
      pos[i * 3 + 2] = r * s * Math.sin(phi);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTreble: { value: 0 },
        uColor: { value: palette.accent },
        uOpacity: { value: 1 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uTime; uniform float uTreble; uniform float uPixelRatio;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float tw = 0.55 + 0.45 * sin(uTime * (0.8 + seed * 2.0) + seed * 40.0);
          vA = tw * (0.35 + 0.65 * seed) * (0.7 + 0.6 * uTreble);
          gl_PointSize = (1.2 + seed * 2.2 + uTreble * 1.5) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uColor; uniform float uOpacity;
        varying float vA;
        ${OUTPUT_GLSL}
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = 1.0 - smoothstep(0.0, 0.5, length(c));
          vec3 col = mix(vec3(1.0), uColor, 0.35);
          gl_FragColor = vec4(cheapOutputAdditive(col * d * vA * uOpacity), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    const floorGeo = new THREE.PlaneGeometry(180, 180, 1, 1);
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBeat: { value: 0 },
        uBass: { value: 0 },
        uColor: { value: palette.primary },
        uColor2: { value: palette.accent },
        uColor3: { value: palette.secondary },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uBeat, uBass, uOpacity; uniform vec3 uColor, uColor2, uColor3;
        varying vec2 vUv; varying vec3 vWorld;
        ${OUTPUT_GLSL}
        float gauss(float x, float s) { return exp(-x * x / (2.0 * s * s)); }
        void main() {
          vec2 p = vWorld.xz;
          float r = length(p);
          // 1 m grid, anti-aliased, fading out toward 25 m; a finer 0.25 m grid close to the feet
          vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          vec2 g2 = abs(fract(p * 4.0 - 0.5) - 0.5) / fwidth(p * 4.0);
          float fine = (1.0 - min(min(g2.x, g2.y), 1.0)) * (1.0 - smoothstep(2.5, 5.0, r)) * 0.25;
          float gridFade = exp(-r * 0.045);
          // soft light pool under the user, breathing with bass
          float pool = gauss(r, 1.5) * (0.04 + 0.10 * uBass);
          // static concentric rings that give the floor scale, lifted by bass
          float rings = (gauss(r - 4.0, 0.10) + gauss(r - 7.0, 0.11) + gauss(r - 10.0, 0.12) + gauss(r - 14.0, 0.14)) * (0.05 + 0.08 * uBass);
          rings *= exp(-r * 0.035);
          // one bright ring per beat travelling outward (smoothstep edges ascending)
          float wave = fract(uTime * 0.3);
          float wr = wave * 24.0;
          float beatRing = gauss(r - wr, 0.25 + wave * 0.6) * uBeat * (1.0 - wave) * 0.9;
          // faint horizon glow far away so the floor never ends in a hard void
          float horizon = smoothstep(28.0, 52.0, r) * (1.0 - smoothstep(52.0, 85.0, r)) * 0.07;
          vec3 col = uColor * (line * 0.30 + fine) * gridFade
                   + uColor * pool
                   + uColor3 * rings
                   + uColor2 * beatRing
                   + uColor3 * horizon;
          gl_FragColor = vec4(cheapOutputAdditive(col * uOpacity), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.floor = new THREE.Mesh(floorGeo, this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0;
    this.group.add(this.floor);
  }

  setPixelRatio(pr: number): void {
    this.starMat.uniforms.uPixelRatio.value = pr;
  }

  update(f: AudioFeatures, dt: number, t: number, params: VizParams): void {
    this.starMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTreble.value = Math.min(1, f.treble * params.intensity);
    this.starMat.uniforms.uOpacity.value = 0.6 + 0.4 * params.glow;
    this.floorMat.uniforms.uTime.value = t * params.speed;
    this.floorMat.uniforms.uBeat.value = f.beatEnv * params.intensity;
    this.floorMat.uniforms.uBass.value = f.bass;
    this.floorMat.uniforms.uOpacity.value = 0.5 + 0.5 * params.glow;
  }

  dispose(): void {
    this.stars.geometry.dispose();
    this.starMat.dispose();
    this.floor.geometry.dispose();
    this.floorMat.dispose();
  }
}
