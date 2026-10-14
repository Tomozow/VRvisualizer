import * as THREE from 'three';
import type { Store } from '@/app/Store';
import type { AudioFeatures, SourceKind } from '@/audio/types';
import { clamp, damp } from '@/util/device';
import { COLOR, FS, MM_PER_PX, drawText, fillRound, fitText, font, strokeRound, type Accent } from './theme';

const HUD_PX_W = 1024;
const HUD_PX_H = 176;
const TOAST_PX_W = 1024;
const TOAST_PX_H = 128;
// Same pixel density as the menu panel (≈ 0.68 mm per px), so 44–52 px type is ≥ 1.2° at 1.4 m.
const HUD_M_W = (HUD_PX_W * MM_PER_PX) / 1000;
const HUD_M_H = (HUD_PX_H * MM_PER_PX) / 1000;
const TOAST_M_W = (TOAST_PX_W * MM_PER_PX) / 1000;
const TOAST_M_H = (TOAST_PX_H * MM_PER_PX) / 1000;
const SHOW_AFTER_TRACK_CHANGE_MS = 4000;

/** Where the HUD lives: this far in front of the head, this far below the horizon (above the menu while it is open). */
const HUD_DISTANCE = 1.4;
const HUD_PITCH = THREE.MathUtils.degToRad(-10);
const HUD_PITCH_MENU_OPEN = THREE.MathUtils.degToRad(17);
/** Lazy follow: the HUD ignores head yaw inside this cone, then eases after the head. */
const FOLLOW_DEAD_ZONE = THREE.MathUtils.degToRad(18);
const FOLLOW_RATE = 3.2;

const KIND_LABEL: Record<SourceKind, string> = {
  file: 'Local file',
  url: 'Stream',
  mic: 'Microphone',
  youtube: 'YouTube',
  demo: 'Demo signal',
};

/** A small canvas-textured quad that fades in and out. */
class HudLabel {
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private material: THREE.MeshBasicMaterial;
  private level = 0;

  constructor(pxW: number, pxH: number, widthM: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, opacity: 0, depthTest: true, depthWrite: false, toneMapped: false, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, (widthM * pxH) / pxW), this.material);
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get opacity(): number {
    return this.level;
  }

  /** Ease toward the target; returns the current opacity. */
  fade(target: number, dt: number): number {
    this.level += (target - this.level) * Math.min(1, dt * 9);
    if (Math.abs(target - this.level) < 0.004) this.level = target;
    this.material.opacity = this.level;
    this.mesh.visible = this.level > 0.01;
    return this.level;
  }

  upload(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.mesh.removeFromParent();
  }
}

export interface MiniHudFrame {
  /** Head position and (unit) viewing direction in world space */
  head: THREE.Vector3;
  forward: THREE.Vector3;
  /** The big menu is currently showing */
  menuVisible: boolean;
  /** HUD / toast are allowed to render at all (VR session, or debug flag on desktop) */
  enabled: boolean;
  accent: Accent;
  accentColor: THREE.Color;
}

/**
 * Track title + beat dot and the store's toast, in front of the head (1.4 m away, 10° below the horizon) so scene /
 * volume toasts and the now-playing HUD are in view without the menu. It follows the head's yaw lazily.
 */
export class MiniHud {
  readonly group = new THREE.Group();
  private hud = new HudLabel(HUD_PX_W, HUD_PX_H, HUD_M_W);
  private toast = new HudLabel(TOAST_PX_W, TOAST_PX_H, TOAST_M_W);
  private dot: THREE.Mesh;
  private dotMat: THREE.MeshBasicMaterial;
  private pitch = HUD_PITCH;
  /** yaw (rad, 0 = looking down −z) the HUD is currently centred on, and the last known head yaw */
  private followYaw = 0;
  private headYaw = 0;
  private placed = false;

  private trackId: string | null = null;
  private trackChangedAt = -1e9;
  private shownTrackId: string | null = null;
  private shownTitle = '';
  private shownArtist: string | undefined = '';
  private shownAccent = '';
  private toastRef: object | null = null;
  private toastText = '';
  private toastUntil = 0;
  private accentKey = '';

