/**
 * HTMLAudioElement routed through the Web Audio graph (MediaElementAudioSourceNode).
 * Used for local files (object URLs), direct URLs and proxied YouTube streams.
 */

export type ElementKind = 'file' | 'url' | 'proxy';

export interface ElementEvents {
  onEnded(): void;
  onError(message: string): void;
  /** element started / paused (not fired for the pause that precedes `ended`) */
  onPlayState(playing: boolean): void;
  /** duration became known / changed */
  onMeta(): void;
}

export class ElementPlayer {
  readonly el: HTMLAudioElement;
  private node: MediaElementAudioSourceNode | null = null;
  private kind: ElementKind = 'file';
  private base = '';          // proxy stream URL without the `t` offset
  private offset = 0;         // seconds already skipped by restarting a proxy stream
  private knownDuration = 0;  // used when the element reports Infinity/NaN (live-style streams)
  private loaded = false;
  private seekable = true;      // proxied streams from a proxy without ffmpeg cannot restart at an offset

  constructor(events: ElementEvents) {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    this.el = el;
    el.addEventListener('ended', () => events.onEnded());
    el.addEventListener('playing', () => events.onPlayState(true));
    el.addEventListener('pause', () => { if (!el.ended) events.onPlayState(false); });
    el.addEventListener('durationchange', () => events.onMeta());
    el.addEventListener('loadedmetadata', () => events.onMeta());
    el.addEventListener('error', () => { if (this.loaded) events.onError(this.describeError()); });
  }

  attach(ctx: AudioContext, target: AudioNode): void {
    if (this.node) return;
    this.node = ctx.createMediaElementSource(this.el);
    this.node.connect(target);
  }

  get currentTime(): number { return this.offset + (this.el.currentTime || 0); }

  get duration(): number {
    if (this.kind === 'proxy' && this.knownDuration > 0) return this.knownDuration;
    const d = this.el.duration;
    return Number.isFinite(d) ? this.offset + d : this.knownDuration;
  }

  load(url: string, kind: ElementKind, knownDuration = 0): void {
    this.kind = kind;
    this.base = kind === 'proxy' ? url : '';
    this.offset = 0;
    this.knownDuration = knownDuration;
    this.seekable = true;
    this.loaded = true;
    this.el.src = url;
    this.el.load();
  }

  setKnownDuration(seconds: number): void {
    if (seconds > 0) this.knownDuration = seconds;
  }

  setSeekable(seekable: boolean): void { this.seekable = seekable; }

  async play(): Promise<void> {
    if (!this.loaded) return;
    try {
      await this.el.play();
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'AbortError') return; // superseded by a newer load()
      if (name === 'NotAllowedError') throw new Error('The browser blocked autoplay. Press play to start.');
      if (name === 'NotSupportedError') throw new Error(this.describeError());
      throw e;
    }
  }

  pause(): void { this.el.pause(); }

  /**
   * Play the loaded track again from the start (repeat one) without fetching it again. Falls back to reloading only
   * when the element cannot seek back: a proxied stream that was restarted at an offset, or a non-seekable response.
   */
  async restart(): Promise<void> {
    if (!this.loaded) return;
    const el = this.el;
    if (this.kind === 'proxy' && this.offset > 0) {
      this.offset = 0;
      el.src = this.base;
      el.load();
    } else {
      try { el.currentTime = 0; } catch { /* no metadata yet: play() below starts from the beginning anyway */ }
      if (el.seekable.length === 0 || el.seekable.start(0) > 0) el.load();
    }
    await this.play();
  }

  /** @returns false when the source cannot seek */
  seek(seconds: number): boolean {
    const s = Math.max(0, seconds);
    if (this.kind === 'proxy') {
      // proxied streams are not seekable: restart the stream at the requested offset
      if (!this.seekable) return false;
      const wasPlaying = !this.el.paused;
      this.offset = s;
      this.el.src = `${this.base}${this.base.includes('?') ? '&' : '?'}t=${Math.floor(s)}`;
      this.el.load();
      if (wasPlaying) void this.play().catch(() => undefined);
      return true;
    }
    try {
      this.el.currentTime = this.duration > 0 ? Math.min(s, this.duration) : s;
      return true;
    } catch {
      return false; // no metadata yet
    }
  }

  /** Stop and release the network connection */
  unload(): void {
    this.loaded = false;
    this.offset = 0;
    this.knownDuration = 0;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }

  dispose(): void {
    this.unload();
    this.node?.disconnect();
    this.node = null;
  }

  private describeError(): string {
    const code = this.el.error?.code;
    if (this.kind === 'proxy') {
      return 'Could not load the stream from the YouTube proxy. Check that it is running, reachable from this device and that yt-dlp works. ' +
        'Note: https pages cannot use a plain http:// LAN address (use https, or localhost via adb reverse; see server/README.md).';
    }
    if (this.kind === 'file') return 'This audio file could not be played (unsupported or corrupted format).';
    if (code === 3) return 'This audio could not be decoded (corrupted or unsupported format).';
    return 'Could not load this audio URL. It must point directly to an audio file and the server must allow cross-origin requests (CORS: Access-Control-Allow-Origin).';
  }
}
