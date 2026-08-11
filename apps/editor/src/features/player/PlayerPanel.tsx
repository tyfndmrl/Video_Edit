/**
 * Preview player panel (M2): WebGL2 compositor canvas + transport bar.
 *
 * - The canvas drawing buffer is the PROJECT resolution; CSS letterboxes it
 *   into the panel (rendering-semantics §2.1 — math always in W x H space).
 * - The engine clock drives editorStore.playheadUs with RAW microseconds (no
 *   frame snapping — the timeline draws its own snap); on pause the playhead
 *   snaps to the project frame grid. Clock writes use source 'engine'
 *   (intersection contract A) — clock$ never echoes seeks (engine contract),
 *   so forwarding is unconditional; the store drops stale engine writes.
 * - docStore/assetStore changes re-load the engine (100 ms debounce); a user
 *   seek flushes a pending load first so seek clamping sees the LIVE doc.
 * - USER playhead moves (timeline scrub / keyboard — detected via userSeekSeq)
 *   fast-seek the engine, with a trailing frame-accurate seek once movement
 *   settles; the settle seek reads the CURRENT store playhead, never a stale
 *   captured target.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTimecode, snapUsToFrameGrid } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import {
  getPlaybackEngine,
  registerPlaybackEngine,
  type AssetResolver,
  type PreviewRateStatus,
  type PreviewStatus,
  type SourceSize,
} from './engine';
import { VideoPlaybackEngine } from './engine-video/engineV1';
import { projectDurationUs, transitionAtPlayhead } from './core/resolve';
import { previewShortfallNote } from './core/scheduler';
import { transitionTypeLabel } from '../timeline/transitions';
import { readIsPlaying, readUserSeekSeq } from './editorBridge';
import { TransformGizmo } from './TransformGizmo';

/** AssetResolver backed by assetStore (proxy presigned URLs, media-urls sync). */
function resolveAsset(assetId: string): ReturnType<AssetResolver> {
  const asset = useAssetStore.getState().getAsset(assetId);
  if (!asset) return null;
  return {
    kind: asset.kind,
    url: asset.status === 'ready' ? (asset.proxyUrl ?? null) : null,
    durationUs: asset.durationUs,
    width: asset.width,
    height: asset.height,
  };
}

const LOAD_DEBOUNCE_MS = 100;
const PRECISE_SEEK_SETTLE_MS = 150;

