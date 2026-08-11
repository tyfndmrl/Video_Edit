/**
 * Timeline body painter — track lanes, clip blocks (name + filmstrip slices +
 * waveforms), selection, drag ghosts, marquee and the snap guide. Draws ONLY
 * the visible time range (viewport virtualization) and produces the hit-test
 * rect list as a side product of drawing.
 */
import {
  isMediaClip,
  type Clip,
  type MediaClip,
  type MicroSec,
  type TimelineDoc,
  type Uuid,
} from '@videoedit/timeline-schema';
import type { AssetSummary } from '../../../state/assetStore';
import { splitLines } from '../../text/textLayout';
import {
  NEW_TRACK_ZONE_H,
  TRACK_H,
  TRANSITION_BADGE_H,
  TRANSITION_BADGE_MIN_CLIP_W,
  TRANSITION_BADGE_W,
  TRIM_HANDLE_W,
  timeToX,
  trackTop,
  transitionBadgeTop,
  visibleRangeUs,
} from '../geometry';
import type { ClipHitRect } from '../hitTest';
import { getFilmstripManifest, getSpriteImage, getWaveformPeaks } from './mediaCache';
import { drawSpeedBadge } from './speedBadge';

// ---------------------------------------------------------------------------
// Drag visual state (owned by the pointer code, drawn here)
// ---------------------------------------------------------------------------

export type DragVisual =
  | {
      kind: 'move';
      /** clipId -> ghost position (uniform delta already applied). */
      ghosts: { clipId: Uuid; trackIndex: number; startUs: MicroSec; durationUs: MicroSec }[];
      valid: boolean;
      guideUs: MicroSec | null;
    }
  | {
      kind: 'trim';
      guideUs: MicroSec | null;
    }
  | {
      kind: 'insert';
      trackIndex: number | 'new';
      startUs: MicroSec;
      durationUs: MicroSec;
      valid: boolean;
      guideUs: MicroSec | null;
    }
  | {
      kind: 'marquee';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    };

export interface BodyRenderState {
  doc: TimelineDoc;
  widthPx: number;
  heightPx: number;
  dpr: number;
  scrollUs: MicroSec;
  pxPerUs: number;
  scrollY: number;
  selection: ReadonlySet<Uuid>;
  assets: ReadonlyMap<Uuid, AssetSummary>;
  drag: DragVisual | null;
}

const COLORS = {
  laneVideo: '#191d26',
  laneAudio: '#171d1a',
  laneOverlay: '#1d1926',
  laneStroke: '#242936',
  newTrackZone: '#12141a',
  newTrackText: '#525a6b',
  clipVideo: '#2b3a55',
  clipVideoStroke: '#3d5a80',
  clipAudio: '#25402f',
  clipAudioStroke: '#3a5f4a',
  clipImage: '#40325c',
  clipImageStroke: '#5b4a7f',
  clipOther: '#4a3b23',
  clipOtherStroke: '#6b5733',
  clipName: '#d5dae4',
  nameBar: 'rgba(0,0,0,0.35)',
  selection: '#e8833a',
  waveform: '#57c785',
  ghostValid: 'rgba(232,131,58,0.35)',
  ghostValidStroke: '#e8833a',
  ghostInvalid: 'rgba(239,68,68,0.35)',
  ghostInvalidStroke: '#ef4444',
  guide: '#e8833a',
  marqueeFill: 'rgba(90,140,255,0.15)',
  marqueeStroke: '#5a8cff',
  lockedOverlay: 'rgba(0,0,0,0.35)',
  hiddenOverlay: 'rgba(10,12,16,0.55)',
  transitionBand: 'rgba(232,131,58,0.30)',
  transitionBandStroke: '#e8833a',
  transitionBadge: '#e8833a',
  transitionBadgeIdle: 'rgba(120,130,150,0.55)',
  transitionBadgeGlyph: '#12141a',
};

const NAME_BAR_H = 15;

/**
 * Name-bar text. Overlay clips have no asset to name them after, and the raw
 * schema kind ("text", "shape") is developer vocabulary — a caption track full
 * of blocks reading "text" tells the user nothing about which caption is which.
 */
function clipLabel(clip: Clip, assets: ReadonlyMap<Uuid, AssetSummary>): string {
  if (isMediaClip(clip) || clip.kind === 'sticker') {
    const assetName = assets.get(clip.assetId)?.name;
    if (assetName) return assetName;
    return clip.kind === 'sticker' ? 'Çıkartma' : 'Klip';
  }
  if (clip.kind === 'text') {
    // splitLines() is the SAME rule the raster uses (features/text/textLayout),
    // so the label is literally the first line the user sees on the canvas.
    const firstLine = splitLines(clip.text.content)[0]?.trim() ?? '';
    return firstLine.length > 0 ? firstLine.slice(0, 60) : 'Metin';
  }
  return SHAPE_LABELS[clip.shape.type];
}

