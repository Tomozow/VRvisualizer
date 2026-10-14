import * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';
import type { Preset, PresetContext, PresetInfo, QualityLevel, VizParams, Palette } from '@/viz/types';
import { createAudioTextures } from '@/viz/shared/AudioTextures';
import { PaletteController, PALETTES } from '@/viz/shared/Palettes';
import { Environment } from '@/viz/shared/Environment';
import { AuroraBackground } from '@/viz/presets/AuroraBackground';
import { PRESET_FACTORIES } from '@/viz/presets';

export interface VisualizerManagerOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  features: AudioFeatures;
  quality: QualityLevel;
}

interface ActivePreset {
  preset: Preset;
  opacity: number;
  target: number;
}

const FADE_SECONDS = 1.2;

/**
 * Owns the shared audio textures, palette, environment and the active preset(s). Presets are
 * created lazily on first use and crossfaded (both update while fading).
 */
export class VisualizerManager {
  readonly presets: PresetInfo[];
  readonly palettes: Palette[] = PALETTES;
  readonly ctx: PresetContext;
  private paletteCtl: PaletteController;
  private environment: Environment;
  private background: AuroraBackground;
  private instances = new Map<string, Preset>();
  private active: ActivePreset[] = [];
  private currentId = '';
  private fog: THREE.FogExp2;

  constructor(private opts: VisualizerManagerOptions) {
    const { scene, renderer, camera, features, quality } = opts;
    this.paletteCtl = new PaletteController(PALETTES[0]);
    const textures = createAudioTextures();
    this.ctx = { renderer, scene, camera, textures, palette: this.paletteCtl.state, quality, features };

    this.presets = PRESET_FACTORIES.map((f) => ({ id: f.id, name: f.name, description: f.description }));

    scene.background = this.paletteCtl.state.background;
    this.fog = new THREE.FogExp2(this.paletteCtl.state.background.getHex(), 0.018);
    scene.fog = this.fog;

    this.environment = new Environment(this.paletteCtl.state, quality);
    this.environment.setPixelRatio(renderer.getPixelRatio());
    scene.add(this.environment.group);

    this.background = new AuroraBackground();
    this.background.init(this.ctx);
    scene.add(this.background.group);
  }

  get currentPresetId(): string {
    return this.currentId;
  }

  private getInstance(id: string): Preset {
    let inst = this.instances.get(id);
    if (!inst) {
      const factory = PRESET_FACTORIES.find((f) => f.id === id);
      if (!factory) throw new Error(`Unknown preset ${id}`);
      inst = factory.create();
      inst.init(this.ctx);
      this.instances.set(id, inst);
    }
    return inst;
  }

  setPreset(id: string, immediate = false): void {
    if (id === this.currentId) return;
    this.currentId = id;
    const preset = this.getInstance(id);
    // fade out everything else
    for (const a of this.active) a.target = 0;
    let entry = this.active.find((a) => a.preset === preset);
    if (!entry) {
      entry = { preset, opacity: immediate ? 1 : 0, target: 1 };
      this.active.push(entry);
      this.opts.scene.add(preset.group);
    } else {
      entry.target = 1;
    }
    if (immediate) {
      for (const a of this.active) a.opacity = a.target;
      this.prune();
    }
    for (const a of this.active) a.preset.setOpacity(a.opacity);
  }

  /** Rebuild every preset at a new quality level (counts/mesh density are fixed at init). */
  setQuality(quality: QualityLevel): void {
    if (quality === this.ctx.quality) return;
    this.ctx.quality = quality;
    for (const a of this.active) this.opts.scene.remove(a.preset.group);
    this.active = [];
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
    this.background.dispose();
    this.opts.scene.remove(this.background.group);
    this.background = new AuroraBackground();
    this.background.init(this.ctx);
    this.opts.scene.add(this.background.group);
    this.environment.dispose();
    this.opts.scene.remove(this.environment.group);
    this.environment = new Environment(this.paletteCtl.state, quality);
    this.environment.setPixelRatio(this.opts.renderer.getPixelRatio());
    this.opts.scene.add(this.environment.group);
    const id = this.currentId;
    this.currentId = '';
    if (id) this.setPreset(id, true);
  }

  setPalette(id: string, immediate = false): void {
    const p = PALETTES.find((x) => x.id === id);
    if (!p) return;
    this.paletteCtl.setPalette(p, immediate);
  }

  update(features: AudioFeatures, dt: number, t: number, params: VizParams): void {
    this.paletteCtl.update(dt);
    this.fog.color.copy(this.paletteCtl.state.background);
    this.ctx.textures.update(features);
    this.environment.update(features, dt, t, params);

    this.background.group.visible = params.background;
    if (params.background) this.background.update(features, dt, t, params);

    let needPrune = false;
    for (const a of this.active) {
      if (a.opacity !== a.target) {
        const dir = a.target > a.opacity ? 1 : -1;
        a.opacity = THREE.MathUtils.clamp(a.opacity + (dir * dt) / FADE_SECONDS, 0, 1);
        a.preset.setOpacity(a.opacity);
        if (a.opacity === 0 && a.target === 0) needPrune = true;
      }
      a.preset.update(features, dt, t, params);
    }
    if (needPrune) this.prune();
  }

  private prune(): void {
    this.active = this.active.filter((a) => {
      if (a.opacity === 0 && a.target === 0) {
        this.opts.scene.remove(a.preset.group);
        return false;
      }
      return true;
    });
  }

  dispose(): void {
    for (const inst of this.instances.values()) {
      this.opts.scene.remove(inst.group);
      inst.dispose();
    }
    this.instances.clear();
    this.active = [];
    this.background.dispose();
    this.environment.dispose();
    this.ctx.textures.dispose();
  }
}
