/**
 * PlaybackEngine contract (design doc 01-frontend-editor.md §4.1) + the
 * process-wide engine singleton.
 *
 * The v1 implementation (engine-video/engineV1.ts) is registered here by
 * PlayerPanel on mount. Other features (timeline keyboard shortcuts, J/K/L,
 * frame stepping) reach the engine ONLY through `getPlaybackEngine()` — it is
 * null until the player panel has mounted, so callers must handle null.
 *
 * The v2 WebCodecs engine (M4) implements the same interface and swaps in
 * behind this accessor without touching call sites.
 */
import type { MicroSec, TimelineDoc, Uuid } from '@videoedit/timeline-schema';

/** Minimal observable — deliberately not rxjs; just enough for a clock feed. */
export interface Observable<T> {
  /** Returns an unsubscribe function. */
  subscribe(cb: (value: T) => void): () => void;
}

/** What the engine needs to know about an asset to play it. */
export interface PlayerAsset {
  kind: 'video' | 'audio' | 'image';
  /** Presigned PROXY url (12 h, media-urls endpoint). null while not ready. */
  url: string | null;
  durationUs?: MicroSec;
  width?: number;
  height?: number;
}

/**
 * Resolves an assetId to playable metadata at load time. Backed by assetStore
 * in the app; a plain map in tests.
 */
export type AssetResolver = (assetId: Uuid) => PlayerAsset | null;

/**
 * Preview capacity snapshot (see PlaybackEngine.previewStatus$).
 *
 * Covers PICTURE AND SOUND on purpose: the decoder budget is shared, and audio
 * clips sit on the bottom tracks, so they are the first thing a scarce pool
 * drops. A report that only counted visual layers let a music bed disappear in
 * silence — see core/scheduler.countPreviewLayers.
 */
export interface PreviewStatus {
  /** Visual layers active at the current position (visible tracks only). */
  totalLayers: number;
  /** How many of them are actually being composited. */
  shownLayers: number;
  /** Clips that should be audible at the current position (unmuted). */
  totalAudio: number;
  /** How many of them actually reach the audio graph (the rest are silent). */
  shownAudio: number;
  /** Labels of the tracks that had to be dropped, top track first. */
  dropped: readonly string[];
}

/** Natural (autorotated) source size of a clip's media, in px. */
export interface SourceSize {
  width: number;
  height: number;
}

export interface SeekOptions {
  /**
   * true  -> frame-accurate seek (used when paused; verified against
   *          requestVideoFrameCallback.mediaTime, ±half frame tolerance)
   * false -> fast scrub seek (throttled, last request wins)
   */
  precise: boolean;
}

/** Design §4.1 — both the v1 <video> engine and the v2 WebCodecs engine obey this. */
export interface PlaybackEngine {
  load(doc: TimelineDoc, assets: AssetResolver): void;
  play(): void;
  pause(): void;
  /**
   * Seek to timeUs. CONTRACT (binding for v2 as well):
   * - seek()/scrubbing NEVER emit on clock$ — while paused the playhead
   *   authority is the editor store, and echoing the seek back would race
   *   newer user seeks (clock-echo feedback).
   * - Implementations keep a monotonic seek sequence counter; after EVERY
   *   await in an async seek path the counter is re-checked, and a stale
   *   continuation (a newer seek/play/scrub arrived meanwhile) must not touch
   *   engine state, media elements, or any observable.
   */
  seek(timeUs: MicroSec, opts?: SeekOptions): Promise<void>;
  /**
   * Master clock in timeline microseconds; the UI playhead follows this.
   * CONTRACT (binding for v2 as well): clock$ carries ONLY the engine's OWN
   * playback progress and the media-end clamp. It never echoes seeks and is
   * silent while paused (the store is the authority then).
   */
  readonly clock$: Observable<MicroSec>;
  /** Emits on play/pause state changes (true = playing). */
  readonly playState$: Observable<boolean>;
  /**
   * Optional: emits true when a play() attempt was rolled back because the
   * audio context could not start without a user gesture (autoplay policy),
   * false once cleared by the next play attempt. UI shows a "click to play"
   * hint and retries on the next real user gesture.
   */
  readonly blocked$?: Observable<boolean>;
  /**
   * Optional: how much of the composition the engine can actually deliver at
   * this instant — visual layers AND audible clips. Emits ONLY on change.
   *
   * CONTRACT: an engine that has to drop anything (finite decoder/element
   * budget) MUST report it here, PICTURE AND SOUND ALIKE. The preview may
   * legitimately be a degraded view of the export, but the user has to be able
   * to SEE that it is degraded — a silently missing layer (or a silently
   * missing music bed) is indistinguishable from a broken one.
   */
  readonly previewStatus$?: Observable<PreviewStatus>;
  setPlaybackRate(r: number): void;
  /** Current playback rate multiplier (1 = realtime). */
  getPlaybackRate(): number;
  /** Current playhead position of the engine, in timeline microseconds. */
  getPositionUs(): MicroSec;
  /**
   * Optional: the size the engine is ACTUALLY drawing this clip's media at
   * (video.videoWidth/Height, decoded image size) — the `w_s, h_s` of
   * rendering-semantics §2.1, already autorotated by the decoder. null when the
   * media is not decoded yet.
   *
   * The transform gizmo draws its box from this so the handles sit exactly on
   * the pixels on screen; asset metadata is only a fallback (it can disagree
   * with the decoder on rotated phone footage).
   */
  getClipSourceSize?(clipId: Uuid): SourceSize | null;
  isPlaying(): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Singleton registry
// ---------------------------------------------------------------------------

let currentEngine: PlaybackEngine | null = null;

/** The active engine, or null before PlayerPanel has mounted / after unmount. */
export function getPlaybackEngine(): PlaybackEngine | null {
  return currentEngine;
}

/** Called by PlayerPanel when it creates/destroys its engine instance. */
export function registerPlaybackEngine(engine: PlaybackEngine | null): void {
  currentEngine = engine;
}

// ---------------------------------------------------------------------------
// Tiny subject helper shared by engine implementations
// ---------------------------------------------------------------------------

export interface Subject<T> extends Observable<T> {
  emit(value: T): void;
  clear(): void;
}

export function createSubject<T>(): Subject<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(value) {
      for (const cb of [...listeners]) cb(value);
    },
    clear() {
      listeners.clear();
    },
  };
}
