import type * as THREE from 'three';
import type { AudioFeatures } from '@/audio/types';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface Palette {
  id: string;
  name: string;
  /** 3..6 CSS hex colours forming a gradient (dark → bright is NOT required; order is the gradient order) */
  stops: string[];
  /** Scene background / fog colour */
  background: string;
  /** Saturated accent for highlights (beat rings, sparks, UI). Defaults to the last stop. Never white. */
  accent?: string;
}

export interface PaletteState {
  /** Current palette definition */
  palette: Palette;
  /** 256x1 RGBA gradient texture, LinearFilter, ClampToEdge. Updated in place when the palette changes. */
  gradient: THREE.DataTexture;
  /** Convenience colours (updated in place; safe to reference from uniforms) */
  primary: THREE.Color;
  secondary: THREE.Color;
  accent: THREE.Color;
  background: THREE.Color;
  /** 0..1 progress of the current palette crossfade (1 = settled). */
  blend: number;
}

/**
 * Shared GPU-side audio history. One ring-buffer row is written per frame.
 * Texture layout (both RedFormat, UnsignedByteType, NearestFilter on V, LinearFilter on U):
 *  - freqHistory: width = BAND_COUNT (128), height = HISTORY_ROWS; value = band energy 0..255
 *  - waveHistory: width = WAVE_COUNT (256), height = HISTORY_ROWS; value = (sample*0.5+0.5)*255
 * Row `uHistoryHead` (0..HISTORY_ROWS-1) is the newest; row (head - k) is k frames old (wrap around).
 * GLSL helper (copy into shaders):
 *   float histRow(float age){ return mod(uHistoryHead - age + float(HISTORY_ROWS), float(HISTORY_ROWS)) / float(HISTORY_ROWS) + 0.5/float(HISTORY_ROWS); }
 */
export const HISTORY_ROWS = 256;

export interface AudioTextures {
  freqHistory: THREE.DataTexture;
  waveHistory: THREE.DataTexture;
  /** Newest row index (float for direct uniform use) */
  head: number;
  /** Shared uniforms object that presets can spread into their own materials */
  uniforms: {
    uFreqHistory: { value: THREE.DataTexture };
    uWaveHistory: { value: THREE.DataTexture };
    uHistoryHead: { value: number };
    uHistoryRows: { value: number };
  };
  /** Write the current frame's features into the ring buffer (one row per 1/72 s of wall-clock time). Called once per frame by the manager. */
  update(features: AudioFeatures, dt?: number): void;
  dispose(): void;
}

/** User-controllable visual parameters (from the UI). */
export interface VizParams {
  /** 0..2, default 1. Multiplies audio reactivity / amplitude. */
  intensity: number;
  /** 0..2, default 1. Multiplies animation speed. */
  speed: number;
  /** 0..1, default 0.8. Brightness / bloom-like glow strength. */
  glow: number;
  /** Whether the aurora background layer is enabled */
  background: boolean;
}

export interface PresetContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Non-XR camera. In XR the renderer substitutes its own; never move either. */
  camera: THREE.PerspectiveCamera;
  textures: AudioTextures;
  palette: PaletteState;
  quality: QualityLevel;
  /** Audio features (same object as engine.features) */
  features: AudioFeatures;
}

/**
 * A visualizer scene. The manager adds `group` to the scene while the preset is active (and
 * during crossfades) and removes it afterwards. Presets must:
 *  - put EVERYTHING they render inside `group`
 *  - keep the user's head area (a 1 m sphere around the origin at eye height 1.6 m) free of solid geometry
 *  - never move/modify the camera
 *  - keep draw calls low (prefer instancing / single Points / single Mesh)
 *  - respect `setOpacity` so crossfades look clean (fade uniforms, not material.opacity hacks)
 *  - clean up in dispose()
 */
export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly group: THREE.Group;
  init(ctx: PresetContext): void;
  /** @param dt seconds since last frame, @param t seconds since app start */
  update(features: AudioFeatures, dt: number, t: number, params: VizParams): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
}
