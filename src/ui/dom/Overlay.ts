import type { Actions, AppState, Store } from '@/app/Store';
import type { AudioFeatures, PlaybackState, Track } from '@/audio/types';
import type { Palette, QualityLevel } from '@/viz/types';
import { KIND_LABEL, LABELS, formatTime } from '@/ui/labels';
import { isQuest } from '@/util/device';
import { ICONS, esc } from './icons';
import { SLIDERS, buildTemplate } from './template';

const WELCOME_KEY = 'resonance-vr.welcomed';
/** Owned by App; read once only to prefill the proxy field (the store just exposes `proxyConfigured`). */
const SETTINGS_KEY = 'resonance-vr.settings.v1';

const NEXT_REPEAT: Record<PlaybackState['repeat'], PlaybackState['repeat']> = { off: 'all', all: 'one', one: 'off' };
const QUALITY_IDS: readonly QualityLevel[] = ['low', 'medium', 'high'];
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|weba|webm|mp4)$/i;
const HEX = /^#[0-9a-f]{3,8}$/i;
const YT_ID = /^[\w-]{6,20}$/;
const YT_VIDEO_ID = /^[\w-]{11}$/;
const YT_SCHEMELESS = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;
/** An engine message about the microphone (permission denied / blocked, no device, HTTPS needed ...). "blocked" alone is not enough: "youtube.com is blocked" is not a microphone problem. */
const MIC_MESSAGE = /microphone|\bmic\b|permission (?:was )?(?:denied|blocked)|notallowed/i;

/** Microphone meter: input level (0..1, AGC normalised) at which each of the 4 segments lights up. */
const METER_STEPS = [0.06, 0.2, 0.4, 0.62] as const;
/** Playing but silent for this long => "No sound heard" chip. */
const SILENCE_MS = 3000;
/** YouTube track with no analysis input for this long (and no explicit error) => treat the microphone as blocked. */
const MIC_GRACE_MS = 8000;
/** A source that starts this soon after page load is a deep link (?demo=1): hide the welcome, but don't mark it seen. */
const DEEP_LINK_MS = 2500;
const PROXY_TEST_ID = 'dQw4w9WgXcQ';
const PROXY_TIMEOUT_MS = 5000;
const LOCAL_HTTP = /^http:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i;

const VR_REASON = {
  https: 'VR needs HTTPS. Open the https:// address in the Meta Quest Browser.',
  noXr: 'This browser has no WebXR. Use the Meta Quest Browser.',
  noHeadset: 'No headset found — open this page on a Quest',
} as const;

type SliderKey = (typeof SLIDERS)[number][0];
type Changed = Set<keyof AppState>;
type Rgb = [number, number, number];

// ---------------------------------------------------------------- small helpers
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Paint the filled part of a range track (overlay.css reads it through --p). */
function fill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${Math.min(100, Math.max(0, pct))}%`);
}

function setRange(input: HTMLInputElement, value: number): void {
  if (Number(input.value) !== value) input.value = String(value);
  fill(input);
}

/** Scroll `item` into view inside `box` only (scrollIntoView would also scroll the page columns). `pad` keeps it clear of the bottom edge. */
function reveal(box: HTMLElement, item: Element | null, pad = 0): void {
  if (!item) return;
  const b = box.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - (b.bottom - pad);
}

/** Elapsed time: 0 shows as 0:00 (formatTime would print the "unknown" dash). */
function elapsed(seconds: number): string {
  return seconds > 0 ? formatTime(seconds) : '0:00';
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;

/** A pasted string worth submitting straight away: an http(s) URL, a scheme-less YouTube address or an 11-char video id. */
function looksLikeLink(text: string): boolean {
  if (/\s/.test(text)) return false;
  if (YT_VIDEO_ID.test(text) || YT_SCHEMELESS.test(text)) return true;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function thumbUrl(t: Track): string | undefined {
  if (t.thumbnail) return t.thumbnail;
  return t.youtubeId && YT_ID.test(t.youtubeId) ? `https://i.ytimg.com/vi/${t.youtubeId}/mqdefault.jpg` : undefined;
}

function queueRow(t: Track, i: number, current: boolean, playing: boolean): string {
  const sub = [t.artist, KIND_LABEL[t.kind]].filter(Boolean).join(' · ');
  const idx = current ? (playing ? ICONS.eq : ICONS.play) : String(i + 1);
  return (
    `<li class="q-row${current ? ' current' : ''}">` +
    `<button class="q-play" data-act="qplay" data-i="${i}"${current ? ' aria-current="true"' : ''}>` +
    `<span class="q-idx">${idx}</span><span class="q-meta"><b>${esc(t.title)}</b><small>${esc(sub)}</small></span></button>` +
    `<button class="q-rm" data-act="qrm" data-i="${i}" aria-label="Remove ${esc(t.title)}" title="Remove">${ICONS.close}</button></li>`
  );
}

function swatch(p: Palette): string {
  const stops = p.stops.filter((c) => HEX.test(c));
  const grad = stops.length > 1 ? `linear-gradient(160deg,${stops.join(',')})` : (stops[0] ?? '#444');
  return `<button class="swatch" data-act="palette" data-id="${esc(p.id)}" title="${esc(p.name)}" aria-label="${esc(p.name)}" style="--grad:${grad}"></button>`;
}

