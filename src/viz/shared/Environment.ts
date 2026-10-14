import * as THREE from 'three';
import type { AudioFeatures, } from '@/audio/types';
import type { PaletteState, QualityLevel, VizParams } from '@/viz/types';

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
        uniform vec3 uColor; uniform float uOpacity;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = 1.0 - smoothstep(0.0, 0.5, length(c));
          vec3 col = mix(vec3(1.0), uColor, 0.35);
          gl_FragColor = vec4(col * d * vA, 1.0) * uOpacity;
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    const floorGeo = new THREE.PlaneGeometry(120, 120, 1, 1);
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBeat: { value: 0 },
        uBass: { value: 0 },
        uColor: { value: palette.primary },
        uColor2: { value: palette.accent },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uBeat, uBass, uOpacity; uniform vec3 uColor, uColor2;
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vec2 p = vWorld.xz;
          float r = length(p);
          // grid lines
          vec2 g = abs(fract(p * 0.5 - 0.5) - 0.5) / fwidth(p * 0.5);
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          // radial rings travelling outward on beats
          float ring = smoothstep(0.08, 0.0, abs(fract(r * 0.18 - uTime * 0.25) - 0.5) - 0.42) * uBeat;
          float fade = exp(-r * 0.09);
          vec3 col = uColor * line * 0.35 + uColor2 * ring * 0.8 + uColor * 0.03 * uBass;
          gl_FragColor = vec4(col * fade, 1.0) * uOpacity;
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
