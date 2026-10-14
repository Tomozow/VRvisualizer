import type { Palette } from '@/viz/types';

/** Panel canvas size in pixels and the world size of the quad it is mapped onto (square pixels). */
export const PANEL_PX_W = 2048;
export const PANEL_PX_H = 1304;
export const PANEL_M_W = 1.4;
export const PANEL_M_H = (PANEL_M_W * PANEL_PX_H) / PANEL_PX_W;
/** World size of one canvas pixel in millimetres (≈ 0.68 mm). */
export const MM_PER_PX = (PANEL_M_W / PANEL_PX_W) * 1000;
/** Smallest hit target edge in canvas pixels: 44 mm, above the 40 mm quality bar. */
export const MIN_HIT_PX = Math.ceil(44 / MM_PER_PX);

/**
 * Type scale in canvas pixels. At 1.4 m, 44 px ≈ 1.23° and 48 px ≈ 1.34° (quality bar: ≥ 1.2°), so nothing
 * on the panel or HUD is set smaller than `label`.
 */
export const FS = {
  /** uppercase section labels, badges, counters, key caps, secondary captions */
  label: 44,
  /** body text and values */
  body: 48,
  /** names and titles */
  title: 56,
} as const;

export const FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';

export function font(size: number, weight = 600): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

export const COLOR = {
  ink: '#05060d',
  text: '#f4f6ff',
  textDim: '#c9cfe8',
  /** the dimmest text on the panel; still ≥ #a8b0cc so 44 px captions stay readable on the dark glass */
  textFaint: '#aab2d0',
  surface: 'rgba(255,255,255,0.055)',
  surfaceStrong: 'rgba(255,255,255,0.10)',
  stroke: 'rgba(255,255,255,0.10)',
  good: '#4ef0a8',
  warn: '#ffc457',
  bad: '#ff6b81',
} as const;

// ---------------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

