/** Inline SVG icons (24x24, painted with currentColor via CSS) and small formatting helpers. */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

const skip10 = (arrow: string): string =>
  svg(`<path d="${arrow}"/><text x="12" y="16.2" font-size="7" font-weight="700" text-anchor="middle" font-family="Inter,system-ui,sans-serif">10</text>`);

export const ICONS = {
  play: svg('<path d="M8 5v14l11-7z"/>'),
  pause: svg('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'),
  prev: svg('<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>'),
  next: svg('<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>'),
  back10: skip10('M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z'),
  fwd10: skip10('M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z'),
  shuffle: svg('<path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2 1.4-1.4zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4h-5.5zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2-3.2-3z"/>'),
  repeat: svg('<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>'),
  repeatOne: svg('<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/>'),
  volume: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.4 7-8.8s-3-7.9-7-8.8z"/>'),
  queue: svg('<path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>'),
  mic: svg('<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/>'),
  note: svg('<path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/>'),
  upload: svg('<path d="M19.4 10A7.5 7.5 0 0 0 12 4C9.1 4 6.6 5.6 5.4 8A6 6 0 0 0 0 14c0 3.3 2.7 6 6 6h13c2.8 0 5-2.2 5-5 0-2.6-2-4.8-4.6-5zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>'),
  vr: svg('<path d="M3 8h18a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5.2l-1.6-2.5H9.8L8.2 17H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>'),
  eye: svg('<path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>'),
  close: svg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>'),
  eq: '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>',
} as const;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use in HTML content or a quoted attribute. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** 83 -> "1:23", 3725 -> "1:02:05". Non-finite / negative input renders as 0:00. */
export function fmtTime(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
