import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AudioEngine } from '@/audio/AudioEngine';
import { VisualizerManager } from '@/viz/VisualizerManager';
import { VRUI } from '@/ui/vr/VRUI';
import { DomOverlay } from '@/ui/dom/Overlay';
import { Store, type Actions, type AppState } from '@/app/Store';
import type { VizParams } from '@/viz/types';
import { detectQuality, clamp } from '@/util/device';

const SETTINGS_KEY = 'resonance-vr.settings.v1';

interface PersistedSettings {
  preset?: string;
  palette?: string;
  params?: Partial<VizParams>;
  autoCycle?: boolean;
  cycleSeconds?: number;
  volume?: number;
  proxyUrl?: string;
}

/**
 * Application orchestrator: owns renderer / scene / XR session, the audio engine, the
 * visualizer manager and both UIs. Implements `Actions` for the UIs.
 */
export class App implements Actions {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly engine: AudioEngine;
  readonly viz: VisualizerManager;
  readonly vrui: VRUI;
  readonly overlay: DomOverlay;
  readonly store: Store;
  private controls: OrbitControls | null = null;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private cycleTimer = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private xrSession: XRSession | null = null;
  private settings: PersistedSettings = {};

  constructor(private container: HTMLElement, private overlayRoot: HTMLElement) {
    this.settings = loadSettings();
    const quality = detectQuality();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFoveation(quality === 'high' ? 0 : 1);
    this.renderer.domElement.id = 'gl';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 400);
    this.camera.position.set(0, 1.6, 0);
    this.camera.lookAt(0, 1.6, -1);
    this.scene.add(this.camera);

    // Desktop: mouse look (no zoom / pan so the head stays at the origin like in VR)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.6, -0.01);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.rotateSpeed = -0.35; // drag to look around
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 0.01;

    this.engine = new AudioEngine({ proxyUrl: this.settings.proxyUrl ?? '' });
    if (this.settings.volume != null) this.engine.setVolume(this.settings.volume);

    this.viz = new VisualizerManager({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      features: this.engine.features,
      quality,
    });

    const params: VizParams = {
      intensity: 1,
      speed: 1,
      glow: 0.8,
      background: true,
      ...(this.settings.params ?? {}),
    };

    const initial: AppState = {
      preset: this.settings.preset && this.viz.presets.some((p) => p.id === this.settings.preset)
        ? this.settings.preset
        : this.viz.presets[0].id,
      presets: this.viz.presets,
      palette: this.settings.palette && this.viz.palettes.some((p) => p.id === this.settings.palette)
        ? this.settings.palette
        : this.viz.palettes[0].id,
      palettes: this.viz.palettes,
      params,
      autoCycle: this.settings.autoCycle ?? false,
      cycleSeconds: this.settings.cycleSeconds ?? 45,
      menuVisible: true,
      tab: 'player',
      mode: '2d',
      xrSupported: false,
      playback: this.engine.playback,
      fps: 0,
      toast: null,
    };
    this.store = new Store(initial);
    this.viz.setPreset(initial.preset, true);
    this.viz.setPalette(initial.palette, true);

    this.engine.addEventListener('change', () => this.store.set({ playback: this.engine.playback }));
    this.engine.addEventListener('trackchange', () => {
      const t = this.engine.playback.track;
      if (t) this.toast(`▶ ${t.title}`);
    });
    this.engine.addEventListener('error', () => {
      const m = this.engine.playback.message;
      if (m) this.toast(m, 4000);
    });

    this.overlay = new DomOverlay(overlayRoot, this.store, this);
    this.engine.setYouTubeHost(this.overlay.youtubeHost);

    this.vrui = new VRUI({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      store: this.store,
      actions: this,
      features: this.engine.features,
    });

    this.detectXR();
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.store.subscribe((s, changed) => {
      if (changed.has('preset') || changed.has('palette') || changed.has('params') || changed.has('autoCycle') || changed.has('cycleSeconds')) {
        this.persist();
      }
    });

