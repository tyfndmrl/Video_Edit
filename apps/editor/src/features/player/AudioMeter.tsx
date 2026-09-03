/**
 * Preview level meter (master bus), docked to the right of the timeline.
 *
 * Everything numeric and every sentence comes from core/meter.ts so it can be
 * unit-tested; this file is the wire and the paint. Two rules shape it:
 *
 * 1. NO RE-RENDER per sample. The engine emits at 30 Hz; bars go to a canvas
 *    and the readout is written with textContent, the same discipline the
 *    transport timecode already follows. Two low-frequency facts DO live in
 *    React state (why the meter is idle, whether the clip latch is lit) and
 *    their setters run on every sample on purpose: they are called in updater
 *    form and return `prev` unchanged, so React bails out without rendering —
 *    an explicit equality check here would just duplicate that bail-out.
 * 2. Silence and "no mix at all" are DIFFERENT. When the engine has no audio
 *    context (before the first play), is blocked by autoplay policy, or is
 *    paused/shuttling, the meter says so in words instead of drawing a zero.
 */
import { useEffect, useRef, useState } from 'react';

import { RULER_H } from '../timeline/geometry';
import { useTransportStore } from '../shortcuts/shuttle';
import { subscribePlaybackEngine } from './engine';
import {
  METER_CAUTION_DB,
  METER_TICKS_DB,
  advanceMeter,
  barFraction,
  createMeterState,
  formatDbfs,
  meterHonestyNote,
  meterInactiveHint,
  meterInactiveLabel,
  meterReadoutDb,
  resetMeter,
  type MeterFrame,
  type MeterReason,
  type MeterState,
} from './core/meter';

const COLOR_BG = '#11151d';
const COLOR_EDGE = '#2a313d';
const COLOR_MUTED = '#8b93a1';
const COLOR_LEVEL = '#e5e9f0';
const COLOR_CAUTION = '#f97316';
const COLOR_OVER = '#ef4444';

/** Attribute cadence for e2e/probes — far below the sampling rate on purpose. */
const ATTR_INTERVAL_MS = 100;

interface Geometry {
  width: number;
  height: number;
}

