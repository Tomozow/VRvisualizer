import type { SourceKind, Track } from '@/audio/types';
import { clamp, detectQuality } from '@/util/device';
import {
  COLOR, FS, circle, drawCard, drawIcon, drawKeycap, drawMeter, drawPaletteChip, drawSeekIcon, drawSliderTrack, drawSwitch,
  drawText, fillRound, fitText, font, formatTime, hGradient, roundRectPath, strokeRound, wrapText, rgba,
  type IconName,
} from './theme';
import type { LiveLabel, TabEnv } from './ui';

/**
 * Layout notes: the canvas is 2048 × 1304 px mapped onto 1.4 × 0.89 m, so 1 px ≈ 0.68 mm. Every piece of text is at
 * least `FS.label` (44 px ≈ 1.2° at 1.4 m); running text and values use `FS.body` (48 px), names `FS.title` (56 px).
 * Interactive widgets are at least 44 mm (≈ 65 px) wide and tall (WidgetList.add enforces it as a safety net).
 */

/** Content area below the header (canvas pixels). */
const LEFT = 64;
const RIGHT = 1984;
const TOP = 186;
const BOTTOM = 1244;

/** A seek to the very end finishes the track; stay this far inside it. */
const SEEK_END_MARGIN = 0.25;

const KIND_LABEL: Record<SourceKind, string> = {
  file: 'LOCAL FILE',
  url: 'STREAM URL',
  mic: 'MICROPHONE',
  youtube: 'YOUTUBE',
  demo: 'DEMO SIGNAL',
};

// ---------------------------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------------------------

/** Uppercase caption; `y` is the baseline. Returns the rendered width. */
function sectionLabel(env: TabEnv, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): number {
  const { ctx } = env;
  ctx.font = font(FS.label, 800);
  ctx.letterSpacing = '3px';
  const w = Math.ceil(ctx.measureText(text).width);
  ctx.letterSpacing = '0px';
  drawText(ctx, text, x, y, FS.label, COLOR.textFaint, { weight: 800, spacing: 3, align });
  return w;
}

function hit(env: TabEnv, key: string, x: number, y: number, w: number, h: number, r: number, click: () => void): void {
  env.widgets.add({ key, x, y, w, h, r, click });
}

function liveLabel(env: TabEnv, o: Omit<LiveLabel, 'size' | 'weight'> & { size?: number; weight?: number }): void {
  env.live.labels.push({ size: FS.label, weight: 700, ...o });
}

interface CircleBtn {
  key: string;
  cx: number;
  cy: number;
  r: number;
  icon?: IconName;
  seek?: -1 | 1;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
  click?: () => void;
}

function circleButton(env: TabEnv, o: CircleBtn): void {
  const { ctx, accent: a } = env;
  ctx.save();
  if (o.disabled) ctx.globalAlpha = 0.32;
  if (o.primary) {
    const g = ctx.createLinearGradient(o.cx - o.r, o.cy - o.r, o.cx + o.r, o.cy + o.r);
    g.addColorStop(0, a.mainCss);
    g.addColorStop(1, a.altCss);
    ctx.shadowColor = a.glow;
    ctx.shadowBlur = 30;
    circle(ctx, o.cx, o.cy, o.r, g);
    ctx.shadowBlur = 0;
  } else {
    circle(ctx, o.cx, o.cy, o.r, o.active ? a.soft : 'rgba(255,255,255,0.075)');
    ctx.beginPath();
    ctx.arc(o.cx, o.cy, o.r - 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = o.active ? a.glow : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const ink = o.primary ? a.ink : o.active ? a.mainCss : COLOR.text;
  if (o.seek) drawSeekIcon(ctx, o.seek, o.cx, o.cy, o.r * 1.78, ink);
  else if (o.icon) drawIcon(ctx, o.icon, o.cx, o.cy, o.r * (o.primary ? 1.0 : 0.95), ink);
  ctx.restore();
  if (!o.disabled && o.click) hit(env, o.key, o.cx - o.r - 8, o.cy - o.r - 8, (o.r + 8) * 2, (o.r + 8) * 2, o.r + 8, o.click);
}

/** Slider with throttled commits and a held value so the knob never snaps back while the store catches up. */
const lastCommitAt = new Map<string, number>();
const lastCommitValue = new Map<string, number>();

/**
 * Draws the groove, registers the GPU overlay for fill + knob and the drag widget. `read` returns the current
 * store value; while dragging (or just after) the held value wins. Nothing here needs a canvas redraw per drag step.
 */
function slider(
  env: TabEnv, key: string, x: number, cy: number, w: number,
  read: () => number, min: number, max: number, step: number, commit: (v: number) => void,
): void {
  drawSliderTrack(env.ctx, x, cy, w);
  env.live.sliders.push({ x, cy, w, value: () => ((env.hold(key) ?? read()) - min) / (max - min) });
  const send = (v: number): void => {
    lastCommitAt.set(key, performance.now());
    lastCommitValue.set(key, v);
    commit(v);
  };
  env.widgets.add({
    key, x: x - 36, y: cy - 46, w: w + 72, h: 92, r: 30,
    drag: (px, _py, phase) => {
      const raw = min + clamp((px - x) / w, 0, 1) * (max - min);
      const v = clamp(+(Math.round(raw / step) * step).toFixed(4), min, max);
      if (phase === 'end') {
        env.setHold(key, v, 450);
        if (lastCommitValue.get(key) !== v) send(v);
        lastCommitValue.delete(key);
        env.invalidate();
      } else {
        env.setHold(key, v, Infinity);
        if (phase === 'start' || (performance.now() - (lastCommitAt.get(key) ?? 0) > 45 && lastCommitValue.get(key) !== v)) send(v);
      }
    },
  });
}

function drawEqGlyph(env: TabEnv, cx: number, cy: number, color: string): void {
  const { ctx } = env;
  const hs = [22, 38, 28];
  hs.forEach((h, i) => fillRound(ctx, cx - 25 + i * 20, cy + 19 - h, 11, h, 4, color));
}

// ---------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------

function drawThumb(env: TabEnv, track: Track | null, x: number, y: number, s: number): void {
  const { ctx, accent: a } = env;
  const img = track && track.thumbnail ? env.images.get(track.thumbnail) : null;
  ctx.save();
  roundRectPath(ctx, x, y, s, s, 30);
  ctx.clip();
  if (img) {
    const scale = Math.max(s / img.naturalWidth, s / img.naturalHeight);
    const sw = s / scale;
    const sh = s / scale;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, s, s);
  } else {
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, rgba(a.main, 0.38));
    g.addColorStop(1, rgba(a.alt, 0.12));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = 'rgba(8,9,20,0.55)';
    ctx.fillRect(x, y, s, s);
    const icon: IconName = track && track.kind === 'mic' ? 'mic' : 'note';
    drawIcon(ctx, icon, x + s / 2, y + s / 2, s * 0.42, 'rgba(255,255,255,0.55)');
  }
  ctx.restore();
  strokeRound(ctx, x + 1.5, y + 1.5, s - 3, s - 3, 29, 'rgba(255,255,255,0.18)', 3);
}

