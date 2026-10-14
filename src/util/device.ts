import type { QualityLevel } from '@/viz/types';

export function isQuest(): boolean {
  return /OculusBrowser|Quest/i.test(navigator.userAgent);
}

export function isMobile(): boolean {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

/** Pick a quality level. Quest 2 => 'medium'; desktop => 'high'; phones => 'low'. ?quality=low|medium|high overrides. */
export function detectQuality(): QualityLevel {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  if (isQuest()) return 'medium';
  if (isMobile()) return 'low';
  // A standalone headset whose UA lacks the Quest token: WebXR present + Android UA → treat as Quest-class.
  if (/Android/i.test(navigator.userAgent) && 'xr' in navigator) return 'medium';
  return 'high';
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. `rate` ≈ 1/seconds to reach ~63 %. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
