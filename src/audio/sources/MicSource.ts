/** Microphone → analyser only. The mic is never connected to the destination (no feedback). */
export class MicSource {
  private stream: MediaStream | null = null;
  private node: MediaStreamAudioSourceNode | null = null;

  /** @param onEnded called when the browser/OS ends the capture (permission revoked, device removed) */
  constructor(private onEnded: () => void) {}

  get isOpen(): boolean { return this.stream !== null; }

  async open(ctx: AudioContext, target: AudioNode): Promise<void> {
    if (this.stream) return;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      throw new Error(window.isSecureContext
        ? 'This browser has no microphone access.'
        : 'Microphone access needs HTTPS (or localhost).');
    }
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      const err = e as DOMException;
      if (err.name === 'OverconstrainedError' || err.name === 'TypeError') {
        stream = await md.getUserMedia({ audio: true }).catch((e2) => { throw describe(e2); });
      } else {
        throw describe(e);
      }
    }
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(target);
    for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => { if (this.stream === stream) { this.close(); this.onEnded(); } });
  }

  close(): void {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function describe(e: unknown): Error {
  const name = (e as DOMException | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error('Microphone permission was denied. Allow microphone access for this site in the browser settings, then try again.');
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
