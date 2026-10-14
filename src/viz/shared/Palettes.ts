import * as THREE from 'three';
import type { Palette, PaletteState } from '@/viz/types';

export const PALETTES: Palette[] = [
  { id: 'neon-sunset', name: 'Neon Sunset', stops: ['#1b0b3a', '#7a1fa2', '#ff3d7f', '#ff9f43', '#ffe08a'], background: '#05030c', accent: '#ffb84d' },
  { id: 'cyber-ice', name: 'Cyber Ice', stops: ['#03101f', '#0f4c81', '#1fa2ff', '#7df9ff', '#d9fbff'], background: '#020812', accent: '#5ef2ff' },
  { id: 'aurora', name: 'Aurora', stops: ['#061a1f', '#0b6e4f', '#2ee6a6', '#9cff8a', '#dcffd0'], background: '#02090b', accent: '#b6ff5c' },
  { id: 'ember', name: 'Ember', stops: ['#1a0500', '#7a1e00', '#ff4d00', '#ffb000', '#ffe2a0'], background: '#0a0302', accent: '#ffc233' },
  { id: 'vapor', name: 'Vapor', stops: ['#1a1040', '#5a2ca0', '#ff6ec7', '#7cf5ff', '#e8f6ff'], background: '#07051a', accent: '#7cf5ff' },
  { id: 'ultraviolet', name: 'Ultraviolet', stops: ['#0a0014', '#3a0ca3', '#7209b7', '#f72585', '#ffb3d9'], background: '#040010', accent: '#ff5fa8' },
  { id: 'mono', name: 'Monochrome', stops: ['#0b0b0f', '#3a3a48', '#9a9ab0', '#d8d8e8', '#f2f2ff'], background: '#050507', accent: '#cfd2ff' },
];

/** Build a 256x1 gradient from colour stops (colours are interpolated in linear RGB). */
export function buildGradient(target: Uint8Array, stops: string[]): void {
  const cols = stops.map((s) => new THREE.Color(s));
  const n = cols.length;
  const tmp = new THREE.Color();
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (n - 1);
    const i0 = Math.min(Math.floor(t), n - 2);
    const f = t - i0;
    tmp.copy(cols[i0]).lerp(cols[i0 + 1], f);
    target[i * 4 + 0] = Math.round(THREE.MathUtils.clamp(tmp.r, 0, 1) * 255);
    target[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(tmp.g, 0, 1) * 255);
    target[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(tmp.b, 0, 1) * 255);
    target[i * 4 + 3] = 255;
  }
}

/**
 * Palette state with smooth crossfade. Call `update(dt)` every frame; the gradient texture and
 * convenience colours ease toward the target palette so colour changes never pop.
 */
export class PaletteController {
  readonly state: PaletteState;
  private from = new Uint8Array(256 * 4);
  private to = new Uint8Array(256 * 4);
  private data = new Uint8Array(256 * 4);
  private fromColors = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private toColors = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private t = 1;

  constructor(initial: Palette) {
    const tex = new THREE.DataTexture(this.data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    this.state = {
      palette: initial,
      gradient: tex,
      primary: new THREE.Color(),
      secondary: new THREE.Color(),
      accent: new THREE.Color(),
      background: new THREE.Color(),
      blend: 1,
    };
    this.setPalette(initial, true);
  }

  setPalette(p: Palette, immediate = false): void {
    this.state.palette = p;
    this.from.set(this.data);
    buildGradient(this.to, p.stops);
    for (let i = 0; i < 4; i++) this.fromColors[i].copy(this.toColors[i]);
    const n = p.stops.length;
    this.toColors[0].set(p.stops[Math.min(n - 2, Math.max(1, Math.floor(n * 0.5)))]);
    this.toColors[1].set(p.stops[Math.max(0, n - 2)]);
    this.toColors[2].set(p.accent ?? p.stops[n - 1]);
    this.toColors[3].set(p.background);
    this.t = immediate ? 1 : 0;
    this.apply();
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / 1.2);
    this.apply();
  }

  private apply(): void {
    const t = this.t < 1 ? this.t * this.t * (3 - 2 * this.t) : 1;
    for (let i = 0; i < this.data.length; i++) {
      this.data[i] = Math.round(this.from[i] + (this.to[i] - this.from[i]) * t);
    }
    this.state.gradient.needsUpdate = true;
    this.state.primary.copy(this.fromColors[0]).lerp(this.toColors[0], t);
    this.state.secondary.copy(this.fromColors[1]).lerp(this.toColors[1], t);
    this.state.accent.copy(this.fromColors[2]).lerp(this.toColors[2], t);
    this.state.background.copy(this.fromColors[3]).lerp(this.toColors[3], t);
    this.state.blend = t;
  }
}
