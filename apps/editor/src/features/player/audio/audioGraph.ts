/**
 * Web Audio graph for the v1 engine (docs/rendering-semantics.md §8).
 *
 *   <video>/<audio> element -> MediaElementAudioSourceNode -> clip GainNode
 *     -> master GainNode -> destination
 *
 * - The AudioContext is created lazily on the first play() (autoplay policy: needs a
 *   user gesture) at the project's settings.audioSampleRate (44100 | 48000, §8.5), set via
 *   setSampleRate() before the context exists. Export is fixed 48 kHz regardless (§8.5).
 * - createMediaElementSource() can only ever be called ONCE per element, so
 *   the source node is created when a pool element is first attached and lives
 *   as long as the element.
 * - Fades/volume envelopes are scheduled with setValueCurveAtTime (linear
 *   interpolation — §8.2 linear fade contract); scrub/pause sets values
 *   directly.
 * - NO DynamicsCompressorNode at the end of the chain (§8.3): the limiter is
 *   export-only; audible clipping in preview is a correct signal to the user.
 */

interface ElementNodes {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes = new Map<HTMLMediaElement, ElementNodes>();
  private pendingElements = new Set<HTMLMediaElement>();
  private sampleRate: 44100 | 48000 = 48000;

  setSampleRate(rate: 44100 | 48000): void {
    // Only effective before the context exists (context sampleRate is fixed).
    this.sampleRate = rate;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Current context time in seconds, or null before the context exists. */
  nowSec(): number | null {
    return this.ctx ? this.ctx.currentTime : null;
  }

  /**
   * Register a media element with the graph. Safe to call before the context
   * exists — attachment is deferred until ensureContext().
   */
  attachElement(el: HTMLMediaElement): void {
    if (this.nodes.has(el) || this.pendingElements.has(el)) return;
    if (this.ctx) {
      this.connectElement(el);
    } else {
      this.pendingElements.add(el);
    }
  }

  private connectElement(el: HTMLMediaElement): void {
    if (!this.ctx || !this.master || this.nodes.has(el)) return;
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0; // silent until an envelope/level is applied
    source.connect(gain);
    gain.connect(this.master);
    this.nodes.set(el, { source, gain });
  }

  /**
   * Create/resume the AudioContext. Must be called from a user-gesture path
   * (the play button). Returns the context.
   */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      for (const el of this.pendingElements) this.connectElement(el);
      this.pendingElements.clear();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  /** Immediate gain (scrub/pause/mute). Cancels any scheduled envelope. */
  setElementGain(el: HTMLMediaElement, value: number): void {
    const nodes = this.nodes.get(el);
    if (!nodes || !this.ctx) return;
    const param = nodes.gain.gain;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setValueAtTime(Math.max(0, value), this.ctx.currentTime);
  }

  /**
   * Schedule a sampled gain envelope starting now over durationSec
   * (setValueCurveAtTime; curve built by core/gain.ts buildGainCurve).
   * After the curve ends the param holds its last value.
   */
  setElementGainCurve(el: HTMLMediaElement, curve: Float32Array, durationSec: number): void {
    const nodes = this.nodes.get(el);
    if (!nodes || !this.ctx || durationSec <= 0 || curve.length < 2) return;
    const param = nodes.gain.gain;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    try {
      param.setValueCurveAtTime(curve, now, durationSec);
    } catch {
      // Overlapping automation (rapid rescheduling race) — fall back to the
      // first sample; the next tick reschedules.
      param.setValueAtTime(curve[0] ?? 0, now);
    }
  }

  /** Cancel scheduled automation and hold the given value (default silent). */
  cancelElement(el: HTMLMediaElement, holdValue = 0): void {
    this.setElementGain(el, holdValue);
  }

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      await this.ctx.suspend();
    }
  }

  dispose(): void {
    for (const [, nodes] of this.nodes) {
      try {
        nodes.source.disconnect();
        nodes.gain.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.nodes.clear();
    this.pendingElements.clear();
    if (this.ctx) {
      // close() reddi yutulur: zaten kapalı/kapanan context'in söküm hatasında yapılacak şey yok
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.master = null;
    }
  }
}
