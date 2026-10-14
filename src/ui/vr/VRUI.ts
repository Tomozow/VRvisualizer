import * as THREE from 'three';
import type { Actions, Store } from '@/app/Store';
import type { AudioFeatures } from '@/audio/types';
import { clamp } from '@/util/device';
import { Controllers, type ControllerHandlers, type StickDir, type XRPointer } from './Controllers';
import { MiniHud } from './MiniHud';
import { Panel, SLOT_MOUSE } from './Panel';

export interface VRUIOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  store: Store;
  actions: Actions;
  features: AudioFeatures;
}

const AUTOHIDE_SECONDS = 12;
const AUTOHIDE_STORAGE_KEY = 'resonance-vr.vrui.autohide';
const VOLUME_STEP = 0.05;
/** Re-place the menu in front of the user when it is re-shown while this far (cos of the angle) off-axis. */
const RESHOW_MIN_COS = Math.cos(THREE.MathUtils.degToRad(75));

/**
 * In-VR user interface: controllers / hands with laser pointers, the world-space menu panel, the mini HUD
 * and toast. Also provides a mouse fallback on desktop so the panel can be used (and screenshot-tested)
 * without a headset.
 */
export class VRUI {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private store: Store;
  private actions: Actions;
  private controllers: Controllers;
  private panel: Panel;
  private hud: MiniHud;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private mouse = { has: false, down: false, pointerId: -1 };

  private clock = 0;
  private lastInteraction = 0;
  private autoHide = true;
  private visible = true;
  private pendingRecenter = -1;
  private debugHud = false;
  private cleanup: (() => void)[] = [];

  // scratch
  private head = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private toPanel = new THREE.Vector3();

  constructor(opts: VRUIOptions) {
    this.renderer = opts.renderer;
    this.camera = opts.camera;
    this.store = opts.store;
    this.actions = opts.actions;
    const params = new URLSearchParams(location.search);
    this.debugHud = params.has('vrhud');
    try {
      this.autoHide = localStorage.getItem(AUTOHIDE_STORAGE_KEY) !== '0';
    } catch {
      /* storage unavailable: keep the default */
    }

    this.panel = new Panel({
      renderer: opts.renderer,
      scene: opts.scene,
      store: opts.store,
      actions: opts.actions,
      features: opts.features,
      getAutoHide: () => this.autoHide,
      setAutoHide: (v) => this.setAutoHide(v),
      onCursor: (pointer) => { opts.renderer.domElement.style.cursor = pointer ? 'pointer' : ''; },
    });
    this.hud = new MiniHud(opts.scene, opts.store, opts.features);

    const handlers: ControllerHandlers = {
      selectStart: (p) => this.onSelectStart(p),
      selectEnd: (p) => { this.panel.pointerPress(p.slot, false); },
      squeezeStart: (p) => this.onSqueezeStart(p),
      squeezeEnd: (p) => this.panel.endGrab(p.slot),
      stick: (p, dir) => this.onStick(p, dir),
      buttonA: (p) => { this.reveal(); this.actions.toggle(); p.pulse(0.3, 30); },
      buttonB: (p) => { this.actions.toggleMenu(); p.pulse(0.3, 30); },
      activity: () => this.touch(),
    };
    this.controllers = new Controllers(opts.renderer, opts.scene, handlers);

    // keep the panel in sync with the store (the DOM UI and keyboard can toggle it too)
    const unsub = opts.store.subscribe((state, changed) => {
      if (changed.has('menuVisible')) {
        this.panel.setShown(state.menuVisible);
        if (state.menuVisible) {
          this.touch();
          this.recenterIfBehind();
        }
      }
    });
    this.cleanup.push(unsub);

    if (params.get('nomenu') === '1') opts.actions.setMenuVisible(false);
    this.panel.setShown(opts.store.state.menuVisible);

    const xr = opts.renderer.xr;
    const onStart = (): void => {
      this.pendingRecenter = 0.35; // let the headset deliver its first pose
      this.touch();
      this.recenter();
    };
    const onEnd = (): void => {
      this.pendingRecenter = -1;
      this.recenter();
    };
    xr.addEventListener('sessionstart', onStart);
    xr.addEventListener('sessionend', onEnd);
    this.cleanup.push(() => xr.removeEventListener('sessionstart', onStart), () => xr.removeEventListener('sessionend', onEnd));

    this.bindMouse();
    this.recenter();
  }