    this.applyQueryParams();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Test / deep-link hooks: ?demo=1 ?preset=id ?palette=id ?nomenu=1 ?youtube=<url or id> ?url=<audio url> */
  private applyQueryParams(): void {
    const q = new URLSearchParams(location.search);
    const preset = q.get('preset');
    if (preset) this.setPreset(preset);
    const palette = q.get('palette');
    if (palette) this.setPalette(palette);
    if (q.get('nomenu') === '1') this.store.set({ menuVisible: false });
    const yt = q.get('youtube');
    const url = q.get('url');
    const demo = q.get('demo') === '1';
    if (!(yt || url || demo)) return;
    const start = () => {
      if (yt) this.addUrl(yt);
      else if (url) this.addUrl(url);
      else this.startDemo();
    };
    // Autoplay policies: try immediately, and again on the first user gesture if the context stayed suspended.
    start();
    const once = () => {
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
      if (this.engine.features.active) return;
      if (demo) start();
      else void this.engine.resume().then(() => { if (!this.engine.playback.playing) void this.engine.play(); });
    };
    window.addEventListener('pointerdown', once);
    window.addEventListener('keydown', once);
  }

  // --------------------------------------------------------------------- loop
  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    const s = this.store.state;

    this.engine.update();
    this.viz.update(this.engine.features, dt, this.elapsed, s.params);
    this.vrui.update(dt, this.elapsed);
    if (!this.renderer.xr.isPresenting) this.controls?.update();

    if (s.autoCycle && this.engine.features.active) {
      this.cycleTimer += dt;
      if (this.cycleTimer >= s.cycleSeconds) {
        this.cycleTimer = 0;
        this.nextPreset();
      }
    }

