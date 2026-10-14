import { BAND_COUNT, WAVE_COUNT, type AudioFeatures } from '../types';

/**
 * Pure signal analysis: turns one frame of analyser data (`features.freq` / `features.wave`, filled by the
 * caller) into every other field of `AudioFeatures`. No Web Audio dependency, nothing is allocated per frame.
 *
 * Analyser byte data is linear in dB (the engine configures -100 dB .. -10 dB), so most thresholds below are
 * expressed on that 0..1 scale. Spectrum: noise gate → tilt → AGC → contrast curve → fast-attack / slow-release.
 * Beats: rise events in the bass band, tempo from an inter-beat histogram, phase-locked grid (see detectBeat).
 */

const FFT_BINS = 1024;
const F_LO = 30;
const F_HI = 16000;

// ---- band shaping -----------------------------------------------------------------------------------------------
const NOISE_FLOOR = 0.2;        // ≈ -82 dB: below this a bin is treated as noise (keeps a quiet mic from lighting up)
const TILT = 0.5;               // extra gain at 16 kHz vs 30 Hz; music falls ~4 dB/oct so highs would otherwise vanish
const AGC_FLOOR = 0.2;          // AGC never amplifies by more than 1/AGC_FLOOR
const AGC_ATTACK = 0.08;        // s
const AGC_RELEASE = 4;          // s (e-fold)
const AGC_RELEASE_SILENT = 1.2; // faster reference decay while the input is silent
const CONTRAST = 1.4;           // power curve after AGC: dB scale looks flat otherwise
const BAND_ATTACK = 0.045;      // s (slightly softened so large geometry does not jump)
const BAND_RELEASE = 0.35;      // s

// ---- loudness / silence -----------------------------------------------------------------------------------------
const LEVEL_FLOOR = 0.012;      // RMS reference floor (≈ -38 dBFS)
const SILENCE_RMS = 0.004;      // ≈ -48 dBFS: above a headset mic's noise floor (white noise at this level stays "silent")
const SILENCE_WAKE = 1.5;       // silence ends once rms exceeds SILENCE_RMS × this (between the two the state is held)
const SILENCE_HOLD = 1.0;       // s
const BAND_RELEASE_SILENT = 0.1; // s: bands fall to zero quickly once the input is declared silent
const ENERGY_TAU = 2;           // s

// ---- beat detection ---------------------------------------------------------------------------------------------
const BASS_REF_FLOOR = 0.002;   // linear amplitude (≈ -54 dB): quieter bass is not amplified to full scale
const RISE_POWER = 0.5;         // sqrt-compress the normalised bass amplitude before taking its rise
const RISE_TAU = 0.07;          // s, follower used to turn the bass level into a "rise" signal
const BASS_K = 1.75;            // event threshold = mean + max(K·σ, MIN) on the rise signal
const BASS_MIN = 0.07;          // ≈ 6 dB rise on the byte scale
const FLUX_K = 2.2;
const FLUX_MIN = 0.22;
const FLUX_FALLBACK_AFTER = 1.5; // s without a bass event before the flux detector may fire
const GRID_TOL = 0.2;           // events within ±20 % of a period of the beat grid count as on-grid
const OFF_GRID_ACCEPT = 0.7;    // off-grid events still count as beats when this strong relative to on-grid ones
const OFF_STREAK_RESET = 6;     // this many off-grid events in a row invalidate the tempo
const HALF_BEAT_ACCEPT = 1.2;   // ... and this strong when they sit on the off-beat (bass lines live there)
const REFRACTORY_MIN = 0.2;  // ≥ 200 ms between visual beat events (≤ 5 Hz; typical music ≈ 2–3 Hz)
const REFRACTORY_MAX = 0.3;
const BEAT_ENV_TAU = 0.12;      // s; 350 ms → ≈5 %
const WARMUP = 0.6;             // s of data before beats can fire
const BPM_MIN = 60;
const BPM_MAX = 180;
const FOLD_EPS = 0.01;          // s: slack on the interval folding so tempi at the range edges (60, 180) do not flip octaves
const OCTAVE_MARGIN = 1.4;      // an octave-related tempo must out-weigh the current one by this factor ...
const OCTAVE_HOLD = 2;          // ... for this many seconds before the tempo jumps
const HIST_BINS = BPM_MAX - BPM_MIN + 1;
const BEAT_HISTORY = 16;
const TWO_PI = Math.PI * 2;