function drawMeter(
  ctx: CanvasRenderingContext2D,
  size: Geometry,
  state: MeterState,
  live: boolean,
): void {
  const { width: w, height: h } = size;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, w, h);

  const labelW = 22;
  const top = 6;
  const bottom = h - 6;
  const span = Math.max(1, bottom - top);
  const barsX = labelW + 2;
  const barsW = Math.max(6, w - barsX - 6);
  const barW = Math.max(4, Math.floor((barsW - 4) / 2));

  // Scale: ticks are linear IN dB, so the spacing tells the truth about ratios.
  ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const db of METER_TICKS_DB) {
    const y = top + (1 - barFraction(db)) * span;
    ctx.strokeStyle = COLOR_EDGE;
    ctx.beginPath();
    ctx.moveTo(labelW + 1, Math.round(y) + 0.5);
    ctx.lineTo(w - 4, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(String(db), labelW - 3, y);
  }

  for (let ch = 0; ch < 2; ch++) {
    const x = barsX + ch * (barW + 4);
    ctx.fillStyle = COLOR_EDGE;
    ctx.fillRect(x, top, barW, span);
    if (!live) continue;

    const rmsDb = state.rmsDb[ch] ?? Number.NEGATIVE_INFINITY;
    const peakDb = state.instantDb[ch] ?? Number.NEGATIVE_INFINITY;
    const holdDb = state.holdDb[ch] ?? Number.NEGATIVE_INFINITY;

    const rmsH = barFraction(rmsDb) * span;
    if (rmsH > 0) {
      ctx.fillStyle = rmsDb >= 0 ? COLOR_OVER : rmsDb >= METER_CAUTION_DB ? COLOR_CAUTION : COLOR_LEVEL;
      ctx.fillRect(x, bottom - rmsH, barW, rmsH);
    }
    const peakH = barFraction(peakDb) * span;
    if (peakH > 0) {
      ctx.fillStyle = peakDb >= 0 ? COLOR_OVER : COLOR_CAUTION;
      ctx.fillRect(x, bottom - peakH, barW, 1);
    }
    const holdH = barFraction(holdDb) * span;
    if (holdH > 0) {
      ctx.fillStyle = holdDb >= 0 ? COLOR_OVER : COLOR_LEVEL;
      ctx.fillRect(x, Math.max(top, bottom - holdH - 1), barW, 2);
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR_MUTED;
  ctx.fillText('L', barsX + barW / 2, h - 2);
  ctx.fillText('R', barsX + barW + 4 + barW / 2, h - 2);
}

export function AudioMeter(): React.JSX.Element {
  const shuttleRate = useTransportStore((s) => s.shuttleRate);
  const shuttleRef = useRef(shuttleRate);
  shuttleRef.current = shuttleRate;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  const stateRef = useRef<MeterState>(createMeterState());
  const sizeRef = useRef<Geometry>({ width: 0, height: 0 });
  const attrRef = useRef({ atMs: 0, text: '' });

  const [reason, setReason] = useState<MeterReason>('no-context');
  const [clipped, setClipped] = useState(false);

  // Canvas backing store follows the CSS box (dpr aware), same shape as the
  // timeline's own measure(): identity-guarded so a no-op resize repaints
  // nothing.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const measure = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      const wantW = Math.round(width * dpr);
      const wantH = Math.round(height * dpr);
      if (canvas.width !== wantW) canvas.width = wantW;
      if (canvas.height !== wantH) canvas.height = wantH;
      sizeRef.current = { width, height };
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawMeter(ctx, sizeRef.current, stateRef.current, false);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let unsubMeter: (() => void) | null = null;

    const paint = (frame: MeterFrame): void => {
      const next = advanceMeter(stateRef.current, frame);
      stateRef.current = next;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d') ?? null;
      if (ctx !== null) drawMeter(ctx, sizeRef.current, next, frame.live);

      const shuttleActive = shuttleRef.current !== null;
      const effectiveReason: MeterReason =
        frame.reason === 'paused' && shuttleActive ? 'shuttle' : frame.reason;
      const label = meterInactiveLabel(effectiveReason, shuttleActive);
      const readout = readoutRef.current;
      if (readout !== null) {
        const text = label ?? formatDbfs(meterReadoutDb(next));
        if (readout.textContent !== text) readout.textContent = text;
        readout.title = meterInactiveHint(effectiveReason, shuttleActive) ?? meterHonestyNote();
      }

      setReason((prev) => (prev === effectiveReason ? prev : effectiveReason));
      setClipped((prev) => (prev === next.clipped ? prev : next.clipped));

      // Test/probe surface: throttled and only when the rounded value moved,
      // so the DOM does not churn at the sampling rate.
      const root = rootRef.current;
      if (root !== null && frame.atMs - attrRef.current.atMs >= ATTR_INTERVAL_MS) {
        const dbText = (db: number): string => (Number.isFinite(db) ? db.toFixed(1) : '-inf');
        const values: readonly [string, string][] = [
          ['data-meter-live', frame.live ? 'true' : 'false'],
          ['data-meter-reason', effectiveReason],
          ['data-meter-db-l', dbText(next.instantDb[0] ?? Number.NEGATIVE_INFINITY)],
          ['data-meter-db-r', dbText(next.instantDb[1] ?? Number.NEGATIVE_INFINITY)],
          ['data-meter-hold-db', dbText(meterReadoutDb(next))],
          ['data-meter-clip', next.clipped ? 'true' : 'false'],
        ];
        const text = values.map(([, v]) => v).join('|');
        if (text !== attrRef.current.text) {
          for (const [name, value] of values) root.setAttribute(name, value);
        }
        attrRef.current = { atMs: frame.atMs, text };
      }
    };

    const unsubEngine = subscribePlaybackEngine((engine) => {
      unsubMeter?.();
      unsubMeter = null;
      if (engine?.meter$ === undefined) return;
      unsubMeter = engine.meter$.subscribe(paint);
    });

    return () => {
      unsubEngine();
      unsubMeter?.();
    };
  }, []);

  const clearLatch = (): void => {
    stateRef.current = resetMeter(stateRef.current, performance.now());
    setClipped(false);
    // Prob yüzeyini HEMEN düzelt: öznitelikler 100 ms'lik pencerede yazılıyor
    // ve motor bu arada dispose edilirse "mandal yanıyor" yalanı asılı kalırdı.
    rootRef.current?.setAttribute('data-meter-clip', 'false');
    attrRef.current = { atMs: 0, text: '' };
    // Repaint immediately so the cleared latch is visible before the next tick.
    const ctx = canvasRef.current?.getContext('2d') ?? null;
    if (ctx !== null) drawMeter(ctx, sizeRef.current, stateRef.current, reason === 'running');
  };

  const shuttleActive = shuttleRate !== null;
  const inactiveHint = meterInactiveHint(reason, shuttleActive);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Ses seviyesi ölçer (önizleme miksi)"
      data-testid="audio-meter"
      data-meter-live="false"
      data-meter-reason="no-context"
      className="flex w-16 shrink-0 flex-col border-l border-edge bg-surface-1"
      title={inactiveHint ?? meterHonestyNote()}
      onClick={clipped ? clearLatch : undefined}
    >
      {/* Aligns the bars with the track area, mirroring the ruler strip. */}
      <div
        style={{ height: RULER_H }}
        className="flex items-center justify-center border-b border-edge bg-surface-2"
      >
        {clipped ? (
          <button
            type="button"
            data-testid="audio-meter-reset"
            aria-label="Klip uyarısını sıfırla (0 dBFS aşıldı)"
            className="rounded bg-red-500/90 px-1 text-[9px] font-semibold text-black"
            onClick={(e) => {
              // Kök div de mandal varken clearLatch dinliyor (pointer kolaylığı);
              // kabarcıklanma iki kez koşmasın diye burada durduruluyor.
              e.stopPropagation();
              clearLatch();
            }}
          >
            KLİP
          </button>
        ) : (
          <span aria-hidden="true" className="text-[9px] tracking-wide text-fg-muted uppercase">
            dBFS
          </span>
        )}
      </div>
      <canvas ref={canvasRef} aria-hidden="true" className="block min-h-0 w-full flex-1" />
      <span
        ref={readoutRef}
        aria-hidden="true"
        data-testid="audio-meter-readout"
        className="border-t border-edge px-1 py-0.5 text-center font-mono text-[9px] text-fg-muted"
      >
        Ölçüm yok
      </span>
    </div>
  );
}