  // ------------------------------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------------------------------

  update(dt: number, t: number): void {
    this.clock = t;
    const nowMs = performance.now();
    const xr = this.renderer.xr.isPresenting;
    const state = this.store.state;

    if (this.pendingRecenter >= 0) {
      this.pendingRecenter -= dt;
      if (this.pendingRecenter < 0) this.recenter();
    }

    this.panel.step(dt);

    // 1. poses + buttons (callbacks fire in here, each re-aims at the fresh panel pose when needed)
    this.controllers.update(dt);

    // 2. grabbing moves the panel; do it before hit-testing
    for (const p of this.controllers.pointers) {
      if (this.panel.grabSlotIndex === p.slot) {
        if (p.squeeze && p.hasRay) this.panel.updateGrab(p.slot, p.origin, p.quaternion);
        else this.panel.endGrab(p.slot);
      }
    }

    // 3. hover / drag for every pointer
    for (const p of this.controllers.pointers) {
      if (xr) this.feed(p);
      else {
        this.panel.pointerLost(p.slot);
        p.hitDistance = -1;
      }
    }
    this.feedMouse(xr);

    // 4. auto-hide
    if (this.panel.hovered || this.panel.busy) this.touch();
    if (
      xr && this.autoHide && state.menuVisible && state.playback.playing && !this.panel.busy &&
      this.clock - this.lastInteraction > AUTOHIDE_SECONDS
    ) {
      this.actions.setMenuVisible(false);
    }

    // 5. draw
    this.panel.render(nowMs, xr);
    this.controllers.updateVisuals(dt, this.visible && this.panel.opacity > 0.05, this.panel.accentColor);
    this.hud.update(dt, {
      anchorPos: this.panel.mesh.position,
      anchorQuat: this.panel.mesh.quaternion,
      menuVisible: this.panel.isShown && this.panel.opacity > 0.05,
      enabled: this.visible && (xr || this.debugHud),
      accent: this.panel.accent,
      accentColor: this.panel.accentColor,
    });
  }

  /** Put the panel back in front of the user (XR head pose, or the desktop camera). */
  recenter(): void {
    const xrCam = this.renderer.xr.getCamera();
    if (this.renderer.xr.isPresenting && xrCam.cameras.length > 0) {
      this.head.copy(xrCam.position);
      this.forward.set(0, 0, -1).applyQuaternion(xrCam.quaternion);
    } else {
      this.camera.getWorldPosition(this.head);
      this.camera.getWorldDirection(this.forward);
    }
    this.panel.place(this.head, this.forward);
    this.touch();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.panel.setForceHidden(!v);
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
    this.renderer.domElement.style.cursor = '';
    this.controllers.dispose();
    this.panel.dispose();
    this.hud.dispose();
  }

  // ------------------------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------------------------

  private touch(): void {
    this.lastInteraction = this.clock;
  }

  private reveal(): void {
    if (!this.store.state.menuVisible) this.actions.setMenuVisible(true);
  }

