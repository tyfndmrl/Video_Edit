/**
 * Ruler canvas — adaptive tick labels (hour -> minute -> second -> frame,
 * design 01 §3.5). Non-drop timecode semantics on the project fps grid.
 */
import {
  frameToUs,
  roundHalfUp,
  usToFrame,
  type MicroSec,
  type Rational,
  type Marker,
} from '@videoedit/timeline-schema';
import { RULER_H, timeToX } from '../geometry';

export interface RulerRenderState {
  widthPx: number;
  dpr: number;
  scrollUs: MicroSec;
  pxPerUs: number;
  fps: Rational;
  markers: readonly Marker[];
}

const COLORS = {
  bg: '#14161c',
  tick: '#3a3f4d',
  tickMinor: '#262b36',
  label: '#8b93a7',
  marker: '#22c55e',
  border: '#2a2f3a',
};

/**
 * Choose the label step: the smallest "nice" interval covering >= targetPx.
 * Frame-level steps only appear when a single frame is wide enough.
 */
export function chooseRulerStepUs(pxPerUs: number, fps: Rational): MicroSec {
  const targetPx = 80;
  const frameUs = Math.max(1, frameToUs(1, fps));
  const nominalFps = Math.max(1, roundHalfUp(fps.num / fps.den));
  const steps: MicroSec[] = [];
  for (const f of [1, 2, 5, 10]) {
    if (f < nominalFps) steps.push(f * frameUs);
  }
  const S = 1_000_000;
  steps.push(S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S);
  steps.push(60 * S, 2 * 60 * S, 5 * 60 * S, 10 * 60 * S, 30 * 60 * S);
  steps.push(3600 * S, 2 * 3600 * S, 6 * 3600 * S);
  for (const s of steps) {
    if (s * pxPerUs >= targetPx) return s;
  }
  return steps[steps.length - 1];
}

/** Compact adaptive label: frames zoom shows SS:FF / M:SS:FF, wider shows M:SS or H:MM:SS. */
export function formatRulerLabel(timeUs: MicroSec, stepUs: MicroSec, fps: Rational): string {
  const totalSeconds = Math.floor(timeUs / 1_000_000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  if (stepUs < 1_000_000) {
    const nominalFps = Math.max(1, roundHalfUp(fps.num / fps.den));
    const ff = usToFrame(timeUs, fps) % nominalFps;
    const base = h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
    return `${base}:${p2(ff)}`;
  }
  if (h > 0) return `${h}:${p2(m)}:${p2(s)}`;
  return `${m}:${p2(s)}`;
}

export function drawRuler(ctx: CanvasRenderingContext2D, state: RulerRenderState): void {
  const { widthPx, dpr, scrollUs, pxPerUs, fps } = state;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, widthPx, RULER_H);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, widthPx, RULER_H);

  const stepUs = chooseRulerStepUs(pxPerUs, fps);
  const minorStepUs = stepUs / 5;
  const startUs = Math.max(0, scrollUs - stepUs);
  const endUs = scrollUs + widthPx / pxPerUs + stepUs;

  // Minor ticks.
  ctx.strokeStyle = COLORS.tickMinor;
  ctx.beginPath();
  const firstMinor = Math.floor(startUs / minorStepUs) * minorStepUs;
  for (let t = firstMinor; t <= endUs; t += minorStepUs) {
    if (t < 0) continue;
    const x = Math.round(timeToX(t, scrollUs, pxPerUs)) + 0.5;
    ctx.moveTo(x, RULER_H - 6);
    ctx.lineTo(x, RULER_H);
  }
  ctx.stroke();

  // Major ticks + labels.
  ctx.strokeStyle = COLORS.tick;
  ctx.fillStyle = COLORS.label;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  const firstMajor = Math.floor(startUs / stepUs) * stepUs;
  for (let t = firstMajor; t <= endUs; t += stepUs) {
    if (t < 0) continue;
    const x = Math.round(timeToX(t, scrollUs, pxPerUs)) + 0.5;
    ctx.moveTo(x, RULER_H - 12);
    ctx.lineTo(x, RULER_H);
    ctx.fillText(formatRulerLabel(t, stepUs, fps), x + 4, RULER_H - 17);
  }
  ctx.stroke();

  // Markers: small green diamonds on the ruler baseline.
  for (const marker of state.markers) {
    const x = timeToX(marker.timeUs, scrollUs, pxPerUs);
    if (x < -8 || x > widthPx + 8) continue;
    ctx.fillStyle = marker.color ?? COLORS.marker;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 10);
    ctx.lineTo(x + 4, RULER_H - 5);
    ctx.lineTo(x, RULER_H);
    ctx.lineTo(x - 4, RULER_H - 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = COLORS.border;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(widthPx, RULER_H - 0.5);
  ctx.stroke();
  ctx.restore();
}