export function drawPlayer(env: TabEnv): void {
  const { ctx, state: s, actions: act, accent: a } = env;
  const pb = s.playback;
  const track = pb.track;
  const queue = pb.queue;
  const LW = 950;

  // ---- now playing --------------------------------------------------------------------------
  const thS = 312;
  drawThumb(env, track, LEFT, TOP + 4, thS);
  const tx = LEFT + thS + 40;
  const tw = LEFT + LW - tx;
  let ty = TOP + 58;
  if (track) {
    ctx.font = font(FS.title, 800);
    const lines = wrapText(ctx, track.title || 'Untitled', tw, 2);
    lines.forEach((ln, i) => drawText(ctx, ln, tx, ty + i * 66, FS.title, COLOR.text, { weight: 800 }));
    ty += lines.length * 66 + 6;
    if (track.artist) {
      ctx.font = font(FS.body, 600);
      drawText(ctx, fitText(ctx, track.artist, tw), tx, ty, FS.body, COLOR.textDim, { weight: 600 });
    }
  } else {
    drawText(ctx, 'Nothing playing', tx, ty, FS.title, COLOR.text, { weight: 800 });
    ctx.font = font(FS.body, 600);
    drawText(ctx, fitText(ctx, 'Open Sources to start', tw), tx, ty + 66, FS.body, COLOR.textDim, { weight: 600 });
  }
  // status pill (source kind / loading / error)
  {
    let text = track ? KIND_LABEL[track.kind] : 'IDLE';
    let col: string = a.mainCss;
    if (pb.status === 'loading') { text = 'LOADING…'; col = COLOR.warn; }
    else if (pb.status === 'error') { text = pb.message ? pb.message : 'ERROR'; col = COLOR.bad; }
    ctx.font = font(FS.label, 800);
    ctx.letterSpacing = '3px';
    const label = fitText(ctx, text, tw - 56);
    const pw = Math.ceil(ctx.measureText(label).width) + 56;
    ctx.letterSpacing = '0px';
    const ph = 64;
    const py = TOP + 4 + thS - ph;
    fillRound(ctx, tx, py, pw, ph, ph / 2, 'rgba(255,255,255,0.07)');
    strokeRound(ctx, tx + 1.5, py + 1.5, pw - 3, ph - 3, ph / 2 - 1, col, 2.5);
    drawText(ctx, label, tx + 28, py + ph / 2 + 2, FS.label, col, { weight: 800, spacing: 3, baseline: 'middle' });
  }

  // ---- progress (fill, knob and the elapsed-time read-out are live overlays) -----------------
  const barX = 250;
  const barW = 584;
  const barY = 570;
  const dur = pb.duration;
  const seekable = !!track && track.kind !== 'mic' && Number.isFinite(dur) && dur > 0;
  drawSliderTrack(ctx, barX, barY, barW);
  env.live.sliders.push({
    x: barX, cy: barY, w: barW, disabled: !seekable,
    value: () => (seekable ? (env.hold('seek') ?? clamp(env.playhead() / dur, 0, 1)) : 0),
  });
  liveLabel(env, {
    x: LEFT, cy: barY, align: 'left', color: COLOR.textDim,
    sig: () => {
      if (!track) return -1;
      if (track.kind === 'mic') return -2;
      const held = env.hold('seek');
      return Math.floor(held !== undefined && seekable ? held * dur : env.playhead());
    },
    text: (n) => (n === -1 ? '–:––' : n === -2 ? 'LIVE' : formatTime(n)),
  });
  drawText(ctx, seekable ? formatTime(dur) : '–:––', LEFT + LW, barY + 2, FS.label, COLOR.textDim, { weight: 700, align: 'right', baseline: 'middle' });
  if (seekable) {
    env.widgets.add({
      key: 'seek', x: barX - 36, y: barY - 50, w: barW + 72, h: 100, r: 32,
      drag: (px, _py, phase) => {
        const f = clamp((px - barX) / barW, 0, 1);
        if (phase === 'end') {
          env.setHold('seek', f, 700);
          act.seek(Math.min(f * dur, Math.max(0, dur - SEEK_END_MARGIN)));
          env.invalidate();
        } else {
          env.setHold('seek', f, Infinity);
        }
      },
    });
  }

  // ---- transport ----------------------------------------------------------------------------
  const cx = LEFT + LW / 2;
  const ty0 = 724;
  const can = queue.length > 0 || !!track;
  circleButton(env, { key: 'shuffle', cx: cx - 420, cy: ty0, r: 46, icon: 'shuffle', active: pb.shuffle, click: () => act.setShuffle(!pb.shuffle) });
  circleButton(env, { key: 'back10', cx: cx - 286, cy: ty0, r: 58, seek: -1, disabled: !seekable, click: () => act.seekBy(-10) });
  circleButton(env, { key: 'prev', cx: cx - 156, cy: ty0, r: 54, icon: 'prev', disabled: !can, click: () => act.prev() });
  circleButton(env, { key: 'toggle', cx, cy: ty0, r: 80, icon: pb.playing ? 'pause' : 'play', primary: true, disabled: !can, click: () => act.toggle() });
  circleButton(env, { key: 'next', cx: cx + 156, cy: ty0, r: 54, icon: 'next', disabled: !can, click: () => act.next() });
  circleButton(env, { key: 'fwd10', cx: cx + 286, cy: ty0, r: 58, seek: 1, disabled: !seekable, click: () => act.seekBy(10) });
  const nextRepeat = pb.repeat === 'off' ? 'all' : pb.repeat === 'all' ? 'one' : 'off';
  circleButton(env, {
    key: 'repeat', cx: cx + 420, cy: ty0, r: 46, icon: pb.repeat === 'one' ? 'repeatOne' : 'repeat',
    active: pb.repeat !== 'off', click: () => act.setRepeat(nextRepeat),
  });

  // ---- volume -------------------------------------------------------------------------------
  const volY = 890;
  const vol = env.hold('volume') ?? pb.volume;
  if (pb.volume > 0.01) env.local.lastVolume = pb.volume;
  circleButton(env, {
    key: 'mute', cx: LEFT + 46, cy: volY, r: 46, icon: vol <= 0.01 ? 'volumeMute' : 'volume',
    click: () => act.setVolume(pb.volume > 0.01 ? 0 : env.local.lastVolume || 0.6),
  });
  slider(env, 'volume', barX, volY, barW, () => env.state.playback.volume, 0, 1, 0.01, (v) => act.setVolume(v));
  liveLabel(env, {
    x: LEFT + LW, cy: volY, align: 'right', color: COLOR.textDim,
    sig: () => Math.round((env.hold('volume') ?? env.state.playback.volume) * 100),
    text: (n) => `${n}%`,
  });

  // ---- scene / palette quick switch ---------------------------------------------------------
  const cy0 = 982;
  const cH = BOTTOM - cy0;
  drawCard(ctx, LEFT, cy0, LW, cH);
  sectionLabel(env, 'SCENE', LEFT + 40, cy0 + 66);
  const presetIdx = Math.max(0, s.presets.findIndex((p) => p.id === s.preset));
  const cur = s.presets[presetIdx];
  circleButton(env, { key: 'qs-prev', cx: LEFT + 92, cy: cy0 + 134, r: 40, icon: 'chevronLeft', click: () => act.prevPreset() });
  circleButton(env, { key: 'qs-next', cx: LEFT + LW - 92, cy: cy0 + 134, r: 40, icon: 'chevronRight', click: () => act.nextPreset() });
  ctx.font = font(52, 800);
  drawText(ctx, fitText(ctx, cur ? cur.name : '–', LW - 330), LEFT + LW / 2, cy0 + 134, 52, COLOR.text, { weight: 800, align: 'center', baseline: 'middle' });
  if (s.presets.length > 0) {
    drawText(ctx, `${presetIdx + 1} / ${s.presets.length}`, LEFT + LW - 40, cy0 + 66, FS.label, COLOR.textDim, { weight: 700, align: 'right' });
  }
  // palette dots: 60 px discs on a 74 px pitch, so every hit rect is 74 px ≈ 50 mm
  const dotR = 30;
  const pitch = 74;
  const n = s.palettes.length;
  const dy = cy0 + 210;
  let dx = LEFT + LW / 2 - (n * pitch) / 2 + pitch / 2;
  for (const p of s.palettes) {
    const g = ctx.createLinearGradient(dx - dotR, dy - dotR, dx + dotR, dy + dotR);
    p.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, p.stops.length - 1), c));
    circle(ctx, dx, dy, dotR, g);
    if (p.id === s.palette) {
      ctx.beginPath();
      ctx.arc(dx, dy, dotR + 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    hit(env, `pal-dot-${p.id}`, dx - pitch / 2, dy - pitch / 2, pitch, pitch, pitch / 2, () => act.setPalette(p.id));
    dx += pitch;
  }

  // ---- queue --------------------------------------------------------------------------------
  const QX = 1070;
  const QW = RIGHT - QX;
  const ROWS = 6;
  const RH = 140;
  const GAP = 10;
  const RY = 276;
  const total = queue.length;
  const headY = TOP + 36;
  const qlw = sectionLabel(env, 'QUEUE', QX, headY + 15);
  if (total > 0) {
    drawText(ctx, `${total} ${total === 1 ? 'track' : 'tracks'}`, QX + qlw + 24, headY + 15, FS.label, COLOR.textDim, { weight: 700 });
  }
  if (pb.index !== env.local.lastIndex) {
    env.local.lastIndex = pb.index;
    env.local.queueTop = null;
  }
  const maxTop = Math.max(0, total - ROWS);
  const top = clamp(env.local.queueTop ?? pb.index - 2, 0, maxTop);
  if (total > ROWS) {
    circleButton(env, { key: 'q-up', cx: QX + QW - 330, cy: headY, r: 34, icon: 'chevronUp', disabled: top <= 0, click: () => { env.local.queueTop = Math.max(0, top - 2); env.invalidate(); } });
    circleButton(env, { key: 'q-down', cx: QX + QW - 242, cy: headY, r: 34, icon: 'chevronDown', disabled: top >= maxTop, click: () => { env.local.queueTop = Math.min(maxTop, top + 2); env.invalidate(); } });
  }
  if (total > 0) {
    const bw = 168;
    const bh = 72;
    const bx = QX + QW - bw;
    fillRound(ctx, bx, headY - bh / 2, bw, bh, bh / 2, 'rgba(255,255,255,0.09)');
    strokeRound(ctx, bx + 1.5, headY - bh / 2 + 1.5, bw - 3, bh - 3, bh / 2 - 1, 'rgba(255,255,255,0.16)', 2);
    drawText(ctx, 'Clear', bx + bw / 2, headY + 2, FS.label, COLOR.text, { weight: 700, align: 'center', baseline: 'middle' });
    hit(env, 'q-clear', bx, headY - bh / 2, bw, bh, bh / 2, () => act.clearQueue());
  }

  if (total === 0) {
    drawCard(ctx, QX, RY - 4, QW, BOTTOM - RY + 4, 30);
    drawIcon(ctx, 'note', QX + QW / 2, RY + 250, 160, 'rgba(255,255,255,0.22)');
    ctx.font = font(52, 800);
    const lines = wrapText(ctx, 'Nothing playing — open Sources', QW - 140, 2);
    lines.forEach((ln, i) => drawText(ctx, ln, QX + QW / 2, RY + 436 + i * 64, 52, COLOR.text, { weight: 800, align: 'center' }));
    const bw = 480;
    const bh = 112;
    const bx = QX + (QW - bw) / 2;
    const by = RY + 580;
    fillRound(ctx, bx, by, bw, bh, bh / 2, hGradient(ctx, bx, bx + bw, a.mainCss, a.altCss));
    drawText(ctx, 'Open Sources', bx + bw / 2, by + bh / 2 + 2, FS.body, a.ink, { weight: 800, align: 'center', baseline: 'middle' });
    hit(env, 'open-sources', bx, by, bw, bh, bh / 2, () => act.setTab('sources'));
    return;
  }

  for (let r = 0; r < ROWS && top + r < total; r++) {
    const i = top + r;
    const t = queue[i];
    const y = RY + r * (RH + GAP);
    const current = i === pb.index;
    fillRound(ctx, QX, y, QW, RH, 26, current ? a.soft : COLOR.surface);
    strokeRound(ctx, QX + 1, y + 1, QW - 2, RH - 2, 25, current ? a.glow : COLOR.stroke, 2.5);
    if (current) fillRound(ctx, QX + 14, y + 26, 8, RH - 52, 4, a.mainCss);
    const midY = y + RH / 2;
    if (current && pb.playing) drawEqGlyph(env, QX + 64, midY, a.mainCss);
    else drawText(ctx, String(i + 1), QX + 64, midY + 2, FS.label, current ? a.mainCss : COLOR.textFaint, { weight: 800, align: 'center', baseline: 'middle' });
    const textX = QX + 116;
    const textW = QW - 116 - 124;
    ctx.font = font(FS.body, 700);
    drawText(ctx, fitText(ctx, t.title || 'Untitled', textW), textX, y + 62, FS.body, current ? COLOR.text : '#e1e5fa', { weight: 700 });
    const sub = [t.artist, KIND_LABEL[t.kind].toLowerCase()].filter(Boolean).join('  ·  ');
    ctx.font = font(FS.label, 600);
    const durText = t.duration ? formatTime(t.duration) : '';
    const durW = durText ? Math.ceil(ctx.measureText(durText).width) + 24 : 0;
    if (durText) drawText(ctx, durText, textX + textW, y + 116, FS.label, COLOR.textDim, { weight: 600, align: 'right' });
    drawText(ctx, fitText(ctx, sub, textW - durW), textX, y + 116, FS.label, COLOR.textFaint, { weight: 600 });
    drawIcon(ctx, 'close', QX + QW - 60, midY, 44, COLOR.textDim);
    hit(env, `q-row-${i}`, QX, y, QW - 120, RH, 26, () => (current ? act.toggle() : act.play(i)));
    hit(env, `q-del-${i}`, QX + QW - 120, y + 14, 106, RH - 28, 26, () => act.removeTrack(i));
  }
  if (total > ROWS) {
    drawText(ctx, `${top + 1}–${Math.min(total, top + ROWS)} of ${total}`, QX + QW / 2, RY + ROWS * (RH + GAP) + 38, FS.label, COLOR.textDim, { weight: 700, align: 'center' });
  }
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

export function drawScenes(env: TabEnv): void {
  const { ctx, state: s, actions: act, accent: a } = env;
  const per = 6;
  const pages = Math.max(1, Math.ceil(s.presets.length / per));
  const activeIdx = Math.max(0, s.presets.findIndex((p) => p.id === s.preset));
  const page = clamp(env.local.scenePage ?? Math.floor(activeIdx / per), 0, pages - 1);

  // left column: scene tiles, description of the active scene, palettes. right column: tuning
  const COLW = 1320;
  const RX = 1424;
  const RW = RIGHT - RX;

  sectionLabel(env, 'SCENES', LEFT, TOP + 36);
  if (pages > 1) {
    const nextX = LEFT + COLW - 40;
    drawText(ctx, `${page + 1} / ${pages}`, nextX - 126, TOP + 36, FS.label, COLOR.textDim, { weight: 700, align: 'right' });
    circleButton(env, { key: 'sc-prev', cx: nextX - 84, cy: TOP + 22, r: 32, icon: 'chevronLeft', disabled: page <= 0, click: () => { env.local.scenePage = page - 1; env.invalidate(); } });
    circleButton(env, { key: 'sc-next', cx: nextX, cy: TOP + 22, r: 32, icon: 'chevronRight', disabled: page >= pages - 1, click: () => { env.local.scenePage = page + 1; env.invalidate(); } });
  }
  const TW = (COLW - 20) / 2;
  const TH = 152;
  const G = 18;
  const y0 = TOP + 72;
  for (let k = 0; k < per; k++) {
    const idx = page * per + k;
    const p = s.presets[idx];
    if (!p) break;
    const x = LEFT + (k % 2) * (TW + 20);
    const y = y0 + Math.floor(k / 2) * (TH + G);
    const active = p.id === s.preset;
    if (active) {
      const g = ctx.createLinearGradient(x, y, x + TW, y + TH);
      g.addColorStop(0, rgba(a.main, 0.34));
      g.addColorStop(1, rgba(a.alt, 0.12));
      fillRound(ctx, x, y, TW, TH, 28, g);
      strokeRound(ctx, x + 2, y + 2, TW - 4, TH - 4, 27, hGradient(ctx, x, x + TW, a.mainCss, a.altCss), 5);
      circle(ctx, x + TW - 52, y + TH / 2, 26, hGradient(ctx, x + TW - 78, x + TW - 26, a.mainCss, a.altCss));
      drawIcon(ctx, 'check', x + TW - 52, y + TH / 2, 34, a.ink);
    } else {
      drawCard(ctx, x, y, TW, TH, 28);
      drawText(ctx, String(idx + 1).padStart(2, '0'), x + TW - 32, y + TH / 2 + 2, FS.label, COLOR.textFaint, { weight: 800, align: 'right', baseline: 'middle' });
    }
    ctx.font = font(FS.body, 700);
    drawText(ctx, fitText(ctx, p.name, TW - 32 - 100), x + 32, y + TH / 2 + 2, FS.body, COLOR.text, { weight: 700, baseline: 'middle' });
    hit(env, `preset-${p.id}`, x, y, TW, TH, 28, () => act.setPreset(p.id));
  }

  // what the active scene is
  const capY = y0 + 3 * TH + 2 * G + G;
  const capH = 132;
  const activePreset = s.presets[activeIdx];
  drawCard(ctx, LEFT, capY, COLW, capH, 26);
  if (activePreset) {
    fillRound(ctx, LEFT + 16, capY + 24, 6, capH - 48, 3, a.mainCss);
    ctx.font = font(FS.body, 600);
    const lines = wrapText(ctx, activePreset.description, COLW - 96, 2);
    const first = capY + (capH - lines.length * 56) / 2 + 42;
    lines.forEach((ln, i) => drawText(ctx, ln, LEFT + 44, first + i * 56, FS.body, COLOR.textDim, { weight: 600 }));
  }

  // palettes
  const perRow = 4;
  const chipGap = 14;
  const chipH = 104;
  const palLabelY = capY + capH + 62;
  const curPal = s.palettes.find((p) => p.id === s.palette);
  sectionLabel(env, 'PALETTE', LEFT, palLabelY);
  if (curPal) drawText(ctx, curPal.name, LEFT + COLW, palLabelY, FS.body, COLOR.textDim, { weight: 700, align: 'right' });
  const chipW = Math.floor((COLW - (perRow - 1) * chipGap) / perRow);
  const cy0 = palLabelY + 26;
  s.palettes.forEach((p, i) => {
    const x = LEFT + (i % perRow) * (chipW + chipGap);
    const y = cy0 + Math.floor(i / perRow) * (chipH + chipGap);
    drawPaletteChip(ctx, x, y, chipW, chipH, p.stops, p.name, p.id === s.palette, a);
    hit(env, `palette-${p.id}`, x - 4, y - 4, chipW + 8, chipH + 8, 28, () => act.setPalette(p.id));
  });

  // sliders (fill, knob and value are live overlays)
  sectionLabel(env, 'TUNING', RX, TOP + 36);
  const sliders: { key: string; label: string; min: number; max: number; k: 'intensity' | 'speed' | 'glow' }[] = [
    { key: 'intensity', label: 'Intensity', min: 0, max: 2, k: 'intensity' },
    { key: 'speed', label: 'Speed', min: 0, max: 2, k: 'speed' },
    { key: 'glow', label: 'Glow', min: 0, max: 1, k: 'glow' },
  ];
  sliders.forEach((sl, i) => {
    const top = y0 + i * 156;
    drawText(ctx, sl.label, RX, top + 32, FS.body, COLOR.text, { weight: 700, baseline: 'middle' });
    liveLabel(env, {
      x: RIGHT, cy: top + 32, align: 'right', size: FS.body, color: COLOR.textDim,
      sig: () => Math.round((env.hold(`param-${sl.key}`) ?? env.state.params[sl.k]) * 100),
      text: (n) => (n / 100).toFixed(2),
    });
    slider(env, `param-${sl.key}`, RX + 40, top + 106, RW - 80, () => env.state.params[sl.k], sl.min, sl.max, 0.05, (val) => act.setParam(sl.k, val));
  });

  // toggles
  const tgY = y0 + 3 * 156 + 6;
  const tgH = 104;
  const toggles: { key: string; label: string; on: boolean; click: () => void }[] = [
    { key: 'autocycle', label: 'Auto-cycle', on: s.autoCycle, click: () => act.setAutoCycle(!s.autoCycle) },
    { key: 'background', label: 'Background', on: s.params.background, click: () => act.setParam('background', !s.params.background) },
  ];
  toggles.forEach((t, i) => {
    const ty = tgY + i * (tgH + 16);
    drawCard(ctx, RX, ty, RW, tgH, 26);
    drawText(ctx, t.label, RX + 28, ty + tgH / 2 + 2, FS.body, COLOR.text, { weight: 700, baseline: 'middle' });
    drawSwitch(ctx, RX + RW - 112 - 24, ty + tgH / 2, t.on, a);
    hit(env, `toggle-${t.key}`, RX, ty, RW, tgH, 26, t.click);
  });
  ctx.font = font(FS.label, 600);
  const note = s.autoCycle ? `Next scene every ${s.cycleSeconds} s` : 'Switch scenes on a timer';
  drawText(ctx, fitText(ctx, note, RW - 16), RX + 8, tgY + 2 * (tgH + 16) + 36, FS.label, COLOR.textFaint, { weight: 600, baseline: 'middle' });
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

function bigTile(env: TabEnv, key: string, x: number, y: number, w: number, h: number, active: boolean, click: () => void): void {
  const { ctx, accent: a } = env;
  if (active) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, rgba(a.main, 0.32));
    g.addColorStop(1, rgba(a.alt, 0.1));
    fillRound(ctx, x, y, w, h, 30, g);
    strokeRound(ctx, x + 2, y + 2, w - 4, h - 4, 29, hGradient(ctx, x, x + w, a.mainCss, a.altCss), 5);
  } else {
    drawCard(ctx, x, y, w, h, 30);
  }
  hit(env, key, x, y, w, h, 30, click);
}

