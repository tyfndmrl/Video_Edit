/**
 * Overlay (text / shape) raster geometry — the numbers BOTH the preview and the
 * export raster have to agree on.
 *
 * rendering-semantics §7 fixes two of them:
 * - the raster is produced at **2x** the project-space bbox (`rasterPx = bboxPx * 2`)
 *   and drawn with a compensating 0.5 factor, so `scale <= 2` never upsamples;
 * - the drawn size is `bboxPx * transform.scale` — an overlay raster is NOT
 *   fit-to-composition like a video frame (§2.2 `fit=contain` applies to MEDIA).
 *
 * That second point is why `OVERLAY_BASE_SCALE` exists: core/transform.ts takes
 * an optional `baseScale` that REPLACES `fitScale`, and for an overlay it is
 * exactly `1 / OVERLAY_RASTER_SCALE`. Same factor in the compositor, in the
 * gizmo and (once the server raster lands) in the export compiler.
 *
 * SHAPE BOX: `ShapeClip` carries no size field, so the natural box of a shape
 * is the PROJECT FRAME — the same rule the export raster enforces
 * (`backend/src/VideoEdit.Media/Text/ShapeGeometry.cs`, which spells out why:
 * "scale = 1 means fit" is only definable when the natural box IS the
 * composition). `scale = 1` is a full-frame shape and the user scales down;
 * the aspect ratio is fixed because the scale is uniform (a wide thin bar is
 * not expressible in the MVP schema — the inspector says so out loud).
 *
 * This module and ShapeGeometry.cs are a matched pair: changing the rule on one
 * side alone makes the preview lie about the export.
 */
import type { ProjectSettings } from '@videoedit/timeline-schema';

/** §7: rasterize at 2x the project-space bbox. */
export const OVERLAY_RASTER_SCALE = 2;

/**
 * Source(raster) px -> composition px factor at `transform.scale === 1`.
 * Passed to computePlacement as `baseScale` (instead of fit=contain).
 */
export const OVERLAY_BASE_SCALE = 1 / OVERLAY_RASTER_SCALE;

/** Natural box of a shape = the project frame (see the file header). */
export function shapeBoxPx(settings: Pick<ProjectSettings, 'width' | 'height'>): {
  width: number;
  height: number;
} {
  return { width: Math.max(2, settings.width), height: Math.max(2, settings.height) };
}

/**
 * Raster factor for SHAPES, deliberately 1 instead of the §7 @2x used for text.
 *
 * A shape's bbox is the whole frame, so @2x would allocate a 3840x2160 texture
 * (~33 MB) per shape in the preview. The raster factor does NOT move geometry —
 * `baseScale = bbox / rasterPx` cancels it out, which is the whole point of
 * carrying baseScale — so the only cost is softer edges when a shape is scaled
 * ABOVE 1. The export still rasterizes at @2x (ChooseRasterScale), i.e. this is
 * a preview-quality choice, not a contract difference.
 */
export const SHAPE_RASTER_SCALE = 1;
