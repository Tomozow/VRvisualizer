import * as THREE from 'three';
import type { Actions, AppState, Store } from '@/app/Store';
import type { AudioFeatures, PlaybackState } from '@/audio/types';
import { clamp } from '@/util/device';
import {
  COLOR, PANEL_M_H, PANEL_M_W, PANEL_PX_H, PANEL_PX_W, drawText, fillRound, font, hGradient, makeAccent, renderGlass,
  strokeRound, type Accent,
} from './theme';
import { drawPlayer, drawScenes, drawSettings, drawSources } from './tabs';
import { ImageCache, WidgetList, type PanelLocal, type RenderInfo, type TabEnv, type Widget } from './ui';

const TABS: { id: AppState['tab']; label: string }[] = [
  { id: 'player', label: 'Player' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'sources', label: 'Sources' },
  { id: 'settings', label: 'Settings' },
];

/** Pointer slots: 0 and 1 are the XR controllers / hands, 2 is the desktop mouse. */
export const SLOT_COUNT = 3;
export const SLOT_MOUSE = 2;

const SHOW_SECONDS = 0.25;
const LIVE_INTERVAL_MS = 100;
const MIN_REDRAW_MS = 33;
const DRAG_REDRAW_MS = 50;
const PX_TO_M_X = PANEL_M_W / PANEL_PX_W;
const PX_TO_M_Y = PANEL_M_H / PANEL_PX_H;

interface Slot {
  /** hover widget (used for the highlight overlay) */
  hover: Widget | null;
  down: Widget | null;
  drag: Widget | null;
  inside: boolean;
  px: number;
  py: number;
}

export interface PanelOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  store: Store;
  actions: Actions;
  features: AudioFeatures;
  getAutoHide(): boolean;
  setAutoHide(v: boolean): void;
  /** called when the mouse starts / stops hovering a clickable widget */
  onCursor(pointer: boolean): void;
}

const OVERLAY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Rounded-rect SDF highlight (fill + crisp ring + soft outer glow), so hovering never needs a canvas redraw.
const OVERLAY_FRAG = /* glsl */ `
uniform vec2 uSize;
uniform float uPad;
uniform float uRadius;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uPress;
varying vec2 vUv;
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
void main() {
  vec2 p = (vUv - 0.5) * (uSize + 2.0 * uPad);
  float d = sdRoundRect(p, uSize * 0.5, uRadius);
  float fill = (1.0 - smoothstep(-1.0, 1.0, d)) * (0.09 + 0.16 * uPress);
  float ring = (1.0 - smoothstep(0.0, 2.2, abs(d - 1.5))) * (0.8 + 0.2 * uPress);
  float glow = exp(-max(d, 0.0) / 7.0) * 0.42 * step(0.0, d);
  float a = clamp((fill + ring + glow) * uAlpha, 0.0, 1.0);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.25 * uPress), a);
  #include <colorspace_fragment>
}`;

class HoverOverlay {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private static geometry: THREE.PlaneGeometry | null = null;
  private static users = 0;
  private static readonly PAD = 22;

  constructor() {
    if (!HoverOverlay.geometry) HoverOverlay.geometry = new THREE.PlaneGeometry(1, 1);
    HoverOverlay.users++;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(100, 100) },
        uPad: { value: HoverOverlay.PAD },
        uRadius: { value: 20 },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAlpha: { value: 0 },
        uPress: { value: 0 },
      },
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(HoverOverlay.geometry, this.mat);
    this.mesh.renderOrder = 101;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.position.z = 0.002;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  show(w: Widget, pressed: boolean, alpha: number, color: THREE.Color): void {
    const pad = HoverOverlay.PAD;
    const u = this.mat.uniforms;
    (u.uSize.value as THREE.Vector2).set(w.w, w.h);
    u.uRadius.value = w.r;
    (u.uColor.value as THREE.Color).copy(color);
    u.uAlpha.value = alpha;
    u.uPress.value = pressed ? 1 : 0;
    this.mesh.scale.set((w.w + pad * 2) * PX_TO_M_X, (w.h + pad * 2) * PX_TO_M_Y, 1);
    this.mesh.position.x = (w.x + w.w / 2 - PANEL_PX_W / 2) * PX_TO_M_X;
    this.mesh.position.y = (PANEL_PX_H / 2 - (w.y + w.h / 2)) * PX_TO_M_Y;
    this.mesh.visible = alpha > 0.01;
  }

  dispose(): void {
    this.mat.dispose();
    if (--HoverOverlay.users === 0 && HoverOverlay.geometry) {
      HoverOverlay.geometry.dispose();
      HoverOverlay.geometry = null;
    }
  }
}