  private setAutoHide(v: boolean): void {
    this.autoHide = v;
    this.touch();
    try {
      localStorage.setItem(AUTOHIDE_STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  private feed(p: XRPointer): void {
    if (p.hasRay) p.hitDistance = this.panel.pointerRay(p.slot, p.origin, p.direction);
    else {
      this.panel.pointerLost(p.slot);
      p.hitDistance = -1;
    }
  }

  private onSelectStart(p: XRPointer): void {
    if (!this.panel.interactive) {
      this.reveal();
      return;
    }
    this.feed(p);
    if (this.panel.pointerPress(p.slot, true)) p.pulse(0.4, 40);
  }

  private onSqueezeStart(p: XRPointer): void {
    if (!this.panel.interactive) {
      this.reveal();
      return;
    }
    this.feed(p);
    if (p.hasRay && this.panel.beginGrab(p.slot, p.origin, p.quaternion)) p.pulse(0.3, 30);
  }

  private onStick(p: XRPointer, dir: StickDir): void {
    this.reveal();
    const s = this.store.state;
    switch (dir) {
      case 'left':
      case 'right': {
        if (dir === 'left') this.actions.prevPreset();
        else this.actions.nextPreset();
        const cur = this.store.state.presets.find((x) => x.id === this.store.state.preset);
        if (cur) this.actions.toast(cur.name, 1400);
        p.pulse(0.2, 25);
        break;
      }
      case 'up':
      case 'down': {
        const v = clamp(Math.round((s.playback.volume + (dir === 'up' ? VOLUME_STEP : -VOLUME_STEP)) * 100) / 100, 0, 1);
        this.actions.setVolume(v);
        this.actions.toast(`Volume ${Math.round(v * 100)}%`, 900);
        p.pulse(0.12, 15);
        break;
      }
    }
  }

  /** When the menu comes back while the user looks elsewhere, bring it into view. */
  private recenterIfBehind(): void {
    const xrCam = this.renderer.xr.getCamera();
    if (!this.renderer.xr.isPresenting || xrCam.cameras.length < 1 || this.panel.grabbing) return;
    this.head.copy(xrCam.position);
    this.forward.set(0, 0, -1).applyQuaternion(xrCam.quaternion);
    this.forward.y = 0;
    this.toPanel.copy(this.panel.mesh.position).sub(this.head);
    this.toPanel.y = 0;
    const fl = this.forward.length();
    const pl = this.toPanel.length();
    if (fl < 1e-3 || pl < 1e-3) {
      this.recenter();
      return;
    }
    if (this.forward.dot(this.toPanel) / (fl * pl) < RESHOW_MIN_COS) this.recenter();
  }

  // ------------------------------------------------------------------------------------------
  // desktop mouse fallback
  // ------------------------------------------------------------------------------------------

  private bindMouse(): void {
    const el = this.renderer.domElement;
    const setNdc = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.mouse.has = true;
    };
    const onMove = (e: PointerEvent): void => {
      setNdc(e);
    };
    // Capture phase so a click on the panel never reaches OrbitControls (it would start orbiting).
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || this.renderer.xr.isPresenting) return;
      setNdc(e);
      this.feedMouse(false);
      if (!this.panel.pointerInside(SLOT_MOUSE)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this.mouse.down = true;
      this.mouse.pointerId = e.pointerId;
      this.touch();
      this.panel.pointerPress(SLOT_MOUSE, true);
    };
    const onUp = (e: PointerEvent): void => {
      if (!this.mouse.down || e.pointerId !== this.mouse.pointerId) return;
      e.stopImmediatePropagation();
      this.mouse.down = false;
      this.panel.pointerPress(SLOT_MOUSE, false);
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    const onLeave = (): void => {
      this.mouse.has = false;
      if (!this.mouse.down) this.panel.pointerLost(SLOT_MOUSE);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointerup', onUp, { capture: true });
    el.addEventListener('pointercancel', onUp, { capture: true });
    el.addEventListener('pointerleave', onLeave);
    this.cleanup.push(() => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.removeEventListener('pointercancel', onUp, { capture: true });
      el.removeEventListener('pointerleave', onLeave);
    });
  }

  private feedMouse(xr: boolean): void {
    if (xr || !this.mouse.has) {
      this.panel.pointerLost(SLOT_MOUSE);
      return;
    }
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.panel.pointerRay(SLOT_MOUSE, this.raycaster.ray.origin, this.raycaster.ray.direction);
  }
}