    // fps estimate (1 s window)
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 1) {
      this.store.set({ fps: Math.round(this.fpsFrames / this.fpsAccum) });
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    if (s.toast && performance.now() > s.toast.until) this.store.set({ toast: null });

    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case ' ': e.preventDefault(); this.toggle(); break;
      case 'ArrowRight': e.shiftKey ? this.next() : this.seekBy(10); break;
      case 'ArrowLeft': e.shiftKey ? this.prev() : this.seekBy(-10); break;
      case 'ArrowUp': this.setVolume(this.engine.playback.volume + 0.05); break;
      case 'ArrowDown': this.setVolume(this.engine.playback.volume - 0.05); break;
      case 'n': this.nextPreset(); break;
      case 'p': this.prevPreset(); break;
      case 'c': this.nextPalette(); break;
      case 'm': this.toggleMenu(); break;
      case 'h': this.overlay.toggleHidden(); break;
      case 'a': this.setAutoCycle(!this.store.state.autoCycle); break;
      default: {
        const n = Number(e.key);
        if (n >= 1 && n <= 9 && this.viz.presets[n - 1]) this.setPreset(this.viz.presets[n - 1].id);
      }
    }
  }

  // ----------------------------------------------------------------------- XR
  private async detectXR(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return;
    try {
      const ok = await xr.isSessionSupported('immersive-vr');
      this.store.set({ xrSupported: ok });
    } catch {
      this.store.set({ xrSupported: false });
    }
  }

  async enterVR(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) {
      this.toast('WebXR is not available in this browser');
      return;
    }
    if (this.xrSession) {
      await this.xrSession.end();
      return;
    }
    await this.engine.resume();
    try {
      const session = await xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
      });
      this.xrSession = session;
      session.addEventListener('end', () => {
        this.xrSession = null;
        this.store.set({ mode: '2d' });
        this.onResize();
      });
      await this.renderer.xr.setSession(session);
      this.store.set({ mode: 'xr', menuVisible: true });
      // Give the headset a frame to settle its pose before placing the panel
      setTimeout(() => this.vrui.recenter(), 300);
    } catch (err) {
      console.error(err);
      this.toast('Could not start VR session: ' + (err as Error).message, 5000);
    }
  }

  // ------------------------------------------------------------------ actions
  setPreset(id: string): void {
    if (!this.viz.presets.some((p) => p.id === id)) return;
    this.viz.setPreset(id);
    this.cycleTimer = 0;
    this.store.set({ preset: id });
  }
  nextPreset(): void {
    const list = this.viz.presets;
    const i = list.findIndex((p) => p.id === this.store.state.preset);
    this.setPreset(list[(i + 1) % list.length].id);
  }
  prevPreset(): void {
    const list = this.viz.presets;
    const i = list.findIndex((p) => p.id === this.store.state.preset);
    this.setPreset(list[(i - 1 + list.length) % list.length].id);
  }
  setPalette(id: string): void {
    if (!this.viz.palettes.some((p) => p.id === id)) return;
    this.viz.setPalette(id);
    this.store.set({ palette: id });
  }
  nextPalette(): void {
    const list = this.viz.palettes;
    const i = list.findIndex((p) => p.id === this.store.state.palette);
    this.setPalette(list[(i + 1) % list.length].id);
  }
  setParam<K extends keyof VizParams>(key: K, value: VizParams[K]): void {
    const params = { ...this.store.state.params, [key]: value };
    this.store.set({ params });
  }
  setAutoCycle(on: boolean): void {
    this.cycleTimer = 0;
    this.store.set({ autoCycle: on });
  }

  play(index?: number): void { void this.engine.resume().then(() => this.engine.play(index)); }
  pause(): void { this.engine.pause(); }
  toggle(): void { void this.engine.resume().then(() => this.engine.toggle()); }
  next(): void { void this.engine.next(); }
  prev(): void { void this.engine.prev(); }
  seek(seconds: number): void { this.engine.seek(seconds); }
  seekBy(delta: number): void { this.engine.seekBy(delta); }
  setVolume(v: number): void {
    this.engine.setVolume(clamp(v, 0, 1));
    this.settings.volume = clamp(v, 0, 1);
    this.persist();
  }
  setShuffle(on: boolean): void { this.engine.setShuffle(on); }
  setRepeat(mode: 'off' | 'all' | 'one'): void { this.engine.setRepeat(mode); }
  removeTrack(index: number): void { this.engine.removeTrack(index); }
  clearQueue(): void { this.engine.clearQueue(); }

  addFiles(files: FileList | File[]): void {
    void this.engine.resume().then(() => this.engine.addFiles(files, true));
  }
  addUrl(url: string): void {
    void this.engine.resume().then(() => this.engine.addUrl(url, true));
  }
  enableMic(): void {
    void this.engine.resume().then(() => this.engine.enableMic()).catch((e: Error) => this.toast('Microphone: ' + e.message, 4000));
  }
  disableMic(): void { this.engine.disableMic(); }
  startDemo(): void { void this.engine.resume().then(() => this.engine.startDemo()); }
  setProxyUrl(url: string): void {
    this.engine.setProxyUrl(url);
    this.settings.proxyUrl = url;
    this.persist();
  }

  setTab(tab: AppState['tab']): void { this.store.set({ tab }); }
  toggleMenu(): void { this.store.set({ menuVisible: !this.store.state.menuVisible }); }
  setMenuVisible(v: boolean): void { this.store.set({ menuVisible: v }); }
  recenter(): void { this.vrui.recenter(); }
  toast(text: string, ms = 2500): void {
    this.store.set({ toast: { text, until: performance.now() + ms } });
  }

  private persist(): void {
    const s = this.store.state;
    const data: PersistedSettings = {
      preset: s.preset,
      palette: s.palette,
      params: s.params,
      autoCycle: s.autoCycle,
      cycleSeconds: s.cycleSeconds,
      volume: this.settings.volume,
      proxyUrl: this.settings.proxyUrl,
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch { /* ignore */ }
  }
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as PersistedSettings) : {};
  } catch {
    return {};
  }
}
