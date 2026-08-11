/**
 * Client-side overlay raster (Canvas2D) — the "instant feedback" half of the
 * hybrid text pipeline in rendering-semantics §7.
 *
 * §7 in one paragraph: the BINDING raster and the binding text metrics come
 * from SkiaSharp on the server; the client draws a temporary Canvas2D raster
 * while the user edits so typing is not a round trip, and swaps it for the
 * server PNG + bbox when the document settles. Export ALWAYS uses the server
 * raster; a canvas raster never reaches an export.
 *
 * TODO(M4 dalga 2, backend): there is no `POST /api/projects/{id}/overlays`
 * (or equivalent) raster/measure endpoint yet, so the swap does not happen —
 * the preview shows the canvas raster permanently and the inspector says so.
 * When the endpoint lands, this module stays as the live-editing fast path and
 * only the cache in the engine learns to prefer the server bitmap.
 *
 * Straight alpha (§6.4): a 2D canvas hands `texImage2D` UNPREMULTIPLIED pixels
 * as long as UNPACK_PREMULTIPLY_ALPHA_WEBGL is false, which the compositor
 * already guarantees. Nothing here may premultiply by hand.
 */
import { cssStackFor } from './fontManifest';
import { OVERLAY_RASTER_SCALE, SHAPE_RASTER_SCALE } from './overlayGeometry';
import { computeShapeGeometry, insetBox, type ShapeStyle } from './shapeGeometry';
import {
  canvasFontString,
  layoutText,
  type TextLayout,
  type TextStyle,
} from './textLayout';

export type { ShapeStyle };

/**
 * Raster ceiling in device px. A 2x raster of a full-frame 4K overlay is
 * 7680 px wide; this cap keeps one overlay texture under ~64 MB and degrades
 * by LOWERING the raster factor (reported back as `baseScale`) instead of
 * refusing to draw.
 */
export const MAX_OVERLAY_RASTER_PX = 4096;

export interface OverlayRaster {
  /** The bitmap to upload as a texture. */
  canvas: HTMLCanvasElement;
  /** Raster size in px (= bbox * effective raster factor). */
  width: number;
  height: number;
  /** §7 bbox in PROJECT px — what the geometry/gizmo box measures. */
  bboxWidthPx: number;
  bboxHeightPx: number;
  /**
   * Source px -> composition px factor at `transform.scale === 1`
   * (= bboxWidthPx / width). Normally 1/OVERLAY_RASTER_SCALE; larger when the
   * raster had to be shrunk by MAX_OVERLAY_RASTER_PX.
   */
  baseScale: number;
}

// ---------------------------------------------------------------------------
// Measuring (shared offscreen context)
// ---------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === 'undefined') {
    measureCtx = null;
    return null;
  }
  measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/**
 * Layout of a text style using the browser's own metrics. Falls back to a
 * crude per-character estimate when there is no DOM (unit tests, SSR) so
 * callers never have to branch.
 */
export function measureTextLayout(style: TextStyle): TextLayout {
  const ctx = getMeasureCtx();
  if (!ctx) {
    return layoutText(style, (line, s) => line.length * s.fontSizePx * 0.55);
  }
  return layoutText(style, (line, s) => {
    ctx.font = canvasFontString(s, cssStackFor(s.fontId));
    return ctx.measureText(line).width;
  });
}

// ---------------------------------------------------------------------------
// Cache keys — any style change must produce a different string
// ---------------------------------------------------------------------------

export function textRasterKey(style: TextStyle): string {
  return JSON.stringify([
    'text',
    style.content,
    style.fontId,
    style.fontSizePx,
    style.fontWeight,
    style.italic,
    style.fill,
    style.stroke?.color ?? null,
    style.stroke?.widthPx ?? 0,
    style.background?.color ?? null,
    style.background?.paddingPx ?? 0,
    style.background?.radiusPx ?? 0,
    style.align,
    style.lineHeight,
  ]);
}

