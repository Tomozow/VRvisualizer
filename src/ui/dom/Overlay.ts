import type { AudioFeatures } from '@/audio/types';
import type { Actions, AppState, Store } from '@/app/Store';
import type { PlaybackState, SourceKind, Track } from '@/audio/types';
import type { Palette } from '@/viz/types';
import { ICONS, esc, fmtTime } from './icons';
import { SLIDERS, buildTemplate } from './template';

const WELCOME_KEY = 'resonance-vr.welcomed';
/** Owned by App; read once only to prefill the proxy field (the store just exposes `proxyConfigured`). */
const SETTINGS_KEY = 'resonance-vr.settings.v1';

const KIND: Record<SourceKind, string> = { file: 'File', url: 'URL', youtube: 'YouTube', mic: 'Mic', demo: 'Demo' };
const NEXT_REPEAT: Record<PlaybackState['repeat'], PlaybackState['repeat']> = { off: 'all', all: 'one', one: 'off' };
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|weba|webm|mp4)$/i;
const HEX = /^#[0-9a-f]{3,8}$/i;
const YT_ID = /^[\w-]{6,20}$/;

type SliderKey = (typeof SLIDERS)[number][0];
type Changed = Set<keyof AppState>;

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

/** Scroll `item` into view inside `box` only (scrollIntoView would also scroll the page columns). */
function reveal(box: HTMLElement, item: Element | null): void {
  if (!item) return;
  const b = box.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

function thumbUrl(t: Track): string | undefined {
  if (t.thumbnail) return t.thumbnail;
  return t.youtubeId && YT_ID.test(t.youtubeId) ? `https://i.ytimg.com/vi/${t.youtubeId}/mqdefault.jpg` : undefined;
}

function queueRow(t: Track, i: number, current: boolean, playing: boolean): string {
  const sub = [t.artist, KIND[t.kind]].filter(Boolean).join(' · ');
  const idx = current ? (playing ? ICONS.eq : ICONS.play) : String(i + 1);
  return (
    `<li class="q-row${current ? ' current' : ''}">` +
    `<button class="q-play" data-act="qplay" data-i="${i}"${current ? ' aria-current="true"' : ''}>` +
    `<span class="q-idx">${idx}</span><span class="q-meta"><b>${esc(t.title)}</b><small>${esc(sub)}</small></span></button>` +
    `<button class="q-rm" data-act="qrm" data-i="${i}" aria-label="Remove ${esc(t.title)}" title="Remove">${ICONS.close}</button></li>`
  );
}

function paletteChip(p: Palette): string {
  const stops = p.stops.filter((c) => HEX.test(c));
  const grad = stops.length > 1 ? `linear-gradient(90deg,${stops.join(',')})` : (stops[0] ?? '#444');
  return `<button class="palette-chip" data-act="palette" data-id="${esc(p.id)}" title="${esc(p.name)}" style="--grad:${grad}"><span>${esc(p.name)}</span></button>`;
}

function presetItem(p: AppState['presets'][number], i: number): string {
  return (
    `<li><button class="preset-item" data-act="preset" data-id="${esc(p.id)}">` +
    `<span class="pi-key">${i < 9 ? i + 1 : ''}</span>` +
    `<span class="pi-text"><b>${esc(p.name)}</b><small>${esc(p.description)}</small></span></button></li>`
  );
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
    enterVr: q<HTMLButtonElement>('#enter-vr'), vrTip: q('#vr-tip'), vrLabel: q('#enter-vr-label'),
    status: q('#status'), statusText: q('#status-text'),
    fileInput: q<HTMLInputElement>('#file-input'), urlForm: q<HTMLFormElement>('#url-form'), urlInput: q<HTMLInputElement>('#url-input'),
    mic: q('#mic-toggle'), micState: q('#mic-state'), proxyInput: q<HTMLInputElement>('#proxy-input'), proxyBadge: q('#proxy-badge'),
    ytWrap: q('#youtube-wrap'), ytHost: q('#youtube-host'), ytCaption: q('#yt-caption'),
    player: q('#player'), thumb: q('#np-thumb'), title: q('#np-title'), sub: q('#np-sub'),
    play: q('#play-btn'), shuffle: q('#shuffle-btn'), repeat: q('#repeat-btn'),
    seek: q<HTMLInputElement>('#seek'), cur: q('#t-cur'), dur: q('#t-dur'), volume: q<HTMLInputElement>('#volume'),
    queueBtn: q('#queue-btn'), queueCount: q('#queue-count'), queuePanel: q('#queue-panel'), queueList: q('#queue-list'),
    presets: q('#preset-list'), palettes: q('#palette-list'),
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
  private resizeObs: ResizeObserver | null = null;
  private hidden = false;
  private queueOpen = false;
  private scrubbing = false;
  private holdSeekUntil = 0;
  private welcomed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
    private readonly actions: Actions,
    /** Live audio features (same object as engine.features) for level / silence indicators */
    private readonly features?: AudioFeatures,
  ) {
    root.classList.add('dom-ui');
    root.innerHTML = buildTemplate();
    this.el = collect(root);
    this.youtubeHost = this.el.ytHost;
    this.bindClicks();
    this.bindInputs();
    this.bindWindow();
    this.bindDrop();
    this.prefillProxy();
    this.initWelcome();
    this.trackPlayerHeight();

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
    if (v) this.setQueueOpen(false);
  }

  dispose(): void {
    this.unsubscribe();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.resizeObs?.disconnect();
    document.body.classList.remove('ui-hidden');
    this.root.classList.remove('dom-ui', 'is-xr', 'is-playing', 'is-dragging', 'is-hidden');
    this.root.replaceChildren();
  }

  // ---------------------------------------------------------------- rendering
  private render(s: AppState, changed: Changed): void {
    const has = (...keys: (keyof AppState)[]) => keys.some((k) => changed.has(k));
    if (changed.has('mode')) this.root.classList.toggle('is-xr', s.mode === 'xr');
    if (has('mode', 'xrSupported')) this.renderVr(s);
    if (has('playback', 'fps')) this.renderStatus(s);
    if (changed.has('playback')) this.renderPlayback(s.playback);
    if (has('presets', 'preset')) this.renderPresets(s, changed.has('preset'));
    if (has('palettes', 'palette')) this.renderPalettes(s);
    if (has('params', 'autoCycle', 'cycleSeconds')) this.renderParams(s);
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

  private renderVr(s: AppState): void {
    const { enterVr, vrTip, vrLabel } = this.el;
    const xr = s.mode === 'xr';
    setText(vrLabel, xr ? 'Exit VR' : 'Enter VR');
    enterVr.disabled = !s.xrSupported && !xr;
    enterVr.classList.toggle('active', xr);
    vrTip.title = enterVr.title = enterVr.disabled ? 'WebXR not available — open on a Quest' : '';
  }

  private renderStatus(s: AppState): void {
    const pb = s.playback;
    const parts = [pb.status === 'loading' ? 'Loading…' : pb.track ? KIND[pb.track.kind] : pb.micEnabled ? 'Mic' : 'Idle'];
    if (pb.micEnabled && pb.track && pb.track.kind !== 'mic') parts.push('Mic on');
    if (s.fps > 0) parts.push(`${s.fps} fps`);
    setText(this.el.statusText, parts.join(' · '));
    this.el.status.dataset.state = pb.status === 'error' ? 'error' : pb.status === 'loading' ? 'loading' : pb.playing ? 'playing' : 'idle';
    this.el.status.title = pb.message ?? '';
  }

  private renderPlayback(pb: PlaybackState): void {
    this.renderNow(pb);
    this.renderTransport(pb);
    this.renderSources(pb);
    this.renderQueue(pb);
    if (pb.track || pb.micEnabled) this.el.welcome.classList.add('gone'); // auto-started: hide, but don't mark as seen
  }

  private renderNow(pb: PlaybackState): void {
    const { thumb, title, sub } = this.el;
    const t = pb.track;
    setText(title, t ? t.title : 'Nothing playing');
    setText(
      sub,
      pb.status === 'error' && pb.message ? pb.message
        : pb.status === 'loading' ? 'Loading…'
        : t ? [t.artist, KIND[t.kind]].filter(Boolean).join(' · ')
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
    const { play, shuffle, repeat, seek, cur, dur, volume } = this.el;
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
    seek.disabled = !seekable;
    for (const b of this.el.needsSeek) b.disabled = !seekable;
    for (const b of this.el.needsQueue) b.disabled = pb.queue.length === 0;
    setText(dur, seekable ? fmtTime(pb.duration) : pb.track ? 'LIVE' : '0:00');
    if (!this.scrubbing && performance.now() >= this.holdSeekUntil) {
      setRange(seek, seekable ? Math.round(Math.min(1, pb.currentTime / pb.duration) * 1000) : 0);
      setText(cur, fmtTime(pb.currentTime));
    }
    if (document.activeElement !== volume) setRange(volume, pb.volume);
  }

  private renderSources(pb: PlaybackState): void {
    const { mic, micState, proxyBadge, ytWrap, ytCaption } = this.el;
    mic.setAttribute('aria-pressed', String(pb.micEnabled));
    setText(micState, pb.micEnabled ? 'On' : 'Off');
    setText(proxyBadge, pb.proxyConfigured ? 'Active' : 'Off');
    proxyBadge.classList.toggle('on', pb.proxyConfigured);
    ytWrap.classList.toggle('active', pb.track?.kind === 'youtube');
    ytCaption.hidden = pb.analysisInput !== 'mic';
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

  private renderPresets(s: AppState, scroll: boolean): void {
    const list = this.el.presets;
    if (this.memo('presets', s.presets)) list.innerHTML = s.presets.map(presetItem).join('');
    for (const b of list.querySelectorAll<HTMLElement>('.preset-item')) {
      const on = b.dataset.id === s.preset;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      if (on && scroll) reveal(list, b);
    }
  }

  private renderPalettes(s: AppState): void {
    const list = this.el.palettes;
    if (this.memo('palettes', s.palettes)) list.innerHTML = s.palettes.map(paletteChip).join('');
    for (const b of list.querySelectorAll<HTMLElement>('.palette-chip')) {
      const on = b.dataset.id === s.palette;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
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
      case 'pick': this.el.fileInput.click(); break;
      case 'mic': if (pb.micEnabled) a.disableMic(); else a.enableMic(); break;
      case 'demo': a.startDemo(); break;
      case 'toggle': a.toggle(); break;
      case 'prev': a.prev(); break;
      case 'next': a.next(); break;
      case 'back': a.seekBy(-10); break;
      case 'fwd': a.seekBy(10); break;
      case 'shuffle': a.setShuffle(!pb.shuffle); break;
      case 'repeat': a.setRepeat(NEXT_REPEAT[pb.repeat]); break;
      case 'queue': this.setQueueOpen(!this.queueOpen); break;
      case 'clear': a.clearQueue(); break;
      case 'qplay': a.play(Number(el.dataset.i)); break;
      case 'qrm': a.removeTrack(Number(el.dataset.i)); break;
      case 'preset': a.setPreset(el.dataset.id ?? ''); break;
      case 'palette': a.setPalette(el.dataset.id ?? ''); break;
      case 'autocycle': a.setAutoCycle(!s.autoCycle); break;
      case 'background': a.setParam('background', !s.params.background); break;
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
      const url = el.urlInput.value.trim();
      if (!url) return actions.toast('Paste a YouTube link or an audio URL first');
      actions.addUrl(url);
      el.urlInput.value = '';
      el.urlInput.blur();
    });

    this.on(el.proxyInput, 'change', () => {
      const url = el.proxyInput.value.trim();
      if (url && !/^https?:\/\//i.test(url)) return actions.toast('Proxy URL must start with http:// or https://', 3500);
      actions.setProxyUrl(url.replace(/\/+$/, ''));
      actions.toast(url ? 'YouTube proxy saved' : 'YouTube proxy disabled');
      el.proxyInput.blur();
    });

    this.on(el.seek, 'input', () => {
      this.scrubbing = true;
      fill(el.seek);
      setText(el.cur, fmtTime((Number(el.seek.value) / 1000) * this.store.state.playback.duration));
    });
    this.on(el.seek, 'change', () => {
      const dur = this.store.state.playback.duration;
      if (dur > 0) actions.seek((Number(el.seek.value) / 1000) * dur);
      this.scrubbing = false;
      this.holdSeekUntil = performance.now() + 600; // don't jump back before the engine reports the new time
    });
    this.on(el.volume, 'input', () => {
      fill(el.volume);
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
  }

  private bindWindow(): void {
    this.on(window, 'pointerdown', (e: PointerEvent) => {
      this.dismissWelcome();
      if (this.queueOpen && !(e.target as Element).closest('#queue-panel, #queue-btn')) this.setQueueOpen(false);
    });
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      this.dismissWelcome();
      if (e.key !== 'Escape') return;
      this.setQueueOpen(false);
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) active.blur();
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
      this.dismissWelcome();
      const dt = e.dataTransfer;
      const files = Array.from(dt.files).filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
      if (files.length) return this.actions.addFiles(files);
      const link = (dt.getData('text/uri-list') || dt.getData('text/plain')).split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
      if (link) this.actions.addUrl(link.trim());
      else this.actions.toast('No audio files found in that drop');
    });
  }

  // ------------------------------------------------------------------- extras
  private prefillProxy(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const url = raw ? (JSON.parse(raw) as { proxyUrl?: string }).proxyUrl : '';
      if (url) this.el.proxyInput.value = url;
    } catch { /* storage blocked or corrupt: leave the field empty */ }
  }

  private initWelcome(): void {
    try { this.welcomed = localStorage.getItem(WELCOME_KEY) === '1'; } catch { /* storage blocked */ }
    if (this.welcomed) this.el.welcome.classList.add('gone');
  }

  private dismissWelcome(): void {
    if (this.welcomed) return;
    this.welcomed = true;
    this.el.welcome.classList.add('gone');
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* storage blocked */ }
  }

  /** Lets CSS float the toast just above the player bar, whatever its height. */
  private trackPlayerHeight(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObs = new ResizeObserver(() => this.root.style.setProperty('--player-h', `${this.el.player.offsetHeight}px`));
    this.resizeObs.observe(this.el.player);
  }
}
