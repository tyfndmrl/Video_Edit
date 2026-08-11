/**
 * Playback engine v1 — hidden <video> pool + WebGL2 compositor
 * (design doc 01-frontend-editor.md §4.2).
 *
 * Responsibilities:
 * - master clock: AudioContext.currentTime-based monotonic time while playing
 *   (performance.now fallback before the context exists)
 * - per-rAF composition: active video frames -> texImage2D -> compositor
 * - <video> pool scheduling (active clips + ~1 s preload double-buffer)
 * - A/V sync: >50 ms drift -> hard re-seek; small drift -> playbackRate ±2%
 * - frame-accurate paused seeks verified via requestVideoFrameCallback
 * - Web Audio gain envelopes (volume + linear fades + 5 ms micro-fades)
 */
import type {
  MediaClip,
  MicroSec,
  ShapeClip,
  StickerClip,
  TextClip,
  TimelineDoc,
  Track,
  Uuid,
} from '@videoedit/timeline-schema';
import { isMediaClip } from '@videoedit/timeline-schema';
import { shapeBoxPx } from '../../text/overlayGeometry';
import {
  rasterizeShape,
  rasterizeText,
  shapeRasterKey,
  textRasterKey,
} from '../../text/overlayRaster';
import type {
  AssetResolver,
  PlaybackEngine,
  PreviewStatus,
  SeekOptions,
  SourceSize,
  Subject,
} from '../engine';
import { createSubject } from '../engine';
import { setIsPlayingSafe } from '../editorBridge';
import { forceRefreshMediaUrls } from '../mediaUrls';
import { Compositor, type DrawItem } from '../compositor/compositor';
import {
  type ActiveClip,
  clipAudioOf,
  colorAdjustOf,
  effectiveOpacity,
  effectiveTransform,
  isClipMuted,
  projectDurationUs,
  resolveAudible,
  resolveVisualStack,
  sourceTimeUs,
} from '../core/resolve';
import {
  computeSlotRequests,
  countPreviewLayers,
  planPool,
  POOL_SIZE,
  samePreviewCapacity,
  type PoolAssignment,
} from '../core/scheduler';
import { buildGainCurve, shouldMicroFadeIn, shouldMicroFadeOut } from '../core/gain';
import { AudioGraph } from '../audio/audioGraph';
import { VideoPool, type PoolSlot } from './videoPool';
import { useDocStore } from '../../../state/docStore';

/** <video>.playbackRate portable range (design §4.2 known limits). */
const MIN_ELEMENT_RATE = 0.0625;
const MAX_ELEMENT_RATE = 16;
/** Drift beyond this -> hard currentTime re-seek (design §4.2: 50 ms). */
const HARD_RESYNC_US = 50_000;
/** Drift beyond this (but under HARD) -> ±2% playbackRate nudge. */
const NUDGE_US = 15_000;
/** Scrub seek throttle (last request wins). */
const SCRUB_THROTTLE_MS = 80;
/** Gain envelope sampling density (samples per second of context time). */
const GAIN_SAMPLES_PER_SEC = 100;
/**
 * Autoplay-policy watchdog: if the AudioContext cannot start within this
 * window after play(), the attempt is rolled back honestly ('blocked') instead
 * of pretending to play with a dead clock/audio.
 */
const AUTOPLAY_BLOCK_TIMEOUT_MS = 300;
/** Min interval between media-error-driven forceRefreshMediaUrls() calls. */
const MEDIA_ERROR_REFRESH_MIN_MS = 10_000;
/**
 * Min interval between retries of a FAILED image decode. renderFrame runs every
 * rAF, so without this an expired image URL would fire ~60 requests per second.
 * Mirrors videoPool's per-slot MEDIA_ERROR_RETRY_MIN_MS.
 */
const IMAGE_ERROR_RETRY_MIN_MS = 5_000;

interface LoadedModel {
  doc: TimelineDoc;
  resolver: AssetResolver;
  durationUs: MicroSec;
}

interface ImageEntry {
  texture: WebGLTexture;
  width: number;
  height: number;
  ready: boolean;
  /** URL this entry was loaded from — a refreshed presign retries immediately. */
  url: string;
  /** Timestamp of the last decode failure (0 = none) — retry throttle. */
  failedAt: number;
}

/**
 * A rasterized text/shape overlay (rendering-semantics §7). Keyed by CLIP id
 * because the style lives on the clip, and re-rasterized whenever `key` (a hash
 * of that style) changes — i.e. on every inspector edit, not every frame.
 */
