import {
  createEmptyFeatures,
  type AnalysisInput,
  type AudioEngineApi,
  type AudioFeatures,
  type EngineStatus,
  type PlaybackState,
  type Track,
} from './types';
import { FeatureExtractor } from './analysis/FeatureExtractor';
import { ElementPlayer } from './sources/ElementPlayer';
import { MicSource } from './sources/MicSource';
import { DemoSource } from './sources/DemoSource';
import { YouTubePlayer, type YtState } from './youtube/YouTubePlayer';
import { isMixList, parseYouTube, youtubeThumbnail, type YouTubeRef } from './youtube/parse';
import { isAudioFile, metaFromUrl, parseFileName, readId3 } from './trackInfo';

type Mode = 'element' | 'youtube' | 'demo';
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const AUTOPLAY_HINT = 'Press play in the video if it does not start (autoplay was blocked).';
const MIC_HINT = 'Visuals cannot follow this YouTube video without the microphone (or a YouTube proxy, see Settings).';
const TIME_POLL = 0.1; // s between currentTime/duration refreshes

let uidCounter = 0;
const uid = (prefix: string) => `${prefix}${(++uidCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalizeProxy(url: string): string {
  const s = url.trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

export class AudioEngine extends EventTarget implements AudioEngineApi {
  readonly features: AudioFeatures = createEmptyFeatures();
  private pb: PlaybackState;
  /** Replaced by a new object on every change (diff by reference) */
  get playback(): PlaybackState { return this.pb; }

  private extractor = new FeatureExtractor(this.features);
  private ctx: AudioContext | null = null;
  private bus!: GainNode;          // unity mix bus: sources → bus → (analyser, master)
  private master!: GainNode;       // volume
  private analyser!: AnalyserNode; // tracks (pre-volume so visuals do not depend on the volume setting)
  private micAnalyser: AnalyserNode | null = null; // never connected to the destination

  private element: ElementPlayer;
  private mic: MicSource;
  private demo: DemoSource | null = null;
  private yt: YouTubePlayer;

  private proxyUrl: string;
  private mode: Mode | null = null;
  private micExplicit = false;
  private live = false;
  private token = 0;
  private errorStreak = 0;
  private lastNow = 0;
  private timeAcc = 0;
  private zeroed = false;
  private hintTimer = 0;
  private readonly history: string[] = [];
  private readonly played = new Set<string>();
  private readonly objectUrls = new Map<string, string>();

  constructor(opts: { proxyUrl?: string } = {}) {
    super();
    this.proxyUrl = normalizeProxy(opts.proxyUrl ?? '');
    this.pb = {
      status: 'idle', playing: false, currentTime: 0, duration: 0, volume: 1, track: null, index: -1, queue: [],
      micEnabled: false, analysisInput: 'none', proxyConfigured: this.proxyUrl !== '', shuffle: false, repeat: 'off',
    };
    this.element = new ElementPlayer({
      onEnded: () => { if (this.mode === 'element') this.onTrackEnded(); },
      onError: (m) => { if (this.mode === 'element') this.onSourceError(m); },
      onPlayState: (playing) => {
        if (this.mode !== 'element') return;
        if (playing) this.errorStreak = 0;
        this.set(playing ? { playing, status: 'ready' } : { playing });
      },
      onMeta: () => { if (this.mode === 'element') this.syncElementDuration(); },
    });
    this.mic = new MicSource(() => {
      this.set({ micEnabled: false });
      this.report('The microphone was disconnected.');
    });
    this.yt = new YouTubePlayer({
      onState: (s) => this.onYtState(s),
      onError: (m) => { if (this.mode === 'youtube') this.onSourceError(m); },
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(ev, this.onGesture, { passive: true });
  }

  // ------------------------------------------------------------------------------------------ context / frame loop
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'running') return;
    // resume() can stay pending without a user gesture: never block callers for long
    await Promise.race([ctx.resume().catch(() => undefined), new Promise<void>((r) => window.setTimeout(r, 600))]);
  }

  update(): void {
    const now = performance.now();
    const dt = this.lastNow ? Math.min(0.1, Math.max(0.001, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    const f = this.features;
    const ctx = this.ctx;
    const running = ctx !== null && ctx.state === 'running';

    const input = this.pb.analysisInput;
    const node = !running ? null : input === 'mic' ? this.micAnalyser : input === 'element' ? this.analyser : null;
    if (node) {
      node.getByteFrequencyData(f.freq as Uint8Array<ArrayBuffer>);
      node.getFloatTimeDomainData(f.wave as Float32Array<ArrayBuffer>);
      this.zeroed = false;
    } else if (!this.zeroed) {
      f.freq.fill(0);
      f.wave.fill(0);
      this.zeroed = true;
    }
    this.extractor.process(dt, running ? ctx.currentTime : f.time + dt);
    f.active = node !== null && this.live;
    if (f.beat) this.dispatchEvent(new Event('beat'));

    this.timeAcc += dt;
    if (this.timeAcc >= TIME_POLL) {
      this.timeAcc = 0;
      this.pollTime();
    }
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) throw new Error('This browser does not support Web Audio.');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = this.pb.volume;
    this.analyser = this.makeAnalyser(ctx);
    this.bus.connect(this.analyser);
    this.bus.connect(this.master);
    this.master.connect(ctx.destination);
    this.element.attach(ctx, this.bus);
    this.extractor.configure(ctx.sampleRate);
    return ctx;
  }

  private makeAnalyser(ctx: AudioContext): AnalyserNode {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.5;
    a.minDecibels = -100;
    a.maxDecibels = -10;
    return a;
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden && this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => undefined);
  };

  private readonly onGesture = (): void => {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  };

  // ------------------------------------------------------------------------------------------------- state helpers
  /** Replace `playback` with a new object (and emit 'change') if anything actually differs */
  private set(patch: Partial<PlaybackState>): void {
    const cur = this.pb as unknown as Record<string, unknown>;
    const diff = (Object.keys(patch) as (keyof PlaybackState)[]).some((k) => cur[k] !== patch[k]);
    if (!diff) return;
    const next: PlaybackState = { ...this.pb, ...patch };
    next.analysisInput = this.analysisFor(next);
    this.pb = next;
    const t = next.track;
    this.live = next.analysisInput === 'mic'
      ? !t || t.kind !== 'youtube' || next.playing
      : next.analysisInput === 'element' && next.playing;
    this.dispatchEvent(new Event('change'));
  }

  private analysisFor(s: PlaybackState): AnalysisInput {
    const t = s.track;
    const ytViaMic = t?.kind === 'youtube' && !this.proxyUrl;
    if (s.micEnabled && (this.micExplicit || ytViaMic)) return 'mic';
    return t && !ytViaMic ? 'element' : 'none';
  }

  /** Surface a problem to the UIs ('error' event + `playback.message`). Non-fatal messages fade after 8 s. */
  private report(message: string, status?: EngineStatus): void {
    this.set(status ? { message, status } : { message });
    this.dispatchEvent(new Event('error'));
    if (!status || status !== 'error') {
      window.setTimeout(() => { if (this.pb.message === message && this.pb.status !== 'error') this.set({ message: undefined }); }, 8000);
    }
  }

  private updateTrack(id: string, patch: Partial<Track>): void {
    const q = this.pb.queue;
    const i = q.findIndex((t) => t.id === id);
    if (i < 0) return;
    const track = { ...q[i], ...patch };
    const queue = q.slice();
    queue[i] = track;
    this.set(i === this.pb.index ? { queue, track } : { queue });
  }

  private pollTime(): void {
    const pb = this.pb;
    if (!pb.track || !pb.playing || !this.mode) return;
    let cur = 0, dur = pb.duration;
    if (this.mode === 'demo') {
      cur = this.demo?.position ?? 0;
    } else if (this.mode === 'youtube') {
      this.syncYouTubeMeta();
      cur = this.yt.currentTime;
      dur = this.yt.duration || dur;
    } else {
      cur = this.element.currentTime;
      dur = this.element.duration || dur;
    }
    if (Math.abs(cur - pb.currentTime) >= 0.05 || dur !== pb.duration) this.set({ currentTime: cur, duration: dur });
  }

  private syncElementDuration(): void {
    const d = this.element.duration;
    if (d > 0 && d !== this.pb.duration) {
      this.set({ duration: d });
      if (this.pb.track && !this.pb.track.duration) this.updateTrack(this.pb.track.id, { duration: d });
    }
  }

  private syncYouTubeMeta(): void {
    const t = this.pb.track;
    if (!t || t.kind !== 'youtube' || this.yt.videoId !== t.youtubeId) return;
    const title = this.yt.title, author = this.yt.author, dur = this.yt.duration;
    const patch: Partial<Track> = {};
    if (title && title !== t.title) patch.title = title;
    if (author && author !== t.artist) patch.artist = author;
    if (dur > 0 && dur !== t.duration) patch.duration = dur;
    if (Object.keys(patch).length) this.updateTrack(t.id, patch);
  }

  // ---------------------------------------------------------------------------------------------------- queue
  addTracks(tracks: Track[], autoplay = false): void {
    if (!tracks.length) return;
    const first = this.pb.queue.length;
    this.set({ queue: [...this.pb.queue, ...tracks] });
    this.enrichYouTube(tracks.filter((t) => t.kind === 'youtube' && t.youtubeId && t.title.startsWith('YouTube ')));
    if (autoplay) void this.play(first);
  }

  addFiles(files: FileList | File[], autoplay = false): void {
    const valid = Array.from(files).filter(isAudioFile);
    if (!valid.length) {
      this.report('No playable audio files found (try mp3, m4a, aac, wav, ogg, opus or flac).');
      return;
    }
    const tracks = valid.map((file): Track => {
      const meta = parseFileName(file.name);
      const id = uid('f');
      const url = URL.createObjectURL(file);
      this.objectUrls.set(id, url);
      return { id, kind: 'file', title: meta.title, artist: meta.artist, url, file };
    });
    this.addTracks(tracks, autoplay);
    valid.forEach((file, i) => {
      void readId3(file).then((m) => {
        if (m.title) this.updateTrack(tracks[i].id, { title: m.title, artist: m.artist ?? tracks[i].artist });
      });
    });
  }

  async addUrl(input: string, autoplay = false): Promise<void> {
    const text = input.trim();
    if (!text) return;
    const yt = parseYouTube(text);
    if (yt) return this.addYouTube(yt, autoplay);

    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
    let url: URL | null = null;
    try { url = new URL(hasScheme ? text : `https://${text}`); } catch { /* handled below */ }
    const bad = !url || !/^(https?:|blob:|data:)$/.test(url.protocol)
      || (!hasScheme && !url.hostname.includes('.') && url.hostname !== 'localhost');
    if (bad || !url) {
      this.report('That is not a valid audio URL or YouTube link.');
      return;
    }
    const meta = metaFromUrl(url);
    this.addTracks([{ id: uid('u'), kind: 'url', title: meta.title, artist: meta.artist, url: url.href }], autoplay);
  }

  private async addYouTube(ref: YouTubeRef, autoplay: boolean): Promise<void> {
    if (ref.listId && !(ref.videoId && isMixList(ref.listId))) {
      const note = 'Reading YouTube playlist…';
      this.set({ message: note });
      try {
        const ids = await YouTubePlayer.probePlaylist(ref.listId);
        if (this.pb.message === note) this.set({ message: undefined });
        const first = this.pb.queue.length;
        this.addTracks(ids.map((id) => this.youtubeTrack(id)), false);
        if (autoplay) void this.play(first + Math.max(0, ref.videoId ? ids.indexOf(ref.videoId) : 0));
        return;
      } catch (e) {
        if (this.pb.message === note) this.set({ message: undefined });
        if (!ref.videoId) {
          this.report((e as Error).message);
          return;
        }
        // playlist unreadable: fall back to the single video from the link
      }
    }
    if (ref.videoId) this.addTracks([this.youtubeTrack(ref.videoId)], autoplay);
  }

  private youtubeTrack(id: string): Track {
    return {
      id: uid('y'), kind: 'youtube', youtubeId: id, title: `YouTube ${id}`,
      thumbnail: youtubeThumbnail(id), url: this.proxyUrl ? this.streamUrl(id) : undefined,
    };
  }

  private streamUrl(id: string): string { return `${this.proxyUrl}/stream?v=${id}`; }

  /** Fill in real titles via oEmbed (4 at a time); the player's own title wins once the video is loaded */
  private enrichYouTube(tracks: Track[]): void {
    const todo = tracks.slice();
    const worker = async () => {
      for (let t = todo.shift(); t; t = todo.shift()) {
        const info = await YouTubePlayer.fetchOEmbed(t.youtubeId!);
        const cur = this.pb.queue.find((q) => q.id === t!.id);
        if (info && cur && cur.title.startsWith('YouTube ')) this.updateTrack(t.id, { title: info.title, artist: info.author || undefined });
      }
    };
    for (let i = 0; i < Math.min(4, todo.length); i++) void worker();
  }

  removeTrack(index: number): void {
    const q = this.pb.queue;
    if (index < 0 || index >= q.length) return;
    this.revoke(q[index].id);
    const queue = q.filter((_, i) => i !== index);
    if (index !== this.pb.index) {
      this.set({ queue, index: index < this.pb.index ? this.pb.index - 1 : this.pb.index });
      return;
    }
    const wasPlaying = this.pb.playing;
    this.token++;
    this.stopOutputs();
    this.set({ queue, index: -1, track: null, playing: false, currentTime: 0, duration: 0, message: undefined, status: queue.length ? 'ready' : 'idle' });
    this.dispatchEvent(new Event('trackchange'));
    if (wasPlaying && queue.length) void this.startTrack(Math.min(index, queue.length - 1));
  }

  clearQueue(): void {
    this.token++;
    this.stopOutputs();
    for (const id of [...this.objectUrls.keys()]) this.revoke(id);
    this.history.length = 0;
    this.played.clear();
    this.set({ queue: [], index: -1, track: null, playing: false, currentTime: 0, duration: 0, message: undefined, status: 'idle' });
    this.dispatchEvent(new Event('trackchange'));
  }

  private revoke(id: string): void {
    const url = this.objectUrls.get(id);
    if (url) { URL.revokeObjectURL(url); this.objectUrls.delete(id); }
  }

  // ------------------------------------------------------------------------------------------------- transport
  async play(index?: number): Promise<void> {
    const pb = this.pb;
    if (index !== undefined) {
      if (index < 0 || index >= pb.queue.length) return;
      if (index !== pb.index || this.mode === null) return this.startTrack(index);
    } else if (!pb.track || this.mode === null) {
      if (pb.track) return this.startTrack(pb.index);
      if (!pb.queue.length) return;
      return this.startTrack(pb.shuffle ? Math.floor(Math.random() * pb.queue.length) : 0);
    }
    // resume the loaded track
    try {
      if (this.mode === 'youtube') {
        this.yt.play();
        return;
      }
      await this.resume();
      if (this.mode === 'demo') { this.demoSource().start(); this.set({ playing: true }); }
      else if (this.mode === 'element') { await this.element.play(); this.set({ playing: true }); }
    } catch (e) {
      this.report((e as Error).message);
    }
  }

  pause(): void {
    if (this.mode === 'element') this.element.pause();
    else if (this.mode === 'youtube') this.yt.pause();
    else if (this.mode === 'demo') this.demo?.pause();
    else return;
    this.set({ playing: false });
  }

  async toggle(): Promise<void> {
    if (this.pb.playing) this.pause();
    else await this.play();
  }

  async next(): Promise<void> {
    const n = this.pickNext(false);
    if (n < 0) return;
    this.pushHistory();
    await this.startTrack(n);
  }

  async prev(): Promise<void> {
    const pb = this.pb;
    if (!pb.track) return;
    if (pb.currentTime > 3) { this.seek(0); return; }
    let target = -1;
    if (pb.shuffle) {
      const id = this.history.pop();
      target = pb.queue.findIndex((t) => t.id === id);
    } else if (pb.index > 0) {
      target = pb.index - 1;
    } else if (pb.repeat === 'all' && pb.queue.length > 1) {
      target = pb.queue.length - 1;
    }
    if (target < 0) { this.seek(0); return; }
    await this.startTrack(target);
  }

  seek(seconds: number): void {
    const pb = this.pb;
    if (!pb.track || !Number.isFinite(seconds)) return;
    const s = Math.max(0, pb.duration > 0 ? Math.min(seconds, pb.duration) : seconds);
    if (this.mode === 'element') this.element.seek(s);
    else if (this.mode === 'youtube') this.yt.seek(s);
    else return;
    this.set({ currentTime: s });
  }

  seekBy(delta: number): void {
    const cur = this.mode === 'element' ? this.element.currentTime : this.mode === 'youtube' ? this.yt.currentTime : this.pb.currentTime;
    this.seek(cur + delta);
  }

  setVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    if (this.ctx) this.master.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.02);
    this.yt.setVolume(vol);
    this.set({ volume: vol });
  }

  setShuffle(on: boolean): void {
    this.played.clear();
    if (this.pb.track) this.played.add(this.pb.track.id);
    this.set({ shuffle: on });
  }

  setRepeat(mode: PlaybackState['repeat']): void { this.set({ repeat: mode }); }

  private pushHistory(): void {
    if (this.pb.track) this.history.push(this.pb.track.id);
    if (this.history.length > 200) this.history.shift();
  }

  /** Index of the track that follows the current one, or -1. `auto` = natural end of a track. */
  private pickNext(auto: boolean): number {
    const { queue, index, repeat, shuffle } = this.pb;
    const n = queue.length;
    if (!n) return -1;
    if (auto && repeat === 'one' && index >= 0) return index;
    if (shuffle) {
      let pool: number[] = [];
      for (let i = 0; i < n; i++) if (i !== index && !this.played.has(queue[i].id)) pool.push(i);
      if (!pool.length) {
        if (auto && repeat !== 'all') return -1;
        this.played.clear();
        if (queue[index]) this.played.add(queue[index].id);
        pool = [];
        for (let i = 0; i < n; i++) if (n === 1 || i !== index) pool.push(i);
      }
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (index + 1 < n) return index + 1;
    return auto && repeat !== 'all' ? -1 : 0;
  }

  private onTrackEnded(): void {
    this.dispatchEvent(new Event('ended'));
    const n = this.pickNext(true);
    if (n >= 0) {
      this.pushHistory();
      void this.startTrack(n);
      return;
    }
    this.stopOutputs();
    this.set({ playing: false, currentTime: 0 });
  }

  /** Fatal problem with the current source: show it and skip ahead when there is somewhere to go */
  private onSourceError(message: string): void {
    this.set({ playing: false });
    this.report(message, 'error');
    const token = this.token;
    if (this.pb.queue.length > 1 && ++this.errorStreak < this.pb.queue.length) {
      window.setTimeout(() => { if (token === this.token && this.pb.status === 'error') void this.next(); }, 1500);
    }
  }

  private stopOutputs(): void {
    this.mode = null;
    window.clearTimeout(this.hintTimer);
    this.element.unload();
    this.yt.stop();
    this.demo?.stop();
  }

  // --------------------------------------------------------------------------------------------- track start
  private async startTrack(index: number): Promise<void> {
    const track = this.pb.queue[index];
    if (!track) return;
    const token = ++this.token;
    this.stopOutputs();
    this.played.add(track.id);
    this.extractor.resetBeat();
    this.set({
      index, track, status: 'loading', message: undefined, playing: false, currentTime: 0, duration: track.duration ?? 0,
    });
    this.dispatchEvent(new Event('trackchange'));

    const proxied = track.kind === 'youtube' && this.proxyUrl !== '';
    try {
      if (track.kind === 'mic') {
        await this.enableMic();
        this.set({ status: 'ready', playing: true });
        return;
      }
      if (track.kind === 'youtube' && !proxied) {
        await this.startYouTube(track, token);
        return;
      }
      // everything else plays through the Web Audio graph; the microphone is not needed
      if (this.mic.isOpen) this.disableMic();
      this.micExplicit = false;
      await this.resume();
      if (token !== this.token) return;
      if (track.kind === 'demo') {
        this.mode = 'demo';
        this.demoSource().start();
        this.set({ status: 'ready', playing: true });
      } else {
        const url = proxied ? this.streamUrl(track.youtubeId!) : track.url;
        if (!url) throw new Error('This track has no audio source.');
        this.mode = 'element';
        this.element.load(url, track.kind === 'file' ? 'file' : proxied ? 'proxy' : 'url', track.duration ?? 0);
        if (proxied) void this.fetchProxyInfo(track, token);
        await this.element.play();
        if (token !== this.token) return;
        this.set({ status: 'ready', playing: true });
      }
    } catch (e) {
      if (token !== this.token) return;
      if (this.mode === 'element' && (e as Error).message.includes('autoplay')) {
        this.report((e as Error).message, 'ready'); // loaded and paused: the user can press play
      } else {
        this.onSourceError((e as Error).message);
      }
    }
  }

  private async startYouTube(track: Track, token: number): Promise<void> {
    this.mode = 'youtube';
    void this.resume();
    const mic = this.openMic(false).catch((e: Error) => {
      if (token === this.token) this.report(`${e.message} ${MIC_HINT}`);
    });
    await this.yt.load(track.youtubeId!);
    if (token !== this.token) return;
    this.set({ status: 'ready' });
    this.hintTimer = window.setTimeout(() => {
      if (token === this.token && !this.pb.playing && this.pb.status === 'ready') this.set({ message: AUTOPLAY_HINT });
    }, 5000);
    await mic;
  }

  private onYtState(state: YtState): void {
    if (this.mode !== 'youtube') return;
    switch (state) {
      case 'playing':
        this.errorStreak = 0;
        window.clearTimeout(this.hintTimer);
        this.syncYouTubeMeta();
        this.set({ playing: true, status: 'ready', message: this.pb.message === AUTOPLAY_HINT ? undefined : this.pb.message });
        break;
      case 'paused':
        this.set({ playing: false });
        break;
      case 'cued':
        this.syncYouTubeMeta();
        this.set({ playing: false, status: 'ready' });
        break;
      case 'ended':
        this.set({ playing: false });
        this.onTrackEnded();
        break;
      default:
        break;
    }
  }

  /** Proxy-mode metadata: the stream has no duration, `/info` does */
  private async fetchProxyInfo(track: Track, token: number): Promise<void> {
    try {
      const r = await fetch(`${this.proxyUrl}/info?v=${track.youtubeId}`);
      if (!r.ok) return;
      const info = (await r.json()) as { title?: string; duration?: number; uploader?: string };
      if (info.duration && info.duration > 0) {
        this.element.setKnownDuration(info.duration);
        if (token === this.token) this.set({ duration: info.duration });
      }
      this.updateTrack(track.id, {
        duration: info.duration || track.duration,
        ...(info.title ? { title: info.title } : {}),
        ...(info.uploader ? { artist: info.uploader } : {}),
      });
    } catch { /* optional */ }
  }

  // --------------------------------------------------------------------------------------------- live input
  async enableMic(): Promise<void> {
    this.micExplicit = true;
    try {
      await this.openMic(true);
    } catch (e) {
      this.micExplicit = false;
      this.set({ message: (e as Error).message });
      throw e;
    }
    // live input replaces a locally playing track (YouTube keeps playing: the mic is how it is analysed)
    if (this.mode === 'element' || this.mode === 'demo') this.pause();
    this.extractor.resetBeat();
    this.set({ micEnabled: true, message: undefined });
  }

  private async openMic(explicit: boolean): Promise<void> {
    if (this.mic.isOpen) { this.set({ micEnabled: true }); return; }
    const ctx = this.ensureContext();
    await this.resume();
    this.micAnalyser ??= this.makeAnalyser(ctx);
    await this.mic.open(ctx, this.micAnalyser);
    if (!explicit) this.extractor.resetBeat();
    this.set({ micEnabled: true });
  }

  disableMic(): void {
    this.micExplicit = false;
    this.mic.close();
    this.set({ micEnabled: false });
    this.extractor.resetBeat();
  }

  startDemo(): void {
    let i = this.pb.queue.findIndex((t) => t.kind === 'demo');
    if (i < 0) {
      i = this.pb.queue.length;
      this.set({ queue: [...this.pb.queue, { id: 'demo', kind: 'demo', title: 'Demo — Resonance', duration: 0 }] });
    }
    void this.play(i);
  }

  stopDemo(): void {
    const i = this.pb.queue.findIndex((t) => t.kind === 'demo');
    if (i >= 0) this.removeTrack(i);
  }

  private demoSource(): DemoSource {
    this.demo ??= new DemoSource(this.ensureContext(), this.bus);
    return this.demo;
  }

  // ------------------------------------------------------------------------------------------------ settings
  setYouTubeHost(host: HTMLElement): void {
    const reload = this.mode === 'youtube' && this.pb.index >= 0;
    this.yt.setHost(host);
    if (reload) void this.startTrack(this.pb.index);
  }

  setProxyUrl(url: string): void {
    this.proxyUrl = normalizeProxy(url);
    this.set({ proxyConfigured: this.proxyUrl !== '' });
  }

  dispose(): void {
    this.token++;
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.removeEventListener(ev, this.onGesture);
    this.stopOutputs();
    this.element.dispose();
    this.mic.close();
    this.yt.destroy();
    for (const id of [...this.objectUrls.keys()]) this.revoke(id);
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }
}