export function PlayerPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  /** The letterboxed stage that holds the canvas — gizmo coordinate origin. */
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VideoPlaybackEngine | null>(null);

  const settings = useDocStore((s) => s.doc.settings);
  const durationUs = useDocStore((s) => projectDurationUs(s.doc));
  const playheadUs = useEditorStore((s) => s.playheadUs);
  /**
   * The transition window under the playhead, as a rendered STRING so the
   * selector stays value-stable (a fresh object every doc change would
   * re-render the panel on every gizmo drag frame).
   *
   * Why the badge exists at all: a crossfade between two similar shots looks
   * exactly like a preview that failed to update. The timeline already draws
   * the band; the player has to say "you are inside it" for the same reason
   * the shortfall note exists — a degraded or unusual frame must be legible.
   */
  const transitionNote = useDocStore((s) => {
    const window = transitionAtPlayhead(s.doc, playheadUs);
    if (!window) return null;
    return `${transitionTypeLabel(window.type)} %${Math.round(window.p * 100)}`;
  });

  // Engine play state — fed from playState$ in the mount effect below, so ANY
  // play/pause source (transport button, timeline Space shortcut) updates it.
  const [isPlaying, setIsPlayingLocal] = useState(false);
  // Autoplay-policy rollback (engine blocked$): show a hint + retry on gesture.
  const [blocked, setBlocked] = useState(false);
  // Preview capacity (engine previewStatus$): how much of the composition —
  // picture AND sound — the finite <video> pool can actually feed right now.
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>({
    totalLayers: 0,
    shownLayers: 0,
    totalAudio: 0,
    shownAudio: 0,
    dropped: [],
  });
  // Clip speed x transport rate can leave the <video> element's portable
  // range; the preview then runs at a different speed than the document and
  // the user has to hear it from us, not discover it in the export.
  const [rateStatus, setRateStatus] = useState<PreviewRateStatus>({
    limited: false,
    requested: 1,
    applied: 1,
  });
  /**
   * Flush the engine's DEBOUNCED doc reload on demand. Assigned by the mount
   * effect below; the gizmo calls it after every drag step so the picture keeps
   * up with the box instead of trailing it by the debounce.
   */
  const flushLoadRef = useRef<() => void>(() => {});

  // ---- engine lifecycle + store wiring (single mount effect) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new VideoPlaybackEngine(canvas);
    engineRef.current = engine;
    registerPlaybackEngine(engine);

    // Engine clock -> playhead (raw µs; timeline does its own draw-snap).
    // clock$ carries ONLY the engine's own playback progress (engine
    // contract) — no echo-guard bookkeeping needed here anymore.
    const unsubClock = engine.clock$.subscribe((timeUs) => {
      useEditorStore.getState().setPlayheadUs(timeUs, 'engine');
    });

    // Reflect play state in the transport; on pause additionally snap the
    // playhead onto the project frame grid + precise seek.
    const unsubPlayState = engine.playState$.subscribe((playing) => {
      setIsPlayingLocal(playing);
      if (playing) return;
      const editor = useEditorStore.getState();
      const fps = useDocStore.getState().doc.settings.fps;
      const snapped = snapUsToFrameGrid(Math.max(0, Math.round(editor.playheadUs)), fps);
      editor.setPlayheadUs(snapped, 'engine');
      void engine.seek(snapped, { precise: true });
    });

    const unsubBlocked = engine.blocked$.subscribe(setBlocked);
    const unsubPreview = engine.previewStatus$.subscribe(setPreviewStatus);
    const unsubRate = engine.previewRate$.subscribe(setRateStatus);

    // doc/asset changes -> engine.load (debounced 100 ms).
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    const doLoad = () => {
      engine.load(useDocStore.getState().doc, resolveAsset);
    };
    const scheduleLoad = () => {
      if (loadTimer !== null) clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        loadTimer = null;
        doLoad();
      }, LOAD_DEBOUNCE_MS);
    };
    // Stale-duration fix: seeks must never clamp against a doc the engine has
    // not loaded yet — flush a pending debounced load before seeking.
    const flushPendingLoad = () => {
      if (loadTimer !== null) {
        clearTimeout(loadTimer);
        loadTimer = null;
        doLoad();
      }
    };
    flushLoadRef.current = flushPendingLoad;
    doLoad();
    const unsubDoc = useDocStore.subscribe((state, prev) => {
      if (state.doc !== prev.doc) scheduleLoad();
    });
    const unsubAssets = useAssetStore.subscribe((state, prev) => {
      if (state.assets !== prev.assets) scheduleLoad();
    });

    // USER playhead moves (timeline click/drag, arrow keys) -> seek.
    // Fast scrub immediately; frame-accurate once movement settles (paused).
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubEditor = useEditorStore.subscribe((state, prev) => {
      // Play-state reconciliation: if some other feature toggles
      // editorStore.isPlaying directly, follow it.
      const nextPlaying = readIsPlaying(state);
      const prevPlaying = readIsPlaying(prev);
      if (nextPlaying !== undefined && nextPlaying !== prevPlaying) {
        if (nextPlaying && !engine.isPlaying()) engine.play();
        else if (!nextPlaying && engine.isPlaying()) engine.pause();
      }

      // Only USER seeks drive the engine (userSeekSeq bump — intersection
      // contract A). Engine-sourced writes (our own clock forwarding above)
      // leave the seq alone. This replaces the old lastClockWriteUs
      // value-equality hack.
      const seq = readUserSeekSeq(state);
      if (seq !== undefined) {
        if (seq === readUserSeekSeq(prev)) return;
      } else if (state.playheadUs === prev.playheadUs) {
        return; // transitional fallback until the store carries userSeekSeq
      }
      flushPendingLoad();
      void engine.seek(state.playheadUs, { precise: false });
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (engine.isPlaying()) return;
        // Read the playhead CURRENT value — a captured target could resurrect
        // an older position when more seeks landed while this timer ran.
        flushPendingLoad();
        void engine.seek(useEditorStore.getState().playheadUs, { precise: true });
      }, PRECISE_SEEK_SETTLE_MS);
    });

    return () => {
      if (loadTimer !== null) clearTimeout(loadTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      unsubClock();
      unsubPlayState();
      unsubBlocked();
      unsubPreview();
      unsubRate();
      unsubDoc();
      unsubAssets();
      unsubEditor();
      flushLoadRef.current = () => {};
      if (getPlaybackEngine() === engine) registerPlaybackEngine(null);
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  // ---- autoplay-blocked: retry on the FIRST real user gesture ----
  // Gestures INSIDE the panel already flow through togglePlayback (the panel
  // click/button is itself the retry); the window listener covers gestures
  // elsewhere (e.g. a timeline click) without double-toggling the panel.
  useEffect(() => {
    if (!blocked) return;
    const retry = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      const engine = engineRef.current;
      if (engine && !engine.isPlaying()) engine.play();
    };
    window.addEventListener('pointerdown', retry, true);
    return () => window.removeEventListener('pointerdown', retry, true);
  }, [blocked]);

  const togglePlayback = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isPlaying()) engine.pause();
    else engine.play();
  }, []);

  /** Natural media size straight from the engine (decoder truth) for the gizmo. */
  const getSourceSize = useCallback(
    (clipId: string): SourceSize | null => engineRef.current?.getClipSourceSize(clipId) ?? null,
    [],
  );
  const flushPreviewLoad = useCallback(() => flushLoadRef.current(), []);

  // Honest degradation, computed by a PURE function (core/scheduler) so the
  // exact wording is unit-tested rather than eyeballed.
  const shortfall = previewShortfallNote(previewStatus);

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2"
        onClick={togglePlayback}
        title={isPlaying ? 'Duraklat (Space)' : 'Oynat (Space)'}
      >
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full object-contain"
          style={{ aspectRatio: `${settings.width} / ${settings.height}` }}
        />
        <TransformGizmo
          containerRef={stageRef}
          canvasRef={canvasRef}
          getSourceSize={getSourceSize}
          flushPreviewLoad={flushPreviewLoad}
          isPlaying={isPlaying}
        />
        {blocked && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-black/70 px-3 py-1.5 text-xs text-white">
              Oynatmak için tıklayın
            </span>
          </div>
        )}
        {/* Honest degradation: the <video> pool is finite, so a composition with
            more simultaneous element-hungry clips than slots drops some of them
            — video layers AND audio beds alike. Silence here would look like a
            rendering bug (or, for the music bed, like a broken mixer). */}
        {shortfall && (
          <div
            data-testid="preview-layer-note"
            role="status"
            className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[11px] text-white"
            title={shortfall.detail}
          >
            {shortfall.text}
          </div>
        )}
        {/* Transition window (§5.3): both sides are being mixed right now. */}
        {transitionNote && (
          <div
            data-testid="preview-transition-note"
            role="status"
            className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[11px] text-white"
            title={
              'Geçiş penceresi: kesimden D/2 önce başlar, D/2 sonra biter ' +
              '(rendering-semantics §5.3). Önizlemede iki klip birlikte çözülüp karıştırılır.'
            }
          >
            Geçiş: {transitionNote}
          </div>
        )}
        {/* Speed honesty (M5): the element could not run at the rate the
            document asks for, so what is on screen is NOT what will be
            exported. Saying nothing here would make the export look broken. */}
        {rateStatus.limited && (
          <div
            data-testid="preview-rate-note"
            role="status"
            className="pointer-events-none absolute right-2 top-2 rounded bg-amber-500/85 px-2 py-1 text-[11px] text-black"
            title={`Tarayıcı <video> hızı 0.0625x–16x aralığındadır; istenen ${rateStatus.requested}x yerine ${rateStatus.applied}x çalınıyor. Dışa aktarımda bu sınır yoktur.`}
          >
            Önizleme hızı sınırlandı: {rateStatus.applied}x
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-edge bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded border border-edge text-fg hover:bg-surface-3"
          onClick={togglePlayback}
          aria-label={isPlaying ? 'Duraklat' : 'Oynat'}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="font-mono text-fg" title="Playhead (proje fps zaman kodu)">
          {formatTimecode(Math.max(0, Math.round(playheadUs)), settings.fps)}
        </span>
        <span className="text-fg-muted">/</span>
        <span className="font-mono" title="Proje süresi">
          {formatTimecode(durationUs, settings.fps)}
        </span>
        <span className="ml-auto text-[10px] tracking-wide uppercase" title="Oynatma motoru">
          v1
        </span>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 0.5 L9 5 L1.5 9.5 Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1" y="0.5" width="3" height="9" fill="currentColor" />
      <rect x="6" y="0.5" width="3" height="9" fill="currentColor" />
    </svg>
  );
}
