/**
 * Thin wrapper around the YouTube IFrame Player API: loads the script once, creates a player inside the host
 * element and exposes a small synchronous control surface. Also provides oEmbed titles and playlist probing.
 */

interface YTRawPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cuePlaylist(opts: { listType: 'playlist'; list: string }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id: string; title: string; author: string };
  getPlaylist(): string[] | null;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width: string | number;
      height: string | number;
      playerVars: Record<string, string | number>;
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTRawPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type YtState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export interface YtEvents {
  onState(state: YtState): void;
  onError(message: string): void;
}

const STATES: Record<number, YtState> = { [-1]: 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const fail = (msg: string) => { apiPromise = null; reject(new Error(msg)); };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); if (window.YT?.Player) resolve(window.YT); else fail('YouTube player failed to initialise.'); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => fail('Could not load the YouTube player (offline, or youtube.com is blocked).');
    document.head.appendChild(s);
    setTimeout(() => fail('Timed out loading the YouTube player.'), 15000);
  });
  return apiPromise;
}

function errorMessage(code: number): string {
  switch (code) {
    case 2: return 'YouTube rejected this video id.';
    case 5: return 'The YouTube player hit an error. Try again.';
    case 100: return 'This YouTube video was removed or is private.';
    case 101:
    case 150: return 'The owner of this YouTube video does not allow embedded playback.';
    case 153: return 'YouTube refused playback because the page sent no referrer (serve the app over http(s)).';
    default: return `YouTube playback error (${code}).`;
  }
}

function playerVars(): Record<string, string | number> {
  const v: Record<string, string | number> = { autoplay: 0, controls: 1, playsinline: 1, rel: 0, modestbranding: 1, fs: 0, disablekb: 1, iv_load_policy: 3 };
  if (location.protocol.startsWith('http')) v.origin = location.origin;
  return v;
}

export class YouTubePlayer {
  private host: HTMLElement | null = null;
  private offscreen: HTMLElement | null = null;
  private player: YTRawPlayer | null = null;
  private ready: Promise<YTRawPlayer> | null = null;
  private volume = 100;

  constructor(private events: YtEvents) {}

  setHost(host: HTMLElement): void {
    if (host === this.host) return;
    this.host = host;
    this.destroy(); // an iframe cannot be moved without reloading, the next load() recreates it
  }

  private ensure(): Promise<YTRawPlayer> {
    if (this.ready) return this.ready;
    const ready = loadApi().then((YT) => new Promise<YTRawPlayer>((resolve, reject) => {
      const mount = document.createElement('div');
      mount.style.cssText = 'width:100%;height:100%';
      this.mountPoint().appendChild(mount);
      const timer = setTimeout(() => reject(new Error('The YouTube player did not start in time.')), 15000);
      const p: YTRawPlayer = new YT.Player(mount, {
        width: '100%',
        height: '100%',
        playerVars: playerVars(),
        events: {
          onReady: () => { clearTimeout(timer); this.player = p; p.setVolume(this.volume); resolve(p); },
          onStateChange: (e) => { const s = STATES[e.data]; if (s) this.events.onState(s); },
          onError: (e) => this.events.onError(errorMessage(e.data)),
        },
      });
    }));
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  private mountPoint(): HTMLElement {
    if (this.host) return this.host;
    if (!this.offscreen) {
      this.offscreen = document.createElement('div');
      this.offscreen.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;pointer-events:none';
      document.body.appendChild(this.offscreen);
    }
    return this.offscreen;
  }

  async load(videoId: string, start = 0): Promise<void> {
    const p = await this.ensure();
    p.setVolume(this.volume);
    p.loadVideoById({ videoId, startSeconds: start });
  }

  play(): void { this.call((p) => p.playVideo()); }
  pause(): void { this.call((p) => p.pauseVideo()); }
  stop(): void { this.call((p) => p.stopVideo()); }
  seek(seconds: number): void { this.call((p) => p.seekTo(Math.max(0, seconds), true)); }
  setVolume(v01: number): void {
    this.volume = Math.round(Math.min(1, Math.max(0, v01)) * 100);
    this.call((p) => p.setVolume(this.volume));
  }

  get currentTime(): number { return this.read((p) => p.getCurrentTime(), 0); }
  get duration(): number { return this.read((p) => p.getDuration(), 0); }
  get state(): YtState { return STATES[this.read((p) => p.getPlayerState(), -1)] ?? 'unstarted'; }
  get title(): string { return this.read((p) => p.getVideoData().title, ''); }
  get author(): string { return this.read((p) => p.getVideoData().author, ''); }
  get videoId(): string { return this.read((p) => p.getVideoData().video_id, ''); }

  destroy(): void {
    const p = this.player;
    this.player = null;
    this.ready = null;
    try { p?.destroy(); } catch { /* already gone */ }
  }

  private call(fn: (p: YTRawPlayer) => void): void {
    if (!this.player) return;
    try { fn(this.player); } catch { /* player not ready for this call yet */ }
  }

  private read<T>(fn: (p: YTRawPlayer) => T, fallback: T): T {
    if (!this.player) return fallback;
    try { const v = fn(this.player); return v ?? fallback; } catch { return fallback; }
  }

  /** Video ids of a playlist, read from a throw-away offscreen player so the visible one is not interrupted. */
  static async probePlaylist(listId: string): Promise<string[]> {
    const YT = await loadApi();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:200px;height:200px;opacity:0;pointer-events:none';
    const mount = document.createElement('div');
    holder.appendChild(mount);
    document.body.appendChild(holder);
    return new Promise<string[]>((resolve, reject) => {
      let player: YTRawPlayer | null = null;
      let poll = 0;
      const done = (ids: string[] | Error) => {
        clearInterval(poll);
        clearTimeout(timer);
        try { player?.destroy(); } catch { /* ignore */ }
        holder.remove();
        if (ids instanceof Error) reject(ids); else resolve(ids);
      };
      const timer = setTimeout(() => done(new Error('Could not read the YouTube playlist (private, or too slow).')), 12000);
      player = new YT.Player(mount, {
        width: 200,
        height: 200,
        playerVars: playerVars(),
        events: {
          onReady: () => {
            player?.cuePlaylist({ listType: 'playlist', list: listId });
            poll = window.setInterval(() => {
              try { const ids = player?.getPlaylist(); if (ids && ids.length) done(ids.slice()); } catch { /* not ready */ }
            }, 250);
          },
          onError: (e) => done(new Error(errorMessage(e.data))),
        },
      });
    });
  }

  /** Title + channel via oEmbed (CORS-enabled, no API key); null if unavailable */
  static async fetchOEmbed(videoId: string): Promise<{ title: string; author: string } | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
      const r = await fetch(`https://www.youtube.com/oembed?url=${watch}&format=json`, { signal: ctl.signal });
      if (!r.ok) return null;
      const j = (await r.json()) as { title?: string; author_name?: string };
      return j.title ? { title: j.title, author: j.author_name ?? '' } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
