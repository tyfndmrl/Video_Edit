import { METER_FFT_SIZE } from '../core/meter';

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

/** Peak and RMS of one analyser window, linear amplitude. */
function measureWindow(buf: Float32Array<ArrayBuffer>): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, buf.length)) };
}

/**
 * One sampled window of the master bus, linear amplitude (1.0 = 0 dBFS).
 * `peak` MAY exceed 1.0: preview deliberately has no limiter (§8.3), and a
 * reading that clipped at 1.0 would hide exactly the overshoot the meter
 * exists to show.
 */
export interface MeterTapReading {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  /** Window length actually read — the meter reports what it measured. */
  windowSamples: number;
}

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes = new Map<HTMLMediaElement, ElementNodes>();
  private pendingElements = new Set<HTMLMediaElement>();
  private sampleRate: 44100 | 48000 = 48000;
  // Meter tap (LEAF — see ensureContext). Never on the audible path.
  private meterTap: GainNode | null = null;
  private meterSplitter: ChannelSplitterNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterBufL: Float32Array<ArrayBuffer> | null = null;
  private meterBufR: Float32Array<ArrayBuffer> | null = null;

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
      this.buildMeterTap(this.ctx, this.master);
      for (const el of this.pendingElements) this.connectElement(el);
      this.pendingElements.clear();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Meter tap: a LEAF branch off the master bus, never a link in it.
   *
   *   master -> destination                (audible path, UNCHANGED)
   *     \--> meterTap -> splitter -> analyserL / analyserR   (outputs unconnected)
   *
   * §8.3 allows no extra node at the END of the preview chain; a fan-out does
   * not change what `destination` receives (audio-parity stays the proof).
   * The tap is an explicit STEREO gain because `master` inherits its channel
   * count from its inputs ('max'), so a lone mono clip would otherwise leave
   * the splitter's right output silent — upmixing here matches §8.5 ("mono
   * sources are upmixed to stereo").
   */
  private buildMeterTap(ctx: AudioContext, master: GainNode): void {
    const tap = ctx.createGain();
    tap.gain.value = 1;
    tap.channelCount = 2;
    tap.channelCountMode = 'explicit';
    tap.channelInterpretation = 'speakers';
    const splitter = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    for (const a of [left, right]) {
      a.fftSize = METER_FFT_SIZE;
      // Time-domain reads are unaffected by smoothing; set to 0 so nobody
      // reading this file assumes the peaks arrive pre-averaged.
      a.smoothingTimeConstant = 0;
    }
    master.connect(tap);
    tap.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    this.meterTap = tap;
    this.meterSplitter = splitter;
    this.analyserL = left;
    this.analyserR = right;
    this.meterBufL = new Float32Array(left.fftSize);
    this.meterBufR = new Float32Array(right.fftSize);
  }

  /**
   * Sample the master bus, or null when there is nothing to measure: no
   * context yet (first play not pressed), a context that is not running, or a
   * torn-down tap. Returning zeros in those cases would report "silent mix"
   * for what is really "no mix" — and a frozen meter reads as a lying one.
   */
  readMeter(): MeterTapReading | null {
    const ctx = this.ctx;
    const left = this.analyserL;
    const right = this.analyserR;
    const bufL = this.meterBufL;
    const bufR = this.meterBufR;
    if (!ctx || ctx.state !== 'running' || !left || !right || !bufL || !bufR) return null;
    left.getFloatTimeDomainData(bufL);
    right.getFloatTimeDomainData(bufR);
    const l = measureWindow(bufL);
    const r = measureWindow(bufR);
    return { peakL: l.peak, peakR: r.peak, rmsL: l.rms, rmsR: r.rms, windowSamples: bufL.length };
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
    for (const node of [this.analyserL, this.analyserR, this.meterSplitter, this.meterTap]) {
      try {
        node?.disconnect();
      } catch {
        // already disconnected — the context is going away regardless
      }
    }
    this.meterTap = null;
    this.meterSplitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.meterBufL = null;
    this.meterBufR = null;
    if (this.ctx) {
      // close() reddi yutulur: zaten kapalı/kapanan context'in söküm hatasında yapılacak şey yok
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.master = null;
    }
  }
}
