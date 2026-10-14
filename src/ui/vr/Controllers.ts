import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

export type StickDir = 'left' | 'right' | 'up' | 'down';

export interface ControllerHandlers {
  selectStart(p: XRPointer): void;
  selectEnd(p: XRPointer): void;
  squeezeStart(p: XRPointer): void;
  squeezeEnd(p: XRPointer): void;
  stick(p: XRPointer, dir: StickDir): void;
  buttonA(p: XRPointer): void;
  buttonB(p: XRPointer): void;
  /** Any physical input happened (fired in addition to the specific callbacks) */
  activity(p: XRPointer): void;
}

// Quest (xr-standard) mapping
const BTN_TRIGGER = 0;
const BTN_SQUEEZE = 1;
const BTN_A = 4; // A / X
const BTN_B = 5; // B / Y

const STICK_ON = 0.65;
const STICK_OFF = 0.45;
const STICK_FIRST_DELAY = 0.35;
const STICK_VERTICAL_REPEAT = 0.12;
const PINCH_ON = 0.02;
const PINCH_OFF = 0.032;

const FORWARD = new THREE.Vector3(0, 0, -1);

/** Per-hand state: pose of the pointing ray plus the button state decoded from the gamepad / hand joints. */
export class XRPointer {
  handedness: XRHandedness = 'none';
  connected = false;
  isHand = false;
  /** a valid ray exists this frame */
  hasRay = false;
  readonly origin = new THREE.Vector3();
  readonly direction = new THREE.Vector3(0, 0, -1);
  readonly quaternion = new THREE.Quaternion();
  select = false;
  squeeze = false;
  /** distance to the panel along the ray, or -1 (written by VRUI, read by the ray visual) */
  hitDistance = -1;
  inputSource: XRInputSource | null = null;

  // decoded state
  pinching = false;
  selectEvent = false;
  squeezeEvent = false;
  prevA = false;
  prevB = false;
  stickDir: StickDir | null = null;
  stickTimer = 0;
  stickRepeating = false;

  constructor(readonly slot: number) {}

  /** Short haptic tick (controllers only). */
  pulse(strength = 0.4, ms = 40): void {
    const gp = this.inputSource?.gamepad;
    if (!gp) return;
    try {
      const act = gp.hapticActuators?.[0];
      if (act && typeof act.pulse === 'function') {
        void act.pulse(strength, ms).catch(() => undefined);
        return;
      }
      void gp.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength }).catch(() => undefined);
    } catch {
      /* haptics are best effort */
    }
  }
}

interface Entry {
  controller: THREE.XRTargetRaySpace;
  hand: THREE.XRHandSpace;
  ray: RayVisual;
  cleanup: (() => void)[];
}

let dotTexture: THREE.CanvasTexture | null = null;
function getDotTexture(): THREE.CanvasTexture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.28, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  dotTexture = new THREE.CanvasTexture(c);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

/** Thin additive beam that shortens to the hit point, with a glowing dot where it lands. */
class RayVisual {
  readonly beam: THREE.Mesh;
  readonly dot: THREE.Sprite;
  private beamMat: THREE.MeshBasicMaterial;
  private dotMat: THREE.SpriteMaterial;
  private white = new THREE.Color(1, 1, 1);
  private tmp = new THREE.Color();
  private level = 0;

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.CylinderGeometry(0.0007, 0.0024, 1, 6, 1, true);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.5);
    // fade along the beam: bright at the hand, dim at the far end
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const f = 1 + pos.getZ(i) * 0.72; // z = 0 -> 1, z = -1 -> 0.28
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = f;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });
    this.beam = new THREE.Mesh(geo, this.beamMat);
    this.beam.renderOrder = 110;
    this.beam.frustumCulled = false;
    this.beam.visible = false;

    this.dotMat = new THREE.SpriteMaterial({
      map: getDotTexture(), color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });
    this.dot = new THREE.Sprite(this.dotMat);
    this.dot.renderOrder = 111;
    this.dot.frustumCulled = false;
    this.dot.visible = false;
    parent.add(this.beam, this.dot);
  }

  update(p: XRPointer, show: boolean, accent: THREE.Color, dt: number): void {
    const hit = p.hitDistance > 0;
    const target = show && p.hasRay ? (hit ? 1 : 0.4) : 0;
    this.level += (target - this.level) * Math.min(1, dt * 14);
    const visible = this.level > 0.01 && p.hasRay;
    this.beam.visible = visible;
    this.dot.visible = visible && hit;
    if (!visible) return;
    const len = hit ? p.hitDistance : 2.4;
    this.beam.position.copy(p.origin);
    this.beam.quaternion.copy(p.quaternion);
    this.beam.scale.set(1, 1, len);
    const pressed = p.select;
    this.tmp.copy(accent).lerp(this.white, pressed ? 0.7 : 0.25);
    this.beamMat.color.copy(this.tmp);
    this.beamMat.opacity = 0.85 * this.level;
    if (hit) {
      this.dot.position.copy(p.direction).multiplyScalar(len - 0.003).add(p.origin);
      this.dot.scale.setScalar(pressed ? 0.05 : 0.036);
      this.dotMat.color.copy(this.tmp);
      this.dotMat.opacity = this.level;
    }
  }

  dispose(): void {
    this.beam.geometry.dispose();
    this.beamMat.dispose();
    this.dotMat.dispose();
    this.beam.removeFromParent();
    this.dot.removeFromParent();
  }
}