const SHAPE_LABELS: Record<'rect' | 'ellipse' | 'line' | 'arrow', string> = {
  rect: 'Dikdörtgen',
  ellipse: 'Elips',
  line: 'Çizgi',
  arrow: 'Ok',
};

function clipFill(kind: Clip['kind']): { fill: string; stroke: string } {
  switch (kind) {
    case 'video':
      return { fill: COLORS.clipVideo, stroke: COLORS.clipVideoStroke };
    case 'audio':
      return { fill: COLORS.clipAudio, stroke: COLORS.clipAudioStroke };
    case 'image':
      return { fill: COLORS.clipImage, stroke: COLORS.clipImageStroke };
    default:
      return { fill: COLORS.clipOther, stroke: COLORS.clipOtherStroke };
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Filmstrip
// ---------------------------------------------------------------------------

function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  clip: MediaClip,
  asset: AssetSummary,
  x: number,
  y: number,
  w: number,
  h: number,
  pxPerUs: number,
  visibleX0: number,
  visibleX1: number,
): void {
  if (!asset.filmstripManifestUrl) return;
  const manifest = getFilmstripManifest(asset.id, asset.filmstripManifestUrl);
  if (!manifest || manifest.tileH <= 0) return;

  const framesPerSprite = manifest.cols * manifest.rows;
  const tileDrawW = Math.max(8, manifest.tileW * (h / manifest.tileH));
  const rate = clip.speed.rate;

  const drawX0 = Math.max(x, visibleX0);
  const drawX1 = Math.min(x + w, visibleX1);
  if (drawX1 <= drawX0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Tiles are laid out on a fixed grid anchored at the clip's left edge so
  // zooming/panning never "swims"; each tile shows the source frame at the
  // tile's own timeline position (zoom-adaptive frame skipping falls out).
  const firstTile = Math.floor((drawX0 - x) / tileDrawW);
  const lastTile = Math.ceil((drawX1 - x) / tileDrawW);
  for (let i = firstTile; i <= lastTile; i++) {
    const tileX = x + i * tileDrawW;
    const offsetUs = Math.max(0, (tileX - x) / pxPerUs);
    const sourceUs = clip.sourceInUs + Math.round(offsetUs * rate);
    let frame = Math.floor(sourceUs / manifest.intervalUs);
    frame = Math.max(0, Math.min(manifest.frameCount - 1, frame));
    const spriteIndex = Math.floor(frame / framesPerSprite);
    const inSprite = frame % framesPerSprite;
    const spriteName = manifest.sprites[spriteIndex];
    if (!spriteName) continue;
    const url = asset.sprites?.[spriteName] ?? (spriteIndex === 0 ? asset.filmstripUrl : undefined);
    if (!url) continue;
    const img = getSpriteImage(asset.id, spriteName, url);
    if (!img) continue;
    const sx = (inSprite % manifest.cols) * manifest.tileW;
    const sy = Math.floor(inSprite / manifest.cols) * manifest.tileH;
    ctx.drawImage(img, sx, sy, manifest.tileW, manifest.tileH, tileX, y, tileDrawW, h);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  clip: MediaClip,
  asset: AssetSummary,
  x: number,
  y: number,
  w: number,
  h: number,
  pxPerUs: number,
  visibleX0: number,
  visibleX1: number,
): void {
  if (!asset.waveformUrl) return;
  const peaks = getWaveformPeaks(asset.id, asset.waveformUrl);
  if (!peaks || peaks.length === 0) return;

  const drawX0 = Math.max(x, Math.floor(visibleX0));
  const drawX1 = Math.min(x + w, Math.ceil(visibleX1));
  if (drawX1 <= drawX0) return;

  const rate = clip.speed.rate;
  const usPerPeak = peaks.secondsPerPeak * 1_000_000;
  const mid = y + h / 2;
  const amp = h / 2 - 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = COLORS.waveform;
  ctx.globalAlpha = 0.85;

  for (let px = drawX0; px < drawX1; px++) {
    // Source-time window covered by this pixel column.
    const t0 = clip.sourceInUs + (px - x) / pxPerUs * rate;
    const t1 = clip.sourceInUs + (px + 1 - x) / pxPerUs * rate;
    let i0 = Math.floor(t0 / usPerPeak);
    let i1 = Math.max(i0 + 1, Math.ceil(t1 / usPerPeak));
    i0 = Math.max(0, Math.min(peaks.length - 1, i0));
    i1 = Math.max(1, Math.min(peaks.length, i1));
    let min = 127;
    let max = -128;
    for (let i = i0; i < i1; i++) {
      const lo = peaks.data[2 * i];
      const hi = peaks.data[2 * i + 1];
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    if (max < min) continue;
    const yTop = mid - (max / 128) * amp;
    const yBot = mid - (min / 128) * amp;
    ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Transitions (rendering-semantics §5)
// ---------------------------------------------------------------------------

/**
 * Paints every cut of one track and returns the badge hit rects.
 *
 * Two marks per cut:
 *  - the BLEND WINDOW `[T - D/2, T + D/2]` as a translucent band with the two
 *    crossing ramps. That window is the normative one (§5.3: the transition
 *    starts D/2 BEFORE the cut and ends D/2 after it), so the drawing tells the
 *    truth about which frames are mixed — a bar drawn from T to T+D would be a
 *    lie the user only discovers in the export.
 *  - a small badge ON the cut, the click target that opens the editor. Painted
 *    for bare cuts too (grey), because a cut with no affordance is a feature
 *    nobody finds.
 */
function drawTransitions(
  ctx: CanvasRenderingContext2D,
  track: TimelineDoc['tracks'][number],
  trackIndex: number,
  laneY: number,
  scrollUs: MicroSec,
  pxPerUs: number,
  widthPx: number,
): ClipHitRect[] {
  const hits: ClipHitRect[] = [];
  const clips = track.clips;
  const badgeTop = transitionBadgeTop(trackIndex);

  for (let i = 0; i + 1 < clips.length; i++) {
    const a = clips[i];
    const b = clips[i + 1];
    if (!isMediaClip(a) || !isMediaClip(b)) continue;
    const cutUs = a.timelineStartUs + a.timelineDurationUs;
    if (cutUs !== b.timelineStartUs) continue; // gap/overlap: no cut

    const cutX = timeToX(cutUs, scrollUs, pxPerUs);
    if (cutX < -TRANSITION_BADGE_W || cutX > widthPx + TRANSITION_BADGE_W) continue;
    const aW = a.timelineDurationUs * pxPerUs;
    const bW = b.timelineDurationUs * pxPerUs;
    if (aW < TRANSITION_BADGE_MIN_CLIP_W || bW < TRANSITION_BADGE_MIN_CLIP_W) continue;

    const transition = a.transitionOut;
    if (transition !== undefined) {
      const halfPx = (transition.durationUs / 2) * pxPerUs;
      const x0 = cutX - halfPx;
      const bandW = Math.max(4, halfPx * 2);
      const y0 = laneY + 3;
      const y1 = laneY + TRACK_H - 5;
      ctx.save();
      ctx.fillStyle = COLORS.transitionBand;
      ctx.fillRect(x0, y0, bandW, y1 - y0);
      // Crossing ramps: A fading out (top-left -> bottom-right) over B fading in.
      ctx.strokeStyle = COLORS.transitionBandStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y1);
      ctx.lineTo(x0 + bandW, y0);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + bandW, y1);
      ctx.stroke();
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, bandW - 1, y1 - y0 - 1);
      ctx.restore();
    }

    // Badge.
    const bx = cutX - TRANSITION_BADGE_W / 2;
    ctx.save();
    roundRect(ctx, bx, badgeTop, TRANSITION_BADGE_W, TRANSITION_BADGE_H, 3);
    ctx.fillStyle = transition !== undefined ? COLORS.transitionBadge : COLORS.transitionBadgeIdle;
    ctx.fill();
    ctx.strokeStyle = COLORS.transitionBadgeGlyph;
    ctx.lineWidth = 1.5;
    const cx = cutX;
    const cy = badgeTop + TRANSITION_BADGE_H / 2;
    ctx.beginPath();
    if (transition !== undefined) {
      // "X" = an applied transition.
      ctx.moveTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.moveTo(cx + 4, cy - 4);
      ctx.lineTo(cx - 4, cy + 4);
    } else {
      // "+" = a bare cut that can take one.
      ctx.moveTo(cx - 4, cy);
      ctx.lineTo(cx + 4, cy);
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx, cy + 4);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.restore();

    hits.push({
      clipId: a.id,
      trackId: track.id,
      trackIndex,
      region: 'transition',
      x: bx,
      y: badgeTop,
      w: TRANSITION_BADGE_W,
      h: TRANSITION_BADGE_H,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main painter
// ---------------------------------------------------------------------------

export function drawTracks(ctx: CanvasRenderingContext2D, state: BodyRenderState): ClipHitRect[] {
  const { doc, widthPx, heightPx, dpr, scrollUs, pxPerUs, scrollY, selection, assets, drag } = state;
  const hits: ClipHitRect[] = [];
  // Appended AFTER every clip rect: hitTestClips scans from the end, so the
  // badge wins over the clip body / trim handle it overlaps.
  const transitionHits: ClipHitRect[] = [];
  const { startUs: visStartUs, endUs: visEndUs } = visibleRangeUs(scrollUs, pxPerUs, widthPx);

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.translate(0, -scrollY);

  const trackCount = doc.tracks.length;

  // Track lanes.
  for (let ti = 0; ti < trackCount; ti++) {
    const track = doc.tracks[ti];
    const y = trackTop(ti);
    if (y + TRACK_H < scrollY || y > scrollY + heightPx) continue;
    ctx.fillStyle =
      track.type === 'audio'
        ? COLORS.laneAudio
        : track.type === 'overlay'
          ? COLORS.laneOverlay
          : COLORS.laneVideo;
    ctx.fillRect(0, y, widthPx, TRACK_H);
    ctx.strokeStyle = COLORS.laneStroke;
    ctx.strokeRect(0.5, y + 0.5, widthPx - 1, TRACK_H - 1);
  }

  // New-track drop zone below the rows.
  {
    const y = trackTop(trackCount) + 2;
    ctx.fillStyle = COLORS.newTrackZone;
    ctx.fillRect(0, y, widthPx, NEW_TRACK_ZONE_H - 6);
    ctx.strokeStyle = COLORS.laneStroke;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(0.5, y + 0.5, widthPx - 1, NEW_TRACK_ZONE_H - 7);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.newTrackText;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      trackCount === 0 ? 'Kütüphaneden medya sürükleyin' : 'Yeni track için buraya bırakın',
      8,
      y + (NEW_TRACK_ZONE_H - 6) / 2,
    );
  }

  // Clips.
  for (let ti = 0; ti < trackCount; ti++) {
    const track = doc.tracks[ti];
    const y = trackTop(ti);
    if (y + TRACK_H < scrollY || y > scrollY + heightPx) continue;

    for (const clip of track.clips) {
      const clipEnd = clip.timelineStartUs + clip.timelineDurationUs;
      if (clipEnd < visStartUs || clip.timelineStartUs > visEndUs) continue;

      const x = timeToX(clip.timelineStartUs, scrollUs, pxPerUs);
      const w = Math.max(2, clip.timelineDurationUs * pxPerUs);
      const selected = selection.has(clip.id);
      const { fill, stroke } = clipFill(clip.kind);

      roundRect(ctx, x, y + 2, w, TRACK_H - 4, 4);
      ctx.fillStyle = fill;
      ctx.fill();

      const asset = isMediaClip(clip) ? assets.get(clip.assetId) : undefined;
      const contentY = y + 2 + NAME_BAR_H;
      const contentH = TRACK_H - 4 - NAME_BAR_H - 2;
      if (isMediaClip(clip) && asset && w > 16 && contentH > 8) {
        ctx.save();
        roundRect(ctx, x, y + 2, w, TRACK_H - 4, 4);
        ctx.clip();
        if (clip.kind === 'audio' || track.type === 'audio') {
          drawWaveform(ctx, clip, asset, x, contentY, w, contentH, pxPerUs, 0, widthPx);
        } else {
          drawFilmstrip(ctx, clip, asset, x, contentY, w, contentH, pxPerUs, 0, widthPx);
        }
        ctx.restore();
      }

      // Name bar.
      if (w > 24) {
        ctx.save();
        roundRect(ctx, x, y + 2, w, TRACK_H - 4, 4);
        ctx.clip();
        ctx.fillStyle = COLORS.nameBar;
        ctx.fillRect(x, y + 2, w, NAME_BAR_H);
        // Speed badge first: the name is what gets truncated when they collide
        // (a re-timed clip whose "2x" is hidden is the misleading case).
        const badgeW = drawSpeedBadge(ctx, clip, x, y + 2, w, NAME_BAR_H);
        ctx.fillStyle = COLORS.clipName;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const name = clipLabel(clip, assets);
        // On a narrow re-timed clip the badge WINS: the block length already
        // hides the speed, while the name is repeated in the inspector.
        const nameMaxW = w - 10 - badgeW;
        if (nameMaxW >= 12) {
          ctx.fillText(name, x + 5, y + 2 + NAME_BAR_H / 2, nameMaxW);
        }
        ctx.restore();
      }

      // Border (selection wins).
      roundRect(ctx, x + 0.5, y + 2.5, w - 1, TRACK_H - 5, 4);
      ctx.strokeStyle = selected ? COLORS.selection : stroke;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;

      // Hit rects (content space): trim handles carved from the body edges.
      const handleW = Math.min(TRIM_HANDLE_W, w / 3);
      hits.push({
        clipId: clip.id, trackId: track.id, trackIndex: ti, region: 'body',
        x, y, w, h: TRACK_H,
      });
      hits.push({
        clipId: clip.id, trackId: track.id, trackIndex: ti, region: 'trimL',
        x, y, w: handleW, h: TRACK_H,
      });
      hits.push({
        clipId: clip.id, trackId: track.id, trackIndex: ti, region: 'trimR',
        x: x + w - handleW, y, w: handleW, h: TRACK_H,
      });
    }

    // Cuts are painted ON TOP of the clips of this lane but UNDER the
    // hidden/locked veils, so a locked lane's badges read as unavailable.
    for (const hit of drawTransitions(ctx, track, ti, y, scrollUs, pxPerUs, widthPx)) {
      transitionHits.push(hit);
    }

    if (track.hidden) {
      ctx.fillStyle = COLORS.hiddenOverlay;
      ctx.fillRect(0, y, widthPx, TRACK_H);
    }
    if (track.locked) {
      ctx.fillStyle = COLORS.lockedOverlay;
      ctx.fillRect(0, y, widthPx, TRACK_H);
    }
  }

  // Marker lines through the body (subtle).
  ctx.strokeStyle = 'rgba(34,197,94,0.25)';
  for (const marker of doc.markers) {
    const x = Math.round(timeToX(marker.timeUs, scrollUs, pxPerUs)) + 0.5;
    if (x < -2 || x > widthPx + 2) continue;
    ctx.beginPath();
    ctx.moveTo(x, scrollY);
    ctx.lineTo(x, scrollY + heightPx);
    ctx.stroke();
  }

  // Drag visuals.
  if (drag) {
    if (drag.kind === 'move') {
      for (const g of drag.ghosts) {
        const y = trackTop(g.trackIndex);
        const x = timeToX(g.startUs, scrollUs, pxPerUs);
        const w = Math.max(2, g.durationUs * pxPerUs);
        roundRect(ctx, x, y + 2, w, TRACK_H - 4, 4);
        ctx.fillStyle = drag.valid ? COLORS.ghostValid : COLORS.ghostInvalid;
        ctx.fill();
        ctx.strokeStyle = drag.valid ? COLORS.ghostValidStroke : COLORS.ghostInvalidStroke;
        ctx.stroke();
      }
    } else if (drag.kind === 'insert') {
      const y = drag.trackIndex === 'new' ? trackTop(trackCount) + 2 : trackTop(drag.trackIndex);
      const h = drag.trackIndex === 'new' ? NEW_TRACK_ZONE_H - 6 : TRACK_H;
      const x = timeToX(drag.startUs, scrollUs, pxPerUs);
      const w = Math.max(2, drag.durationUs * pxPerUs);
      roundRect(ctx, x, y + 2, w, h - 4, 4);
      ctx.fillStyle = drag.valid ? COLORS.ghostValid : COLORS.ghostInvalid;
      ctx.fill();
      ctx.strokeStyle = drag.valid ? COLORS.ghostValidStroke : COLORS.ghostInvalidStroke;
      ctx.stroke();
    } else if (drag.kind === 'marquee') {
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0);
      const h = Math.abs(drag.y1 - drag.y0);
      ctx.fillStyle = COLORS.marqueeFill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.marqueeStroke;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    // Snap guide line (full height, orange).
    const guideUs = drag.kind === 'marquee' ? null : drag.guideUs;
    if (guideUs !== null && guideUs !== undefined) {
      const x = Math.round(timeToX(guideUs, scrollUs, pxPerUs)) + 0.5;
      ctx.strokeStyle = COLORS.guide;
      ctx.beginPath();
      ctx.moveTo(x, scrollY);
      ctx.lineTo(x, scrollY + heightPx);
      ctx.stroke();
    }
  }

  ctx.restore();
  return hits.concat(transitionHits);
}
