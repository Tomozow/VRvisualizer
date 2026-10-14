import type { Actions, AppState } from '@/app/Store';
import type { AudioFeatures } from '@/audio/types';
import { MIN_HIT_PX, type Accent } from './theme';

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
  /** Slider groove (left edge, length in canvas px): the panel ticks the haptics every 5 % of a drag along it */
  track?: { x: number; w: number };
}

export class WidgetList {
  readonly items: Widget[] = [];

  clear(): void {
    this.items.length = 0;
  }

  /** Registers a hit rect, growing it around its centre to the minimum comfortable target size (44 mm). */
  add(w: Widget): void {
    if (w.w < MIN_HIT_PX) {
      w.x -= (MIN_HIT_PX - w.w) / 2;
      w.w = MIN_HIT_PX;
    }
    if (w.h < MIN_HIT_PX) {
      w.y -= (MIN_HIT_PX - w.h) / 2;
      w.h = MIN_HIT_PX;
    }
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

/**
 * Things that change every frame (slider fill + knob, time and value read-outs) are not part of the canvas:
 * the panel renders them as small GPU overlays so a drag or a ticking clock never re-uploads the whole texture.
 * Tabs register them while drawing; the panel evaluates the callbacks every frame.
 */
export interface LiveSlider {
  /** groove left edge, vertical centre and length in canvas pixels */
  x: number;
  cy: number;
  w: number;
  /** 0..1, read every frame (held drag value, store value or playhead) */
  value(): number;
  disabled?: boolean;
}

export interface LiveLabel {
  /** anchor point (left or right edge) and vertical centre in canvas pixels */
  x: number;
  cy: number;
  align: 'left' | 'right';
  size: number;
  weight: number;
  color: string;
  /** cheap integer signature read every frame; the label is re-rendered only when it changes */
  sig(): number;
  text(sig: number): string;
}

export class LiveList {
  readonly sliders: LiveSlider[] = [];
  readonly labels: LiveLabel[] = [];

  clear(): void {
    this.sliders.length = 0;
    this.labels.length = 0;
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
  live: LiveList;
  images: ImageCache;
  local: PanelLocal;
  /** Extrapolated playhead position in seconds, sampled when the canvas was drawn */
  time: number;
  /** Extrapolated playhead position right now (for live overlays) */
  playhead(): number;
  presenting: boolean;
  autoHide: boolean;
  setAutoHide(v: boolean): void;
  /** Hide the menu (header ✕ / Settings); the user gets a toast on how to bring it back */
  hideMenu(): void;
  /** Playing, but the input has been silent for a while (see VRUI) */
  noSound: boolean;
  /** Playing, but the audio context never started: the play button asks for a tap */
  soundStuck: boolean;
  renderInfo(): RenderInfo;
  /** While a value is being dragged / just committed the UI shows it instead of the (lagging) store value */
  hold(key: string): number | undefined;
  setHold(key: string, value: number, holdMs: number): void;
  /** Ask for a redraw as soon as the throttle allows */
  invalidate(): void;
  /** Ask for a redraw once `ms` have passed (a timed state, e.g. an armed confirm button, expires) */
  invalidateIn(ms: number): void;
  nowMs: number;
}