export function shapeRasterKey(shape: ShapeStyle, boxW: number, boxH: number): string {
  return JSON.stringify([
    'shape',
    shape.type,
    shape.fill,
    shape.stroke?.color ?? null,
    shape.stroke?.widthPx ?? 0,
    shape.radiusPx ?? 0,
    boxW,
    boxH,
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Raster factor that keeps the bitmap under MAX_OVERLAY_RASTER_PX. */
function rasterFactor(bboxW: number, bboxH: number, wanted: number): number {
  const longest = Math.max(bboxW, bboxH);
  if (!(longest > 0)) return wanted;
  return Math.min(wanted, MAX_OVERLAY_RASTER_PX / longest);
}

/**
 * Allocates the bitmap and installs the project-px coordinate system, so every
 * draw call below works in PROJECT pixels and the raster factor is applied
 * once, here.
 */
function beginRaster(
  bboxWidthPx: number,
  bboxHeightPx: number,
  wantedFactor: number = OVERLAY_RASTER_SCALE,
): { ctx: CanvasRenderingContext2D; raster: OverlayRaster } | null {
  if (typeof document === 'undefined') return null;
  const bboxW = Math.max(1, bboxWidthPx);
  const bboxH = Math.max(1, bboxHeightPx);
  const factor = rasterFactor(bboxW, bboxH, wantedFactor);
  const width = Math.max(1, Math.round(bboxW * factor));
  const height = Math.max(1, Math.round(bboxH * factor));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  // Derive the factor from the ROUNDED size so `bbox * baseScale` and the real
  // bitmap agree to the pixel (a rounded-up raster would otherwise draw ~0.5 px
  // wider than the gizmo box).
  ctx.setTransform(width / bboxW, 0, 0, height / bboxH, 0, 0);
  return {
    ctx,
    raster: {
      canvas,
      width,
      height,
      bboxWidthPx: bboxW,
      bboxHeightPx: bboxH,
      baseScale: bboxW / width,
    },
  };
}

/** Rounded-rect path (ctx.roundRect is not available everywhere yet). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Rasterizes a text style at @2x its project-space bbox. Returns null when
 * there is no DOM (unit tests) — callers treat that as "no overlay texture".
 */
export function rasterizeText(style: TextStyle): OverlayRaster | null {
  const layout = measureTextLayout(style);
  const started = beginRaster(layout.bboxWidthPx, layout.bboxHeightPx);
  if (!started) return null;
  const { ctx, raster } = started;

  const background = style.background;
  if (background && background.color) {
    ctx.fillStyle = background.color;
    roundRectPath(ctx, 0, 0, layout.bboxWidthPx, layout.bboxHeightPx, background.radiusPx);
    ctx.fill();
  }

  ctx.font = canvasFontString(style, cssStackFor(style.fontId));
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const stroke = style.stroke;
  for (const line of layout.lines) {
    if (line.text.length === 0) continue;
    if (stroke && stroke.widthPx > 0) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.widthPx;
      ctx.strokeText(line.text, line.xPx, line.centerYPx);
    }
    ctx.fillStyle = style.fill;
    ctx.fillText(line.text, line.xPx, line.centerYPx);
  }
  return raster;
}

/**
 * Rasterizes a shape into its natural box (= the project frame).
 *
 * Every number here comes from `computeShapeGeometry`, the mirror of the
 * export's ShapeGeometry.cs, and the draw order mirrors SkiaOverlayRasterService
 * .DrawShape: rect/ellipse = fill then optional stroke on the inset box;
 * line/arrow = a BUTT-capped body in the stroke colour (falling back to `fill`)
 * plus a filled head. Preview and export must draw the same shape, not merely a
 * similar one.
 */
export function rasterizeShape(
  shape: ShapeStyle,
  boxWidthPx: number,
  boxHeightPx: number,
): OverlayRaster | null {
  const g = computeShapeGeometry(shape, boxWidthPx, boxHeightPx);
  const started = beginRaster(g.boxWidthPx, g.boxHeightPx, SHAPE_RASTER_SCALE);
  if (!started) return null;
  const { ctx, raster } = started;
  const strokeColor = g.strokeWidthPx > 0 ? shape.stroke?.color : undefined;

  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';

  if (shape.type === 'rect' || shape.type === 'ellipse') {
    const box = insetBox(g);
    const w = Math.max(0.5, box.right - box.left);
    const h = Math.max(0.5, box.bottom - box.top);
    if (shape.type === 'rect') {
      roundRectPath(ctx, box.left, box.top, w, h, g.cornerRadiusPx);
    } else {
      ctx.beginPath();
      ctx.ellipse(box.left + w / 2, box.top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.closePath();
    }
    ctx.fillStyle = shape.fill;
    ctx.fill();
    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = g.strokeWidthPx;
      ctx.stroke();
    }
    return raster;
  }

  // line / arrow: one body in a single colour (two colours on a single-body
  // shape would be meaningless — the export makes the same call).
  const color = strokeColor ?? shape.fill;
  const y = g.boxHeightPx / 2;
  const x0 = g.lineThicknessPx / 2;
  const tipX = g.boxWidthPx - g.lineThicknessPx / 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = g.lineThicknessPx;

  if (shape.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(tipX, y);
    ctx.stroke();
    return raster;
  }

  const headBaseX = tipX - g.arrowHeadLengthPx;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(headBaseX, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tipX, y);
  ctx.lineTo(headBaseX, y - g.arrowHeadHalfWidthPx);
  ctx.lineTo(headBaseX, y + g.arrowHeadHalfWidthPx);
  ctx.closePath();
  ctx.fill();
  return raster;
}
