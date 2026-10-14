import type { SourceKind, Track } from '@/audio/types';
import { clamp, detectQuality } from '@/util/device';
import {
  COLOR, circle, drawCard, drawIcon, drawKeycap, drawMeter, drawPaletteChip, drawSeekIcon, drawSlider, drawSwitch, drawText,
  fillRound, fitText, font, formatTime, hGradient, roundRectPath, strokeRound, wrapText, rgba,
  type IconName,
} from './theme';
import type { TabEnv } from './ui';

/** Content area below the header (canvas pixels). */
const LEFT = 64;
const RIGHT = 1984;
const TOP = 186;

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

function sectionLabel(env: TabEnv, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): void {
  drawText(env.ctx, text, x, y, 36, COLOR.textFaint, { weight: 800, spacing: 4, align });
}

function hit(env: TabEnv, key: string, x: number, y: number, w: number, h: number, r: number, click: () => void): void {
  env.widgets.add({ key, x, y, w, h, r, click });
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
  if (o.seek) drawSeekIcon(ctx, o.seek, o.cx, o.cy, o.r * 1.15, ink);
  else if (o.icon) drawIcon(ctx, o.icon, o.cx, o.cy, o.r * (o.primary ? 1.0 : 0.95), ink);
  ctx.restore();
  if (!o.disabled && o.click) hit(env, o.key, o.cx - o.r - 8, o.cy - o.r - 8, (o.r + 8) * 2, (o.r + 8) * 2, o.r + 8, o.click);
}

/** Slider with throttled commits and a held value so the knob never snaps back while the store catches up. */
const lastCommitAt = new Map<string, number>();
const lastCommitValue = new Map<string, number>();

