/**
 * Clip speed badge (M5) — the "2x" pill in a clip's name bar.
 *
 * Why the timeline needs it at all: speed is the only clip property that makes
 * the block's LENGTH lie about its content (a 10 s source at 2x is a 5 s
 * block). Without a marker the user has no way to tell a sped-up clip from a
 * trimmed one, and the difference decides what a trim will do.
 *
 * The label is a pure function so the wording is unit-tested rather than
 * eyeballed on a canvas; the drawing half is deliberately dumb.
 */
import type { Clip } from '@videoedit/timeline-schema';
import { isMediaClip } from '@videoedit/timeline-schema';

/**
 * Narrowest clip that still gets a badge — the SAME gate the name bar uses.
 *
 * It is deliberately low. A fitted timeline draws a 3 s clip at ~25 px, and
 * that is exactly the case where the badge matters most: the shorter the
 * block, the more its length hides the fact that the clip was re-timed. When
 * the pill and the name cannot both fit, drawTracks drops the NAME.
 */
export const SPEED_BADGE_MIN_CLIP_W = 24;

/**
 * "2x" / "0.5x" / "1.25x", or null when the clip runs at native speed (rate 1
 * is the absence of information, and a badge on every clip is no badge).
 *
 * Rates are stored rounded to 3 decimals (timelineOps.SPEED_DECIMALS); the
 * label drops trailing zeros so the presets read as "2x", not "2.000x".
 */
export function speedBadgeLabel(clip: Clip): string | null {
  if (!isMediaClip(clip)) return null;
  const rate = clip.speed.rate;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const rounded = Math.round(rate * 1000) / 1000;
  if (rounded === 1) return null;
  return `${String(rounded)}x`;
}

/**
 * Paints the badge at the RIGHT end of the clip's name bar. Caller has already
 * clipped to the clip body, so the pill can never bleed onto a neighbour.
 * Returns the pill width (0 when nothing was drawn).
 */
export function drawSpeedBadge(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  y: number,
  w: number,
  barH: number,
): number {
  if (w < SPEED_BADGE_MIN_CLIP_W) return 0;
  const label = speedBadgeLabel(clip);
  if (label === null) return 0;

  ctx.save();
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const textW = ctx.measureText(label).width;
  const padX = 3;
  const pillW = textW + padX * 2;
  // Nothing to gain from a pill wider than its clip.
  if (pillW + 6 > w) {
    ctx.restore();
    return 0;
  }
  const pillH = barH - 4;
  const pillX = x + w - pillW - 3;
  const pillY = y + 2;
  ctx.fillStyle = 'rgba(250, 204, 21, 0.85)'; // amber: "this clip is re-timed"
  ctx.beginPath();
  const r = Math.min(3, pillH / 2);
  ctx.moveTo(pillX + r, pillY);
  ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
  ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
  ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
  ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1c1917';
  ctx.fillText(label, pillX + padX, pillY + pillH / 2);
  ctx.restore();
  return pillW;
}