export function parseColor(css: string): Rgb {
  let h = css.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

export function css(c: Rgb): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function luminance(c: Rgb): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

function rgbToHsl(c: Rgb): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/** Accent colours derived from the active palette (what the whole UI is tinted with). */
export interface Accent {
  key: string;
  main: Rgb;
  alt: Rgb;
  mainCss: string;
  altCss: string;
  /** translucent fill for selected states */
  soft: string;
  /** translucent border / glow */
  glow: string;
  /** text colour that stays readable on top of the accent gradient */
  ink: string;
}

const FALLBACK_STOPS = ['#1b0b3a', '#7a1fa2', '#ff3d7f', '#ff9f43', '#fff1a8'];

export function makeAccent(palette: Palette | undefined): Accent {
  const stops = (palette && palette.stops.length >= 2 ? palette.stops : FALLBACK_STOPS).map(parseColor);
  // The most saturated, mid-bright stop makes the best UI accent; the next-brightest becomes the second gradient colour.
  let best = 0;
  let bestScore = -1;
  stops.forEach((c, i) => {
    const [, s, l] = rgbToHsl(c);
    const score = (0.25 + s) * Math.max(0, 1 - Math.abs(l - 0.62) * 1.8);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const main = stops[best];
  let alt = stops[Math.min(stops.length - 1, best + 1)];
  if (alt === main) alt = stops[Math.max(0, best - 1)];
  if (luminance(alt) < 0.3) alt = mixRgb(alt, main, 0.5);
  const mid = mixRgb(main, alt, 0.5);
  return {
    key: palette ? palette.id : 'default',
    main,
    alt,
    mainCss: css(main),
    altCss: css(alt),
    soft: rgba(main, 0.2),
    glow: rgba(main, 0.55),
    ink: luminance(mid) > 0.55 ? '#0a0b16' : '#ffffff',
  };
}

// ---------------------------------------------------------------------------------------------
// Primitive drawing
// ---------------------------------------------------------------------------------------------

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function fillRound(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function strokeRound(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, stroke: string | CanvasGradient, lineWidth = 2): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

export function hGradient(ctx: CanvasRenderingContext2D, x0: number, x1: number, a: string, b: string): CanvasGradient {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

export function vGradient(ctx: CanvasRenderingContext2D, y0: number, y1: number, a: string, b: string): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

export function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string | CanvasGradient): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

export interface TextOpts {
  weight?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  spacing?: number;
}

export function drawText(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, size: number, color: string | CanvasGradient, o: TextOpts = {}): void {
  ctx.font = font(size, o.weight ?? 600);
  ctx.fillStyle = color;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  if (o.spacing !== undefined) ctx.letterSpacing = `${o.spacing}px`;
  ctx.fillText(str, x, y);
  if (o.spacing !== undefined) ctx.letterSpacing = '0px';
}

const fitCache = new Map<string, string>();

/** Truncate with an ellipsis so the string fits `maxW` in the current ctx.font. */
export function fitText(ctx: CanvasRenderingContext2D, str: string, maxW: number): string {
  if (str === '') return str;
  const key = `${ctx.font}|${maxW}|${str}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  let out = str;
  if (ctx.measureText(str).width > maxW) {
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(str.slice(0, mid).trimEnd() + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    out = str.slice(0, lo).trimEnd() + '…';
  }
  if (fitCache.size > 600) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

const wrapCache = new Map<string, string[]>();

/** Greedy word wrap into at most `maxLines` lines (the last one ellipsised), using the current ctx.font. */
export function wrapText(ctx: CanvasRenderingContext2D, str: string, maxW: number, maxLines: number): string[] {
  const key = `${ctx.font}|${maxW}|${maxLines}|${str}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const words = str.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const trial = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(trial).width <= maxW) {
      cur = trial;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = '';
      if (lines.length === maxLines) break;
      i--; // retry this word on the next line
    } else {
      // single word wider than the line: hard-truncate it
      lines.push(fitText(ctx, words[i], maxW));
      if (lines.length === maxLines) { i++; break; }
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && i < words.length) {
    lines[maxLines - 1] = fitText(ctx, lines[maxLines - 1] + ' ' + words.slice(i).join(' '), maxW);
  }
  if (lines.length === 0) lines.push('');
  if (wrapCache.size > 300) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = ss < 10 ? `0${ss}` : `${ss}`;
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${p}`;
  return `${m}:${p}`;
}

// ---------------------------------------------------------------------------------------------
// Icons (Path2D, 24x24 design grid)
// ---------------------------------------------------------------------------------------------

const ICON_PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volumeMute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  chevronLeft: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  chevronRight: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  chevronUp: 'M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
  chevronDown: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
  note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  recenter: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
  exit: 'M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  headset: 'M4 8h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4.2c-.7 0-1.3-.4-1.6-1l-.6-1.3c-.3-.5-.8-.7-1.6-.7s-1.3.2-1.6.7L9.8 17c-.3.6-.9 1-1.6 1H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zm3.5 2.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6zm9 0a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z',
} as const;

export type IconName = keyof typeof ICON_PATHS;

const iconCache = new Map<IconName, Path2D>();

/** Fill an icon centred on (cx, cy), `size` px tall. */
export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, cx: number, cy: number, size: number, color: string | CanvasGradient): void {
  let p = iconCache.get(name);
  if (!p) {
    p = new Path2D(ICON_PATHS[name]);
    iconCache.set(name, p);
  }
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(p, 'evenodd');
  ctx.restore();
}

/** Circular "skip 10 s" arrow with the number inside. dir = -1 rewinds (head points left), +1 skips ahead (head points right). */
export function drawSeekIcon(ctx: CanvasRenderingContext2D, dir: -1 | 1, cx: number, cy: number, size: number, color: string): void {
  const r = size * 0.4;
  const top = -Math.PI / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size * 0.085;
  ctx.lineCap = 'round';
  // three quarters of a circle that ends at the top, where the head points along the direction of travel
  ctx.beginPath();
  ctx.arc(cx, cy, r, dir < 0 ? Math.PI : 0, top, dir < 0);
  ctx.stroke();
  const hx = cx;
  const hy = cy - r;
  const hs = size * 0.19;
  ctx.beginPath();
  ctx.moveTo(hx + dir * hs * 1.15, hy);
  ctx.lineTo(hx - dir * hs * 0.35, hy - hs * 0.95);
  ctx.lineTo(hx - dir * hs * 0.35, hy + hs * 0.95);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawText(ctx, '10', cx, cy + size * 0.015, Math.max(FS.label, size * 0.375), color, { weight: 800, align: 'center', baseline: 'middle' });
}

// ---------------------------------------------------------------------------------------------
// Compound controls (pure drawing; hit rects are registered by the caller)
// ---------------------------------------------------------------------------------------------

export function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 26, tint?: string): void {
  fillRound(ctx, x, y, w, h, r, tint ?? COLOR.surface);
  strokeRound(ctx, x + 1, y + 1, w - 2, h - 2, r, COLOR.stroke, 2);
}

/** Slider geometry shared with the GPU overlay that draws the fill and knob (see Panel's LiveSliderQuad). */
export const SLIDER = { barH: 16, knobGlow: 34, knobR: 24, knobCore: 12, knobDisabled: 20 } as const;

/**
 * The static groove of a horizontal slider. The filled part and the knob are not drawn here: they live in a
 * small shader quad on top of the panel so dragging never needs a canvas redraw / texture upload.
 */
export function drawSliderTrack(ctx: CanvasRenderingContext2D, x: number, cy: number, w: number): void {
  fillRound(ctx, x, cy - SLIDER.barH / 2, w, SLIDER.barH, SLIDER.barH / 2, 'rgba(255,255,255,0.13)');
}

export function drawSwitch(ctx: CanvasRenderingContext2D, x: number, cy: number, on: boolean, a: Accent): void {
  const w = 112;
  const h = 58;
  fillRound(ctx, x, cy - h / 2, w, h, h / 2, on ? hGradient(ctx, x, x + w, a.mainCss, a.altCss) : 'rgba(255,255,255,0.16)');
  circle(ctx, on ? x + w - h / 2 : x + h / 2, cy, h / 2 - 7, '#ffffff');
}

/** Gradient chip showing a palette. */
export function drawPaletteChip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, stops: readonly string[], name: string, active: boolean, a: Accent): void {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  const n = Math.max(1, stops.length - 1);
  stops.forEach((s, i) => g.addColorStop(i / n, s));
  fillRound(ctx, x, y, w, h, 24, g);
  // scrim so the label stays readable on bright stops
  fillRound(ctx, x, y + h * 0.3, w, h * 0.7, 24, vGradient(ctx, y + h * 0.3, y + h, 'rgba(0,0,0,0)', 'rgba(3,4,10,0.84)'));
  ctx.save();
  ctx.font = font(FS.label, 700);
  drawText(ctx, fitText(ctx, name, w - 24), x + w / 2, y + h - 22, FS.label, '#ffffff', { weight: 700, align: 'center' });
  ctx.restore();
  if (active) {
    strokeRound(ctx, x - 4, y - 4, w + 8, h + 8, 28, '#ffffff', 5);
    strokeRound(ctx, x - 9, y - 9, w + 18, h + 18, 32, a.glow, 4);
  } else {
    strokeRound(ctx, x + 1, y + 1, w - 2, h - 2, 24, 'rgba(255,255,255,0.18)', 2);
  }
}

/** Segmented level meter, level 0..1. */
export function drawMeter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, level: number, segments: number, a: Accent): void {
  const gap = 6;
  const sw = (w - gap * (segments - 1)) / segments;
  const lit = Math.round(Math.max(0, Math.min(1, level)) * segments);
  for (let i = 0; i < segments; i++) {
    const f = i / (segments - 1);
    let col: string;
    if (i >= lit) col = 'rgba(255,255,255,0.10)';
    else col = f > 0.85 ? COLOR.bad : f > 0.65 ? COLOR.warn : css(mixRgb(a.main, a.alt, f));
    fillRound(ctx, x + i * (sw + gap), y, sw, h, 5, col);
  }
}

/** Small key-cap label (controller legend). Returns its width. */
export function drawKeycap(ctx: CanvasRenderingContext2D, x: number, cy: number, label: string, a: Accent): number {
  ctx.font = font(FS.label, 800);
  const w = Math.ceil(ctx.measureText(label).width) + 40;
  const h = 72;
  fillRound(ctx, x, cy - h / 2, w, h, 18, 'rgba(255,255,255,0.08)');
  strokeRound(ctx, x + 1.5, cy - h / 2 + 1.5, w - 3, h - 3, 17, a.glow, 3);
  drawText(ctx, label, x + w / 2, cy + 2, FS.label, COLOR.text, { weight: 800, align: 'center', baseline: 'middle' });
  return w;
}

/**
 * Pre-render the static glass background (drop shadow, body, accent border glow) into an offscreen canvas.
 * Redrawn only when the accent changes, so normal panel redraws are a single drawImage.
 */
export function renderGlass(target: HTMLCanvasElement, a: Accent): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const W = PANEL_PX_W;
  const H = PANEL_PX_H;
  const m = 28;
  const r = 20;
  ctx.clearRect(0, 0, W, H);
  // soft shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  roundRectPath(ctx, m, m, W - m * 2, H - m * 2, r);
  ctx.fillStyle = 'rgba(8,9,18,0.96)';
  ctx.fill();
  ctx.restore();
  // body gradient
  const g = ctx.createLinearGradient(0, m, 0, H - m);
  g.addColorStop(0, 'rgba(24,27,52,0.94)');
  g.addColorStop(0.45, 'rgba(12,14,29,0.94)');
  g.addColorStop(1, 'rgba(8,9,20,0.95)');
  roundRectPath(ctx, m, m, W - m * 2, H - m * 2, r);
  ctx.fillStyle = g;
  ctx.fill();
  // subtle accent wash in the top corners
  ctx.save();
  roundRectPath(ctx, m, m, W - m * 2, H - m * 2, r);
  ctx.clip();
  const wash = ctx.createRadialGradient(W * 0.15, m, 10, W * 0.15, m, W * 0.55);
  wash.addColorStop(0, rgba(a.main, 0.18));
  wash.addColorStop(1, rgba(a.main, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
  const wash2 = ctx.createRadialGradient(W * 0.9, H - m, 10, W * 0.9, H - m, W * 0.5);
  wash2.addColorStop(0, rgba(a.alt, 0.12));
  wash2.addColorStop(1, rgba(a.alt, 0));
  ctx.fillStyle = wash2;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // border glow
  ctx.save();
  ctx.shadowColor = a.glow;
  ctx.shadowBlur = 18;
  roundRectPath(ctx, m, m, W - m * 2, H - m * 2, r);
  ctx.strokeStyle = rgba(a.main, 0.75);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
  roundRectPath(ctx, m + 3, m + 3, W - m * 2 - 6, H - m * 2 - 6, r - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  ctx.stroke();
}