interface OverlayEntry {
  texture: WebGLTexture;
  /** Style signature; a mismatch is what triggers a re-raster. */
  key: string;
  /** Raster size in px (the texture's own size). */
  width: number;
  height: number;
  /** §7 bbox in project px -> what the gizmo box measures. */
  bboxWidthPx: number;
  bboxHeightPx: number;
  /** Source px -> composition px at scale=1 (see PlacementInput.baseScale). */
  baseScale: number;
}

function clampElementRate(rate: number): number {
  return Math.min(MAX_ELEMENT_RATE, Math.max(MIN_ELEMENT_RATE, rate));
}

export class VideoPlaybackEngine implements PlaybackEngine {
  readonly clock$: Subject<MicroSec> = createSubject<MicroSec>();
  readonly playState$: Subject<boolean> = createSubject<boolean>();
  /** True after an autoplay-blocked rollback; cleared on the next play(). */
  readonly blocked$: Subject<boolean> = createSubject<boolean>();
  /** Visual layers active vs composited — emits ONLY when the pair changes. */
  readonly previewStatus$: Subject<PreviewStatus> = createSubject<PreviewStatus>();

  private model: LoadedModel | null = null;
  private compositor: Compositor;
  private pool: VideoPool;
  private audio = new AudioGraph();

  private playing = false;
  private rate = 1;
  /**
   * Monotonic seek generation (PlaybackEngine seek contract). Bumped by every
   * seek/scrub/play; async precise-seek continuations compare against it after
   * EVERY await and abort silently when stale — a delayed precise seek must
   * never move state, elements, or emit anything after a newer seek landed.
   */
  private seekSeq = 0;
  /** Monotonic play-attempt id — stale autoplay watchdog completions abort. */
  private playAttempt = 0;
  private blocked = false;
  /** Set on pool media error; the next tick re-applies the pool assignment. */
  private mediaErrorRetryPending = false;
  private lastMediaErrorRefreshAt = 0;
  private positionUs: MicroSec = 0;
  /** Clock anchor: positionUs at anchorSec on the reference clock. */
  private anchorUs: MicroSec = 0;
  private anchorSec = 0;

  private raf = 0;
  private disposed = false;

  private assignments: PoolAssignment[] = [];
  private slotTextures = new Map<number, WebGLTexture>();
  /** Last uploaded video time per slot — skips redundant uploads while paused. */
  private slotUploadedAt = new Map<number, number>();
  private imageTextures = new Map<Uuid, ImageEntry>();
  /** Text/shape rasters, keyed by clip id (see OverlayEntry). */
  private overlayTextures = new Map<Uuid, OverlayEntry>();
  /** Last emitted previewStatus$ value — the change filter for the note. */
  private previewStatus: PreviewStatus = {
    totalLayers: 0,
    shownLayers: 0,
    totalAudio: 0,
    shownAudio: 0,
    dropped: [],
  };

  /** Clip ids with a scheduled audio envelope (rebuilt on play/seek/cuts). */
  private scheduledAudio = new Set<Uuid>();