function slider(
  env: TabEnv, key: string, x: number, cy: number, w: number,
  value: number, min: number, max: number, step: number, commit: (v: number) => void,
): number {
  const shown = env.hold(key) ?? value;
  drawSlider(env.ctx, x, cy, w, (shown - min) / (max - min), env.accent);
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
      } else {
        env.setHold(key, v, Infinity);
        if (phase === 'start' || (performance.now() - (lastCommitAt.get(key) ?? 0) > 45 && lastCommitValue.get(key) !== v)) send(v);
      }
      env.invalidate();
    },
  });
  return shown;
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
  const thS = 340;
  drawThumb(env, track, LEFT, TOP + 4, thS);
  const tx = LEFT + thS + 44;
  const tw = LEFT + LW - tx;
  let ty = TOP + 56;
  if (track) {
    ctx.font = font(56, 800);
    const lines = wrapText(ctx, track.title || 'Untitled', tw, 3);
    lines.forEach((ln, i) => drawText(ctx, ln, tx, ty + i * 66, 56, COLOR.text, { weight: 800 }));
    ty += lines.length * 66 + 4;
    if (track.artist) {
      ctx.font = font(42, 600);
      drawText(ctx, fitText(ctx, track.artist, tw), tx, ty, 42, COLOR.textDim, { weight: 600 });
    }
  } else {
    drawText(ctx, 'Nothing playing', tx, ty, 56, COLOR.text, { weight: 800 });
    ctx.font = font(42, 600);
    drawText(ctx, fitText(ctx, 'Open Sources to start', tw), tx, ty + 66, 42, COLOR.textDim, { weight: 600 });
  }
  // status pill (source kind / loading / error)
  {
    let text = track ? KIND_LABEL[track.kind] : 'IDLE';
    let col: string = a.mainCss;
    if (pb.status === 'loading') { text = 'LOADING…'; col = COLOR.warn; }
    else if (pb.status === 'error') { text = pb.message ? pb.message : 'ERROR'; col = COLOR.bad; }
    ctx.font = font(36, 800);
    ctx.letterSpacing = '3px';
    const label = fitText(ctx, text, tw - 56);
    const pw = Math.ceil(ctx.measureText(label).width) + 56;
    ctx.letterSpacing = '0px';
    const py = TOP + 4 + thS - 62;
    fillRound(ctx, tx, py, pw, 62, 31, 'rgba(255,255,255,0.07)');
    strokeRound(ctx, tx + 1.5, py + 1.5, pw - 3, 59, 30, col, 2.5);
    drawText(ctx, label, tx + 28, py + 31, 36, col, { weight: 800, spacing: 3, baseline: 'middle' });
  }

  // ---- progress -----------------------------------------------------------------------------
  const barX = 196;
  const barW = 688;
  const barY = 614;
  const dur = pb.duration;
  const seekable = !!track && track.kind !== 'mic' && Number.isFinite(dur) && dur > 0;
  const heldSeek = env.hold('seek');
  const frac = seekable ? (heldSeek ?? clamp(env.time / dur, 0, 1)) : 0;
  drawSlider(ctx, barX, barY, barW, frac, a, !seekable);
  const shownTime = heldSeek !== undefined && seekable ? heldSeek * dur : env.time;
  drawText(ctx, !track ? '–:––' : track.kind === 'mic' ? 'LIVE' : formatTime(shownTime), LEFT, barY + 2, 40, COLOR.textDim, { weight: 700, baseline: 'middle' });
  drawText(ctx, seekable ? formatTime(dur) : '–:––', LEFT + LW, barY + 2, 40, COLOR.textDim, { weight: 700, align: 'right', baseline: 'middle' });
  if (seekable) {
    env.widgets.add({
      key: 'seek', x: barX - 36, y: barY - 50, w: barW + 72, h: 100, r: 32,
      drag: (px, _py, phase) => {
        const f = clamp((px - barX) / barW, 0, 1);
        if (phase === 'end') {
          env.setHold('seek', f, 700);
          act.seek(f * dur);
        } else {
          env.setHold('seek', f, Infinity);
        }
        env.invalidate();
      },
    });
  }

  // ---- transport ----------------------------------------------------------------------------
  const cx = LEFT + LW / 2;
  const ty0 = 752;
  const can = queue.length > 0 || !!track;
  circleButton(env, { key: 'shuffle', cx: cx - 430, cy: ty0, r: 48, icon: 'shuffle', active: pb.shuffle, click: () => act.setShuffle(!pb.shuffle) });
  circleButton(env, { key: 'back10', cx: cx - 290, cy: ty0, r: 50, seek: -1, disabled: !seekable, click: () => act.seekBy(-10) });
  circleButton(env, { key: 'prev', cx: cx - 160, cy: ty0, r: 56, icon: 'prev', disabled: !can, click: () => act.prev() });
  circleButton(env, { key: 'toggle', cx, cy: ty0, r: 84, icon: pb.playing ? 'pause' : 'play', primary: true, disabled: !can, click: () => act.toggle() });
  circleButton(env, { key: 'next', cx: cx + 160, cy: ty0, r: 56, icon: 'next', disabled: !can, click: () => act.next() });
  circleButton(env, { key: 'fwd10', cx: cx + 290, cy: ty0, r: 50, seek: 1, disabled: !seekable, click: () => act.seekBy(10) });
  const nextRepeat = pb.repeat === 'off' ? 'all' : pb.repeat === 'all' ? 'one' : 'off';
  circleButton(env, {
    key: 'repeat', cx: cx + 430, cy: ty0, r: 48, icon: pb.repeat === 'one' ? 'repeatOne' : 'repeat',
    active: pb.repeat !== 'off', click: () => act.setRepeat(nextRepeat),
  });

  // ---- volume -------------------------------------------------------------------------------
  const volY = 904;
  const vol = env.hold('volume') ?? pb.volume;
  if (pb.volume > 0.01) env.local.lastVolume = pb.volume;
  circleButton(env, {
    key: 'mute', cx: LEFT + 44, cy: volY, r: 44, icon: vol <= 0.01 ? 'volumeMute' : 'volume',
    click: () => act.setVolume(pb.volume > 0.01 ? 0 : env.local.lastVolume || 0.6),
  });
  slider(env, 'volume', 196, volY, barW, pb.volume, 0, 1, 0.01, (v) => act.setVolume(v));
  drawText(ctx, `${Math.round(vol * 100)}%`, LEFT + LW, volY + 2, 40, COLOR.textDim, { weight: 700, align: 'right', baseline: 'middle' });

  // ---- scene / palette quick switch ---------------------------------------------------------
  const cy0 = 988;
  const cH = 248;
  drawCard(env.ctx, LEFT, cy0, LW, cH);
  sectionLabel(env, 'SCENE', LEFT + 40, cy0 + 62);
  const presetIdx = Math.max(0, s.presets.findIndex((p) => p.id === s.preset));
  const cur = s.presets[presetIdx];
  circleButton(env, { key: 'qs-prev', cx: LEFT + 92, cy: cy0 + 130, r: 40, icon: 'chevronLeft', click: () => act.prevPreset() });
  circleButton(env, { key: 'qs-next', cx: LEFT + LW - 92, cy: cy0 + 130, r: 40, icon: 'chevronRight', click: () => act.nextPreset() });
  ctx.font = font(52, 800);
  drawText(ctx, fitText(ctx, cur ? cur.name : '–', LW - 300), LEFT + LW / 2, cy0 + 130, 52, COLOR.text, { weight: 800, align: 'center', baseline: 'middle' });
  if (s.presets.length > 0) {
    drawText(ctx, `${presetIdx + 1} / ${s.presets.length}`, LEFT + LW - 40, cy0 + 62, 36, COLOR.textFaint, { weight: 700, align: 'right' });
  }
  // palette dots
  const dotR = 27;
  const dotGap = 22;
  const n = s.palettes.length;
  const rowW = n * dotR * 2 + (n - 1) * dotGap;
  let dx = LEFT + LW / 2 - rowW / 2 + dotR;
  const dy = cy0 + 200;
  for (const p of s.palettes) {
    const g = ctx.createLinearGradient(dx - dotR, dy - dotR, dx + dotR, dy + dotR);
    p.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, p.stops.length - 1), c));
    circle(ctx, dx, dy, dotR, g);
    if (p.id === s.palette) {
      ctx.beginPath();
      ctx.arc(dx, dy, dotR + 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    hit(env, `pal-dot-${p.id}`, dx - dotR - 8, dy - dotR - 8, (dotR + 8) * 2, (dotR + 8) * 2, dotR + 8, () => act.setPalette(p.id));
    dx += dotR * 2 + dotGap;
  }

  // ---- queue --------------------------------------------------------------------------------
  const QX = 1070;
  const QW = RIGHT - QX;
  const ROWS = 6;
  const RH = 132;
  const GAP = 12;
  const RY = 270;
  const total = queue.length;
  sectionLabel(env, 'QUEUE', QX, TOP + 50);
  if (total > 0) {
    drawText(ctx, `${total} ${total === 1 ? 'track' : 'tracks'}`, QX + 168, TOP + 50, 36, COLOR.textDim, { weight: 700 });
  }
  if (pb.index !== env.local.lastIndex) {
    env.local.lastIndex = pb.index;
    env.local.queueTop = null;
  }
  const maxTop = Math.max(0, total - ROWS);
  const top = clamp(env.local.queueTop ?? pb.index - 2, 0, maxTop);
  if (total > ROWS) {
    circleButton(env, { key: 'q-up', cx: QX + QW - 250, cy: TOP + 40, r: 32, icon: 'chevronUp', disabled: top <= 0, click: () => { env.local.queueTop = Math.max(0, top - 2); env.invalidate(); } });
    circleButton(env, { key: 'q-down', cx: QX + QW - 170, cy: TOP + 40, r: 32, icon: 'chevronDown', disabled: top >= maxTop, click: () => { env.local.queueTop = Math.min(maxTop, top + 2); env.invalidate(); } });
  }
  if (total > 0) {
    const bw = 120;
    const bx = QX + QW - bw;
    fillRound(ctx, bx, TOP + 8, bw, 64, 32, 'rgba(255,255,255,0.07)');
    drawText(ctx, 'Clear', bx + bw / 2, TOP + 41, 36, COLOR.textDim, { weight: 700, align: 'center', baseline: 'middle' });
    hit(env, 'q-clear', bx, TOP + 8, bw, 64, 32, () => act.clearQueue());
  }

  if (total === 0) {
    drawCard(ctx, QX, RY - 4, QW, 880, 30);
    drawIcon(ctx, 'note', QX + QW / 2, RY + 250, 150, 'rgba(255,255,255,0.22)');
    ctx.font = font(50, 800);
    const lines = wrapText(ctx, 'Nothing playing — open Sources', QW - 140, 2);
    lines.forEach((ln, i) => drawText(ctx, ln, QX + QW / 2, RY + 410 + i * 62, 50, COLOR.text, { weight: 800, align: 'center' }));
    const bw = 440;
    const bh = 104;
    const bx = QX + (QW - bw) / 2;
    const by = RY + 560;
    fillRound(ctx, bx, by, bw, bh, 52, hGradient(ctx, bx, bx + bw, a.mainCss, a.altCss));
    drawText(ctx, 'Open Sources', bx + bw / 2, by + bh / 2 + 2, 44, a.ink, { weight: 800, align: 'center', baseline: 'middle' });
    hit(env, 'open-sources', bx, by, bw, bh, 52, () => act.setTab('sources'));
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
    if (current && pb.playing) drawEqGlyph(env, QX + 70, midY, a.mainCss);
    else drawText(ctx, String(i + 1), QX + 70, midY + 2, 40, current ? a.mainCss : COLOR.textFaint, { weight: 800, align: 'center', baseline: 'middle' });
    const textX = QX + 128;
    const textW = QW - 128 - 120;
    ctx.font = font(44, 700);
    drawText(ctx, fitText(ctx, t.title || 'Untitled', textW), textX, midY - 8, 44, current ? COLOR.text : '#e1e5fa', { weight: 700 });
    const sub = [t.artist, KIND_LABEL[t.kind].toLowerCase()].filter(Boolean).join('  ·  ');
    ctx.font = font(36, 600);
    const durW = t.duration ? Math.ceil(ctx.measureText(formatTime(t.duration)).width) + 24 : 0;
    if (t.duration) drawText(ctx, formatTime(t.duration), textX + textW, midY + 44, 36, COLOR.textDim, { weight: 600, align: 'right' });
    ctx.font = font(36, 500);
    drawText(ctx, fitText(ctx, sub, textW - durW), textX, midY + 44, 36, COLOR.textFaint, { weight: 500 });
    drawIcon(ctx, 'close', QX + QW - 62, midY, 40, COLOR.textDim);
    hit(env, `q-row-${i}`, QX, y, QW - 118, RH, 26, () => (current ? act.toggle() : act.play(i)));
    hit(env, `q-del-${i}`, QX + QW - 118, y + 14, 104, RH - 28, 26, () => act.removeTrack(i));
  }
  if (total > ROWS) {
    drawText(ctx, `${top + 1}–${Math.min(total, top + ROWS)} of ${total}`, QX + QW / 2, RY + ROWS * (RH + GAP) + 44, 36, COLOR.textFaint, { weight: 700, align: 'center' });
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

  sectionLabel(env, 'SCENES', LEFT, TOP + 30);
  if (pages > 1) {
    drawText(ctx, `${page + 1} / ${pages}`, RIGHT - 130, TOP + 30, 36, COLOR.textDim, { weight: 700, align: 'right' });
    circleButton(env, { key: 'sc-prev', cx: RIGHT - 92, cy: TOP + 16, r: 30, icon: 'chevronLeft', disabled: page <= 0, click: () => { env.local.scenePage = page - 1; env.invalidate(); } });
    circleButton(env, { key: 'sc-next', cx: RIGHT - 30, cy: TOP + 16, r: 30, icon: 'chevronRight', disabled: page >= pages - 1, click: () => { env.local.scenePage = page + 1; env.invalidate(); } });
  }
  const TW = 624;
  const TH = 200;
  const G = 24;
  const y0 = TOP + 56;
  for (let k = 0; k < per; k++) {
    const idx = page * per + k;
    const p = s.presets[idx];
    if (!p) break;
    const x = LEFT + (k % 3) * (TW + G);
    const y = y0 + Math.floor(k / 3) * (TH + G);
    const active = p.id === s.preset;
    if (active) {
      const g = ctx.createLinearGradient(x, y, x + TW, y + TH);
      g.addColorStop(0, rgba(a.main, 0.34));
      g.addColorStop(1, rgba(a.alt, 0.12));
      fillRound(ctx, x, y, TW, TH, 28, g);
      strokeRound(ctx, x + 2, y + 2, TW - 4, TH - 4, 27, hGradient(ctx, x, x + TW, a.mainCss, a.altCss), 5);
    } else {
      drawCard(ctx, x, y, TW, TH, 28);
    }
    ctx.font = font(48, 800);
    drawText(ctx, fitText(ctx, p.name, TW - 60 - (active ? 180 : 70)), x + 32, y + 66, 48, COLOR.text, { weight: 800 });
    if (active) drawText(ctx, 'ACTIVE', x + TW - 32, y + 62, 34, a.mainCss, { weight: 800, align: 'right', spacing: 3 });
    else drawText(ctx, String(idx + 1).padStart(2, '0'), x + TW - 32, y + 62, 36, COLOR.textFaint, { weight: 800, align: 'right' });
    ctx.font = font(36, 500);
    wrapText(ctx, p.description, TW - 64, 2).forEach((ln, i) => drawText(ctx, ln, x + 32, y + 118 + i * 42, 36, COLOR.textDim, { weight: 500 }));
    hit(env, `preset-${p.id}`, x, y, TW, TH, 28, () => act.setPreset(p.id));
  }

  // palettes
  const perRow = 7;
  const chipH = 104;
  const rows = Math.max(1, Math.ceil(s.palettes.length / perRow));
  const palLabelY = y0 + 2 * (TH + G) + 36;
  const curPal = s.palettes.find((p) => p.id === s.palette);
  sectionLabel(env, 'PALETTE', LEFT, palLabelY);
  if (curPal) drawText(ctx, curPal.name, RIGHT, palLabelY, 36, COLOR.textDim, { weight: 700, align: 'right' });
  const chipW = Math.floor((RIGHT - LEFT - (perRow - 1) * 14) / perRow);
  const cy0 = palLabelY + 28;
  s.palettes.forEach((p, i) => {
    const x = LEFT + (i % perRow) * (chipW + 14);
    const y = cy0 + Math.floor(i / perRow) * (chipH + 20);
    drawPaletteChip(ctx, x, y, chipW, chipH, p.stops, p.name, p.id === s.palette, a);
    hit(env, `palette-${p.id}`, x - 6, y - 6, chipW + 12, chipH + 12, 26, () => act.setPalette(p.id));
  });

  // sliders + toggles
  const sy = cy0 + rows * (chipH + 20) + 36;
  const sliders: { key: string; label: string; min: number; max: number; k: 'intensity' | 'speed' | 'glow' }[] = [
    { key: 'intensity', label: 'Intensity', min: 0, max: 2, k: 'intensity' },
    { key: 'speed', label: 'Speed', min: 0, max: 2, k: 'speed' },
    { key: 'glow', label: 'Glow', min: 0, max: 1, k: 'glow' },
  ];
  sliders.forEach((sl, i) => {
    const cy = sy + 36 + i * 100;
    drawText(ctx, sl.label, LEFT, cy + 2, 44, COLOR.text, { weight: 700, baseline: 'middle' });
    const v = slider(env, `param-${sl.key}`, 330, cy, 800, s.params[sl.k], sl.min, sl.max, 0.05, (val) => act.setParam(sl.k, val));
    drawText(ctx, v.toFixed(2), 1160 + 90, cy + 2, 44, COLOR.textDim, { weight: 700, align: 'right', baseline: 'middle' });
  });

  const tx = 1400;
  const tw = RIGHT - tx;
  const toggles: { key: string; label: string; on: boolean; click: () => void }[] = [
    { key: 'autocycle', label: 'Auto-cycle', on: s.autoCycle, click: () => act.setAutoCycle(!s.autoCycle) },
    { key: 'background', label: 'Background', on: s.params.background, click: () => act.setParam('background', !s.params.background) },
  ];
  toggles.forEach((t, i) => {
    const cy = sy + 36 + i * 100;
    drawCard(ctx, tx, cy - 44, tw, 88, 26);
    drawText(ctx, t.label, tx + 32, cy + 2, 44, COLOR.text, { weight: 700, baseline: 'middle' });
    drawSwitch(ctx, tx + tw - 112 - 28, cy, t.on, a);
    hit(env, `toggle-${t.key}`, tx, cy - 44, tw, 88, 26, t.click);
  });
  ctx.font = font(36, 500);
  const note = s.autoCycle ? `Next scene every ${s.cycleSeconds} s` : 'Switch scenes on a timer';
  drawText(ctx, fitText(ctx, note, tw), tx + 8, sy + 36 + 2 * 100 + 4, 36, COLOR.textFaint, { weight: 500, baseline: 'middle' });
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
  const TH = 262;
  const micOn = pb.micEnabled;
  const silent = features.silence;

  // microphone tile
  bigTile(env, 'mic', LEFT, TOP, TWID, TH, micOn, () => (micOn ? act.disableMic() : act.enableMic()));
  circle(ctx, LEFT + 110, TOP + 100, 62, micOn ? hGradient(ctx, LEFT + 48, LEFT + 172, a.mainCss, a.altCss) : 'rgba(255,255,255,0.09)');
  drawIcon(ctx, 'mic', LEFT + 110, TOP + 100, 68, micOn ? a.ink : COLOR.text);
  drawText(ctx, micOn ? 'Microphone on' : 'Microphone off', LEFT + 206, TOP + 88, 56, COLOR.text, { weight: 800 });
  const micStatus = micOn ? (silent ? 'No signal yet' : 'Listening') : 'Tap to turn on';
  drawText(ctx, micStatus, LEFT + 206, TOP + 140, 40, micOn ? (silent ? COLOR.warn : COLOR.good) : COLOR.textDim, { weight: 600 });
  sectionLabel(env, 'INPUT LEVEL', LEFT + 40, TOP + 202);
  drawMeter(ctx, LEFT + 40 + 330, TOP + 178, TWID - 80 - 330, 34, features.level, 26, a);

  // demo tile
  const dx = RIGHT - TWID;
  const demoPlaying = !!pb.track && pb.track.kind === 'demo' && pb.playing;
  bigTile(env, 'demo', dx, TOP, TWID, TH, demoPlaying, () => act.startDemo());
  circle(ctx, dx + 110, TOP + 100, 62, demoPlaying ? hGradient(ctx, dx + 48, dx + 172, a.mainCss, a.altCss) : 'rgba(255,255,255,0.09)');
  drawIcon(ctx, demoPlaying ? 'pause' : 'play', dx + 110, TOP + 100, 68, demoPlaying ? a.ink : COLOR.text);
  drawText(ctx, 'Demo track', dx + 206, TOP + 88, 56, COLOR.text, { weight: 800 });
  drawText(ctx, demoPlaying ? 'Playing now' : 'Tap to start', dx + 206, TOP + 140, 40, demoPlaying ? COLOR.good : COLOR.textDim, { weight: 600 });
  ctx.font = font(36, 500);
  wrapText(ctx, 'Built-in synthetic music at about 124 BPM, always available offline.', TWID - 80, 2)
    .forEach((ln, i) => drawText(ctx, ln, dx + 40, TOP + 196 + i * 42, 36, COLOR.textFaint, { weight: 500 }));

  // YouTube card
  const yy = TOP + TH + 32;
  const yh = 336;
  drawCard(ctx, LEFT, yy, RIGHT - LEFT, yh, 30);
  drawIcon(ctx, 'play', LEFT + 74, yy + 66, 58, '#ff4d5e');
  sectionLabel(env, 'YOUTUBE & LINKS', LEFT + 128, yy + 78);
  ctx.font = font(46, 700);
  wrapText(ctx, 'Add YouTube/URL in the 2D browser window before entering VR; playback controls work here.', RIGHT - LEFT - 100, 2)
    .forEach((ln, i) => drawText(ctx, ln, LEFT + 50, yy + 154 + i * 58, 46, COLOR.text, { weight: 700 }));
  ctx.font = font(38, 500);
  wrapText(ctx, 'YouTube audio is analysed through the headset microphone, so keep the sound playing and the microphone allowed.', RIGHT - LEFT - 100 - 330, 2)
    .forEach((ln, i) => drawText(ctx, ln, LEFT + 50, yy + 272 + i * 44, 38, COLOR.textDim, { weight: 500 }));
  {
    const bw = 300;
    const bh = 84;
    const bx = RIGHT - 50 - bw;
    const by = yy + yh - 50 - bh + 10;
    fillRound(ctx, bx, by, bw, bh, 42, 'rgba(255,255,255,0.09)');
    strokeRound(ctx, bx + 1.5, by + 1.5, bw - 3, bh - 3, 41, a.glow, 3);
    drawText(ctx, 'Open Player', bx + bw / 2, by + bh / 2 + 2, 40, COLOR.text, { weight: 700, align: 'center', baseline: 'middle' });
    hit(env, 'open-player', bx, by, bw, bh, 42, () => act.setTab('player'));
  }

  // status card
  const sy = yy + yh + 32;
  const sh = TOP + 1058 - sy;
  drawCard(ctx, LEFT, sy, RIGHT - LEFT, sh, 30);
  const analysis = pb.analysisInput === 'element' ? 'Direct from the audio player' : pb.analysisInput === 'mic' ? 'Microphone loop-back' : 'None yet';
  const engine = pb.status === 'idle' ? 'Idle' : pb.status === 'loading' ? 'Loading…' : pb.status === 'ready' ? 'Ready' : 'Error';
  const rows: { k: string; v: string; col: string }[] = [
    { k: 'Analysis input', v: analysis, col: COLOR.text },
    { k: 'Microphone', v: micOn ? 'Open' : 'Closed', col: micOn ? COLOR.good : COLOR.textDim },
    { k: 'Engine', v: pb.message ? `${engine} — ${pb.message}` : engine, col: pb.status === 'error' ? COLOR.bad : pb.status === 'loading' ? COLOR.warn : COLOR.text },
    { k: 'Signal', v: features.active ? (silent ? 'Silent' : `Active · ${Math.round(features.level * 100)}%`) : 'Idle', col: features.active && !silent ? COLOR.good : COLOR.textDim },
  ];
  rows.forEach((r, i) => {
    const ry = sy + 50 + i * 60;
    drawText(ctx, r.k, LEFT + 48, ry, 40, COLOR.textFaint, { weight: 600, baseline: 'middle' });
    ctx.font = font(42, 700);
    drawText(ctx, fitText(ctx, r.v, RIGHT - LEFT - 96 - 420), LEFT + 48 + 420, ry, 42, r.col, { weight: 700, baseline: 'middle' });
  });
  const needHint = (micOn || pb.analysisInput === 'mic') && silent;
  const hy = sy + sh - 120;
  if (needHint) {
    fillRound(ctx, LEFT + 32, hy, RIGHT - LEFT - 64, 100, 24, 'rgba(255,196,87,0.13)');
    strokeRound(ctx, LEFT + 33.5, hy + 1.5, RIGHT - LEFT - 67, 97, 23, 'rgba(255,196,87,0.6)', 3);
    ctx.font = font(36, 600);
    wrapText(ctx, 'The microphone hears nothing. Raise the headset volume, keep the audio playing and allow microphone access.', RIGHT - LEFT - 150, 2)
      .forEach((ln, i) => drawText(ctx, ln, LEFT + 62, hy + 33 + i * 40, 36, COLOR.warn, { weight: 600, baseline: 'middle' }));
  } else {
    ctx.font = font(36, 500);
    drawText(ctx, fitText(ctx, 'Tip: the microphone feeds the visuals only. It is never played back.', RIGHT - LEFT - 100), LEFT + 50, hy + 50, 36, COLOR.textFaint, { weight: 500, baseline: 'middle' });
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
  const bh = 128;
  drawCard(ctx, LEFT, TOP, LW, bh, 30);
  circle(ctx, LEFT + 80, TOP + bh / 2, 42, 'rgba(255,255,255,0.09)');
  drawIcon(ctx, 'recenter', LEFT + 80, TOP + bh / 2, 50, a.mainCss);
  drawText(ctx, 'Recenter menu', LEFT + 160, TOP + 58, 50, COLOR.text, { weight: 800 });
  drawText(ctx, 'Place it in front of you', LEFT + 160, TOP + 104, 36, COLOR.textDim, { weight: 500 });
  hit(env, 'recenter', LEFT, TOP, LW, bh, 30, () => act.recenter());

  // Exit / enter VR
  const ey = TOP + bh + 22;
  const inXr = s.mode === 'xr';
  const canEnter = inXr || s.xrSupported;
  ctx.save();
  if (!canEnter) ctx.globalAlpha = 0.45;
  drawCard(ctx, LEFT, ey, LW, bh, 30, inXr ? 'rgba(255,107,129,0.11)' : undefined);
  circle(ctx, LEFT + 80, ey + bh / 2, 42, 'rgba(255,255,255,0.09)');
  drawIcon(ctx, inXr ? 'exit' : 'headset', LEFT + 80, ey + bh / 2, 50, inXr ? COLOR.bad : a.mainCss);
  drawText(ctx, inXr ? 'Exit VR' : 'Enter VR', LEFT + 160, ey + 58, 50, COLOR.text, { weight: 800 });
  drawText(ctx, inXr ? 'Return to the 2D page' : canEnter ? 'Start an immersive session' : 'WebXR is not available here', LEFT + 160, ey + 104, 36, COLOR.textDim, { weight: 500 });
  ctx.restore();
  if (canEnter) hit(env, 'vr', LEFT, ey, LW, bh, 30, () => act.enterVR());

  // Auto-hide
  const ay = ey + bh + 22;
  const ah = 112;
  drawCard(ctx, LEFT, ay, LW, ah, 30);
  drawText(ctx, 'Auto-hide menu', LEFT + 40, ay + 48, 44, COLOR.text, { weight: 700 });
  drawText(ctx, 'After 12 s of no input while playing', LEFT + 40, ay + 90, 36, COLOR.textDim, { weight: 500 });
  drawSwitch(ctx, LEFT + LW - 112 - 36, ay + ah / 2, env.autoHide, a);
  hit(env, 'autohide', LEFT, ay, LW, ah, 30, () => env.setAutoHide(!env.autoHide));

  // Performance
  const py = ay + ah + 22;
  const ph = TOP + 1058 - py;
  drawCard(ctx, LEFT, py, LW, ph, 30);
  sectionLabel(env, 'PERFORMANCE', LEFT + 40, py + 64);
  const target = env.presenting ? (info.frameRate || 72) : 60;
  const ratio = s.fps / target;
  const fpsCol = s.fps <= 0 ? COLOR.textDim : ratio >= 0.92 ? COLOR.good : ratio >= 0.7 ? COLOR.warn : COLOR.bad;
  drawText(ctx, s.fps > 0 ? String(s.fps) : '–', LEFT + 40, py + 220, 150, fpsCol, { weight: 800 });
  const fw = s.fps > 0 ? ctx.measureText(String(s.fps)).width : 70;
  drawText(ctx, 'FPS', LEFT + 40 + fw + 22, py + 216, 48, COLOR.textDim, { weight: 700 });
  if (!qualityLabel) qualityLabel = detectQuality().toUpperCase();
  const perf: { k: string; v: string }[] = [
    { k: 'Quality', v: qualityLabel },
    { k: 'Display', v: env.presenting ? `${info.frameRate || 72} Hz headset` : 'Desktop window' },
    { k: 'Draw calls', v: String(info.calls) },
    { k: 'Triangles', v: info.triangles >= 1000 ? `${(info.triangles / 1000).toFixed(info.triangles >= 100000 ? 0 : 1)}k` : String(info.triangles) },
  ];
  perf.forEach((r, i) => {
    const ry = py + 300 + i * 62;
    drawText(ctx, r.k, LEFT + 40, ry, 40, COLOR.textFaint, { weight: 600, baseline: 'middle' });
    drawText(ctx, r.v, LEFT + LW - 40, ry, 40, COLOR.text, { weight: 700, align: 'right', baseline: 'middle' });
  });

  // Controls legend
  const lx = LEFT + LW + 40;
  const lw = RIGHT - lx;
  const lh = 1058;
  drawCard(ctx, lx, TOP, lw, lh, 30);
  sectionLabel(env, 'CONTROLS', lx + 44, TOP + 76);
  const rowH = 148;
  LEGEND.forEach((row, i) => {
    const cy = TOP + 190 + i * rowH;
    if (i > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(lx + 44, cy - rowH / 2 + 2, lw - 88, 2);
    }
    let x = lx + 44;
    row.caps.forEach((c, ci) => {
      if (ci > 0) {
        drawText(ctx, '/', x + 12, cy + 1, 36, COLOR.textFaint, { weight: 600, align: 'center', baseline: 'middle' });
        x += 34;
      }
      x += drawKeycap(ctx, x, cy, c, a);
    });
    if (row.arrows) {
      const [i1, i2]: [IconName, IconName] = row.arrows === 'lr' ? ['chevronLeft', 'chevronRight'] : ['chevronDown', 'chevronUp'];
      drawIcon(ctx, i1, x + 34, cy, 54, a.mainCss);
      drawIcon(ctx, i2, x + 34 + 52, cy, 54, a.mainCss);
      x += 120;
    }
    ctx.font = font(40, 500);
    const textX = lx + 44 + 440;
    const avail = lx + lw - 44 - textX;
    const lines = wrapText(ctx, row.text, avail, 2);
    lines.forEach((ln, li) => drawText(ctx, ln, textX, cy + (lines.length === 1 ? 2 : li * 46 - 20), 40, COLOR.text, { weight: 500, baseline: 'middle' }));
  });
  ctx.font = font(36, 500);
  drawText(ctx, fitText(ctx, 'Hand tracking: point at the menu and pinch to click.', lw - 88), lx + 44, TOP + lh - 34, 36, COLOR.textFaint, { weight: 500 });
}