/**
 * Wraps the two XR input slots: controller / hand models, pointing rays, and per-frame gamepad / pinch
 * decoding. Survives repeated sessions because it only attaches to the persistent `renderer.xr` groups.
 */
export class Controllers {
  readonly pointers: XRPointer[] = [new XRPointer(0), new XRPointer(1)];
  readonly root = new THREE.Group();
  private entries: Entry[] = [];
  private scale = new THREE.Vector3();
  private onSessionStart: () => void;
  private onSessionEnd: () => void;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, private handlers: ControllerHandlers) {
    this.root.name = 'resonance-vr-controllers';
    scene.add(this.root);
    const modelFactory = new XRControllerModelFactory();
    const handFactory = new XRHandModelFactory();

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const hand = renderer.xr.getHand(i);
      this.root.add(controller, grip, hand);
      grip.add(modelFactory.createControllerModel(grip));
      hand.add(handFactory.createHandModel(hand, 'mesh'));
      const ray = new RayVisual(this.root);
      const p = this.pointers[i];
      const cleanup: (() => void)[] = [];

      const onConnected = (e: { data: XRInputSource }): void => {
        p.inputSource = e.data;
        p.handedness = e.data.handedness;
        p.isHand = !!e.data.hand;
        p.connected = true;
        p.selectEvent = false;
        p.squeezeEvent = false;
      };
      const onDisconnected = (): void => {
        this.releaseAll(p);
        p.connected = false;
        p.inputSource = null;
        p.isHand = false;
        p.hasRay = false;
        p.hitDistance = -1;
      };
      const onSelectStart = (): void => { p.selectEvent = true; };
      const onSelectEnd = (): void => { p.selectEvent = false; };
      const onSqueezeStart = (): void => { p.squeezeEvent = true; };
      const onSqueezeEnd = (): void => { p.squeezeEvent = false; };
      controller.addEventListener('connected', onConnected);
      controller.addEventListener('disconnected', onDisconnected);
      controller.addEventListener('selectstart', onSelectStart);
      controller.addEventListener('selectend', onSelectEnd);
      controller.addEventListener('squeezestart', onSqueezeStart);
      controller.addEventListener('squeezeend', onSqueezeEnd);
      cleanup.push(
        () => controller.removeEventListener('connected', onConnected),
        () => controller.removeEventListener('disconnected', onDisconnected),
        () => controller.removeEventListener('selectstart', onSelectStart),
        () => controller.removeEventListener('selectend', onSelectEnd),
        () => controller.removeEventListener('squeezestart', onSqueezeStart),
        () => controller.removeEventListener('squeezeend', onSqueezeEnd),
      );
      this.entries.push({ controller, hand, ray, cleanup });
    }

    this.onSessionStart = () => {
      for (const p of this.pointers) this.releaseAll(p);
    };
    this.onSessionEnd = () => {
      for (const p of this.pointers) {
        this.releaseAll(p);
        p.connected = false;
        p.inputSource = null;
        p.hasRay = false;
        p.hitDistance = -1;
      }
    };
    renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    renderer.xr.addEventListener('sessionend', this.onSessionEnd);
  }

  /** Release any held buttons (fires the matching end callbacks so drags / grabs finish cleanly). */
  private releaseAll(p: XRPointer): void {
    p.pinching = false;
    p.selectEvent = false;
    p.squeezeEvent = false;
    if (p.select) { p.select = false; this.handlers.selectEnd(p); }
    if (p.squeeze) { p.squeeze = false; this.handlers.squeezeEnd(p); }
    p.stickDir = null;
    p.prevA = p.prevB = false;
  }

  /**
   * Read poses for both hands first, then decode buttons (so callbacks can raycast against fresh poses).
   */
  update(dt: number): void {
    if (!this.renderer.xr.isPresenting) return;
    for (let i = 0; i < 2; i++) this.readPose(this.pointers[i], this.entries[i]);
    for (let i = 0; i < 2; i++) this.readButtons(this.pointers[i], dt);
  }

  private readPose(p: XRPointer, e: Entry): void {
    p.hasRay = false;
    const src = p.inputSource;
    if (!p.connected || !src) return;
    const ctrl = e.controller;
    if (src.hand) {
      const hand = e.hand;
      const tip = hand.joints['index-finger-tip'];
      const thumb = hand.joints['thumb-tip'];
      if (!hand.visible || !tip || !thumb || !tip.visible || !thumb.visible) {
        p.pinching = false;
        return;
      }
      const d = tip.position.distanceTo(thumb.position);
      if (p.pinching) p.pinching = d < PINCH_OFF;
      else p.pinching = d < PINCH_ON;
      if (ctrl.visible) {
        // the runtime's pointer pose follows the pinch point
        ctrl.updateWorldMatrix(true, false);
        ctrl.matrixWorld.decompose(p.origin, p.quaternion, this.scale);
        p.direction.copy(FORWARD).applyQuaternion(p.quaternion);
        p.hasRay = true;
      } else {
        const wrist = hand.joints.wrist;
        if (!wrist || !wrist.visible) return;
        p.origin.copy(tip.position);
        p.direction.copy(tip.position).sub(wrist.position).normalize();
        p.quaternion.setFromUnitVectors(FORWARD, p.direction);
        p.hasRay = true;
      }
      return;
    }
    p.pinching = false;
    if (!ctrl.visible) return;
    ctrl.updateWorldMatrix(true, false);
    ctrl.matrixWorld.decompose(p.origin, p.quaternion, this.scale);
    p.direction.copy(FORWARD).applyQuaternion(p.quaternion);
    p.hasRay = true;
  }

  private readButtons(p: XRPointer, dt: number): void {
    const src = p.inputSource;
    if (!p.connected || !src) return;
    const h = this.handlers;
    const gp = src.hand ? null : src.gamepad ?? null;

    // trigger / pinch
    const trig = gp ? buttonValue(gp, BTN_TRIGGER) : 0;
    const selectNow = p.select ? (trig > 0.35 || p.pinching || p.selectEvent) : (trig > 0.6 || p.pinching || p.selectEvent);
    if (selectNow !== p.select) {
      p.select = selectNow;
      if (selectNow) { h.activity(p); h.selectStart(p); } else h.selectEnd(p);
    }

    // squeeze / grip
    const sq = gp ? buttonValue(gp, BTN_SQUEEZE) : 0;
    const squeezeNow = p.squeeze ? (sq > 0.35 || p.squeezeEvent) : (sq > 0.6 || p.squeezeEvent);
    if (squeezeNow !== p.squeeze) {
      p.squeeze = squeezeNow;
      if (squeezeNow) { h.activity(p); h.squeezeStart(p); } else h.squeezeEnd(p);
    }

    if (!gp) return;

    // face buttons
    const a = buttonValue(gp, BTN_A) > 0.5;
    if (a && !p.prevA) { h.activity(p); h.buttonA(p); }
    p.prevA = a;
    const b = buttonValue(gp, BTN_B) > 0.5;
    if (b && !p.prevB) { h.activity(p); h.buttonB(p); }
    p.prevB = b;

    // thumbstick with dead zone, hysteresis and repeat delay
    const ax = gp.axes;
    const sx = (ax.length >= 4 ? ax[2] : ax[0]) || 0;
    const sy = (ax.length >= 4 ? ax[3] : ax[1]) || 0;
    const mag = Math.hypot(sx, sy);
    let dir: StickDir | null = null;
    if (mag > (p.stickDir ? STICK_OFF : STICK_ON)) {
      dir = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'right' : 'left') : (sy > 0 ? 'down' : 'up');
    }
    if (dir !== p.stickDir) {
      p.stickDir = dir;
      p.stickTimer = 0;
      p.stickRepeating = false;
      if (dir) { h.activity(p); h.stick(p, dir); }
    } else if (dir) {
      p.stickTimer += dt;
      const vertical = dir === 'up' || dir === 'down';
      const delay = p.stickRepeating && vertical ? STICK_VERTICAL_REPEAT : STICK_FIRST_DELAY;
      if (p.stickTimer >= delay) {
        p.stickTimer = 0;
        p.stickRepeating = true;
        h.activity(p);
        h.stick(p, dir);
      }
    }
  }

  /** Update beams and hit dots. `showRays` is false while the panel is hidden. */
  updateVisuals(dt: number, showRays: boolean, accent: THREE.Color): void {
    const presenting = this.renderer.xr.isPresenting;
    for (let i = 0; i < 2; i++) this.entries[i].ray.update(this.pointers[i], showRays && presenting, accent, dt);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
    this.renderer.xr.removeEventListener('sessionend', this.onSessionEnd);
    for (const e of this.entries) {
      for (const fn of e.cleanup) fn();
      e.ray.dispose();
    }
    this.entries.length = 0;
    this.root.removeFromParent();
    if (dotTexture) { dotTexture.dispose(); dotTexture = null; }
  }
}

function buttonValue(gp: Gamepad, index: number): number {
  const b = gp.buttons[index];
  if (!b) return 0;
  return b.pressed ? Math.max(1, b.value) : b.value;
}
