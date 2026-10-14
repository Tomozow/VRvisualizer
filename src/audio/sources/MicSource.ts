/** Microphone → analyser only. The mic is never connected to the destination (no feedback). */
export class MicSource {
  private stream: MediaStream | null = null;
  private node: MediaStreamAudioSourceNode | null = null;
  /** The getUserMedia request in flight; overlapping open() calls share it instead of starting a second capture */
  private opening: Promise<void> | null = null;
  /** Bumped by close(): a request that started before the bump is cancelled and releases its stream when it resolves */
  private generation = 0;

  /** @param onEnded called when the browser/OS ends the capture (permission revoked, device removed) */
  constructor(private onEnded: () => void) {}

  get isOpen(): boolean { return this.stream !== null; }

  /** True while a permission prompt / device start-up is pending */
  get isOpening(): boolean { return this.opening !== null; }

  /**
   * Resolves once the microphone is open. Rejects with an Error named 'AbortError' (see `isAbortError`) when
   * close() was called while the request was pending: the capture that arrives afterwards is stopped immediately.
   */
  open(ctx: AudioContext, target: AudioNode): Promise<void> {
    if (this.stream) return Promise.resolve();
    if (!this.opening) {
      const p: Promise<void> = this.doOpen(ctx, target).finally(() => { if (this.opening === p) this.opening = null; });
      this.opening = p;
    }
    return this.opening;
  }

  private async doOpen(ctx: AudioContext, target: AudioNode): Promise<void> {
    const generation = this.generation;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      throw new Error(window.isSecureContext
        ? 'This browser has no microphone access.'
        : 'Microphone access needs HTTPS (or localhost).');
    }
    let stream: MediaStream;
    try {
      try {
        stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) {
        const err = e as DOMException;
        if (generation === this.generation && (err.name === 'OverconstrainedError' || err.name === 'TypeError')) {
          stream = await md.getUserMedia({ audio: true }).catch((e2) => { throw describe(e2); });
        } else {
          throw describe(e);
        }
      }
    } catch (e) {
      // nobody wants the result any more: a permission error is not worth reporting
      throw generation === this.generation ? e : abortError();
    }
    if (generation !== this.generation) { // close() ran while the permission prompt was open
      stopTracks(stream);
      throw abortError();
    }
    if (this.stream) { // already open (a request that was started after a close() won the race)
      stopTracks(stream);
      return;
    }
    let node: MediaStreamAudioSourceNode;
    try {
      node = ctx.createMediaStreamSource(stream);
    } catch (e) {
      stopTracks(stream);
      throw e;
    }
    node.connect(target);
    this.stream = stream;
    this.node = node;
    for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => { if (this.stream === stream) { this.close(); this.onEnded(); } });
  }

  close(): void {
    this.generation++; // cancels a pending open()
    this.opening = null;
    this.node?.disconnect();
    this.node = null;
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
  }
}

/** True for the error open() rejects with when it was cancelled by close() */
export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === 'AbortError';
}

/** DOMException-like error (name 'AbortError') for a request that was cancelled before it completed */
export function abortError(): Error {
  const e = new Error('The microphone request was cancelled.');
  e.name = 'AbortError';
  return e;
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

function describe(e: unknown): Error {
  const name = (e as DOMException | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error('Microphone blocked. Allow it in the browser\'s site settings, then try again.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error('No microphone was found.');
    case 'NotReadableError':
    case 'AbortError':
      return new Error('The microphone is busy or unavailable (another app may be using it).');
    default:
      return new Error('Could not open the microphone' + (name ? ` (${name})` : '') + '.');
  }
}
