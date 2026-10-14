import type { PlaybackState } from '@/audio/types';
import type { PresetInfo, VizParams, Palette } from '@/viz/types';

export type UiMode = '2d' | 'xr';

export interface AppState {
  /** Active preset id */
  preset: string;
  presets: PresetInfo[];
  /** Active palette id */
  palette: string;
  palettes: Palette[];
  params: VizParams;
  /** Auto-cycle presets every `cycleSeconds` */
  autoCycle: boolean;
  cycleSeconds: number;
  /** VR menu panel visibility */
  menuVisible: boolean;
  /** Which panel tab is open */
  tab: 'player' | 'scenes' | 'sources' | 'settings';
  mode: UiMode;
  xrSupported: boolean;
  playback: PlaybackState;
  /** FPS estimate for the settings tab */
  fps: number;
  /** Short transient notification shown in both UIs */
  toast: { text: string; until: number } | null;
}

export type Listener = (state: AppState, changed: Set<keyof AppState>) => void;

/**
 * Tiny observable store. `set` merges a partial state and notifies listeners with the changed keys.
 * `playback` is replaced by reference on every engine change so UIs can diff cheaply.
 */
export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private pending = new Set<keyof AppState>();
  private scheduled = false;

  constructor(initial: AppState) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<AppState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof AppState)[]) {
      if (this.state[k] !== patch[k]) {
        (this.state as Record<keyof AppState, unknown>)[k] = patch[k];
        this.pending.add(k);
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  /** Notify synchronously (UIs are cheap; VR panel only redraws when dirty). */
  private flush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const changed = this.pending;
      this.pending = new Set();
      for (const fn of this.listeners) fn(this.state, changed);
    });
  }
}

/** Commands the UIs may issue. Implemented by App. */
export interface Actions {
  // scenes
  setPreset(id: string): void;
  nextPreset(): void;
  prevPreset(): void;
  setPalette(id: string): void;
  nextPalette(): void;
  setParam<K extends keyof VizParams>(key: K, value: VizParams[K]): void;
  setAutoCycle(on: boolean): void;
  // transport
  play(index?: number): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(seconds: number): void;
  seekBy(delta: number): void;
  setVolume(v: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: PlaybackState['repeat']): void;
  removeTrack(index: number): void;
  clearQueue(): void;
  // sources
  addFiles(files: FileList | File[]): void;
  addUrl(url: string): void;
  enableMic(): void;
  disableMic(): void;
  startDemo(): void;
  setProxyUrl(url: string): void;
  // ui
  setTab(tab: AppState['tab']): void;
  toggleMenu(): void;
  setMenuVisible(v: boolean): void;
  /** Move the VR panel back in front of the user */
  recenter(): void;
  enterVR(): Promise<void>;
  toast(text: string, ms?: number): void;
}
