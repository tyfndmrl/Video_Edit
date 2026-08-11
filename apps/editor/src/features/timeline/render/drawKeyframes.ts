/**
 * Keyframe strip painter — the ONLY thing this module draws.
 *
 * It lives next to the other timeline painters (same conventions: content-space
 * geometry in, canvas ink out, no state) but on its OWN overlay canvas, so the
 * body painter's virtualization/hit-rect pipeline is untouched. Layout comes
 * from features/keyframes/stripGeometry — "what is drawn" and "what is
 * clickable" therefore read the same numbers.
 *
 * The overlay canvas covers the whole timeline wrap (ruler included), so the
 * transform is: canvasY = RULER_H + contentY - scrollY. The ruler strip is
 * clipped away, because a diamond scrolled under the ruler must not paint over
 * the timecode.
 */
import {
  KEYFRAME_DIAMOND_R,
  KEYFRAME_ROW_H,
  type StripLayout,
} from '../../keyframes/stripGeometry';
import { RULER_H } from '../geometry';

export interface KeyframeLayerState {
  layout: StripLayout | null;
  widthPx: number;
  heightPx: number;
  dpr: number;
  scrollY: number;
  /** The diamond currently under the pointer / being dragged (highlighted). */
  active: { channel: string; timeUs: number } | null;
}

const COLORS = {
  band: 'rgba(12,14,20,0.72)',
  bandStroke: 'rgba(232,131,58,0.45)',
  baseline: 'rgba(255,255,255,0.14)',
  label: 'rgba(214,220,232,0.75)',
  diamondStroke: '#0c0e14',
  activeStroke: '#ffffff',
  chip: 'rgba(232,131,58,0.85)',
  chipText: '#12141a',
};

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

export function drawKeyframeStrip(
  ctx: CanvasRenderingContext2D,
  state: KeyframeLayerState,
): void {
  const { layout, widthPx, heightPx, dpr, scrollY, active } = state;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, Math.max(1, widthPx * dpr), Math.max(1, heightPx * dpr));
  if (!layout || layout.rows.length === 0) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  // Body area only: never paint over the ruler.
  ctx.beginPath();
  ctx.rect(0, RULER_H, widthPx, Math.max(0, heightPx - RULER_H));
  ctx.clip();
  ctx.translate(0, RULER_H - scrollY);

  const bandH = layout.bottomY - layout.topY;
  const bandW = layout.x1 - layout.x0;

  // Band plate: the strip must read as a separate editing surface, not as part
  // of the filmstrip it sits on.
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(layout.x0, layout.topY, bandW, bandH);
  ctx.strokeStyle = COLORS.bandStroke;
  ctx.lineWidth = 1;
  ctx.strokeRect(layout.x0 + 0.5, layout.topY + 0.5, bandW - 1, bandH - 1);

  ctx.font = '8px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (const row of layout.rows) {
    const cy = row.y + KEYFRAME_ROW_H / 2;

    // Baseline: the row's time axis.
    ctx.strokeStyle = COLORS.baseline;
    ctx.beginPath();
    ctx.moveTo(layout.x0 + 1, Math.round(cy) + 0.5);
    ctx.lineTo(layout.x1 - 1, Math.round(cy) + 0.5);
    ctx.stroke();

    // Channel tag, pinned to the left edge of the visible band.
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'left';
    ctx.fillText(row.short, layout.x0 + 2, cy);

    ctx.textAlign = 'center';
    for (const d of row.diamonds) {
      if (d.x < layout.x0 - KEYFRAME_DIAMOND_R || d.x > layout.x1 + KEYFRAME_DIAMOND_R) continue;
      const isActive =
        active !== null && active.channel === row.channel && active.timeUs === d.timeUs;
      const r = isActive ? KEYFRAME_DIAMOND_R + 1 : KEYFRAME_DIAMOND_R;
      diamond(ctx, d.x, cy, r);
      ctx.fillStyle = row.color;
      ctx.fill();
      ctx.strokeStyle = isActive ? COLORS.activeStroke : COLORS.diamondStroke;
      ctx.lineWidth = isActive ? 1.5 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // "+N": channels that are animated but did not fit. Silence here would read
  // as "the strip lost my keyframes"; the Inspector still edits every channel.
  if (layout.hiddenChannels.length > 0) {
    const text = `+${layout.hiddenChannels.length}`;
    const w = 16;
    const x = layout.x1 - w - 2;
    const y = layout.topY + 1;
    ctx.fillStyle = COLORS.chip;
    ctx.fillRect(x, y, w, KEYFRAME_ROW_H - 1);
    ctx.fillStyle = COLORS.chipText;
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w / 2, y + (KEYFRAME_ROW_H - 1) / 2);
  }

  ctx.restore();
}