  constructor(scene: THREE.Scene, private store: Store, private features: AudioFeatures) {
    this.group.name = 'resonance-vr-hud';
    this.dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false,
      blending: THREE.AdditiveBlending, opacity: 0,
    });
    this.dot = new THREE.Mesh(new THREE.CircleGeometry((17 / HUD_PX_W) * HUD_M_W, 24), this.dotMat);
    this.dot.renderOrder = 101;
    this.dot.frustumCulled = false;
    this.dot.position.set(((70 - HUD_PX_W / 2) / HUD_PX_W) * HUD_M_W, 0, 0.003);
    this.hud.mesh.add(this.dot);
    this.toast.mesh.position.set(0, HUD_M_H / 2 + TOAST_M_H / 2 + 0.008, 0.002);
    this.group.rotation.order = 'YXZ';
    this.group.add(this.hud.mesh, this.toast.mesh);
    scene.add(this.group);
  }

  update(dt: number, f: MiniHudFrame): void {
    const state = this.store.state;
    const now = performance.now();
    const pb = state.playback;
    const track = pb.track;

    // --- track title HUD
    const id = track ? track.id : null;
    if (id !== this.trackId) {
      this.trackId = id;
      if (id) this.trackChangedAt = now;
    }
    const fresh = now - this.trackChangedAt < SHOW_AFTER_TRACK_CHANGE_MS;
    const wantHud = f.enabled && !!track && ((pb.playing && !f.menuVisible) || fresh);
    if (track && (wantHud || this.hud.opacity > 0.01)) {
      if (
        track.id !== this.shownTrackId || track.title !== this.shownTitle || track.artist !== this.shownArtist ||
        f.accent.mainCss !== this.shownAccent
      ) {
        this.shownTrackId = track.id;
        this.shownTitle = track.title;
        this.shownArtist = track.artist;
        this.shownAccent = f.accent.mainCss;
        this.drawHud(track.title, track.artist || KIND_LABEL[track.kind], f.accent);
      }
    }
    const hudLevel = this.hud.fade(wantHud ? 1 : 0, dt);

    // --- toast
    const toast = state.toast;
    if (toast && toast !== this.toastRef) {
      this.toastRef = toast;
      this.toastUntil = toast.until;
      if (toast.text !== this.toastText || this.accentKey !== f.accent.mainCss) {
        this.toastText = toast.text;
        this.accentKey = f.accent.mainCss;
        this.drawToast(toast.text, f.accent);
      }
    } else if (!toast) {
      this.toastRef = null;
    }
    const wantToast = f.enabled && !!toast && now < this.toastUntil;
    const toastLevel = this.toast.fade(wantToast ? 1 : 0, dt);

    // --- placement: in front of the head, lazily following its yaw
    const wasVisible = this.group.visible;
    this.place(dt, f, !wasVisible && (wantHud || wantToast));
    this.group.visible = hudLevel > 0.01 || toastLevel > 0.01;

    // --- beat dot
    if (hudLevel > 0.01) {
      const beat = this.features.active ? this.features.beatEnv : 0;
      this.dot.scale.setScalar(1 + beat * 0.9);
      this.dotMat.color.copy(f.accentColor);
      this.dotMat.opacity = (0.4 + 0.6 * beat) * hudLevel;
    }
  }

  /** Position / orient the group. `snap` re-centres on the head at once (the HUD is about to appear). */
  private place(dt: number, f: MiniHudFrame, snap: boolean): void {
    if (Math.hypot(f.forward.x, f.forward.z) > 0.25) this.headYaw = Math.atan2(-f.forward.x, -f.forward.z);
    if (snap || !this.placed) {
      this.followYaw = this.headYaw;
      this.placed = true;
    } else {
      const delta = THREE.MathUtils.euclideanModulo(this.headYaw - this.followYaw + Math.PI, Math.PI * 2) - Math.PI;
      const excess = Math.abs(delta) - FOLLOW_DEAD_ZONE;
      if (excess > 0) this.followYaw += Math.sign(delta) * excess * (1 - Math.exp(-FOLLOW_RATE * dt));
    }
    // with the menu open the HUD moves above it instead of covering it
    this.pitch = damp(this.pitch, f.menuVisible ? HUD_PITCH_MENU_OPEN : HUD_PITCH, 6, dt);
    const cp = Math.cos(this.pitch);
    this.group.position.set(
      f.head.x - Math.sin(this.followYaw) * cp * HUD_DISTANCE,
      f.head.y + Math.sin(this.pitch) * HUD_DISTANCE,
      f.head.z - Math.cos(this.followYaw) * cp * HUD_DISTANCE,
    );
    // upright, facing the head, tilted by the angle it is seen from (clamped so it never leans far)
    this.group.rotation.set(clamp(this.pitch, -0.5, 0.5), this.followYaw, 0);
  }

  private drawHud(title: string, subtitle: string, a: Accent): void {
    const ctx = this.hud.ctx;
    ctx.clearRect(0, 0, HUD_PX_W, HUD_PX_H);
    fillRound(ctx, 8, 8, HUD_PX_W - 16, HUD_PX_H - 16, 44, 'rgba(8,9,20,0.9)');
    strokeRound(ctx, 10, 10, HUD_PX_W - 20, HUD_PX_H - 20, 42, a.glow, 3);
    ctx.beginPath();
    ctx.arc(70, HUD_PX_H / 2, 19, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3;
    ctx.stroke();
    const x = 118;
    const w = HUD_PX_W - x - 44;
    ctx.font = font(52, 800);
    drawText(ctx, fitText(ctx, title || 'Untitled', w), x, 80, 52, COLOR.text, { weight: 800 });
    ctx.font = font(FS.label, 600);
    drawText(ctx, fitText(ctx, subtitle, w), x, 138, FS.label, COLOR.textDim, { weight: 600 });
    this.hud.upload();
  }

  private drawToast(text: string, a: Accent): void {
    const ctx = this.toast.ctx;
    ctx.clearRect(0, 0, TOAST_PX_W, TOAST_PX_H);
    ctx.font = font(FS.body, 700);
    const label = fitText(ctx, text, TOAST_PX_W - 160);
    const tw = Math.ceil(ctx.measureText(label).width);
    const pw = Math.max(220, tw + 90);
    const px = (TOAST_PX_W - pw) / 2;
    fillRound(ctx, px, 12, pw, TOAST_PX_H - 24, 40, 'rgba(8,9,20,0.92)');
    strokeRound(ctx, px + 1.5, 13.5, pw - 3, TOAST_PX_H - 27, 39, a.glow, 3);
    drawText(ctx, label, TOAST_PX_W / 2, TOAST_PX_H / 2 + 2, FS.body, COLOR.text, { weight: 700, align: 'center', baseline: 'middle' });
    this.toast.upload();
  }

  dispose(): void {
    this.hud.dispose();
    this.toast.dispose();
    this.dot.geometry.dispose();
    this.dotMat.dispose();
    this.group.removeFromParent();
  }
}