// analyser byte → linear amplitude (bytes span -100..-10 dB)
const AMP = new Float32Array(256).map((_, b) => Math.pow(10, (-100 + 90 * b / 255) / 20));

const GROUPS: readonly [number, number][] = [[30, 60], [60, 250], [250, 500], [500, 2000], [2000, 4000], [4000, 16000]];

export class FeatureExtractor {
  private binHz = 48000 / 2048;
  // band → bin mapping (wide bands average bins lo..hi, narrow bands interpolate between lo and lo+1)
  private lo = new Int16Array(BAND_COUNT);
  private hi = new Int16Array(BAND_COUNT);
  private frac = new Float32Array(BAND_COUNT);
  private tilt = new Float32Array(BAND_COUNT);
  private groupRange = new Int16Array(GROUPS.length * 2);
  private bassLo = 2;
  private bassHi = 7;

  private prevRaw = new Float32Array(BAND_COUNT);
  private agcRef = AGC_FLOOR;
  private levelRef = LEVEL_FLOOR;
  private fluxRef = 2;
  private waveRef = 0.2;
  private silentFor = 2;
  private clock = 0;

  // beat state
  private bass = new Pulse(BASS_K, BASS_MIN, 1.5);   // events on the bass "rise" signal
  private fluxPulse = new Pulse(FLUX_K, FLUX_MIN, 1.0); // fallback events on the spectral flux
  private xl = 0;
  private bassRef = BASS_REF_FLOOR;
  private warm = 0;
  private lastBeat = -10;
  private lastBassEvent = -10;
  private riseRef = 0.2;
  private hist = new Float32Array(HIST_BINS);
  private beatTimes = new Float64Array(BEAT_HISTORY);
  private beatN = 0;
  private pending = 0;
  private pendingBpm = 0;
  private octaveSince = -1;                          // clock time since which an octave-related tempo has been winning
  // beat grid (phase-locked once a tempo is known)
  private anchor = 0;
  private evT = new Float64Array(BEAT_HISTORY);      // recent bass events (accepted or not): time + peak
  private evP = new Float32Array(BEAT_HISTORY);
  private evN = 0;
  private curOn = true;                               // classification of the event in progress
  private curE = 0;
  private curT = 0;
  private onAvg = 0;
  private offStreak = 0;
  private lastReg = -10;

  constructor(private f: AudioFeatures) {
    this.configure(48000);
  }