/** Canvas-drawn world-space panel with a retained hit-rect list. */
export class Panel {
  readonly mesh: THREE.Mesh;
  accent: Accent;
  /** Accent as a linear THREE.Color, for rays / overlays */
  readonly accentColor = new THREE.Color();

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private glass: HTMLCanvasElement;
  private glassKey = '';
  private texture: THREE.CanvasTexture;
  private material: THREE.MeshBasicMaterial;
  private overlays: HoverOverlay[] = [];
  private beatDot: THREE.Mesh;
  private beatMat: THREE.MeshBasicMaterial;
  private widgets = new WidgetList();
  private images: ImageCache;
  private local: PanelLocal = { queueTop: null, lastIndex: -1, scenePage: null, lastVolume: 0.7 };
  private env: TabEnv;
  private unsub: () => void;

  private slots: Slot[] = [];
  private holds = new Map<string, { v: number; until: number }>();

  // visibility
  private shownTarget = true;
  private forceHidden = false;
  private amt = 0;
  private eased = 0;

  // redraw bookkeeping
  private dirty = true;
  private lastDrawMs = -1e9;
  private drawnSig = -2;
  private mouseHover = false;
  private beatX = 0;
  private beatY = 0;
  private nowMs = 0;

  // playhead extrapolation
  private pbRef: PlaybackState | null = null;
  private pbTime = 0;
  private pbAt = 0;

  // grab
  private grabSlot = -1;
  private grabPos = new THREE.Vector3();
  private grabQuat = new THREE.Quaternion();

