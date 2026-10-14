import * as THREE from 'three';
import type { Actions, Store } from '@/app/Store';
import type { AudioFeatures } from '@/audio/types';
import { LABELS } from '@/ui/labels';
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
/** The menu never hides on its own before this long into a session, nor before the user has used it once. */
const AUTOHIDE_MIN_SESSION_SECONDS = 30;
/** The "how to get it back" toast accompanies the first few auto-hides only (counted across sessions). */
const HIDE_HINT_STORAGE_KEY = 'resonance-vr.vrui.hidehints';
const HIDE_HINT_MAX = 3;
const HIDE_HINT_PINCH = 'Menu hidden. Pinch to bring it back';
const VOLUME_STEP = 0.05;
/** Status checks (silence, suspended audio) run at this rate at most. */
const STATUS_INTERVAL_SECONDS = 0.25;
/** Playing but silent for this long: tell the user (the engine's own silence flag already needs > 1 s). */
const NO_SOUND_SECONDS = 3;
/** This long after a session starts, "playing" without a running analyser means the audio context is still suspended. */
const SOUND_CHECK_DELAY_SECONDS = 1.5;
const SOUND_PROMPT = 'Tap ▶ to start sound';
const HAPTIC_TICK = { strength: 0.08, ms: 10 } as const;
/** Hover ticks closer together than this are dropped (a ray sweeping over a row of buttons). */
const HAPTIC_TICK_MIN_MS = 35;
/** Re-place the menu in front of the user when it is re-shown while this far (cos of the angle) off-axis... */
const RESHOW_MIN_COS = Math.cos(THREE.MathUtils.degToRad(75));
/** ...or this far (m) from the head, e.g. after walking away from where it was left. */
const RESHOW_MAX_DISTANCE = 2.2;
/** Second recentre this long after a session starts, once tracking has settled (skipped if the menu is in use). */
const SETTLE_SECONDS = 0.35;

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
  private features: AudioFeatures;
  private controllers: Controllers;
  private panel: Panel;
  private hud: MiniHud;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private mouse = { has: false, down: false, pointerId: -1 };

  private clock = 0;
  private lastInteraction = 0;
  private autoHide = true;
  /** clock time the current XR session started, and whether the user has used the menu in it */
  private sessionStart = 0;
  private interacted = false;
  private hideHints = 0;
  // status polling (≤ 4 Hz): silence, and audio that never started after entering VR
  private statusTimer = 0;
  private silentSince = -1;
  private noSound = false;
  private soundCheckAt = -1;
  private soundPrompt = false;
  private lastTickAt = [0, 0];
  /** the XR reference space whose `reset` (the user re-centred the headset) moves the menu back in front of them */
  private refSpace: XRReferenceSpace | null = null;
  private onSpaceReset = (): void => {
    // the next frame's pose lives in the new origin: place the panel then (an XRFrame is only valid inside the frame loop)
    this.headValid = false;
    this.recenterPending = true;
  };
  private visible = true;
  /** recentre on the first frame that has a head pose of the current session */
  private recenterPending = false;
  private settleTimer = -1;
  private debugHud = false;
  private cleanup: (() => void)[] = [];

  // Head pose (XR viewer pose, or the desktop camera), refreshed every frame. `headValid` is false from the
  // start of a session until its first pose arrives, so a previous session's pose is never used.
  private headPos = new THREE.Vector3();
  private headQuat = new THREE.Quaternion();
  private headForward = new THREE.Vector3();
  private headValid = false;

  // scratch
  private forward = new THREE.Vector3();
  private toPanel = new THREE.Vector3();
  private parentPos = new THREE.Vector3();
  private parentQuat = new THREE.Quaternion();
  private parentScale = new THREE.Vector3();

  constructor(opts: VRUIOptions) {
    this.renderer = opts.renderer;
    this.camera = opts.camera;
    this.store = opts.store;
    this.actions = opts.actions;
    this.features = opts.features;
    const params = new URLSearchParams(location.search);
    this.debugHud = params.has('vrhud');
    try {
      this.autoHide = localStorage.getItem(AUTOHIDE_STORAGE_KEY) !== '0';
      this.hideHints = Number.parseInt(localStorage.getItem(HIDE_HINT_STORAGE_KEY) ?? '0', 10) || 0;
    } catch {
      /* storage unavailable: keep the defaults */
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
      onHide: () => this.hideMenu(),
      onTick: (slot) => this.tick(slot),
    });
    this.hud = new MiniHud(opts.scene, opts.store, opts.features);

    const handlers: ControllerHandlers = {
      selectStart: (p) => this.onSelectStart(p),
      selectEnd: (p) => { this.panel.pointerPress(p.slot, false); },
      squeezeStart: (p) => this.onSqueezeStart(p),
      squeezeEnd: (p) => this.panel.endGrab(p.slot),
      stick: (p, dir) => this.onStick(p, dir),
      // Shortcuts act without opening the menu; their feedback is a toast. Only B / Y, trigger and grip reveal it.
      buttonA: (p) => {
        const willPlay = !this.store.state.playback.playing;
        this.actions.toggle();
        this.actions.toast(willPlay ? 'Playing' : 'Paused', 1200);
        p.pulse(0.3, 30);
      },
      buttonB: (p) => {
        const hiding = this.store.state.menuVisible;
        this.actions.toggleMenu();
        if (hiding) this.actions.toast('Menu hidden', 1400);
        p.pulse(0.3, 30);
      },
      buttonBHold: (p) => this.bringMenuHere(p),
      activity: () => this.touchIfVisible(),
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
      // The XR camera still holds the previous session's pose here: wait for the first frame that has a fresh one.
      this.headValid = false;
      this.recenterPending = true;
      this.settleTimer = SETTLE_SECONDS;
      this.sessionStart = this.clock;
      this.interacted = false;
      this.soundCheckAt = this.clock + SOUND_CHECK_DELAY_SECONDS;
      this.touch();
      this.unwatchReferenceSpace();
      this.refSpace = xr.getReferenceSpace();
      this.refSpace?.addEventListener('reset', this.onSpaceReset);
    };
    const onEnd = (): void => {
      // App resets the desktop camera right after this event; recentre in front of it on the next frame.
      this.headValid = false;
      this.recenterPending = true;
      this.settleTimer = -1;
      this.soundCheckAt = -1;
      this.setSoundPrompt(false);
      this.unwatchReferenceSpace();
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

    const freshHead = this.sampleHead();
    if (this.recenterPending && freshHead) this.recenter();
    if (this.settleTimer >= 0) {
      this.settleTimer -= dt;
      if (this.settleTimer < 0 && freshHead && !this.panel.busy && !this.panel.hovered) this.recenter();
    }

    this.panel.step(dt);

    // 1. poses + buttons (callbacks fire in here, each re-aims at the fresh panel pose when needed)
    this.controllers.update(dt);

    // 2. grabbing moves the panel; do it before hit-testing
    for (const p of this.controllers.pointers) {
      if (this.panel.grabSlotIndex === p.slot) {
        if (p.squeeze && p.hasRay && this.headValid) this.panel.updateGrab(p.slot, p.origin, this.headPos);
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

    // 4. status checks (≤ 4 Hz), then auto-hide: only for someone who has used the menu, and never in a session's first 30 s
    this.statusTimer += dt;
    if (this.statusTimer >= STATUS_INTERVAL_SECONDS) {
      this.statusTimer = 0;
      this.pollStatus();
    }
    if (this.panel.hovered || this.panel.busy) {
      this.touch();
      this.interacted = true;
    }
    if (
      xr && this.autoHide && this.interacted && state.menuVisible && state.playback.playing && !this.panel.busy &&
      this.clock - this.sessionStart >= AUTOHIDE_MIN_SESSION_SECONDS && this.clock - this.lastInteraction > AUTOHIDE_SECONDS
    ) {
      this.actions.setMenuVisible(false);
      this.hintHidden();
    }

    // 5. draw
    this.panel.render(nowMs, xr);
    this.controllers.updateVisuals(dt, this.visible && this.panel.opacity > 0.05, this.panel.accentColor);
    this.hud.update(dt, {
      head: this.headPos,
      forward: this.headForward,
      menuVisible: this.panel.isShown && this.panel.opacity > 0.05,
      enabled: this.visible && (xr || this.debugHud),
      noSound: this.noSound,
      handsOnly: this.handsOnly(),
      accent: this.panel.accent,
      accentColor: this.panel.accentColor,
    });
  }

  /** Put the panel back in front of the user (XR head pose, or the desktop camera). */
  recenter(): void {
    const fresh = this.sampleHead();
    if (!fresh && !this.headValid) {
      // inside a session that has not produced a pose yet: do it on the first frame that has one
      this.recenterPending = true;
      return;
    }
    this.recenterPending = false;
    this.panel.place(this.headPos, this.headForward);
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
    this.unwatchReferenceSpace();
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

  /** Input that does not open the menu keeps it alive while it is open, and is otherwise ignored. */
  private touchIfVisible(): void {
    if (this.store.state.menuVisible) this.touch();
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
    this.interacted = true;
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
    if (p.hasRay && this.panel.beginGrab(p.slot, p.origin)) p.pulse(0.3, 30);
  }

  private onStick(p: XRPointer, dir: StickDir): void {
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
        this.actions.toast(`Volume ${Math.round(v * 100)} %`, 900);
        p.pulse(0.12, 15);
        break;
      }
    }
  }

  /** Hide from the header ✕ / Settings: the toast says how to bring it back (hands have no B / Y). */
  private hideMenu(): void {
    this.actions.setMenuVisible(false);
    if (this.handsOnly()) this.actions.toast(HIDE_HINT_PINCH, 4500);
    else this.actions.toast('Menu hidden', 1600);
  }

  /** After an auto-hide: for the first few times, explain how to get the menu back. */
  private hintHidden(): void {
    if (this.hideHints >= HIDE_HINT_MAX) return;
    this.hideHints++;
    try {
      localStorage.setItem(HIDE_HINT_STORAGE_KEY, String(this.hideHints));
    } catch {
      /* the in-memory count still limits this session */
    }
    this.actions.toast(this.handsOnly() ? HIDE_HINT_PINCH : LABELS.menuHiddenHint, 5000);
  }

  /** Long press on B / Y: show the menu if needed and put it in front of the user. */
  private bringMenuHere(p: XRPointer): void {
    if (!this.store.state.menuVisible) this.actions.setMenuVisible(true);
    this.recenter();
    this.actions.toast('Menu recentered', 1400);
    p.pulse(0.5, 60);
  }

  /** True while the only tracked input is hands (no controller with B / Y or a trigger). */
  private handsOnly(): boolean {
    let hands = false;
    for (const p of this.controllers.pointers) {
      if (!p.connected) continue;
      if (!p.isHand) return false;
      hands = true;
    }
    return hands;
  }

  /** Haptic detent for a pointer slot (the mouse, slot 2, has none; hands have no actuator). */
  private tick(slot: number): void {
    const p = this.controllers.pointers[slot];
    if (!p) return;
    const now = performance.now();
    if (now - this.lastTickAt[slot] < HAPTIC_TICK_MIN_MS) return;
    this.lastTickAt[slot] = now;
    p.pulse(HAPTIC_TICK.strength, HAPTIC_TICK.ms);
  }

  /** Silence and suspended-audio checks; runs at most every STATUS_INTERVAL_SECONDS. */
  private pollStatus(): void {
    const pb = this.store.state.playback;
    const f = this.features;

    // "No sound heard": playing through a running analyser that has been silent for a while
    if (pb.playing && f.active && f.silence) {
      if (this.silentSince < 0) this.silentSince = this.clock;
    } else {
      this.silentSince = -1;
    }
    const noSound = this.silentSince >= 0 && this.clock - this.silentSince > NO_SOUND_SECONDS;
    if (noSound !== this.noSound) {
      this.noSound = noSound;
      this.panel.setNoSound(noSound);
    }

    // Entering VR can leave the audio context suspended ("playing" but nothing analysed): ask for a tap on ▶
    if (this.soundCheckAt >= 0 && this.clock >= this.soundCheckAt) {
      this.soundCheckAt = -1;
      if (pb.playing && !f.active) {
        this.setSoundPrompt(true);
        this.actions.toast(SOUND_PROMPT, 6000);
        const s = this.store.state;
        if (!s.menuVisible) {
          this.actions.setMenuVisible(true);
          this.touch(); // the store listener that normally does this runs after the auto-hide check of this frame
        }
        if (s.tab !== 'player') this.actions.setTab('player');
      }
    }
    if (this.soundPrompt && (f.active || !pb.playing)) this.setSoundPrompt(false);
  }

  private setSoundPrompt(v: boolean): void {
    this.soundPrompt = v;
    this.panel.setSoundStuck(v);
  }

  private unwatchReferenceSpace(): void {
    this.refSpace?.removeEventListener('reset', this.onSpaceReset);
    this.refSpace = null;
  }

  /**
   * Refresh the cached head pose: the XR viewer pose while presenting (never the stale camera array of an earlier
   * session), the desktop camera otherwise. Returns true when this call produced a fresh pose.
   */
  private sampleHead(): boolean {
    const xr = this.renderer.xr;
    if (!xr.isPresenting) {
      this.camera.getWorldPosition(this.headPos);
      this.camera.getWorldQuaternion(this.headQuat);
    } else {
      // Only inside an XR frame callback: outside it (or before the first frame) there is no fresh pose.
      const frame = xr.getFrame() as XRFrame | null;
      const space = xr.getReferenceSpace();
      const pose = frame && space ? frame.getViewerPose(space) : null;
      if (!pose) return false;
      const { position: p, orientation: o } = pose.transform;
      this.headPos.set(p.x, p.y, p.z);
      this.headQuat.set(o.x, o.y, o.z, o.w);
      const parent = this.camera.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.matrixWorld.decompose(this.parentPos, this.parentQuat, this.parentScale);
        this.headPos.applyMatrix4(parent.matrixWorld);
        this.headQuat.premultiply(this.parentQuat);
      }
    }
    this.headForward.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.headValid = true;
    return true;
  }

  /** When the menu comes back while the user looks elsewhere (or has walked off), bring it into view. */
  private recenterIfBehind(): void {
    if (!this.renderer.xr.isPresenting || this.panel.grabbing) return;
    const fresh = this.sampleHead();
    if (!fresh && !this.headValid) {
      this.recenterPending = true;
      return;
    }
    this.toPanel.copy(this.panel.mesh.position).sub(this.headPos);
    if (this.toPanel.length() > RESHOW_MAX_DISTANCE) {
      this.recenter();
      return;
    }
    this.forward.copy(this.headForward);
    this.forward.y = 0;
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