  private scrubPendingUs: MicroSec | null = null;
  private scrubTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    this.pool = new VideoPool(
      POOL_SIZE,
      (el) => this.audio.attachElement(el),
      () => this.handleMediaError(),
    );
    const loop = () => {
      if (this.disposed) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // PlaybackEngine API
  // -------------------------------------------------------------------------

  load(doc: TimelineDoc, assets: AssetResolver): void {
    if (this.disposed) return;
    this.model = { doc, resolver: assets, durationUs: projectDurationUs(doc) };
    this.audio.setSampleRate(doc.settings.audioSampleRate);
    this.compositor.resize(doc.settings.width, doc.settings.height);
    this.positionUs = Math.min(this.positionUs, this.model.durationUs);
    if (this.playing) this.reanchor(this.positionUs);
    this.refreshPool(this.positionUs);
    // Doc edits invalidate scheduled envelopes (volumes/fades may have changed).
    this.scheduledAudio.clear();
    this.pruneOverlayTextures(doc);
  }

  /**
   * Frees rasters of overlay clips that left the document (deleted, undone,
   * project switched). Style CHANGES are handled by the key check in
   * overlayDrawItem; this only stops the map from growing forever.
   */
  private pruneOverlayTextures(doc: TimelineDoc): void {
    if (this.overlayTextures.size === 0) return;
    const alive = new Set<Uuid>();
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'text' || clip.kind === 'shape') alive.add(clip.id);
      }
    }
    for (const [clipId, entry] of this.overlayTextures) {
      if (alive.has(clipId)) continue;
      this.compositor.deleteTexture(entry.texture);
      this.overlayTextures.delete(clipId);
    }
  }

  play(): void {
    if (this.disposed || this.playing || !this.model) return;
    if (this.model.durationUs <= 0) return;
    if (this.positionUs >= this.model.durationUs) this.positionUs = 0; // replay from start
    this.playing = true;
    this.seekSeq++; // playback takes over — stale precise-seek continuations abort
    this.scheduledAudio.clear();
    if (this.blocked) {
      this.blocked = false;
      this.blocked$.emit(false);
    }
    // User gesture path: create/resume the AudioContext, then anchor the clock
    // on it. Playback starts immediately on the fallback clock meanwhile. If
    // the context cannot start (autoplay policy: no real gesture), roll back
    // honestly instead of pretending to play (blocked state).
    void this.startAudioContext(++this.playAttempt);
    this.reanchor(this.positionUs);
    this.syncElements(true);
    this.playState$.emit(true);
    setIsPlayingSafe(true);
  }

  /**
   * Resume/create the AudioContext with a watchdog. On success the clock is
   * re-anchored onto the context time; on timeout (autoplay blocked) the play
   * attempt is rolled back and blocked$ fires so the UI can show a
   * "click to play" hint and retry on the next real user gesture.
   */
  private async startAudioContext(attempt: number): Promise<void> {
    const resumed = await Promise.race([
      this.audio.ensureContext().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), AUTOPLAY_BLOCK_TIMEOUT_MS);
      }),
    ]);
    // Stale guard: a newer play()/pause() owns the state now.
    if (this.disposed || attempt !== this.playAttempt || !this.playing) return;
    if (resumed) {
      // Context clock takes over from the performance.now fallback.
      this.reanchor(this.currentClockUs());
      // Envelopes registered before the context existed were no-ops —
      // reschedule them on the real graph.
      this.scheduledAudio.clear();
      return;
    }
    // Autoplay-blocked: honest rollback. Position returns to the anchor (the
    // wall-clock "progress" without a running context never really played).
    this.playing = false;
    this.positionUs = this.anchorUs;
    this.pool.pauseAll();
    for (const slot of this.pool.slots) this.audio.cancelElement(slot.video);
    this.scheduledAudio.clear();
    this.blocked = true;
    this.playState$.emit(false);
    setIsPlayingSafe(false);
    this.blocked$.emit(true);
  }

  pause(): void {
    if (this.disposed || !this.playing) return;
    this.positionUs = this.currentClockUs();
    this.playing = false;
    this.pool.pauseAll();
    for (const slot of this.pool.slots) this.audio.cancelElement(slot.video);
    this.scheduledAudio.clear();
    this.playState$.emit(false);
    setIsPlayingSafe(false);
  }

  async seek(timeUs: MicroSec, opts?: SeekOptions): Promise<void> {
    if (this.disposed || !this.model) return;
    // Clamp against the LIVE document duration, not the (100 ms debounced)
    // loaded model — a seek right after an edit must not be capped/allowed by
    // a stale duration.
    const target = Math.max(0, Math.min(Math.round(timeUs), this.liveDurationUs()));
    const seq = ++this.seekSeq;
    if (opts?.precise) {
      this.cancelScrubTimer();
      this.applySeek(target);
      if (!this.playing) {
        await this.preciseSeekActiveVideos(target, seq);
        // Stale guard: a newer seek/play arrived while we awaited — this
        // continuation must not touch anything anymore.
        if (this.disposed || seq !== this.seekSeq || this.playing) return;
        this.renderFrame(target);
      }
      // CONTRACT: no clock$ emit — seeks never echo; the store is authoritative.
      return;
    }
    // Fast scrub: throttled, last request wins.
    this.scrubPendingUs = target;
    if (this.scrubTimer === null) {
      this.applyScrub();
      this.scrubTimer = setTimeout(() => {
        this.scrubTimer = null;
        if (this.scrubPendingUs !== null && this.scrubPendingUs !== this.positionUs) {
          this.applyScrub();
        }
      }, SCRUB_THROTTLE_MS);
    }
  }

  setPlaybackRate(r: number): void {
    if (this.disposed || !Number.isFinite(r) || r <= 0) return;
    const clamped = Math.min(MAX_ELEMENT_RATE, Math.max(MIN_ELEMENT_RATE, r));
    if (clamped === this.rate) return;
    if (this.playing) this.positionUs = this.currentClockUs();
    this.rate = clamped;
    if (this.playing) {
      this.reanchor(this.positionUs);
      this.scheduledAudio.clear(); // envelopes depend on the rate — reschedule
    }
  }

  getPlaybackRate(): number {
    return this.rate;
  }

  getPositionUs(): MicroSec {
    return this.playing ? this.currentClockUs() : this.positionUs;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cancelScrubTimer();
    this.playing = false;
    this.pool.dispose();
    this.audio.dispose();
    for (const [, tex] of this.slotTextures) this.compositor.deleteTexture(tex);
    this.slotTextures.clear();
    for (const [, entry] of this.imageTextures) this.compositor.deleteTexture(entry.texture);
    this.imageTextures.clear();
    for (const [, entry] of this.overlayTextures) this.compositor.deleteTexture(entry.texture);
    this.overlayTextures.clear();
    this.compositor.dispose();
    this.clock$.clear();
    this.playState$.clear();
    this.blocked$.clear();
    this.previewStatus$.clear();
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  /**
   * Project duration computed from the LIVE docStore document at call time
   * (stale-duration fix): the engine model lags edits by the load debounce.
   * Falls back to the loaded model when the live doc belongs to a different
   * project (project switch) or the store is unavailable.
   */
  private liveDurationUs(): MicroSec {
    const model = this.model;
    if (!model) return 0;
    try {
      const liveDoc = useDocStore.getState().doc;
      if (liveDoc === model.doc) return model.durationUs;
      if (liveDoc.projectId === model.doc.projectId) return projectDurationUs(liveDoc);
    } catch {
      // store not usable in this context — model duration is the best we have
    }
    return model.durationUs;
  }

  private nowSec(): number {
    const ctxNow = this.audio.nowSec();
    return ctxNow !== null ? ctxNow : performance.now() / 1000;
  }

  private reanchor(positionUs: MicroSec): void {
    this.anchorUs = positionUs;
    this.anchorSec = this.nowSec();
  }

  private currentClockUs(): MicroSec {
    if (!this.playing) return this.positionUs;
    const elapsed = this.nowSec() - this.anchorSec;
    return Math.round(this.anchorUs + elapsed * 1e6 * this.rate);
  }

  // -------------------------------------------------------------------------
  // Seeking
  // -------------------------------------------------------------------------

  private cancelScrubTimer(): void {
    if (this.scrubTimer !== null) {
      clearTimeout(this.scrubTimer);
      this.scrubTimer = null;
    }
    this.scrubPendingUs = null;
  }

  /** Common state change for any seek; element repositioning is separate. */
  private applySeek(targetUs: MicroSec): void {
    this.positionUs = targetUs;
    if (this.playing) {
      this.reanchor(targetUs);
      this.scheduledAudio.clear(); // envelopes are position-dependent
    }
    this.refreshPool(targetUs);
  }

  /** Fast scrub: set currentTime on active elements without verification. */
  private applyScrub(): void {
    const target = this.scrubPendingUs;
    if (target === null || !this.model) return;
    this.scrubPendingUs = null;
    this.applySeek(target);
    for (const { clip } of resolveVisualStack(this.model.doc, target)) {
      if (!isMediaClip(clip) || clip.kind === 'image') continue;
      const slot = this.pool.slotForClip(clip.id);
      if (!slot) continue;
      const srcSec = sourceTimeUs(clip, target) / 1e6;
      if (slot.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        try {
          slot.video.currentTime = srcSec;
        } catch {
          // not seekable yet
        }
      }
    }
    if (!this.playing) this.renderFrame(target);
    // CONTRACT: no clock$ emit from scrubbing (see seek()).
  }

  private frameDurationUs(): number {
    const fps = this.model?.doc.settings.fps;
    if (!fps) return 33_333;
    return (fps.den * 1e6) / fps.num;
  }

  /**
   * Frame-accurate paused seek (design §4.2): set currentTime, then verify the
   * presented frame's mediaTime via requestVideoFrameCallback within ±half a
   * frame; retry with a tiny forward bias, accept after 3 attempts (±1 frame
   * is documented preview tolerance, rendering-semantics §1.7).
   */
  private async preciseSeekActiveVideos(targetUs: MicroSec, seq: number): Promise<void> {
    const model = this.model;
    if (!model) return;
    const tolerance = this.frameDurationUs() / 2;
    // Staleness probe handed to every element job: re-checked after EVERY
    // await so a delayed precise seek can never re-position an element after
    // a newer seek/play took over (seek contract).
    const stillValid = () => !this.disposed && seq === this.seekSeq;
    const jobs: Promise<void>[] = [];
    for (const { clip } of resolveVisualStack(model.doc, targetUs)) {
      if (!isMediaClip(clip) || clip.kind !== 'video') continue;
      const slot = this.pool.slotForClip(clip.id);
      if (!slot) continue;
      this.slotUploadedAt.delete(slot.index);
      jobs.push(preciseSeekElement(slot.video, sourceTimeUs(clip, targetUs), tolerance, stillValid));
    }
    // Audio-only elements just get a plain position (no frame accuracy needed).
    for (const { clip } of resolveAudible(model.doc, targetUs)) {
      if (clip.kind !== 'audio') continue;
      const slot = this.pool.slotForClip(clip.id);
      if (slot && slot.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        try {
          slot.video.currentTime = sourceTimeUs(clip, targetUs) / 1e6;
        } catch {
          // ignore
        }
      }
    }
    await Promise.all(jobs);
  }

  // -------------------------------------------------------------------------
  // Pool scheduling
  // -------------------------------------------------------------------------

  /**
   * Pool <video> media error (expired presigned URL, network failure). The
   * pool already cleared the slot's URL (throttled per slot); here we ask the
   * media-urls sync for fresh URLs (throttled engine-wide, self-contained —
   * assetStore itself is untouched) and retry the assignment next tick.
   */
  private handleMediaError(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastMediaErrorRefreshAt >= MEDIA_ERROR_REFRESH_MIN_MS) {
      this.lastMediaErrorRefreshAt = now;
      forceRefreshMediaUrls();
    }
    this.mediaErrorRetryPending = true;
  }

  private refreshPool(tUs: MicroSec): void {
    const model = this.model;
    if (!model) return;
    const wanted = computeSlotRequests(model.doc, tUs);
    this.assignments = planPool(this.assignments, wanted, POOL_SIZE);
    const activeIds = new Set(wanted.filter((w) => w.priority === 0).map((w) => w.clipId));
    const bySlotRequest = new Map(wanted.map((w) => [w.clipId, w]));
    const changed = this.pool.apply(this.assignments, (assetId) => {
      const asset = model.resolver(assetId);
      return asset?.url ?? null;
    });
    for (const slot of changed) {
      this.slotUploadedAt.delete(slot.index);
      if (slot.clipId === null) continue;
      const req = bySlotRequest.get(slot.clipId);
      if (!req) continue;
      if (activeIds.has(slot.clipId)) {
        // Became active (cut crossed / new load): position at the expected
        // source time; playback state is reconciled in syncElements().
        this.pool.positionWhenReady(slot, req.sourceTimeUs / 1e6);
      } else {
        // Preload: warm the decoder at the clip's in-point, stay paused.
        if (!slot.video.paused) slot.video.pause();
        this.pool.positionWhenReady(slot, req.sourceTimeUs / 1e6);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Playback element sync (drift correction, play/pause reconciliation)
  // -------------------------------------------------------------------------

  private syncElements(justStarted: boolean): void {
    const model = this.model;
    if (!model) return;
    const t = this.currentClockUs();
    const activeElementClips = new Map<Uuid, { clip: MediaClip; track: Track }>();
    for (const { clip, track } of resolveVisualStack(model.doc, t)) {
      if (isMediaClip(clip) && clip.kind === 'video') activeElementClips.set(clip.id, { clip, track });
    }
    for (const { clip, track } of resolveAudible(model.doc, t)) {
      if (clip.kind !== 'image' && !activeElementClips.has(clip.id)) {
        activeElementClips.set(clip.id, { clip, track });
      }
    }

    for (const slot of this.pool.slots) {
      if (slot.clipId === null) continue;
      const entry = activeElementClips.get(slot.clipId);
      const video = slot.video;
      if (!entry) {
        // Preload slot: must not play.
        if (!video.paused) video.pause();
        continue;
      }
      const { clip, track } = entry;
      const baseRate = clampElementRate(clip.speed.rate * this.rate);
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        const expectedUs = sourceTimeUs(clip, t);
        const actualUs = video.currentTime * 1e6;
        const drift = actualUs - expectedUs;
        if (Math.abs(drift) > HARD_RESYNC_US || justStarted) {
          try {
            video.currentTime = expectedUs / 1e6;
          } catch {
            // not seekable yet
          }
          video.playbackRate = baseRate;
        } else if (Math.abs(drift) > NUDGE_US) {
          // Melt small drift with a ±2% rate nudge (§4.2).
          video.playbackRate = clampElementRate(baseRate * (drift > 0 ? 0.98 : 1.02));
        } else {
          video.playbackRate = baseRate;
        }
      }
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
      this.ensureAudioEnvelope(slot, clip, track, t);
    }
  }

  // -------------------------------------------------------------------------
  // Audio envelopes
  // -------------------------------------------------------------------------

  private ensureAudioEnvelope(slot: PoolSlot, clip: MediaClip, track: Track, tUs: MicroSec): void {
    if (this.scheduledAudio.has(clip.id)) return;
    this.scheduledAudio.add(clip.id);
    if (!this.audio.context) return; // context appears on first play(); rescheduled then

    const audio = clipAudioOf(clip);
    if (audio === null || isClipMuted(track, clip)) {
      this.audio.setElementGain(slot.video, 0);
      return;
    }

    const clipDur = clip.timelineDurationUs;
    const startClipUs = Math.min(clipDur, Math.max(0, tUs - clip.timelineStartUs));
    const remainingUs = clipDur - startClipUs;
    if (remainingUs <= 0) {
      this.audio.setElementGain(slot.video, 0);
      return;
    }

    // §8.4 seamless-splice exception: no micro-fade on a shared split edge.
    // Decision is clip-boundary based with a one-frame(+5 ms) edge tolerance —
    // envelopes are scheduled on the tick AFTER the cut (core/gain.ts).
    const prev = this.adjacentClip(track, clip, 'prev');
    const next = this.adjacentClip(track, clip, 'next');
    const microFadeIn = shouldMicroFadeIn(prev, clip, startClipUs, this.frameDurationUs());
    const microFadeOut = shouldMicroFadeOut(clip, next);

    const durationSec = remainingUs / (1e6 * this.rate);
    const samples = Math.max(2, Math.min(2000, Math.ceil(durationSec * GAIN_SAMPLES_PER_SEC)));
    const curve = buildGainCurve(audio, clipDur, startClipUs, clipDur, samples, {
      microFadeIn,
      microFadeOut,
      volumeKeyframes: clip.keyframes.volume,
    });
    this.audio.setElementGainCurve(slot.video, curve, durationSec);
  }

  private adjacentClip(track: Track, clip: MediaClip, dir: 'prev' | 'next'): MediaClip | null {
    const idx = track.clips.indexOf(clip);
    if (idx < 0) return null;
    const neighbor = track.clips[dir === 'prev' ? idx - 1 : idx + 1];
    if (!neighbor || !isMediaClip(neighbor)) return null;
    return neighbor;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private tick(): void {
    const model = this.model;
    if (!model) return;

    if (this.mediaErrorRetryPending) {
      // A pool element errored (expired presign / network): re-apply the pool
      // assignment so the cleared slot reloads its (possibly refreshed) URL.
      this.mediaErrorRetryPending = false;
      this.refreshPool(this.getPositionUs());
    }

    if (this.playing) {
      let t = this.currentClockUs();
      if (t >= model.durationUs) {
        // Reached the end: clamp and stop.
        this.positionUs = model.durationUs;
        this.playing = false;
        this.pool.pauseAll();
        for (const slot of this.pool.slots) this.audio.cancelElement(slot.video);
        this.scheduledAudio.clear();
        this.playState$.emit(false);
        setIsPlayingSafe(false);
        t = model.durationUs;
        this.renderFrame(t);
        this.clock$.emit(t);
        return;
      }
      this.refreshPool(t);
      this.syncElements(false);
      this.renderFrame(t);
      this.clock$.emit(t);
    } else {
      // Paused: keep compositing (doc edits, async video frames, image loads).
      this.renderFrame(this.positionUs);
    }
  }

  private renderFrame(tUs: MicroSec): void {
    const model = this.model;
    if (!model) return;
    const items: DrawItem[] = [];
    // BOTTOM first — the compositor blends in array order (§6.3 draw order).
    // Every visible layer with an element gets composited: the pool feeds ALL
    // of them at once, not just the top one.
    const stack = resolveVisualStack(model.doc, tUs);
    for (const { clip } of stack) {
      if (isMediaClip(clip)) {
        if (clip.kind === 'video') {
          const item = this.videoDrawItem(clip, tUs);
          if (item) items.push(item);
        } else if (clip.kind === 'image') {
          const item = this.imageDrawItem(clip, tUs);
          if (item) items.push(item);
        }
        // 'audio' never draws.
      } else if (clip.kind === 'sticker') {
        // A sticker is an image asset on an overlay track — same texture path.
        const item = this.imageDrawItem(clip, tUs);
        if (item) items.push(item);
      } else {
        // text / shape: client Canvas2D raster (§7 live-editing half).
        const item = this.overlayDrawItem(clip, tUs);
        if (item) items.push(item);
      }
    }
    this.compositor.render(items, model.doc.settings.backgroundColor);
    this.reportPreviewStatus(stack, resolveAudible(model.doc, tUs));
  }

  /**
   * Tell the UI how much of the composition is really coming through — layers
   * AND sound. Capacity based (does the clip own a pool element?), NOT
   * readiness based: a clip whose decoder is still warming up is a transient,
   * not a limitation, and flashing "3/4 layers" during every seek would train
   * users to ignore the note. Emits only on change.
   */
  private reportPreviewStatus(
    stack: readonly ActiveClip[],
    audible: readonly ActiveClip<MediaClip>[],
  ): void {
    const next = countPreviewLayers(
      stack,
      audible,
      (clipId) => this.pool.slotForClip(clipId) !== null,
    );
    if (samePreviewCapacity(next, this.previewStatus)) return;
    this.previewStatus = next;
    this.previewStatus$.emit(next);
  }

  /**
   * Size the compositor is really drawing this clip at (§2.1 `w_s, h_s`).
   * Video: the decoder's autorotated frame size. Image: the decoded bitmap.
   * null while nothing is decoded yet — the caller falls back to asset
   * metadata and finally to the composition size.
   */
  getClipSourceSize(clipId: Uuid): SourceSize | null {
    const model = this.model;
    if (!model) return null;
    const slot = this.pool.slotForClip(clipId);
    if (slot && slot.video.videoWidth > 0 && slot.video.videoHeight > 0) {
      return { width: slot.video.videoWidth, height: slot.video.videoHeight };
    }
    // Overlay raster: the box the gizmo must draw is the RASTER, and it is not
    // fit to the composition — baseScale travels with the size (§7).
    const overlay = this.overlayTextures.get(clipId);
    if (overlay) {
      return { width: overlay.width, height: overlay.height, baseScale: overlay.baseScale };
    }
    for (const track of model.doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id !== clipId) continue;
        const assetId =
          isMediaClip(clip) && clip.kind === 'image'
            ? clip.assetId
            : clip.kind === 'sticker'
              ? clip.assetId
              : null;
        if (assetId === null) return null;
        const entry = this.imageTextures.get(assetId);
        return entry?.ready && entry.width > 0
          ? { width: entry.width, height: entry.height }
          : null;
      }
    }
    return null;
  }

  /**
   * Text/shape draw item, rasterizing on demand.
   *
   * The raster is CACHED against a signature of the style, so the expensive
   * part (Canvas2D layout + fill + texImage2D) runs once per edit, not once per
   * animation frame — while transform/opacity/keyframes stay per-frame values
   * applied to the same bitmap, which is exactly what §7 promises ("aynı
   * bitmap'i transform etmek = garanti parity").
   */
  private overlayDrawItem(clip: TextClip | ShapeClip, tUs: MicroSec): DrawItem | null {
    const model = this.model;
    if (!model) return null;
    const box = shapeBoxPx(model.doc.settings);
    const key =
      clip.kind === 'text'
        ? textRasterKey(clip.text)
        : shapeRasterKey(clip.shape, box.width, box.height);

    let entry = this.overlayTextures.get(clip.id);
    if (!entry || entry.key !== key) {
      const raster =
        clip.kind === 'text'
          ? rasterizeText(clip.text)
          : rasterizeShape(clip.shape, box.width, box.height);
      // No DOM / no 2D context: draw nothing rather than a wrong-sized quad.
      if (!raster) return null;
      const texture = entry?.texture ?? this.compositor.createTexture();
      this.compositor.upload(texture, raster.canvas);
      entry = {
        texture,
        key,
        width: raster.width,
        height: raster.height,
        bboxWidthPx: raster.bboxWidthPx,
        bboxHeightPx: raster.bboxHeightPx,
        baseScale: raster.baseScale,
      };
      this.overlayTextures.set(clip.id, entry);
    }

    return {
      texture: entry.texture,
      srcW: entry.width,
      srcH: entry.height,
      baseScale: entry.baseScale,
      transform: effectiveTransform(clip, tUs),
      opacity: effectiveOpacity(clip, tUs),
      colorAdjust: colorAdjustOf(clip),
    };
  }

  private videoDrawItem(clip: MediaClip, tUs: MicroSec): DrawItem | null {
    const slot = this.pool.slotForClip(clip.id);
    if (!slot) return null;
    const video = slot.video;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;

    let texture = this.slotTextures.get(slot.index);
    if (!texture) {
      texture = this.compositor.createTexture();
      this.slotTextures.set(slot.index, texture);
      this.slotUploadedAt.delete(slot.index);
    }
    // While playing: fresh frame every rAF. While paused: only re-upload when
    // the element's time actually changed (seek landed).
    const stamp = video.currentTime;
    if (this.playing || this.slotUploadedAt.get(slot.index) !== stamp) {
      this.compositor.upload(texture, video);
      this.slotUploadedAt.set(slot.index, stamp);
    }
    return {
      texture,
      srcW: video.videoWidth,
      srcH: video.videoHeight,
      transform: effectiveTransform(clip, tUs),
      opacity: effectiveOpacity(clip, tUs),
      colorAdjust: colorAdjustOf(clip),
    };
  }

  /**
   * Still-image texture path, shared by image clips and STICKERS: a sticker is
   * schema-wise just an image asset on an overlay track, so it goes through the
   * same decode/cache/refresh logic (including the expired-presign retry).
   */
  private imageDrawItem(clip: MediaClip | StickerClip, tUs: MicroSec): DrawItem | null {
    const model = this.model;
    if (!model) return null;
    const url = model.resolver(clip.assetId)?.url ?? null;
    let entry = this.imageTextures.get(clip.assetId);

    // A previous decode failed (expired presigned URL, network, corrupt file).
    // Retry once the URL was refreshed, or after the cooldown — never on the
    // next rAF, which would be a 60 fps request storm against a dead URL.
    if (entry && entry.failedAt !== 0) {
      const refreshed = url !== null && url !== entry.url;
      const cooled = Date.now() - entry.failedAt >= IMAGE_ERROR_RETRY_MIN_MS;
      if (!refreshed && !cooled) return null;
      this.compositor.deleteTexture(entry.texture);
      this.imageTextures.delete(clip.assetId);
      entry = undefined;
    }

    if (!entry) {
      if (!url) return null;
      const texture = this.compositor.createTexture();
      entry = { texture, width: 0, height: 0, ready: false, url, failedAt: 0 };
      this.imageTextures.set(clip.assetId, entry);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      // Stale guard: a retry may have replaced the entry while this load was in
      // flight — only the entry that owns THIS texture may be written.
      const owned = (): ImageEntry | null => {
        if (this.disposed) return null;
        const e = this.imageTextures.get(clip.assetId);
        return e && e.texture === texture ? e : null;
      };
      img.onload = () => {
        const e = owned();
        if (!e) return;
        this.compositor.upload(e.texture, img);
        e.width = img.naturalWidth;
        e.height = img.naturalHeight;
        e.ready = true;
        e.failedAt = 0;
      };
      // Without this the image silently never appears and the preview looks
      // like a rendering bug. Same recovery path as a <video> media error:
      // ask the media-urls sync for fresh presigned URLs (throttled
      // engine-wide) and let the retry above pick the new URL up.
      img.onerror = () => {
        const e = owned();
        if (!e) return;
        e.ready = false;
        e.failedAt = Date.now();
        this.handleMediaError();
      };
      img.src = url;
      return null;
    }
    if (!entry.ready || entry.width <= 0) return null;
    return {
      texture: entry.texture,
      srcW: entry.width,
      srcH: entry.height,
      transform: effectiveTransform(clip, tUs),
      opacity: effectiveOpacity(clip, tUs),
      colorAdjust: colorAdjustOf(clip),
    };
  }
}

