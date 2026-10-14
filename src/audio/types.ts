/**
 * Audio contracts shared by the engine, the visualizer and the UI.
 * The engine owns and mutates ONE AudioFeatures object; everyone else reads it.
 */

export const BAND_COUNT = 128; // log-spaced bands used by visualizers (30 Hz .. 16 kHz)
export const WAVE_COUNT = 256; // downsampled waveform samples exposed to visualizers

export interface AudioFeatures {
  /** Raw analyser output (length fftSize/2 = 1024), 0..255 */
  freq: Uint8Array;
  /** Raw time-domain samples (length fftSize = 2048), -1..1 */
  wave: Float32Array;
  /** Log-spaced bands, AGC (auto gain) normalised and smoothed (fast attack / slow release), 0..1, length BAND_COUNT */
  bands: Float32Array;
  /** Same bands without temporal smoothing, 0..1 */
  bandsRaw: Float32Array;
  /** Downsampled waveform (length WAVE_COUNT), -1..1, lightly AGC normalised so quiet sources still show */
  waveform: Float32Array;

  /** Band energies, AGC normalised, 0..1 (may slightly exceed 1 on peaks; consumers clamp) */
  sub: number;      // 20-60 Hz
  bass: number;     // 60-250 Hz
  lowMid: number;   // 250-500 Hz
  mid: number;      // 500-2000 Hz
  highMid: number;  // 2-4 kHz
  treble: number;   // 4-16 kHz

  /** RMS loudness, AGC normalised 0..1 */
  level: number;
  /** Peak sample magnitude 0..1 (raw, not normalised) */
  peak: number;
  /** Long-term (≈2 s) smoothed level 0..1 */
  energy: number;
  /** Spectral flux (onset strength), normalised 0..1 */
  onset: number;

  /** True only on the frame a beat was detected */
  beat: boolean;
  /** 1 on beat, exponential decay to 0 over ≈350 ms */
  beatEnv: number;
  /** Strength of the last beat relative to the local average, 0..1 */
  beatStrength: number;
  /** Estimated tempo in BPM, 0 if unknown */
  bpm: number;
  /** 0..1 phase inside the predicted beat interval (derived from bpm + last beat time) */
  beatPhase: number;
  /** Monotonic counter of beats detected since the engine started */
  beatCount: number;

  /** Audio context time in seconds */
  time: number;
  /** Seconds since the previous update() */
  dt: number;
  /** True while a source is connected and the engine is running */
  active: boolean;
  /** True when the input has been essentially silent for > 1 s (e.g. mic with nothing playing) */
  silence: boolean;
}

export function createEmptyFeatures(): AudioFeatures {
  return {
    freq: new Uint8Array(1024),
    wave: new Float32Array(2048),
    bands: new Float32Array(BAND_COUNT),
    bandsRaw: new Float32Array(BAND_COUNT),
    waveform: new Float32Array(WAVE_COUNT),
    sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
    level: 0, peak: 0, energy: 0, onset: 0,
    beat: false, beatEnv: 0, beatStrength: 0, bpm: 0, beatPhase: 0, beatCount: 0,
    time: 0, dt: 0, active: false, silence: true,
  };
}

export type SourceKind = 'file' | 'url' | 'mic' | 'youtube' | 'demo';

export interface Track {
  id: string;
  title: string;
  artist?: string;
  kind: SourceKind;
  /** Direct audio URL (file: object URL, url: remote URL, youtube: proxied stream URL when a proxy is configured) */
  url?: string;
  file?: File;
  /** YouTube video id (kind === 'youtube') */
  youtubeId?: string;
  /** Optional thumbnail URL for the UI */
  thumbnail?: string;
  duration?: number;
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

/** How the analyser receives signal for the current track */
export type AnalysisInput = 'element' | 'mic' | 'none';

export interface PlaybackState {
  status: EngineStatus;
  message?: string;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** 0..1 */
  volume: number;
  track: Track | null;
  index: number;
  queue: Track[];
  /** Whether the microphone is currently open */
  micEnabled: boolean;
  analysisInput: AnalysisInput;
  /** Whether a YouTube audio proxy is configured (see docs/ARCHITECTURE.md) */
  proxyConfigured: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

/** Events dispatched by the engine (CustomEvent with no detail; read engine.playback) */
export type EngineEventName = 'change' | 'trackchange' | 'ended' | 'error' | 'beat';

export interface AudioEngineApi extends EventTarget {
  readonly features: AudioFeatures;
  readonly playback: PlaybackState;
  /** Create/resume the AudioContext. Must be called from a user gesture before anything is audible. */
  resume(): Promise<void>;
  /** Pull analyser data and update `features`. Call once per rendered frame. */
  update(): void;

  // --- queue / transport -------------------------------------------------
  addTracks(tracks: Track[], autoplay?: boolean): void;
  addFiles(files: FileList | File[], autoplay?: boolean): void;
  /** Accepts a direct audio URL, a YouTube URL / id, or a YouTube playlist URL */
  addUrl(input: string, autoplay?: boolean): Promise<void>;
  removeTrack(index: number): void;
  clearQueue(): void;
  play(index?: number): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(seconds: number): void;
  seekBy(delta: number): void;
  setVolume(v: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: PlaybackState['repeat']): void;

  // --- live input ----------------------------------------------------------
  /** Open the microphone (also used to analyse YouTube / anything playing on the headset). */
  enableMic(): Promise<void>;
  disableMic(): void;
  /** Demo signal generator (synthetic music) so the app is never silent in a demo/test. */
  startDemo(): void;
  stopDemo(): void;

  /** Element the YouTube IFrame player should live in (visible in 2D mode). */
  setYouTubeHost(host: HTMLElement): void;
  /** Optional CORS audio proxy base URL for YouTube (e.g. http://192.168.1.10:8787). '' disables. */
  setProxyUrl(url: string): void;

  dispose(): void;
}