  // scratch
  private inv = new THREE.Matrix4();
  private tmpN = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(private opts: PanelOptions) {
    const { renderer, scene, store } = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_PX_W;
    this.canvas.height = PANEL_PX_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.glass = document.createElement('canvas');
    this.glass.width = PANEL_PX_W;
    this.glass.height = PANEL_PX_H;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      opacity: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_M_W, PANEL_M_H), this.material);
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.rotation.order = 'YXZ';
    this.mesh.position.set(0, 1.3, -1.4);
    this.mesh.rotation.set(-0.21, 0, 0);
    this.mesh.name = 'resonance-vr-panel';
    scene.add(this.mesh);

    for (let i = 0; i < SLOT_COUNT; i++) {
      this.slots.push({ hover: null, down: null, drag: null, inside: false, px: 0, py: 0 });
      const o = new HoverOverlay();
      this.overlays.push(o);
      this.mesh.add(o.mesh);
    }

    this.beatMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.beatDot = new THREE.Mesh(new THREE.CircleGeometry(0.0105, 32), this.beatMat);
    this.beatDot.renderOrder = 101;
    this.beatDot.frustumCulled = false;
    this.beatDot.position.z = 0.003;
    this.mesh.add(this.beatDot);

    this.accent = makeAccent(undefined);
    this.refreshAccent(store.state);

    this.images = new ImageCache(() => { this.dirty = true; });

    this.env = {
      ctx: this.ctx,
      state: store.state,
      actions: opts.actions,
      features: opts.features,
      accent: this.accent,
      widgets: this.widgets,
      images: this.images,
      local: this.local,
      time: 0,
      presenting: false,
      autoHide: opts.getAutoHide(),
      setAutoHide: (v) => { opts.setAutoHide(v); this.dirty = true; },
      renderInfo: () => this.renderInfo(),
      hold: (key) => this.getHold(key),
      setHold: (key, v, ms) => { this.holds.set(key, { v, until: ms === Infinity ? Infinity : this.nowMs + ms }); },
      invalidate: () => { this.dirty = true; },
      nowMs: 0,
    };

    this.unsub = store.subscribe((state, changed) => {
      if (changed.has('palette') || changed.has('palettes')) this.refreshAccent(state);
      for (const k of changed) {
        if (k === 'toast' || k === 'menuVisible') continue;
        if (k === 'fps' && state.tab !== 'settings') continue;
        this.dirty = true;
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // visibility
  // ------------------------------------------------------------------------------------------

  get isShown(): boolean {
    return this.shownTarget && !this.forceHidden;
  }

  /** Opacity after easing (0 hidden .. 1 fully shown) */
  get opacity(): number {
    return this.eased;
  }

  get interactive(): boolean {
    return this.isShown && this.amt > 0.6;
  }

  /** True while any pointer is pressing or dragging something */
  get busy(): boolean {
    if (this.grabSlot >= 0) return true;
    for (const s of this.slots) if (s.down || s.drag) return true;
    return false;
  }

  /** True while any pointer hovers the panel */
  get hovered(): boolean {
    if (!this.interactive) return false;
    for (const s of this.slots) if (s.inside) return true;
    return false;
  }

  get grabbing(): boolean {
    return this.grabSlot >= 0;
  }

  setShown(v: boolean): void {
    if (v === this.shownTarget) return;
    this.shownTarget = v;
    if (!v) this.cancelAll();
    else this.dirty = true;
  }

  setForceHidden(v: boolean): void {
    if (v === this.forceHidden) return;
    this.forceHidden = v;
    if (v) this.cancelAll();
  }

  private cancelAll(): void {
    this.grabSlot = -1;
    for (const s of this.slots) {
      if (s.drag) s.drag.drag?.(s.px, s.py, 'end');
      s.drag = null;
      s.down = null;
      s.hover = null;
      s.inside = false;
    }
    this.setCursor(false);
  }

  private setCursor(pointer: boolean): void {
    if (pointer !== this.mouseHover) {
      this.mouseHover = pointer;
      this.opts.onCursor(pointer);
    }
  }

  // ------------------------------------------------------------------------------------------
  // placement / grab
  // ------------------------------------------------------------------------------------------

  /** Put the panel 1.4 m in front of `head` along the horizontal part of `forward`, tilted toward the face. */
  place(head: THREE.Vector3, forward: THREE.Vector3): void {
    let fx = forward.x;
    let fz = forward.z;
    const len = Math.hypot(fx, fz);
    if (len < 1e-3) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
    const dist = 1.4;
    const y = clamp(1.3, head.y - 0.6, head.y - 0.1);
    this.mesh.position.set(head.x + fx * dist, y, head.z + fz * dist);
    const pitch = clamp(Math.atan2(head.y - y, dist), 0, 0.4);
    this.mesh.rotation.set(-pitch, Math.atan2(-fx, -fz), 0);
    this.refreshMatrices();
  }

  private refreshMatrices(): void {
    this.mesh.updateMatrixWorld();
    this.inv.copy(this.mesh.matrixWorld).invert();
  }

  beginGrab(slot: number, pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
    if (this.grabSlot >= 0 || !this.interactive || !this.slots[slot].inside) return false;
    this.grabSlot = slot;
    // panel pose expressed in the controller frame
    const inv = this.tmpQ.copy(quat).invert();
    this.grabPos.copy(this.mesh.position).sub(pos).applyQuaternion(inv);
    this.grabQuat.copy(inv).multiply(this.mesh.quaternion);
    return true;
  }

  updateGrab(slot: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    if (slot !== this.grabSlot) return;
    this.mesh.quaternion.copy(quat).multiply(this.grabQuat);
    this.mesh.position.copy(this.grabPos).applyQuaternion(quat).add(pos);
    this.refreshMatrices();
  }

  endGrab(slot: number): void {
    if (slot === this.grabSlot) this.grabSlot = -1;
  }

  get grabSlotIndex(): number {
    return this.grabSlot;
  }

  // ------------------------------------------------------------------------------------------
  // pointers
  // ------------------------------------------------------------------------------------------

  /**
   * Feed a world-space pointer ray. Returns the distance to the panel plane when the ray hits the
   * panel, otherwise -1. While dragging a widget the (unclamped) plane intersection keeps driving it.
   */
  pointerRay(slot: number, origin: THREE.Vector3, dir: THREE.Vector3): number {
    const s = this.slots[slot];
    const dragging = s.drag !== null;
    if (!this.interactive && !dragging) {
      this.clearSlot(slot);
      return -1;
    }
    const n = this.tmpN.set(0, 0, 1).applyQuaternion(this.mesh.quaternion);
    const denom = dir.dot(n);
    let t = -1;
    if (denom < -1e-5) {
      t = this.tmpV.copy(this.mesh.position).sub(origin).dot(n) / denom;
    }
    if (t < 0) {
      s.inside = false;
      if (!dragging) { s.hover = null; if (slot === SLOT_MOUSE) this.setCursor(false); }
      return -1;
    }
    const p = this.tmpV.copy(dir).multiplyScalar(t).add(origin).applyMatrix4(this.inv);
    const u = p.x / PANEL_M_W + 0.5;
    const v = p.y / PANEL_M_H + 0.5;
    const px = u * PANEL_PX_W;
    const py = (1 - v) * PANEL_PX_H;
    s.inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    if (dragging) {
      if (Math.abs(px - s.px) > 0.4 || Math.abs(py - s.py) > 0.4) {
        s.px = px;
        s.py = py;
        s.drag!.drag!(px, py, 'move');
      }
      s.hover = s.drag;
    } else {
      s.px = px;
      s.py = py;
      s.hover = s.inside ? this.widgets.hit(px, py) : null;
    }
    if (slot === SLOT_MOUSE) this.setCursor(s.hover !== null);
    return s.inside ? t : -1;
  }

  /** The pointer has no ray this frame (controller lost, mouse left the canvas). */
  pointerLost(slot: number): void {
    const s = this.slots[slot];
    if (s.drag) return; // keep dragging with the last known position until the button is released
    this.clearSlot(slot);
  }

  private clearSlot(slot: number): void {
    const s = this.slots[slot];
    s.inside = false;
    s.hover = null;
    if (slot === SLOT_MOUSE) this.setCursor(false);
  }

  pointerInside(slot: number): boolean {
    return this.interactive && this.slots[slot].inside;
  }

  /** Press (down = true) or release. Returns true when the press activated a widget. */
  pointerPress(slot: number, down: boolean): boolean {
    const s = this.slots[slot];
    if (down) {
      if (!this.interactive || !s.inside || s.down) return false;
      const w = this.widgets.hit(s.px, s.py);
      if (!w) return false;
      s.down = w;
      this.dirty = true;
      if (w.drag) {
        s.drag = w;
        w.drag(s.px, s.py, 'start');
      } else if (w.click) {
        w.click();
      }
      return true;
    }
    if (s.drag) {
      const d = s.drag;
      s.drag = null;
      d.drag!(s.px, s.py, 'end');
    }
    s.down = null;
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // per-frame
  // ------------------------------------------------------------------------------------------

  /** Animate visibility, apply pose, refresh the inverse matrix used for hit tests. */
  step(dt: number): void {
    const target = this.isShown ? 1 : 0;
    if (this.amt < target) this.amt = Math.min(target, this.amt + dt / SHOW_SECONDS);
    else if (this.amt > target) this.amt = Math.max(target, this.amt - dt / SHOW_SECONDS);
    const e = 1 - Math.pow(1 - this.amt, 3);
    this.eased = e;
    const k = 0.92 + 0.08 * e;
    this.mesh.scale.set(k, k, 1);
    this.material.opacity = e;
    this.mesh.visible = e > 0.004;
    this.refreshMatrices();
  }

  /** Resolve highlights, redraw the canvas when needed, update the live overlay meshes. */
  render(nowMs: number, presenting: boolean): void {
    this.nowMs = nowMs;
    if (!this.mesh.visible) {
      for (const o of this.overlays) o.hide();
      return;
    }
    this.syncClock(nowMs);

    const sinceDraw = nowMs - this.lastDrawMs;
    let dragging = false;
    for (const s of this.slots) if (s.drag) dragging = true;
    let need = false;
    if (this.dirty && sinceDraw >= (dragging ? DRAG_REDRAW_MS : MIN_REDRAW_MS)) need = true;
    else if (sinceDraw >= LIVE_INTERVAL_MS && this.liveSig(nowMs) !== this.drawnSig) need = true;
    if (need) this.draw(nowMs, presenting);

    // hover / pressed highlights
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this.slots[i];
      const w = s.hover;
      if (w && this.interactive) {
        const pressed = s.down !== null && (s.down === w || s.down.key === w.key);
        this.overlays[i].show(w, pressed, this.eased, this.accentColor);
      } else {
        this.overlays[i].hide();
      }
    }

    // beat dot
    const f = this.opts.features;
    const beat = f.active ? f.beatEnv : 0;
    this.beatDot.scale.setScalar(1 + beat * 0.9);
    this.beatMat.opacity = (0.4 + 0.6 * beat) * this.eased;
    this.beatDot.position.x = (this.beatX - PANEL_PX_W / 2) * PX_TO_M_X;
    this.beatDot.position.y = (PANEL_PX_H / 2 - this.beatY) * PX_TO_M_Y;
  }

  private syncClock(nowMs: number): void {
    const pb = this.opts.store.state.playback;
    if (pb !== this.pbRef || pb.currentTime !== this.pbTime) {
      this.pbRef = pb;
      this.pbTime = pb.currentTime;
      this.pbAt = nowMs;
    }
  }

  private displayTime(nowMs: number): number {
    const pb = this.opts.store.state.playback;
    let t = pb.currentTime;
    if (pb.playing && pb.status !== 'loading') t += (nowMs - this.pbAt) / 1000;
    if (pb.duration > 0 && t > pb.duration) t = pb.duration;
    return t;
  }

  private liveSig(nowMs: number): number {
    const s = this.opts.store.state;
    switch (s.tab) {
      case 'player': {
        const pb = s.playback;
        if (!pb.track || !pb.playing) return -1;
        const t = this.displayTime(nowMs);
        return Math.floor(t) * 1000 + (pb.duration > 0 ? Math.round((t / pb.duration) * 690) : 0);
      }
      case 'sources': {
        const f = this.opts.features;
        return Math.round(f.level * 26) * 4 + (f.silence ? 1 : 0) + (f.active ? 2 : 0);
      }
      case 'settings':
        return Math.floor(nowMs / 1000);
      default:
        return -1;
    }
  }

  private getHold(key: string): number | undefined {
    const h = this.holds.get(key);
    if (!h) return undefined;
    if (this.nowMs >= h.until) {
      this.holds.delete(key);
      return undefined;
    }
    return h.v;
  }

  private renderInfo(): RenderInfo {
    const r = this.opts.renderer;
    const session = r.xr.getSession();
    return {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      frameRate: session && session.frameRate ? Math.round(session.frameRate) : 0,
    };
  }

  private refreshAccent(state: AppState): void {
    this.accent = makeAccent(state.palettes.find((p) => p.id === state.palette));
    const [r, g, b] = this.accent.main;
    this.accentColor.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    this.beatMat.color.copy(this.accentColor);
    if (this.env) this.env.accent = this.accent;
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------------------
  // drawing
  // ------------------------------------------------------------------------------------------

  private draw(nowMs: number, presenting: boolean): void {
    const ctx = this.ctx;
    const state = this.opts.store.state;
    const env = this.env;
    if (this.glassKey !== this.accent.key + this.accent.mainCss) {
      renderGlass(this.glass, this.accent);
      this.glassKey = this.accent.key + this.accent.mainCss;
    }
    env.state = state;
    env.accent = this.accent;
    env.nowMs = nowMs;
    env.time = this.displayTime(nowMs);
    env.presenting = presenting;
    env.autoHide = this.opts.getAutoHide();

    ctx.clearRect(0, 0, PANEL_PX_W, PANEL_PX_H);
    ctx.drawImage(this.glass, 0, 0);
    this.widgets.clear();
    this.drawHeader(state);
    switch (state.tab) {
      case 'player': drawPlayer(env); break;
      case 'scenes': drawScenes(env); break;
      case 'sources': drawSources(env); break;
      case 'settings': drawSettings(env); break;
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.lastDrawMs = nowMs;
    this.drawnSig = this.liveSig(nowMs);

    // the layout may have changed under a stationary pointer
    for (const s of this.slots) {
      if (!s.drag) s.hover = s.inside ? this.widgets.hit(s.px, s.py) : null;
    }
  }

  private drawHeader(state: AppState): void {
    const ctx = this.ctx;
    const a = this.accent;
    // logo mark: three equaliser bars
    const bars = [34, 58, 42];
    bars.forEach((h, i) => fillRound(ctx, 70 + i * 18, 94 - h / 2, 11, h, 5.5, hGradient(ctx, 70, 124, a.mainCss, a.altCss)));
    ctx.font = font(52, 800);
    ctx.letterSpacing = '7px';
    drawText(ctx, 'RESONANCE', 142, 112, 52, COLOR.text, { weight: 800, spacing: 7 });
    ctx.font = font(52, 800);
    ctx.letterSpacing = '7px';
    const tw = ctx.measureText('RESONANCE').width;
    ctx.letterSpacing = '0px';
    drawText(ctx, 'VR', 142 + tw + 12, 112, 52, a.mainCss, { weight: 800, spacing: 4 });
    ctx.font = font(52, 800);
    const vw = ctx.measureText('VR').width + 8;
    this.beatX = 142 + tw + 12 + vw + 52;
    this.beatY = 94;
    ctx.beginPath();
    ctx.arc(this.beatX, this.beatY, 21, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // tabs
    const tabW = 300;
    const gap = 8;
    const x0 = 1984 - (tabW * TABS.length + gap * (TABS.length - 1));
    TABS.forEach((t, i) => {
      const x = x0 + i * (tabW + gap);
      const y = 52;
      const h = 84;
      const active = state.tab === t.id;
      if (active) {
        fillRound(ctx, x, y, tabW, h, 42, a.soft);
        strokeRound(ctx, x + 1.5, y + 1.5, tabW - 3, h - 3, 41, a.glow, 3);
      }
      drawText(ctx, t.label, x + tabW / 2, y + h / 2 + 2, 44, active ? COLOR.text : COLOR.textDim, { weight: active ? 800 : 600, align: 'center', baseline: 'middle' });
      this.widgets.add({ key: `tab-${t.id}`, x, y, w: tabW, h, r: 42, click: () => this.opts.actions.setTab(t.id) });
    });
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(64, 158, 1920, 2);
  }

  dispose(): void {
    this.unsub();
    this.cancelAll();
    this.mesh.removeFromParent();
    for (const o of this.overlays) o.dispose();
    this.beatDot.geometry.dispose();
    this.beatMat.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.images.dispose();
  }
}