// ---------------------------------------------------------------------------
// Frame-accurate element seek helper
// ---------------------------------------------------------------------------

function waitSeeked(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, timeoutMs);
    const onSeeked = () => {
      clearTimeout(timer);
      resolve();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
  });
}

function nextVideoFrame(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<VideoFrameCallbackMetadata | null> {
  return new Promise((resolve) => {
    let handle = 0;
    const timer = setTimeout(() => {
      video.cancelVideoFrameCallback(handle);
      resolve(null);
    }, timeoutMs);
    handle = video.requestVideoFrameCallback((_now, meta) => {
      clearTimeout(timer);
      resolve(meta);
    });
  });
}

/**
 * Seek an element to targetSrcUs and verify the presented frame's mediaTime is
 * within ±toleranceUs (half a project frame). Design §7 pitfall 5: never trust
 * currentTime blindly — some engines round it to the nearest frame.
 *
 * stillValid is re-checked after EVERY await (seek contract): once a newer
 * seek/play supersedes this job it must not move the element again.
 */
async function preciseSeekElement(
  video: HTMLVideoElement,
  targetSrcUs: MicroSec,
  toleranceUs: number,
  stillValid: () => boolean,
): Promise<void> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitSeeked(video, 500); // metadata race — accept best effort
    if (!stillValid()) return;
  }
  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
  const targetSec = targetSrcUs / 1e6;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!stillValid()) return;
    try {
      // Tiny forward bias on retries nudges the demuxer past rounding edges.
      video.currentTime = targetSec + attempt * 0.001;
    } catch {
      return;
    }
    if (!hasRvfc) {
      await waitSeeked(video, 300);
      return;
    }
    const meta = await nextVideoFrame(video, 300);
    if (!stillValid()) return;
    if (meta === null) return; // no new frame presented — accept
    if (Math.abs(meta.mediaTime * 1e6 - targetSrcUs) <= toleranceUs) return;
  }
  // 3 attempts exhausted: ±1 frame is the documented v1 preview tolerance.
}
