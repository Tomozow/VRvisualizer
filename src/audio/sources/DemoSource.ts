/**
 * Synthetic "track" built from Web Audio nodes: 4/4 kick at 124 BPM with sidechain pump, off-beat bass following a
 * chord progression, hats / clap from filtered noise, a detuned-saw pad whose lowpass opens and closes over a
 * 16-bar cycle, and an arpeggio with delay in the second half. Scheduled with a look-ahead timer.
 */

const BPM = 124;
const STEP = 60 / BPM / 4;     // one 16th note in seconds
const LOOKAHEAD = 0.25;        // s scheduled ahead
const CYCLE_BARS = 16;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Chord { bass: number; pad: number[] }
// 8 chords × 2 bars = one 16-bar cycle: Am F C G | Am F Dm E
const CHORDS: Chord[] = [
  { bass: 33, pad: [57, 60, 64] }, { bass: 29, pad: [57, 60, 65] },
  { bass: 36, pad: [55, 60, 64] }, { bass: 31, pad: [55, 59, 62] },
  { bass: 33, pad: [57, 60, 64] }, { bass: 29, pad: [57, 60, 65] },
  { bass: 38, pad: [57, 62, 65] }, { bass: 28, pad: [56, 59, 64] },
];
const ARP_STEPS = new Set([0, 3, 6, 10, 12, 14]);

class Graph {
  readonly out: GainNode;
  readonly drums: GainNode;
  readonly duck: GainNode;
  readonly padFilter: BiquadFilterNode;
  readonly padOscs: OscillatorNode[] = [];
  readonly padBase: number[] = [];
  readonly delayIn: GainNode;
  private noise: AudioBuffer;
  private seed = 12345;
  private nodes: AudioNode[] = [];

  constructor(readonly ctx: AudioContext, dest: AudioNode) {
    const mk = <T extends AudioNode>(n: T): T => { this.nodes.push(n); return n; };
    this.out = mk(ctx.createGain());
    this.out.gain.value = 0.9;
    const comp = mk(ctx.createDynamicsCompressor());
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.15;
    comp.connect(this.out);
    this.out.connect(dest);
    this.drums = mk(ctx.createGain());
    this.drums.connect(comp);
    this.duck = mk(ctx.createGain());
    this.duck.connect(comp);

    // pad: 3 chord tones × 2 detuned saws → lowpass → duck
    this.padFilter = mk(ctx.createBiquadFilter());
    this.padFilter.type = 'lowpass'; this.padFilter.Q.value = 5; this.padFilter.frequency.value = 250;
    const padGain = mk(ctx.createGain());
    padGain.gain.value = 0.1;
    this.padFilter.connect(padGain).connect(this.duck);
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = i % 2 ? 9 : -9;
      o.frequency.value = mtof(CHORDS[0].pad[i >> 1]);
      o.connect(this.padFilter);
      o.start();
      this.padOscs.push(o);
    }

    // feedback delay (dotted 8th) for the arpeggio
    this.delayIn = mk(ctx.createGain());
    this.delayIn.gain.value = 0.45;
    const delay = mk(ctx.createDelay(1));
    delay.delayTime.value = STEP * 3;
    const fb = mk(ctx.createGain());
    fb.gain.value = 0.38;
    const tone = mk(ctx.createBiquadFilter());
    tone.type = 'lowpass'; tone.frequency.value = 2800;
    this.delayIn.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(tone); tone.connect(this.duck);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; d[i] = this.seed / 2147483648 - 1; }
  }

  private env(g: AudioParam, t: number, peak: number, attack: number, decay: number): void {
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private burst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g.gain, t, gain, 0.002, dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t, (this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0) / 4294967296 * 1.5);
    src.stop(t + dur + 0.02);
  }

  kick(t: number): void {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    this.env(g.gain, t, 1, 0.004, 0.38);
    o.connect(g); g.connect(this.drums);
    o.start(t); o.stop(t + 0.45);
    this.burst(t, 0.012, 'highpass', 2500, 0.7, 0.22, this.drums);
    // sidechain pump
    this.duck.gain.setValueAtTime(0.3, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.3);
  }

  hat(t: number, open: boolean, vel: number): void {
    this.burst(t, open ? 0.2 : 0.04, 'highpass', open ? 6000 : 7500, 0.7, vel * (open ? 0.16 : 0.2), this.drums);
  }

  clap(t: number, vel: number): void {
    for (let i = 0; i < 3; i++) this.burst(t + i * 0.011, 0.015, 'bandpass', 1500, 1.2, 0.3 * vel, this.drums);
    this.burst(t + 0.033, 0.14, 'bandpass', 1300, 0.9, 0.22 * vel, this.drums);
  }

  bass(t: number, midi: number, dur: number): void {
    const f = mtof(midi);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.Q.value = 6;
    filt.frequency.setValueAtTime(1000, t);
    filt.frequency.exponentialRampToValueAtTime(160, t + 0.18);
    const g = this.ctx.createGain();
    this.env(g.gain, t, 0.5, 0.006, dur);
    const saw = this.ctx.createOscillator(), sub = this.ctx.createOscillator();
    saw.type = 'sawtooth'; saw.frequency.value = f;
    sub.type = 'sine'; sub.frequency.value = f;
    saw.connect(filt); sub.connect(filt); filt.connect(g); g.connect(this.duck);
    for (const o of [saw, sub]) { o.start(t); o.stop(t + dur + 0.05); }
  }

  pluck(t: number, midi: number): void {
    const o = this.ctx.createOscillator(), filt = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = mtof(midi);
    filt.type = 'lowpass'; filt.Q.value = 2;
    filt.frequency.setValueAtTime(3200, t);
    filt.frequency.exponentialRampToValueAtTime(500, t + 0.15);
    this.env(g.gain, t, 0.07, 0.003, 0.2);
    o.connect(filt); filt.connect(g); g.connect(this.duck); g.connect(this.delayIn);
    o.start(t); o.stop(t + 0.25);
  }

  setChord(chord: Chord, t: number): void {
    this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(mtof(chord.pad[i >> 1]), t, 0.1));
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.015);
    window.setTimeout(() => {
      this.padOscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } o.disconnect(); });
      this.nodes.forEach((n) => n.disconnect());
    }, 200);
  }
}

