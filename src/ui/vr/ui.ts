import type { Actions, AppState } from '@/app/Store';
import type { AudioFeatures } from '@/audio/types';
import type { Accent } from './theme';

/**
 * Tiny retained-widget layer for the canvas panel. Every redraw rebuilds the list of hit rects; the
 * panel resolves pointer hover / press against it.
 */

export type DragPhase = 'start' | 'move' | 'end';

export interface Widget {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** corner radius of the hover highlight */
  r: number;
  click?: () => void;
  /** px / py are canvas pixel coordinates (they may lie outside the rect while dragging) */
  drag?: (px: number, py: number, phase: DragPhase) => void;
}

export class WidgetList {
  readonly items: Widget[] = [];

  clear(): void {
    this.items.length = 0;
  }

  add(w: Widget): void {
    this.items.push(w);
  }

  /** Topmost widget under the point (widgets added later sit on top). */
  hit(px: number, py: number): Widget | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const w = this.items[i];
      if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return w;
    }
    return null;
  }

  find(key: string): Widget | null {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].key === key) return this.items[i];
    return null;
  }
}

/** Loads thumbnails lazily (CORS-enabled so the canvas stays untainted) and asks for a redraw when one arrives. */
export class ImageCache {
  private map = new Map<string, HTMLImageElement | null>();

  constructor(private onChange: () => void) {}

  /** Returns a decoded image, or null while loading / on failure. */
  get(url: string): HTMLImageElement | null {
    if (this.map.has(url)) {
      const img = this.map.get(url);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    }
    if (this.map.size >= 12) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => this.onChange();
    img.onerror = () => {
      this.map.set(url, null);
      this.onChange();
    };
    img.src = url;
    this.map.set(url, img);
    return null;
  }

  dispose(): void {
    for (const img of this.map.values()) {
      if (img) { img.onload = null; img.onerror = null; }
    }
    this.map.clear();
  }
}

/** UI-local state that is not part of the app store. */
export interface PanelLocal {
  /** Manual queue scroll position, null = follow the current track */
  queueTop: number | null;
  /** queue index seen on the last draw, to reset manual scrolling when the track changes */
  lastIndex: number;
  /** Manual scene page, null = page of the active preset */
  scenePage: number | null;
  /** Volume to restore when un-muting */
  lastVolume: number;
}

export interface RenderInfo {
  calls: number;
  triangles: number;
  /** XR display refresh rate (0 when unknown / not presenting) */
  frameRate: number;
}

export interface TabEnv {
  ctx: CanvasRenderingContext2D;
  state: AppState;
  actions: Actions;
  features: AudioFeatures;
  accent: Accent;
  widgets: WidgetList;
  images: ImageCache;
  local: PanelLocal;
  /** Extrapolated playhead position in seconds */
  time: number;
  presenting: boolean;
  autoHide: boolean;
  setAutoHide(v: boolean): void;
  renderInfo(): RenderInfo;
  /** While a value is being dragged / just committed the UI shows it instead of the (lagging) store value */
  hold(key: string): number | undefined;
  setHold(key: string, value: number, holdMs: number): void;
  /** Ask for a redraw as soon as the throttle allows */
  invalidate(): void;
  nowMs: number;
}