/** Thumbnail tile; the CSS gradient underneath doubles as the fallback when ./thumbs/<id>.jpg is missing. */
function sceneTile(p: AppState['presets'][number], i: number): string {
  const hue = (i * 62 + 255) % 360;
  return (
    `<li><button class="scene-tile" data-act="preset" data-id="${esc(p.id)}" title="${esc(p.description)}" aria-label="${esc(p.name)}" style="--h:${hue}">` +
    `<img src="./thumbs/${encodeURIComponent(p.id)}.jpg" alt="" loading="lazy" decoding="async" draggable="false" />` +
    (i < 9 ? `<span class="st-num" aria-hidden="true">${i + 1}</span>` : '') +
    `<span class="st-name">${esc(p.name)}</span></button></li>`
  );
}

// ---- palette -> accent colours (same idea as the VR panel: a saturated, mid-bright stop plus its neighbour)
function parseHex(hex: string): Rgb | null {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = Array.from(h, (c) => c + c).join('');
  if (h.length < 6) return null;
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hsl([r, g, b]: Rgb): [number, number] {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  return [d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1), l];
}

const luma = ([r, g, b]: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
const rgbCss = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const DEFAULT_ACCENT: { a: Rgb; b: Rgb } = { a: [124, 92, 255], b: [46, 230, 214] };

/**
 * The first stop of every palette is near-black, so using it literally would make the accent invisible on the dark
 * glass. Pick the most saturated mid-bright stop as `a` and its brighter neighbour as `b` (what the VR panel does).
 */
function accentOf(palette: Palette | undefined): { a: Rgb; b: Rgb; ink: string } {
  const stops = (palette?.stops ?? []).map(parseHex).filter((c): c is Rgb => c !== null);
  let a = DEFAULT_ACCENT.a;
  let b = DEFAULT_ACCENT.b;
  if (stops.length >= 2) {
    let best = 0;
    let bestScore = -1;
    stops.forEach((c, i) => {
      const [s, l] = hsl(c);
      const score = (0.25 + s) * Math.max(0, 1 - Math.abs(l - 0.62) * 1.8);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    a = stops[best];
    b = stops[Math.min(stops.length - 1, best + 1)];
    if (b === a) b = stops[Math.max(0, best - 1)];
    if (luma(b) < 0.3) b = mix(b, a, 0.5);
  }
  return { a, b, ink: luma(mix(a, b, 0.5)) > 0.55 ? '#05060c' : '#ffffff' };
}

/** Look every element up once; a missing node is a template bug, so fail loudly. */
function collect(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`DomOverlay: ${sel} not found`);
    return el;
  };
  const params = {} as Record<SliderKey, { input: HTMLInputElement; out: HTMLElement }>;
  for (const [key] of SLIDERS) params[key] = { input: q<HTMLInputElement>(`#param-${key}`), out: q(`#out-${key}`) };
  const needs = (kind: string) => Array.from(root.querySelectorAll<HTMLButtonElement>(`[data-needs="${kind}"]`));
  return {
    params,
    needsQueue: needs('queue'),
    needsSeek: needs('seek'),
    qualityBtns: Array.from(root.querySelectorAll<HTMLButtonElement>('#quality [data-id]')),
    enterVr: q<HTMLButtonElement>('#enter-vr'), vrTip: q('#vr-tip'), vrLabel: q('#enter-vr-label'), vrReason: q('#vr-reason'), vrCopy: q('#vr-copy'),
    helpBtn: q('#help-btn'), help: q('#help'), helpClose: q<HTMLButtonElement>('#help-close'),
    status: q('#status'), statusText: q('#status-text'), chipListening: q('#chip-listening'),
    banner: q('#banner'), bannerText: q('#banner-text'), micBanner: q('#mic-banner'), micPrompt: q('#mic-prompt'),
    fileInput: q<HTMLInputElement>('#file-input'), urlForm: q<HTMLFormElement>('#url-form'), urlInput: q<HTMLInputElement>('#url-input'),
    mic: q('#mic-toggle'), micState: q('#mic-state'), meter: q('#mic-meter'),
    proxyInput: q<HTMLInputElement>('#proxy-input'), proxyBadge: q('#proxy-badge'), proxyTest: q<HTMLButtonElement>('#proxy-test'),
    proxyStatus: q('#proxy-status'), proxyWarn: q('#proxy-warn'),
    ytWrap: q('#youtube-wrap'), ytHost: q('#youtube-host'), ytCaption: q('#yt-caption'),
    player: q('#player'), thumb: q('#np-thumb'), title: q('#np-title'), sub: q('#np-sub'), chipNoSound: q('#chip-nosound'),
    play: q('#play-btn'), shuffle: q('#shuffle-btn'), repeat: q('#repeat-btn'),
    seek: q<HTMLInputElement>('#seek'), cur: q('#t-cur'), dur: q('#t-dur'),
    volume: q<HTMLInputElement>('#volume'), volOut: q('#vol-out'), mute: q('#mute-btn'),
    queueBtn: q('#queue-btn'), queueCount: q('#queue-count'), queuePanel: q('#queue-panel'), queueList: q('#queue-list'),
    presets: q('#preset-list'), palettes: q('#palette-list'), paletteName: q('#palette-name'),
    autoCycle: q('#autocycle'), cycleNote: q('#autocycle-note'), background: q('#background'),
    toast: q('#toast'), welcome: q('#welcome'),
  };
}

/**
 * 2D HTML overlay: top bar, sources, scenes, player bar and toast over the full-screen canvas.
 * Reads `store.state`, issues `Actions`, and on each store change only touches the parts whose keys changed.
 */
export class DomOverlay {
  /** 320x180 container for the YouTube IFrame player; stays laid out (but invisible) when no YouTube track is active. */
  readonly youtubeHost: HTMLElement;

  private readonly el: ReturnType<typeof collect>;
  private readonly offs: Array<() => void> = [];
  /** Last value written per key, so heavy DOM rebuilds are skipped when nothing changed. */
  private readonly last = new Map<string, unknown>();
  private readonly unsubscribe: () => void;
  private readonly quest = isQuest();
  private readonly createdAt = performance.now();
  private resizeObs: ResizeObserver | null = null;
  private hidden = false;
  private queueOpen = false;
  private helpOpen = false;
  private helpOpener: HTMLElement | null = null;
  private scrubbing = false;
  private holdSeekUntil = 0;
  private welcomed = false;
  /** The WebXR support probe has had time to answer, so "no headset" is a fact rather than "still checking" */
  private vrChecked = false;
  // microphone-for-YouTube state
  private micTrackId = '';
  private micNeededSince = 0;
  private micBlocked = false;
  // playback message banner
  private bannerMsg: string | undefined;
  private bannerDismissed = false;
  private silentSince = 0;
  // proxy
  private savedProxy = '';
  private proxyTestedOk = '';
  private proxyTicket = 0;
  private volBeforeMute = 0.8;
  private revealTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
    private readonly actions: Actions,
    /** Live audio features (same object as engine.features) for level / silence indicators */
    private readonly features?: AudioFeatures,
  ) {
    root.classList.add('dom-ui');
    root.classList.toggle('is-quest', this.quest);
    root.innerHTML = buildTemplate(this.quest);
    this.el = collect(root);
    this.youtubeHost = this.el.ytHost;
    this.bindClicks();
    this.bindInputs();
    this.bindWindow();
    this.bindDrop();
    this.prefillProxy();
    this.initWelcome();
    this.trackPlayerHeight();
    this.startTimers();

    const s = store.state;
    this.render(s, new Set(Object.keys(s) as (keyof AppState)[]));
    this.unsubscribe = store.subscribe((state, changed) => this.render(state, changed));
  }

  toggleHidden(): void {
    this.setHidden(!this.hidden);
  }

  setHidden(v: boolean): void {
    this.hidden = v;
    document.body.classList.toggle('ui-hidden', v);
    this.root.classList.toggle('is-hidden', v);
    if (v) {
      this.setQueueOpen(false);
      this.setHelpOpen(false);
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.resizeObs?.disconnect();
    document.body.classList.remove('ui-hidden');
    this.root.classList.remove('dom-ui', 'is-xr', 'is-playing', 'is-dragging', 'is-hidden', 'is-quest');
    for (const v of ['--a', '--b', '--a-rgb', '--b-rgb', '--ink']) this.root.style.removeProperty(v);
    this.root.replaceChildren();
  }

  // ---------------------------------------------------------------- rendering
  private render(s: AppState, changed: Changed): void {
    const has = (...keys: (keyof AppState)[]) => keys.some((k) => changed.has(k));
    if (changed.has('mode')) this.root.classList.toggle('is-xr', s.mode === 'xr');
    if (has('palette', 'palettes')) this.renderAccent(s);
    if (has('mode', 'xrSupported')) this.renderVr(s);
    if (has('playback', 'fps')) this.renderStatus(s);
    if (changed.has('playback')) this.renderPlayback(s.playback);
    if (has('presets', 'preset')) this.renderPresets(s);
    if (has('palettes', 'palette')) this.renderPalettes(s);
    if (has('params', 'autoCycle', 'cycleSeconds')) this.renderParams(s);
    if (changed.has('quality')) this.renderQuality(s.quality);
    if (changed.has('toast')) {
      if (s.toast) setText(this.el.toast, s.toast.text); // keep the text while fading out
      this.el.toast.classList.toggle('show', !!s.toast);
    }
  }

  private memo(key: string, value: unknown): boolean {
    if (this.last.has(key) && this.last.get(key) === value) return false;
    this.last.set(key, value);
    return true;
  }

  /** Make the 2D accent follow the active palette (overlay.css reads --a / --b / --ink and the -rgb triplets). */
  private renderAccent(s: AppState): void {
    const palette = s.palettes.find((p) => p.id === s.palette);
    if (!this.memo('accent', palette)) return;
    const { a, b, ink } = accentOf(palette);
    const st = this.root.style;
    st.setProperty('--a', rgbCss(a));
    st.setProperty('--b', rgbCss(b));
    st.setProperty('--a-rgb', a.join(' '));
    st.setProperty('--b-rgb', b.join(' '));
    st.setProperty('--ink', ink);
  }

  private renderVr(s: AppState): void {
    const { enterVr, vrTip, vrLabel, vrReason, vrCopy } = this.el;
    const xr = s.mode === 'xr';
    const unavailable = !s.xrSupported && !xr;
    setText(vrLabel, xr ? 'Exit VR' : 'Enter VR');
    enterVr.disabled = unavailable;
    enterVr.classList.toggle('active', xr);
    enterVr.classList.toggle('primary', !unavailable);
    enterVr.classList.toggle('ghost', unavailable);

    let reason = '';
    let canCopy = false;
    if (unavailable) {
      const hasXr = !!(navigator as Navigator & { xr?: unknown }).xr;
      if (!window.isSecureContext) reason = VR_REASON.https;
      else if (!hasXr) reason = VR_REASON.noXr;
      else if (this.vrChecked) { reason = VR_REASON.noHeadset; canCopy = true; }
    }
    setText(vrReason, reason);
    vrReason.hidden = !reason;
    vrCopy.hidden = !canCopy;
    vrTip.title = enterVr.title = reason;
  }

  private renderStatus(s: AppState): void {
    const pb = s.playback;
    const parts = [pb.status === 'loading' ? 'Loading…' : pb.track ? KIND_LABEL[pb.track.kind] : pb.micEnabled ? KIND_LABEL.mic : 'Idle'];
    if (s.fps > 0 && s.fps < 60) parts.push(`${s.fps} fps`); // only worth a pixel when it is a problem
    setText(this.el.statusText, parts.join(' · '));
    this.el.status.dataset.state = pb.status === 'error' ? 'error' : pb.status === 'loading' ? 'loading' : pb.playing ? 'playing' : 'idle';
    this.el.status.title = [pb.message, s.fps > 0 ? `${s.fps} fps` : ''].filter(Boolean).join(' · ');
    this.el.chipListening.hidden = pb.analysisInput !== 'mic';
  }

  private renderPlayback(pb: PlaybackState): void {
    this.renderNow(pb);
    this.renderTransport(pb);
    this.renderSources(pb);
    this.renderQueue(pb);
    this.renderMessages(pb);
    this.updateSilence(performance.now());
    if (pb.track || pb.micEnabled) this.dismissWelcome(performance.now() - this.createdAt > DEEP_LINK_MS); // a source started
  }

  private renderNow(pb: PlaybackState): void {
    const { thumb, title, sub } = this.el;
    const t = pb.track;
    setText(title, t ? t.title : pb.micEnabled ? LABELS.micOn : LABELS.emptyQueue);
    setText(
      sub,
      pb.status === 'loading' ? 'Loading…'
        : pb.status === 'error' ? 'Can’t play this track' // the reason lives in the banner under the top bar
        : t ? [t.artist, KIND_LABEL[t.kind]].filter(Boolean).join(' · ')
        : pb.micEnabled ? 'Live input'
        : 'Add music, paste a link, or turn on the microphone',
    );
    sub.classList.toggle('error', pb.status === 'error');
    const url = t ? thumbUrl(t) : undefined;
    if (this.memo('thumb', url ?? t?.kind ?? '')) {
      const icon = t?.kind === 'mic' ? ICONS.mic : t?.kind === 'youtube' ? ICONS.play : ICONS.note;
      thumb.innerHTML = icon + (url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" />` : '');
    }
  }

  private renderTransport(pb: PlaybackState): void {
    const { play, shuffle, repeat, seek, cur, dur, volume, volOut, mute } = this.el;
    if (this.memo('playing', pb.playing)) {
      play.innerHTML = pb.playing ? ICONS.pause : ICONS.play;
      const label = pb.playing ? 'Pause' : 'Play';
      play.title = label;
      play.setAttribute('aria-label', label);
    }
    play.classList.toggle('loading', pb.status === 'loading');
    this.root.classList.toggle('is-playing', pb.playing);
    shuffle.classList.toggle('on', pb.shuffle);
    shuffle.setAttribute('aria-pressed', String(pb.shuffle));
    if (this.memo('repeat', pb.repeat)) {
      repeat.innerHTML = pb.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
      repeat.title = `Repeat: ${pb.repeat}`;
      repeat.setAttribute('aria-label', repeat.title);
    }
    repeat.classList.toggle('on', pb.repeat !== 'off');

    const seekable = Number.isFinite(pb.duration) && pb.duration > 0;
    const live = pb.track ? pb.track.kind === 'mic' : pb.micEnabled;
    seek.disabled = !seekable;
    for (const b of this.el.needsSeek) b.disabled = !seekable;
    for (const b of this.el.needsQueue) b.disabled = pb.queue.length === 0;
    setText(dur, seekable ? formatTime(pb.duration) : live ? LABELS.live : LABELS.unknownDuration);
    if (!this.scrubbing && performance.now() >= this.holdSeekUntil) {
      setRange(seek, seekable ? Math.round(Math.min(1, pb.currentTime / pb.duration) * 1000) : 0);
      setText(cur, elapsed(pb.currentTime));
    }

    if (pb.volume > 0) this.volBeforeMute = pb.volume;
    if (document.activeElement !== volume) setRange(volume, pb.volume);
    setText(volOut, percent(pb.volume));
    const muted = pb.volume === 0;
    if (this.memo('muted', muted)) {
      mute.innerHTML = muted ? ICONS.volumeOff : ICONS.volume;
      mute.title = muted ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-label', mute.title);
    }
  }

  private renderSources(pb: PlaybackState): void {
    const { mic, micState } = this.el;
    mic.setAttribute('aria-pressed', String(pb.micEnabled));
    setText(micState, pb.micEnabled ? 'On' : 'Off');
    this.renderProxyBadge();
  }

  /**
   * YouTube + microphone: an info card while the microphone is still to be granted, a persistent amber banner when
   * it was refused, and the generic message banner for everything else the engine has to say.
   */
  private renderMessages(pb: PlaybackState): void {
    const { banner, bannerText, micBanner, micPrompt, ytCaption, ytWrap } = this.el;
    const t = pb.track;
    const yt = t?.kind === 'youtube';
    // analysisInput 'none' with a YouTube track means "analysed through the mic, but the mic is not open"
    const needsMic = !!yt && pb.analysisInput === 'none';
    const viaMic = !!yt && pb.analysisInput === 'mic';
    const id = t?.id ?? '';
    if (id !== this.micTrackId) {
      this.micTrackId = id;
      this.micBlocked = false;
      this.micNeededSince = 0;
    }
    if (!needsMic) {
      this.micBlocked = false;
      this.micNeededSince = 0;
    } else {
      if (!this.micNeededSince) this.micNeededSince = performance.now();
      if (pb.message && MIC_MESSAGE.test(pb.message)) this.micBlocked = true; // latched: the engine clears its message after 8 s
    }

    const showYt = !!yt && pb.analysisInput !== 'element'; // proxied streams have no player to show
    ytWrap.classList.toggle('active', showYt);
    // re-check whenever the column grows (info card, caption) so nothing ends up under the player bar
    const ytKey = showYt ? `${id}|${needsMic && !this.micBlocked}|${viaMic}` : '';
    if (this.memo('ytShown', ytKey) && showYt) {
      // the column may be taller than the screen: bring the video (and the microphone card above it) into view
      window.clearTimeout(this.revealTimer);
      this.revealTimer = window.setTimeout(() => this.revealYouTube(), 380); // after the 0.3 s expand transition
    }
    micPrompt.hidden = !(needsMic && !this.micBlocked);
    micBanner.hidden = !this.micBlocked;
    micBanner.title = this.micBlocked ? (pb.message ?? '') : '';
    ytCaption.hidden = !viaMic;

    if (pb.message !== this.bannerMsg) {
      this.bannerMsg = pb.message;
      this.bannerDismissed = false;
    }
    // the amber banner already explains a microphone message; anything else the engine says still gets its own line
    const show = !!pb.message && !this.bannerDismissed && !(this.micBlocked && MIC_MESSAGE.test(pb.message));
    banner.hidden = !show;
    if (show) {
      setText(bannerText, pb.message ?? '');
      banner.classList.toggle('err', pb.status === 'error');
      banner.setAttribute('role', pb.status === 'error' ? 'alert' : 'status');
    }
  }

  private revealYouTube(): void {
    for (const box of this.root.querySelectorAll<HTMLElement>('.col-left, .columns')) {
      if (box.scrollHeight > box.clientHeight + 1) reveal(box, this.el.ytWrap, 32);
    }
  }

  /** "No sound heard" chip: playing, analysed, but silent for a few seconds. Replaces the sub-line while shown. */
  private updateSilence(now: number): void {
    const pb = this.store.state.playback;
    const silent = !!this.features && pb.playing && pb.analysisInput !== 'none' && this.features.silence;
    if (!silent) this.silentSince = 0;
    else if (!this.silentSince) this.silentSince = now;
    const show = this.silentSince > 0 && now - this.silentSince > SILENCE_MS && !this.micBlocked;
    this.el.chipNoSound.hidden = !show;
    this.el.sub.hidden = show;
  }

  private renderQueue(pb: PlaybackState): void {
    const { queueCount, queueList } = this.el;
    setText(queueCount, pb.queue.length ? String(pb.queue.length) : '');
    if (!this.queueOpen) return;
    const sig = `${pb.index}|${pb.playing}|${pb.queue.map((t) => `${t.id}\t${t.title}`).join('\n')}`;
    if (!this.memo('qsig', sig)) return;
    const top = queueList.scrollTop;
    queueList.innerHTML = pb.queue.length
      ? pb.queue.map((t, i) => queueRow(t, i, i === pb.index, pb.playing)).join('')
      : '<li class="q-empty">The queue is empty. Add music from Sources.</li>';
    queueList.scrollTop = top;
    if (this.memo('qidx', pb.index)) reveal(queueList, queueList.querySelector('.current'));
  }

  private renderPresets(s: AppState): void {
    const list = this.el.presets;
    if (this.memo('presets', s.presets)) list.innerHTML = s.presets.map(sceneTile).join('');
    for (const b of list.querySelectorAll<HTMLElement>('.scene-tile')) {
      const on = b.dataset.id === s.preset;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  private renderPalettes(s: AppState): void {
    const list = this.el.palettes;
    if (this.memo('palettes', s.palettes)) list.innerHTML = s.palettes.map(swatch).join('');
    for (const b of list.querySelectorAll<HTMLElement>('.swatch')) {
      const on = b.dataset.id === s.palette;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    setText(this.el.paletteName, s.palettes.find((p) => p.id === s.palette)?.name ?? '');
  }

  private renderParams(s: AppState): void {
    for (const [key] of SLIDERS) {
      const { input, out } = this.el.params[key];
      setText(out, s.params[key].toFixed(2));
      if (document.activeElement !== input) setRange(input, s.params[key]);
    }
    for (const [el, on] of [[this.el.autoCycle, s.autoCycle], [this.el.background, s.params.background]] as const) {
      el.setAttribute('aria-checked', String(on));
    }
    setText(this.el.cycleNote, `every ${s.cycleSeconds} s`);
  }

  private renderQuality(q: QualityLevel): void {
    for (const b of this.el.qualityBtns) {
      const on = b.dataset.id === q;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  private setQueueOpen(open: boolean): void {
    this.queueOpen = open;
    this.el.queuePanel.classList.toggle('open', open);
    this.el.queueBtn.classList.toggle('on', open);
    this.el.queueBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.last.delete('qsig');
      this.last.delete('qidx');
      this.renderQueue(this.store.state.playback);
    }
  }

  private setHelpOpen(open: boolean): void {
    if (open === this.helpOpen) return;
    this.helpOpen = open;
    this.el.help.hidden = !open;
    this.el.helpBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.helpOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.helpClose.focus();
    } else {
      const opener = this.helpOpener;
      this.helpOpener = null;
      if (opener && this.el.help.contains(document.activeElement)) opener.focus();
    }
  }

  // ------------------------------------------------------------------- events
  private on<T extends EventTarget, E extends Event>(target: T, type: string, fn: (e: E) => void, capture = false): void {
    const handler = fn as EventListener;
    target.addEventListener(type, handler, capture);
    this.offs.push(() => target.removeEventListener(type, handler, capture));
  }

  /** One delegated listener: every control carries `data-act` (plus `data-id` / `data-i` where needed). */
  private bindClicks(): void {
    this.on(this.root, 'click', (e: MouseEvent) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-act]');
      if (!el) return;
      this.act(el.dataset.act ?? '', el);
      // Keep keyboard shortcuts (Space, H, ...) working after a pointer click
      if (e.detail > 0 && el instanceof HTMLButtonElement) el.blur();
    });
  }

  private act(name: string, el: HTMLElement): void {
    const a = this.actions;
    const s = this.store.state;
    const pb = s.playback;
    switch (name) {
      case 'vr': a.enterVR(); break;
      case 'hide': this.setHidden(true); break;
      case 'show': this.setHidden(false); break;
      case 'help': this.setHelpOpen(true); break;
      case 'help-close': this.setHelpOpen(false); break;
      case 'welcome-close': this.dismissWelcome(true); break;
      case 'welcome-demo': a.startDemo(); this.dismissWelcome(true); break;
      case 'pick': this.el.fileInput.click(); break;
      case 'paste': void this.pasteLink(); break;
      case 'copylink': void this.copyLink(); break;
      case 'mic': if (pb.micEnabled) a.disableMic(); else a.enableMic(); break;
      case 'mic-retry':
        this.micBlocked = false;
        this.micNeededSince = performance.now();
        this.renderMessages(pb);
        a.enableMic();
        break;
      case 'demo': a.startDemo(); break;
      case 'banner-close':
        this.bannerDismissed = true;
        this.el.banner.hidden = true;
        break;
      case 'toggle': a.toggle(); break;
      case 'prev': a.prev(); break;
      case 'next': a.next(); break;
      case 'back': a.seekBy(-10); break;
      case 'fwd': a.seekBy(10); break;
      case 'shuffle': a.setShuffle(!pb.shuffle); break;
      case 'repeat': a.setRepeat(NEXT_REPEAT[pb.repeat]); break;
      case 'mute': a.setVolume(pb.volume > 0 ? 0 : this.volBeforeMute || 0.8); break;
      case 'queue': this.setQueueOpen(!this.queueOpen); break;
      case 'clear': a.clearQueue(); break;
      case 'qplay': a.play(Number(el.dataset.i)); break;
      case 'qrm': a.removeTrack(Number(el.dataset.i)); break;
      case 'preset': a.setPreset(el.dataset.id ?? ''); break;
      case 'palette': a.setPalette(el.dataset.id ?? ''); break;
      case 'autocycle': a.setAutoCycle(!s.autoCycle); break;
      case 'background': a.setParam('background', !s.params.background); break;
      case 'quality': {
        const q = el.dataset.id as QualityLevel;
        if (QUALITY_IDS.includes(q)) a.setQuality(q);
        break;
      }
      case 'proxy-test': void this.testProxy(); break;
    }
  }

  private submitUrl(): void {
    const { urlInput } = this.el;
    const url = urlInput.value.trim();
    if (!url) return this.actions.toast('Paste a YouTube link or an audio URL first');
    this.actions.addUrl(url);
    urlInput.value = '';
    urlInput.blur();
  }

  private async pasteLink(): Promise<void> {
    let text = '';
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch { /* permission refused or no clipboard API (insecure context) */ }
    if (!text) return this.actions.toast('Clipboard is empty or blocked');
    this.el.urlInput.value = text;
    if (looksLikeLink(text)) this.submitUrl();
    else this.el.urlInput.focus(); // not a link: let the user see and fix what was pasted
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(location.href);
      this.actions.toast('Link copied — open it on your Quest');
    } catch {
      this.actions.toast('Could not copy. Copy the address from the address bar instead.', 3500);
    }
  }

  private bindInputs(): void {
    const { el, actions, root } = this;

    this.on(el.fileInput, 'change', () => {
      const files = Array.from(el.fileInput.files ?? []);
      el.fileInput.value = ''; // allow picking the same file again
      if (files.length) actions.addFiles(files);
    });

    this.on(el.urlForm, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      this.submitUrl();
    });

    this.on(el.proxyInput, 'change', () => {
      if (this.commitProxy()) el.proxyInput.blur();
    });
    this.on(el.proxyInput, 'input', () => {
      if (this.proxyBase() !== this.proxyTestedOk) el.proxyStatus.hidden = true;
      this.renderProxyWarn();
      this.renderProxyBadge();
    });

    this.on(el.seek, 'input', () => {
      this.scrubbing = true;
      fill(el.seek);
      setText(el.cur, elapsed((Number(el.seek.value) / 1000) * this.store.state.playback.duration));
    });
    this.on(el.seek, 'change', () => {
      const dur = this.store.state.playback.duration;
      if (dur > 0) actions.seek((Number(el.seek.value) / 1000) * dur);
      this.scrubbing = false;
      this.holdSeekUntil = performance.now() + 600; // don't jump back before the engine reports the new time
    });
    this.on(el.volume, 'input', () => {
      fill(el.volume);
      setText(el.volOut, percent(Number(el.volume.value)));
      actions.setVolume(Number(el.volume.value));
    });

    this.on(root, 'input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      const key = input.dataset.param as SliderKey | undefined;
      if (!key) return;
      fill(input);
      setText(el.params[key].out, Number(input.value).toFixed(2));
      actions.setParam(key, Number(input.value));
    });

    // Release focus after dragging a slider so global shortcuts (Space, H, arrows) keep working
    this.on(root, 'pointerup', (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.type === 'range') setTimeout(() => t.blur(), 0);
    });

    // A thumbnail that fails to load falls back to the icon underneath
    this.on(el.thumb, 'error', (e: Event) => (e.target as HTMLElement).remove(), true);
    // A scene image that is missing (or still to be added) falls back to the gradient tile with its name
    this.on(el.presets, 'error', (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      img.closest('.scene-tile')?.classList.add('nothumb');
      img.remove();
    }, true);
  }

  private bindWindow(): void {
    this.on(window, 'pointerdown', (e: PointerEvent) => {
      if (this.queueOpen && !(e.target as Element).closest('#queue-panel, #queue-btn')) this.setQueueOpen(false);
    });
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.helpOpen) return this.setHelpOpen(false);
        this.setQueueOpen(false);
        const active = document.activeElement;
        if (active instanceof HTMLInputElement) active.blur();
        return;
      }
      if (e.key === '?' && !this.quest && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        this.setHelpOpen(!this.helpOpen);
      }
    });
  }

  /** Drag & drop works over the whole window, not just the drop zone. */
  private bindDrop(): void {
    const hasPayload = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).some((t) => t === 'Files' || t === 'text/uri-list');
    let depth = 0;
    const setDragging = (on: boolean) => this.root.classList.toggle('is-dragging', on);

    this.on(window, 'dragenter', (e: DragEvent) => {
      if (!hasPayload(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    });
    this.on(window, 'dragover', (e: DragEvent) => {
      if (!hasPayload(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.on(window, 'dragleave', (e: DragEvent) => {
      if (!hasPayload(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    });
    this.on(window, 'drop', (e: DragEvent) => {
      if (!hasPayload(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      const files = Array.from(dt.files).filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
      if (files.length) return this.actions.addFiles(files);
      const link = (dt.getData('text/uri-list') || dt.getData('text/plain')).split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
      if (link) this.actions.addUrl(link.trim());
      else this.actions.toast('No audio files found in that drop');
    });
  }

  // ------------------------------------------------------------------- proxy
  private prefillProxy(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const url = raw ? (JSON.parse(raw) as { proxyUrl?: string }).proxyUrl : '';
      if (url) {
        this.el.proxyInput.value = url;
        this.savedProxy = this.proxyBase();
      }
    } catch { /* storage blocked or corrupt: leave the field empty */ }
    this.renderProxyWarn();
  }

  /** The field's value as the engine will use it (no trailing slash, http:// when no scheme was typed). */
  private proxyBase(): string {
    const v = this.el.proxyInput.value.trim().replace(/\/+$/, '');
    return v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `http://${v}` : v;
  }

  /** Browsers refuse http:// requests from https:// pages unless the target is localhost. */
  private proxyIsMixedContent(): boolean {
    const url = this.proxyBase();
    return location.protocol === 'https:' && /^http:\/\//i.test(url) && !LOCAL_HTTP.test(url);
  }

  private renderProxyWarn(): void {
    this.el.proxyWarn.hidden = !this.proxyIsMixedContent();
  }

  private renderProxyBadge(): void {
    const configured = this.store.state.playback.proxyConfigured;
    const base = this.proxyBase();
    const connected = configured && base !== '' && base === this.proxyTestedOk;
    setText(this.el.proxyBadge, !configured ? 'Off' : connected ? 'Connected' : 'Saved');
    this.el.proxyBadge.classList.toggle('on', connected);
    this.el.proxyBadge.classList.toggle('saved', configured && !connected);
  }

  /** Validate and store the field; returns false (with a toast) when the address is unusable. */
  private commitProxy(): boolean {
    const { proxyInput } = this.el;
    const url = proxyInput.value.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      this.actions.toast('Proxy URL must start with http:// or https://', 3500);
      return false;
    }
    const clean = url.replace(/\/+$/, '');
    this.savedProxy = clean;
    this.actions.setProxyUrl(clean);
    this.actions.toast(url ? 'YouTube proxy saved' : 'YouTube proxy disabled');
    this.renderProxyBadge();
    return true;
  }

  private setProxyStatus(state: 'busy' | 'ok' | 'err', text: string): void {
    const el = this.el.proxyStatus;
    el.hidden = false;
    el.dataset.state = state;
    setText(el, text);
  }

  private async testProxy(): Promise<void> {
    const base = this.proxyBase();
    if (!base) return this.setProxyStatus('err', '✗ Enter the proxy address first');
    if (!/^https?:\/\//i.test(base)) return this.setProxyStatus('err', '✗ The address must start with http:// or https://');
    const ticket = ++this.proxyTicket;
    const { proxyTest } = this.el;
    proxyTest.disabled = true;
    this.setProxyStatus('busy', 'Testing…');

    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    let error = '';
    try {
      const r = await fetch(`${base}/info?v=${PROXY_TEST_ID}`, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) {
        let detail = '';
        try { detail = ((await r.json()) as { error?: string }).error ?? ''; } catch { /* not JSON */ }
        error = `The server answered HTTP ${r.status}${detail ? `: ${detail}` : ''}`;
      }
    } catch (e) {
      error = ctrl.signal.aborted ? 'No answer within 5 s'
        : this.proxyIsMixedContent() ? 'Blocked by the browser (http:// from an https:// page)'
        : e instanceof TypeError ? 'Could not reach the server (wrong address, not running, or blocked)'
        : (e as Error).message;
    } finally {
      window.clearTimeout(timer);
    }
    if (ticket !== this.proxyTicket) return; // a newer test replaced this one
    proxyTest.disabled = false;
    if (error) {
      this.proxyTestedOk = '';
      this.setProxyStatus('err', `✗ ${error}`);
    } else {
      this.proxyTestedOk = base;
      this.setProxyStatus('ok', '✓ Connected');
      if (base !== this.savedProxy && this.proxyBase() === base) { // a passing address is worth keeping
        this.el.proxyInput.value = base;
        this.commitProxy();
      }
    }
    this.renderProxyBadge();
  }

  // ------------------------------------------------------------------- welcome
  private initWelcome(): void {
    try { this.welcomed = localStorage.getItem(WELCOME_KEY) === '1'; } catch { /* storage blocked */ }
    // ?nowelcome=1 is used by the test scripts
    if (this.welcomed || new URLSearchParams(location.search).get('nowelcome') === '1') this.el.welcome.classList.add('gone');
  }

  /** Only an explicit ✕ / "Play demo" or a source starting closes the welcome (dragging to look must not). */
  private dismissWelcome(persist: boolean): void {
    this.el.welcome.classList.add('gone');
    if (!persist || this.welcomed) return;
    this.welcomed = true;
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* storage blocked */ }
  }

  // ------------------------------------------------------------------- timers
  /** Level meter, silence chip and the microphone grace period run at 4 Hz, never per frame. */
  private startTimers(): void {
    const tick = (): void => {
      const pb = this.store.state.playback;
      const f = this.features;
      const now = performance.now();

      const level = f && f.active && pb.analysisInput === 'mic' ? f.level : 0;
      let lit = 0;
      for (const step of METER_STEPS) if (level >= step) lit++;
      if (this.memo('meter', lit)) {
        Array.from(this.el.meter.children).forEach((seg, i) => seg.classList.toggle('on', i < lit));
      }

      // YouTube is playing but nothing ever opened the microphone and no error said why: call it blocked
      if (!this.micBlocked && this.micNeededSince && pb.playing && now - this.micNeededSince > MIC_GRACE_MS) {
        this.micBlocked = true;
        this.renderMessages(pb);
      }
      this.updateSilence(now);
    };
    const id = window.setInterval(tick, 250);
    this.offs.push(() => window.clearInterval(id), () => window.clearTimeout(this.revealTimer));

    // "No headset" is only a fact once the WebXR support probe has had time to answer
    const vrId = window.setTimeout(() => {
      this.vrChecked = true;
      this.renderVr(this.store.state);
    }, 1200);
    this.offs.push(() => window.clearTimeout(vrId));
  }

  /** Lets CSS float the toast just above the player bar, whatever its height. */
  private trackPlayerHeight(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObs = new ResizeObserver(() => this.root.style.setProperty('--player-h', `${this.el.player.offsetHeight}px`));
    this.resizeObs.observe(this.el.player);
  }
}