  /** Build the bin → band tables for a sample rate (call whenever the context rate is known/changes). */
  configure(sampleRate: number): void {
    this.binHz = sampleRate / (FFT_BINS * 2);
    const ratio = F_HI / F_LO;
    const edge = (i: number) => F_LO * Math.pow(ratio, i / BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const f0 = edge(b), f1 = edge(b + 1);
      const lo = Math.ceil(f0 / this.binHz), hi = Math.ceil(f1 / this.binHz) - 1;
      if (hi > lo) {
        this.lo[b] = lo;
        this.hi[b] = Math.min(hi, FFT_BINS - 1);
        this.frac[b] = 0;
      } else {
        const pos = Math.sqrt(f0 * f1) / this.binHz;
        const i = Math.min(Math.floor(pos), FFT_BINS - 2);
        this.lo[b] = i;
        this.hi[b] = i; // hi === lo marks "interpolate"
        this.frac[b] = pos - i;
      }
      this.tilt[b] = 1 + TILT * (b / (BAND_COUNT - 1));
    }
    GROUPS.forEach(([a, z], g) => {
      let s = BAND_COUNT, e = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const c = Math.sqrt(edge(b) * edge(b + 1));
        if (c >= a && c < z) { if (b < s) s = b; e = b + 1; }
      }
      this.groupRange[g * 2] = s;
      this.groupRange[g * 2 + 1] = e;
    });
    this.bassLo = Math.max(1, Math.ceil(40 / this.binHz));
    this.bassHi = Math.max(this.bassLo + 1, Math.floor(180 / this.binHz));
  }

  /** Forget tempo / beat history (new track or source). AGC references are kept so levels stay continuous. */
  resetBeat(): void {
    this.resetTempo();
    this.bass.reset();
    this.fluxPulse.reset();
    this.evN = 0;
    this.f.beatPhase = 0;
    this.warm = 0;
    this.lastBeat = this.lastBassEvent = this.clock - 10;
    this.prevRaw.fill(0);
  }

  private resetTempo(): void {
    this.hist.fill(0);
    this.beatN = 0;
    this.pending = 0;
    this.octaveSince = -1;
    this.f.bpm = 0;
  }

  process(dt: number, time: number): void {
    const f = this.f;
    this.clock += dt;
    f.dt = dt;
    f.time = time;

    // ---- time domain: peak, rms ------------------------------------------------------------------------------------
    const wave = f.wave;
    let sumSq = 0, peak = 0;
    for (let i = 0; i < wave.length; i++) {
      const s = wave[i];
      sumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / wave.length);
    f.peak = peak;

    // ---- bands (noise gated) -------------------------------------------------------------------------------------
    // computed before the silence decision: a spectrum that is entirely below the noise gate counts as silence
    const freq = f.freq, raw = f.bandsRaw, bands = f.bands;
    const inv = 1 / 255;
    let frameMax = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const lo = this.lo[b], hi = this.hi[b];
      let x: number;
      if (hi === lo) {
        const w = this.frac[b];
        x = (freq[lo] * (1 - w) + freq[lo + 1] * w) * inv;
      } else {
        let sum = 0, max = 0;
        for (let k = lo; k <= hi; k++) { const v = freq[k]; sum += v; if (v > max) max = v; }
        x = (0.6 * sum / (hi - lo + 1) + 0.4 * max) * inv;
      }
      x = x > NOISE_FLOOR ? (x - NOISE_FLOOR) / (1 - NOISE_FLOOR) * this.tilt[b] : 0;
      raw[b] = x;
      if (x > frameMax) frameMax = x;
    }

    // ---- silence ---------------------------------------------------------------------------------------------------
    if (frameMax === 0 || rms < SILENCE_RMS) this.silentFor += dt;
    else if (rms > SILENCE_RMS * SILENCE_WAKE) this.silentFor = 0;
    const silent = this.silentFor > SILENCE_HOLD;
    f.silence = silent;

    // level (AGC): fast attack reference, slow release, floored; gated to 0 while the input is silent
    if (rms > this.levelRef) this.levelRef += (rms - this.levelRef) * (1 - Math.exp(-dt / 0.1));
    else this.levelRef = Math.max(LEVEL_FLOOR, this.levelRef * Math.exp(-dt / (silent ? AGC_RELEASE_SILENT : AGC_RELEASE)));
    const lv = silent ? 0 : Math.min(1, rms / this.levelRef);
    f.level = silent ? 0 : f.level + (lv - f.level) * (1 - Math.exp(-dt / (lv > f.level ? 0.04 : 0.15)));
    f.energy += (f.level - f.energy) * (1 - Math.exp(-dt / ENERGY_TAU));

    this.updateWaveform(peak, dt);

    // AGC reference: fast attack, slow release towards a floor (never amplifies noise to full scale)
    if (frameMax > this.agcRef) this.agcRef += (frameMax - this.agcRef) * (1 - Math.exp(-dt / AGC_ATTACK));
    else this.agcRef = Math.max(AGC_FLOOR, this.agcRef * Math.exp(-dt / (silent ? AGC_RELEASE_SILENT : AGC_RELEASE)));

    const g = silent ? 0 : 1 / this.agcRef;
    const atk = 1 - Math.exp(-dt / BAND_ATTACK), rel = 1 - Math.exp(-dt / (silent ? BAND_RELEASE_SILENT : BAND_RELEASE));
    let flux = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      let v = raw[b] * g;
      v = v >= 1 ? 1 : Math.pow(v, CONTRAST);
      const d = v - this.prevRaw[b];
      if (d > 0) flux += d;
      this.prevRaw[b] = v;
      raw[b] = v;
      const s = bands[b];
      const nb = s + (v > s ? atk : rel) * (v - s);
      bands[b] = silent && nb < 0.004 ? 0 : nb;
    }
    if (silent) {
      f.sub = f.bass = f.lowMid = f.mid = f.highMid = f.treble = 0;
    } else {
      f.sub = this.group(0); f.bass = this.group(1); f.lowMid = this.group(2);
      f.mid = this.group(3); f.highMid = this.group(4); f.treble = this.group(5);
    }

    // ---- onset (spectral flux) ---------------------------------------------------------------------------------------
    if (flux > this.fluxRef) this.fluxRef += (flux - this.fluxRef) * (1 - Math.exp(-dt / 0.1));
    else this.fluxRef = Math.max(2, this.fluxRef * Math.exp(-dt / 3));
    f.onset = Math.max(Math.min(1, flux / this.fluxRef), f.onset * Math.exp(-dt / 0.08));

    this.detectBeat(dt, silent);
  }

  /** 0.5·mean + 0.5·max of a band group (smoothed bands) */
  private group(g: number): number {
    const s = this.groupRange[g * 2], e = this.groupRange[g * 2 + 1];
    if (e <= s) return 0;
    const bands = this.f.bands;
    let sum = 0, max = 0;
    for (let b = s; b < e; b++) { const v = bands[b]; sum += v; if (v > max) max = v; }
    return 0.5 * sum / (e - s) + 0.5 * max;
  }

  /** Triggered (rising zero-crossing) 256-sample scope window with light AGC */
  private updateWaveform(peak: number, dt: number): void {
    const wave = this.f.wave, out = this.f.waveform;
    if (peak > this.waveRef) this.waveRef += (peak - this.waveRef) * (1 - Math.exp(-dt / 0.05));
    else this.waveRef = Math.max(0.12, this.waveRef * Math.exp(-dt / 3));
    const gain = Math.min(8, 0.95 / this.waveRef);
    const stride = (wave.length - 1024 > 0 ? 1024 : wave.length) / WAVE_COUNT; // 4
    let start = 0;
    const search = wave.length - 1024 - 4;
    for (let i = 1; i < search; i++) {
      if (wave[i - 1] < 0 && wave[i] >= 0) { start = i; break; }
    }
    for (let i = 0; i < WAVE_COUNT; i++) {
      const j = start + i * stride;
      let a = 0;
      for (let k = 0; k < stride; k++) a += wave[j + k];
      const v = a / stride * gain;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Beat tracking in three layers: (1) onset events on the rise of the 40–180 Hz amplitude (spectral-flux events as
   * a fallback for bass-less material), (2) tempo from an inter-beat-interval histogram, (3) once a tempo is known,
   * a beat grid that follows the phase carrying the most event energy. Events off the grid (e.g. off-beat bass
   * notes) are not reported as beats unless they are about as strong as the on-grid ones.
   */
  private detectBeat(dt: number, silent: boolean): void {
    const f = this.f;
    const now = this.clock;
    f.beat = false;
    f.beatEnv = f.beatEnv > 0.002 ? f.beatEnv * Math.exp(-dt / BEAT_ENV_TAU) : 0;

    // bass-band amplitude (40–180 Hz) straight from the analyser bytes, in the linear domain where a kick stands
    // out from sustained bass, normalised by its own slow peak reference and mildly compressed
    let pw = 0;
    for (let k = this.bassLo; k <= this.bassHi; k++) { const a = AMP[f.freq[k]]; pw += a * a; }
    const amp = Math.sqrt(pw / (this.bassHi - this.bassLo + 1));
    if (amp > this.bassRef) this.bassRef += (amp - this.bassRef) * (1 - Math.exp(-dt / 0.05));
    else this.bassRef = Math.max(BASS_REF_FLOOR, this.bassRef * Math.exp(-dt / 3));
    const x = Math.pow(amp / this.bassRef, RISE_POWER);
    if (this.warm === 0) this.xl = x;
    const h = x > this.xl ? x - this.xl : 0;
    this.xl += (x - this.xl) * (1 - Math.exp(-dt / RISE_TAU));
    this.warm += dt;
    const ready = !silent && this.warm > WARMUP;

    const be = this.bass.step(h, dt, now);
    const fe = this.fluxPulse.step(f.onset, dt, now);
    if (be === 1) {
      this.lastBassEvent = now;
      this.onEvent(now, Math.min(1, h / this.riseRef), ready, true);
    } else if (fe === 1 && now - this.lastBassEvent > FLUX_FALLBACK_AFTER) {
      this.onEvent(now, f.onset, ready, false);
    }
    if (be === 2) this.endEvent(this.bass.peak);

    // no beat for ~8 periods: forget the tempo
    if (f.bpm > 0 && now - this.lastBeat > Math.max(3, 8 * 60 / f.bpm)) this.resetTempo();

    f.beatPhase = 0;
    if (f.bpm > 0) {
      const p = (now - this.anchor) / (60 / f.bpm);
      f.beatPhase = p - Math.floor(p);
    }
  }

  private onEvent(t: number, rel: number, ready: boolean, isBass: boolean): void {
    const f = this.f;
    const period = f.bpm > 0 ? 60 / f.bpm : 0;
    let e = 0;
    if (period > 0) { const p = (t - this.anchor) / period; e = p - Math.round(p); }
    const on = Math.abs(e) <= GRID_TOL;
    if (isBass) { this.curOn = on; this.curE = e; this.curT = t; }
    if (!ready) return;
    if (t - this.lastReg >= REFRACTORY_MIN) { this.lastReg = t; this.registerBeat(t); } // tempo learning sees every event
    if (on) this.fire(t, rel);
  }

  private fire(t: number, rel: number): void {
    const f = this.f;
    const period = f.bpm > 0 ? 60 / f.bpm : 0;
    const refractory = period > 0 ? Math.min(REFRACTORY_MAX, Math.max(REFRACTORY_MIN, period * 0.45)) : REFRACTORY_MIN;
    if (t - this.lastBeat < refractory) return;
    f.beat = true;
    f.beatEnv = 1;
    f.beatStrength = Math.min(1, 0.35 + 0.65 * rel);
    f.beatCount++;
    this.lastBeat = t;
  }

  /** The rise event that started at `curT` is over: learn from its peak and keep the grid on the strongest phase */
  private endEvent(peak: number): void {
    const f = this.f;
    const i = this.evN % BEAT_HISTORY;
    this.evT[i] = this.curT; this.evP[i] = peak; this.evN++;
    this.riseRef = Math.max(0.1, this.riseRef + (peak - this.riseRef) * (peak > this.riseRef ? 0.5 : 0.08));
    const rel = Math.min(1, peak / this.riseRef);
    if (this.lastBeat === this.curT) f.beatStrength = Math.min(1, 0.3 + 0.7 * rel);
    if (f.bpm <= 0) return;

    if (this.curOn) {
      this.onAvg += (peak - this.onAvg) * 0.25;
      this.offStreak = 0;
    } else if (++this.offStreak >= OFF_STREAK_RESET) {
      this.resetTempo(); // the music does not fit the grid (wrong tempo, or the tempo changed)
      return;
    } else {
      // off-grid event: a beat anyway if it is as strong as the on-grid ones (syncopated kick), reported a few frames late
      const need = Math.abs(this.curE) > 0.4 ? HALF_BEAT_ACCEPT : OFF_GRID_ACCEPT;
      if (peak >= need * this.onAvg && this.warm > WARMUP) this.fire(this.curT, rel);
    }
    this.alignGrid(0.35);
  }

  /**
   * Move the beat grid towards the phase that carries the most recent event energy (peak², newest first): kicks win
   * over off-beat bass notes, and a phase jump of up to half a beat is followed within a few events.
   */
  private alignGrid(gain: number): void {
    const period = 60 / this.f.bpm;
    const n = Math.min(this.evN, BEAT_HISTORY);
    let sx = 0, sy = 0, age = 1;
    for (let k = 1; k <= n; k++, age *= 0.9) {
      const j = (this.evN - k) % BEAT_HISTORY;
      const w = age * this.evP[j] * this.evP[j];
      const a = TWO_PI * this.evT[j] / period;
      sx += w * Math.cos(a); sy += w * Math.sin(a);
    }
    if (sx === 0 && sy === 0) return;
    const target = Math.atan2(sy, sx) / TWO_PI;
    const cur = this.anchor / period;
    let d = target - (cur - Math.floor(cur));
    d -= Math.round(d);
    this.anchor += gain * d * period;
  }

  private lockGrid(t: number): void {
    this.anchor = t;
    this.alignGrid(1);
    this.onAvg = this.riseRef * 0.8;
    this.offStreak = 0;
  }

  /** Inter-beat-interval histogram (folded into 60–180 BPM) + least-squares refinement and hysteresis */
  private registerBeat(t: number): void {
    const times = this.beatTimes;
    const n = this.beatN;
    for (let k = 1; k <= 3 && k <= n; k++) {
      let ibi = t - times[(n - k) % BEAT_HISTORY];
      if (ibi < 0.15 || ibi > 6) continue;
      // fold into the tempo range with some slack, so jitter around 60 / 180 BPM does not flip the octave
      while (ibi < 60 / BPM_MAX - FOLD_EPS) ibi *= 2;
      while (ibi > 60 / BPM_MIN + FOLD_EPS) ibi /= 2;
      const pos = 60 / ibi - BPM_MIN;
      const w = k === 1 ? 1 : k === 2 ? 0.6 : 0.4;
      if (k === 1) for (let i = 0; i < HIST_BINS; i++) this.hist[i] *= 0.9;
      for (let i = Math.max(0, Math.floor(pos) - 2); i <= Math.min(HIST_BINS - 1, Math.floor(pos) + 3); i++) {
        const d = i - pos;
        this.hist[i] += w * Math.exp(-d * d / 1.28);
      }
    }
    times[n % BEAT_HISTORY] = t;
    this.beatN = n + 1;
    if (this.beatN < 4) return;

    // tempo candidate: densest ±4 BPM window of the histogram
    const hist = this.hist;
    let total = 0;
    for (let i = 0; i < HIST_BINS; i++) total += hist[i];
    let best = 0, bi = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      let w = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(HIST_BINS - 1, i + 4); j++) w += hist[j];
      if (w > best) { best = w; bi = i; }
    }
    if (best < 2.5 || best < 0.22 * total) return; // not confident yet
    let num = 0, den = 0;
    for (let j = Math.max(0, bi - 4); j <= Math.min(HIST_BINS - 1, bi + 4); j++) { num += j * hist[j]; den += hist[j]; }
    const cand = this.refine(BPM_MIN + num / den);

    const f = this.f;
    if (f.bpm === 0) { f.bpm = cand; this.pending = 0; this.lockGrid(t); return; }
    if (Math.abs(cand - f.bpm) < f.bpm * 0.025) { f.bpm += 0.25 * (cand - f.bpm); this.pending = 0; this.octaveSince = -1; return; }
    if (Math.abs(Math.abs(Math.log2(cand / f.bpm)) - 1) < 0.08) {
      // double / half of the current tempo: switch only when it clearly out-weighs the current one for a while
      this.pending = 0;
      const cur = Math.round(f.bpm) - BPM_MIN;
      let curW = 0;
      for (let j = Math.max(0, cur - 4); j <= Math.min(HIST_BINS - 1, cur + 4); j++) curW += hist[j];
      if (best < OCTAVE_MARGIN * curW) { this.octaveSince = -1; return; }
      if (this.octaveSince < 0) this.octaveSince = t;
      if (t - this.octaveSince >= OCTAVE_HOLD) { f.bpm = cand; this.octaveSince = -1; this.lockGrid(t); }
      return;
    }
    this.octaveSince = -1;
    // a different tempo must win several times in a row before the grid moves
    if (this.pending > 0 && Math.abs(cand - this.pendingBpm) < this.pendingBpm * 0.03) this.pending++;
    else { this.pending = 1; this.pendingBpm = cand; }
    if (this.pending >= 4) { f.bpm = cand; this.pending = 0; this.lockGrid(t); }
  }

  /** Least-squares fit of beat times on the nominal grid; returns the refined BPM (or the input if the grid is ragged) */
  private refine(bpm: number): number {
    const per = 60 / bpm;
    const m = Math.min(this.beatN, BEAT_HISTORY);
    const t0 = this.beatTimes[(this.beatN - m) % BEAT_HISTORY];
    let sn = 0, st = 0, snn = 0, snt = 0, last = -1, cnt = 0;
    for (let i = 0; i < m; i++) {
      const t = this.beatTimes[(this.beatN - m + i) % BEAT_HISTORY] - t0;
      const idx = Math.round(t / per);
      if (Math.abs(t - idx * per) > 0.2 * per || idx <= last) continue; // skip off-grid / duplicate indices
      last = idx; cnt++; sn += idx; st += t; snn += idx * idx; snt += idx * t;
    }
    const den = cnt * snn - sn * sn;
    if (cnt < 5 || den <= 0) return bpm;
    const slope = (cnt * snt - sn * st) / den;
    const refined = 60 / slope;
    return Math.abs(refined - bpm) < bpm * 0.04 ? refined : bpm;
  }
}

/** Adaptive-threshold event detector on a non-negative signal: threshold = running mean + max(K·σ, minDelta) */
class Pulse {
  peak = 0;
  private mean = 0;
  private vari = 0;
  private active = false;
  private start = 0;
  private startThr = 0;

  constructor(private k: number, private minDelta: number, private tau: number) {}

  reset(): void { this.mean = this.vari = this.peak = 0; this.active = false; }

  /** @returns 1 on the frame an event starts, 2 on the frame it ends, 0 otherwise */
  step(v: number, dt: number, now: number): 0 | 1 | 2 {
    const thr = this.mean + Math.max(this.k * Math.sqrt(this.vari), this.minDelta);
    let r: 0 | 1 | 2 = 0;
    if (this.active) {
      if (v > this.peak) this.peak = v;
      if (v < 0.5 * this.startThr || now - this.start > 0.3) { this.active = false; r = 2; }
    } else if (v > thr) {
      this.active = true; this.peak = v; this.start = now; this.startThr = thr; r = 1;
    }
    const a = 1 - Math.exp(-dt / this.tau);
    const d = v - this.mean;
    this.mean += a * d;
    this.vari += a * (d * d - this.vari);
    return r;
  }
}