export class DemoSource {
  private g: Graph | null = null;
  private timer = 0;
  private step = 0;
  private nextTime = 0;
  private arpHit = 0;

  constructor(private ctx: AudioContext, private dest: AudioNode) {}

  get running(): boolean { return this.g !== null; }

  /** Seconds of music played so far (continues across pause/resume) */
  get position(): number {
    const ahead = this.g ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0;
    return Math.max(0, this.step * STEP - ahead);
  }

  start(): void {
    if (this.g) return;
    this.g = new Graph(this.ctx, this.dest);
    this.nextTime = this.ctx.currentTime + 0.08;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  pause(): void {
    clearInterval(this.timer);
    this.g?.dispose();
    this.g = null;
  }

  stop(): void {
    this.pause();
    this.step = 0;
    this.arpHit = 0;
  }

  private tick(): void {
    const g = this.g;
    if (!g) return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.05) { // main thread stalled: skip the steps we missed, stay on the grid
      const missed = Math.ceil((now - this.nextTime) / STEP);
      this.step += missed;
      this.nextTime += missed * STEP;
    }
    while (this.nextTime < now + LOOKAHEAD) {
      this.schedule(g, this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
    // pad filter breathes over the 16-bar cycle (closed → open → closed)
    const pos = (this.step / 16 / CYCLE_BARS) % 1;
    const open = 0.5 - 0.5 * Math.cos(pos * 2 * Math.PI);
    g.padFilter.frequency.setTargetAtTime(220 * Math.pow(2, 3.9 * open), now, 0.25);
  }

  private schedule(g: Graph, step: number, t: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16) % CYCLE_BARS;
    const chord = CHORDS[bar >> 1];
    if (s === 0 && bar % 2 === 0) g.setChord(chord, t);

    if (s % 4 === 0) g.kick(t);
    if (bar >= 2 && bar < 15 || bar === 15 && s < 8) {
      if (s === 2 || s === 6 || s === 10 || s === 14) g.bass(t, chord.bass, 0.2);
      else if (s === 7 && bar % 4 === 3) g.bass(t, chord.bass + 12, 0.1);
      else if (s === 11 && bar % 4 === 3) g.bass(t, chord.bass + 7, 0.1);
    }
    if (bar >= 2) {
      if (bar >= 4 && (s === 6 || s === 14)) g.hat(t, true, 1);
      else if (s % 4 === 2) g.hat(t, false, 0.8);
      else if (bar >= 6 && s % 2 === 1) g.hat(t, false, 0.3);
    }
    if (bar >= 4 && (s === 4 || s === 12)) g.clap(t, 1);
    if (bar === 15 && s >= 8 && (s % 2 === 0 || s >= 13)) g.clap(t, 0.4 + (s - 8) * 0.07); // build-up into the next cycle
    if (bar >= 8 && ARP_STEPS.has(s)) {
      const p = chord.pad;
      const notes = [p[0] + 12, p[1] + 12, p[2] + 12, p[1] + 24];
      g.pluck(t, notes[this.arpHit++ % 4]);
    }
  }
}