export function drawSources(env: TabEnv): void {
  const { ctx, state: s, actions: act, accent: a, features } = env;
  const pb = s.playback;
  const TWID = 940;
  const TH = 300;
  const micOn = pb.micEnabled;
  const silent = features.silence;

  // microphone tile
  bigTile(env, 'mic', LEFT, TOP, TWID, TH, micOn, () => (micOn ? act.disableMic() : act.enableMic()));
  circle(ctx, LEFT + 104, TOP + 96, 56, micOn ? hGradient(ctx, LEFT + 48, LEFT + 160, a.mainCss, a.altCss) : 'rgba(255,255,255,0.09)');
  drawIcon(ctx, 'mic', LEFT + 104, TOP + 96, 62, micOn ? a.ink : COLOR.text);
  drawText(ctx, micOn ? 'Microphone on' : 'Microphone off', LEFT + 196, TOP + 88, FS.title, COLOR.text, { weight: 800 });
  const micStatus = micOn ? (silent ? 'No signal yet' : 'Listening') : 'Tap to turn on';
  drawText(ctx, micStatus, LEFT + 196, TOP + 148, FS.body, micOn ? (silent ? COLOR.warn : COLOR.good) : COLOR.textDim, { weight: 600 });
  const lvlW = sectionLabel(env, 'LEVEL', LEFT + 40, TOP + 250);
  const meterX = LEFT + 40 + lvlW + 28;
  drawMeter(ctx, meterX, TOP + 220, LEFT + TWID - 40 - meterX, 40, features.level, 24, a);

  // demo tile
  const dx = RIGHT - TWID;
  const demoPlaying = !!pb.track && pb.track.kind === 'demo' && pb.playing;
  bigTile(env, 'demo', dx, TOP, TWID, TH, demoPlaying, () => act.startDemo());
  circle(ctx, dx + 104, TOP + 96, 56, demoPlaying ? hGradient(ctx, dx + 48, dx + 160, a.mainCss, a.altCss) : 'rgba(255,255,255,0.09)');
  drawIcon(ctx, demoPlaying ? 'pause' : 'play', dx + 104, TOP + 96, 62, demoPlaying ? a.ink : COLOR.text);
  drawText(ctx, 'Demo track', dx + 196, TOP + 88, FS.title, COLOR.text, { weight: 800 });
  drawText(ctx, demoPlaying ? 'Playing now' : 'Tap to start', dx + 196, TOP + 148, FS.body, demoPlaying ? COLOR.good : COLOR.textDim, { weight: 600 });
  ctx.font = font(FS.body, 600);
  wrapText(ctx, 'Built-in music at about 124 BPM, works offline.', TWID - 80, 2)
    .forEach((ln, i) => drawText(ctx, ln, dx + 40, TOP + 220 + i * 54, FS.body, COLOR.textDim, { weight: 600 }));

  // YouTube card
  const yy = TOP + TH + 24;
  const yh = 304;
  drawCard(ctx, LEFT, yy, RIGHT - LEFT, yh, 30);
  drawIcon(ctx, 'play', LEFT + 74, yy + 62, 58, '#ff4d5e');
  sectionLabel(env, 'YOUTUBE & LINKS', LEFT + 128, yy + 76);
  {
    const bw = 340;
    const bh = 88;
    const bx = RIGHT - 44 - bw;
    const by = yy + 20;
    fillRound(ctx, bx, by, bw, bh, bh / 2, 'rgba(255,255,255,0.09)');
    strokeRound(ctx, bx + 1.5, by + 1.5, bw - 3, bh - 3, bh / 2 - 1, a.glow, 3);
    drawText(ctx, 'Open Player', bx + bw / 2, by + bh / 2 + 2, FS.body, COLOR.text, { weight: 700, align: 'center', baseline: 'middle' });
    hit(env, 'open-player', bx, by, bw, bh, bh / 2, () => act.setTab('player'));
  }
  ctx.font = font(FS.body, 700);
  wrapText(ctx, 'Add YouTube/URL in the 2D browser window before entering VR; playback controls work here.', RIGHT - LEFT - 100, 2)
    .forEach((ln, i) => drawText(ctx, ln, LEFT + 50, yy + 164 + i * 60, FS.body, COLOR.text, { weight: 700 }));
  ctx.font = font(FS.body, 600);
  drawText(ctx, fitText(ctx, 'Audio is analysed through the headset microphone.', RIGHT - LEFT - 100), LEFT + 50, yy + 278, FS.body, COLOR.textDim, { weight: 600 });

  // status card
  const sy = yy + yh + 24;
  const sh = BOTTOM - sy;
  drawCard(ctx, LEFT, sy, RIGHT - LEFT, sh, 30);
  const analysis = pb.analysisInput === 'element' ? 'Direct from the player' : pb.analysisInput === 'mic' ? 'Microphone loop-back' : 'None yet';
  const engine = pb.status === 'idle' ? 'Idle' : pb.status === 'loading' ? 'Loading…' : pb.status === 'ready' ? 'Ready' : 'Error';
  const cells: { k: string; v: string; col: string }[] = [
    { k: 'Analysis input', v: analysis, col: COLOR.text },
    { k: 'Engine', v: pb.message ? `${engine} — ${pb.message}` : engine, col: pb.status === 'error' ? COLOR.bad : pb.status === 'loading' ? COLOR.warn : COLOR.text },
    { k: 'Microphone', v: micOn ? 'Open' : 'Closed', col: micOn ? COLOR.good : COLOR.textDim },
    { k: 'Signal', v: features.active ? (silent ? 'Silent' : `Active · ${Math.round(features.level * 100)}%`) : 'Idle', col: features.active && !silent ? COLOR.good : COLOR.textDim },
  ];
  const cellW = (RIGHT - LEFT) / 2;
  cells.forEach((c, i) => {
    const cx0 = LEFT + 44 + (i % 2) * cellW;
    const cy1 = sy + 22 + Math.floor(i / 2) * 112;
    drawText(ctx, c.k, cx0, cy1 + 40, FS.label, COLOR.textFaint, { weight: 700 });
    ctx.font = font(FS.body, 700);
    drawText(ctx, fitText(ctx, c.v, cellW - 88), cx0, cy1 + 92, FS.body, c.col, { weight: 700 });
  });
  const needHint = (micOn || pb.analysisInput === 'mic') && silent;
  const hy = sy + 22 + 2 * 112 + 8;
  const hh = sh - (hy - sy) - 22;
  ctx.font = font(FS.body, 600);
  if (needHint) {
    fillRound(ctx, LEFT + 32, hy, RIGHT - LEFT - 64, hh, 24, 'rgba(255,196,87,0.13)');
    strokeRound(ctx, LEFT + 33.5, hy + 1.5, RIGHT - LEFT - 67, hh - 3, 23, 'rgba(255,196,87,0.6)', 3);
    wrapText(ctx, 'The microphone hears nothing. Raise the headset volume, keep the audio playing and allow microphone access.', RIGHT - LEFT - 130, 2)
      .forEach((ln, i) => drawText(ctx, ln, LEFT + 62, hy + 50 + i * 56, FS.body, COLOR.warn, { weight: 600 }));
  } else {
    wrapText(ctx, 'Tip: the microphone feeds the visuals only. It is never played back.', RIGHT - LEFT - 100, 2)
      .forEach((ln, i) => drawText(ctx, ln, LEFT + 50, hy + 50 + i * 56, FS.body, COLOR.textFaint, { weight: 600 }));
  }
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

interface LegendRow {
  caps: string[];
  arrows?: 'lr' | 'ud';
  text: string;
}

const LEGEND: LegendRow[] = [
  { caps: ['TRIGGER', 'PINCH'], text: 'Click, drag, seek' },
  { caps: ['GRIP'], text: 'Hold on the menu to move it' },
  { caps: ['STICK'], arrows: 'lr', text: 'Previous / next scene' },
  { caps: ['STICK'], arrows: 'ud', text: 'Volume down / up' },
  { caps: ['A', 'X'], text: 'Play / pause' },
  { caps: ['B', 'Y'], text: 'Show / hide menu' },
];

let qualityLabel = '';

export function drawSettings(env: TabEnv): void {
  const { ctx, state: s, actions: act, accent: a } = env;
  const LW = 860;
  const info = env.renderInfo();

  // Recenter
  const bh = 132;
  const gap = 18;
  drawCard(ctx, LEFT, TOP, LW, bh, 30);
  circle(ctx, LEFT + 84, TOP + bh / 2, 44, 'rgba(255,255,255,0.09)');
  drawIcon(ctx, 'recenter', LEFT + 84, TOP + bh / 2, 52, a.mainCss);
  drawText(ctx, 'Recenter menu', LEFT + 168, TOP + 62, 52, COLOR.text, { weight: 800 });
  drawText(ctx, 'Place it in front of you', LEFT + 168, TOP + 108, FS.label, COLOR.textDim, { weight: 600 });
  hit(env, 'recenter', LEFT, TOP, LW, bh, 30, () => act.recenter());

  // Exit / enter VR
  const ey = TOP + bh + gap;
  const inXr = s.mode === 'xr';
  const canEnter = inXr || s.xrSupported;
  ctx.save();
  if (!canEnter) ctx.globalAlpha = 0.5;
  drawCard(ctx, LEFT, ey, LW, bh, 30, inXr ? 'rgba(255,107,129,0.11)' : undefined);
  circle(ctx, LEFT + 84, ey + bh / 2, 44, 'rgba(255,255,255,0.09)');
  drawIcon(ctx, inXr ? 'exit' : 'headset', LEFT + 84, ey + bh / 2, 52, inXr ? COLOR.bad : a.mainCss);
  drawText(ctx, inXr ? 'Exit VR' : 'Enter VR', LEFT + 168, ey + 62, 52, COLOR.text, { weight: 800 });
  ctx.font = font(FS.label, 600);
  drawText(ctx, fitText(ctx, inXr ? 'Return to the 2D page' : canEnter ? 'Start an immersive session' : 'WebXR is not available here', LW - 168 - 28), LEFT + 168, ey + 108, FS.label, COLOR.textDim, { weight: 600 });
  ctx.restore();
  if (canEnter) hit(env, 'vr', LEFT, ey, LW, bh, 30, () => act.enterVR());

  // Auto-hide
  const ay = ey + bh + gap;
  const ah = 132;
  drawCard(ctx, LEFT, ay, LW, ah, 30);
  drawText(ctx, 'Auto-hide menu', LEFT + 40, ay + 62, FS.body, COLOR.text, { weight: 700 });
  ctx.font = font(FS.label, 600);
  drawText(ctx, fitText(ctx, 'After 12 s without input', LW - 40 - 190), LEFT + 40, ay + 108, FS.label, COLOR.textDim, { weight: 600 });
  drawSwitch(ctx, LEFT + LW - 112 - 36, ay + ah / 2, env.autoHide, a);
  hit(env, 'autohide', LEFT, ay, LW, ah, 30, () => env.setAutoHide(!env.autoHide));

  // Performance
  const py = ay + ah + gap;
  const ph = BOTTOM - py;
  drawCard(ctx, LEFT, py, LW, ph, 30);
  sectionLabel(env, 'PERFORMANCE', LEFT + 40, py + 68);
  const target = env.presenting ? (info.frameRate || 72) : 60;
  const ratio = s.fps / target;
  const fpsCol = s.fps <= 0 ? COLOR.textDim : ratio >= 0.92 ? COLOR.good : ratio >= 0.7 ? COLOR.warn : COLOR.bad;
  ctx.font = font(150, 800);
  const fpsText = s.fps > 0 ? String(s.fps) : '–';
  const fw = ctx.measureText(fpsText).width;
  drawText(ctx, fpsText, LEFT + 40, py + 226, 150, fpsCol, { weight: 800 });
  drawText(ctx, 'FPS', LEFT + 40 + fw + 24, py + 222, FS.body, COLOR.textDim, { weight: 700 });
  if (!qualityLabel) qualityLabel = detectQuality().toUpperCase();
  const perf: { k: string; v: string }[] = [
    { k: 'Quality', v: qualityLabel },
    { k: 'Display', v: env.presenting ? `${info.frameRate || 72} Hz headset` : 'Desktop window' },
    { k: 'Draw calls', v: String(info.calls) },
    { k: 'Triangles', v: info.triangles >= 1000 ? `${(info.triangles / 1000).toFixed(info.triangles >= 100000 ? 0 : 1)}k` : String(info.triangles) },
  ];
  perf.forEach((r, i) => {
    const ry = py + 316 + i * 68;
    drawText(ctx, r.k, LEFT + 40, ry, FS.label, COLOR.textFaint, { weight: 700, baseline: 'middle' });
    drawText(ctx, r.v, LEFT + LW - 40, ry, FS.body, COLOR.text, { weight: 700, align: 'right', baseline: 'middle' });
  });

  // Controls legend
  const lx = LEFT + LW + 40;
  const lw = RIGHT - lx;
  const lh = BOTTOM - TOP;
  drawCard(ctx, lx, TOP, lw, lh, 30);
  sectionLabel(env, 'CONTROLS', lx + 44, TOP + 76);
  const rowH = 134;
  const textX = lx + 44 + 490;
  LEGEND.forEach((row, i) => {
    const cy = TOP + 182 + i * rowH;
    if (i > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(lx + 44, cy - rowH / 2, lw - 88, 2);
    }
    let x = lx + 44;
    row.caps.forEach((c, ci) => {
      if (ci > 0) {
        drawText(ctx, '/', x + 14, cy + 2, FS.label, COLOR.textFaint, { weight: 600, align: 'center', baseline: 'middle' });
        x += 28;
      }
      x += drawKeycap(ctx, x, cy, c, a);
    });
    if (row.arrows) {
      const [i1, i2]: [IconName, IconName] = row.arrows === 'lr' ? ['chevronLeft', 'chevronRight'] : ['chevronDown', 'chevronUp'];
      drawIcon(ctx, i1, x + 34, cy, 54, a.mainCss);
      drawIcon(ctx, i2, x + 34 + 52, cy, 54, a.mainCss);
    }
    ctx.font = font(FS.body, 600);
    const avail = lx + lw - 40 - textX;
    const lines = wrapText(ctx, row.text, avail, 2);
    lines.forEach((ln, li) => drawText(ctx, ln, textX, cy + (lines.length === 1 ? 2 : li * 54 - 25), FS.body, COLOR.text, { weight: 600, baseline: 'middle' }));
  });
  ctx.font = font(FS.body, 600);
  wrapText(ctx, 'Hand tracking: point at the menu and pinch to click.', lw - 88, 2)
    .forEach((ln, i) => drawText(ctx, ln, lx + 44, TOP + lh - 84 + i * 56, FS.body, COLOR.textDim, { weight: 600 }));
}
