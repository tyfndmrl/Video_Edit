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
 * WHAT THE METİN-OVERLAY DENETİMİ CHANGED HERE (bulgu #2 and #3a):
 * - the layout rule is now the SERVER's, shared through textLayout.ts and
 *   pinned cross-language by test-vectors/text-layout-vectors.json. The bbox is
 *   a union of boxes (not `content + 2*(stroke + padding)`), the background is
 *   painted on `content ± padding` (not on the whole bbox), and lines are drawn
 *   on real baselines (not on `textBaseline: 'middle'` guesses);
 * - the font is the SAME FILE the export uses: fontCatalogue.ts installs
 *   `@font-face` rules for the curated TTFs served by `GET /api/fonts/...`, so
 *   `measureText` shapes the file SkiaSharp rasterizes, not a lookalike the OS
 *   happened to have.
 *
 * STILL OPEN (docs/backlog.md, "Sunucu overlay ölçüm/raster ucu"): there is no
 * `POST /api/overlays/measure` yet, so the client's Canvas2D shaping is still a
 * SECOND shaping engine next to HarfBuzz. Same rule, same file, but ligatures /
 * RTL / emoji can still differ by a few pixels — the inspector note says so.
 * When the endpoint lands, this module stays as the live-editing fast path and
 * only the cache in the engine learns to prefer the server bitmap.
 *
 * Straight alpha (§6.4): a 2D canvas hands `texImage2D` UNPREMULTIPLIED pixels
 * as long as UNPACK_PREMULTIPLY_ALPHA_WEBGL is false, which the compositor
 * already guarantees. Nothing here may premultiply by hand.
 */
import { cssStackFor, fontCatalogueRevision } from './fontManifest';
import { OVERLAY_RASTER_SCALE, SHAPE_RASTER_SCALE } from './overlayGeometry';
import { computeShapeGeometry, insetBox, type ShapeStyle } from './shapeGeometry';
import {
  EMPTY_INK,
  canvasFontString,
  layoutText,
  type GlyphMeasurer,
  type InkBox,
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
 * Probe string for the FONT box metrics. `fontBoundingBox*` is a property of
 * the font, not of the text, but a browser only fills it in for a real
 * measurement — an empty string is not one.
 */
const METRICS_PROBE = 'Hg';

/**
 * Browser measurer — Canvas2D `measureText`, mapped onto the SHARED contract in
 * textLayout.ts (the same interface `IGlyphMeasurer` gives SkiaSharp).
 *
 * SIGN CONVENTION: Canvas reports every metric as a POSITIVE distance from the
 * baseline; Skia (and therefore our layout contract) wants a NEGATIVE ascent
 * and an ink box whose `top` is negative above the baseline. The negations
 * below are that conversion — getting them wrong flips the box vertically.
 */
function browserMeasurer(ctx: CanvasRenderingContext2D, style: TextStyle): GlyphMeasurer {
  ctx.font = canvasFontString(style, cssStackFor(style.fontId));
  const probe = ctx.measureText(METRICS_PROBE);
  const ascent = probe.fontBoundingBoxAscent;
  const descent = probe.fontBoundingBoxDescent;
  // Very old engines omit fontBoundingBox*; fall back to the em box so the
  // vertical model degrades predictably instead of producing NaN.
  const usable = Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0;
  return {
    metrics: usable
      ? { ascent: -ascent, descent }
      : { ascent: -style.fontSizePx * 0.8, descent: style.fontSizePx * 0.2 },
    advance: (line) => {
      ctx.font = canvasFontString(style, cssStackFor(style.fontId));
      return ctx.measureText(line).width;
    },
    ink: (line): InkBox => {
      if (line.length === 0) return EMPTY_INK;
      ctx.font = canvasFontString(style, cssStackFor(style.fontId));
      const m = ctx.measureText(line);
      const left = -m.actualBoundingBoxLeft;
      const right = m.actualBoundingBoxRight;
      const top = -m.actualBoundingBoxAscent;
      const bottom = m.actualBoundingBoxDescent;
      if (![left, right, top, bottom].every(Number.isFinite)) return EMPTY_INK;
      return { left, top, right, bottom };
    },
  };
}

/**
 * DOM-less measurer (unit tests, SSR): a crude synthetic font so callers never
 * have to branch. Deliberately NOT the vector file's font — the vector tests
 * drive `layoutText` directly with their own measurer.
 */
function estimateMeasurer(style: TextStyle): GlyphMeasurer {
  const cell = style.fontSizePx * 0.55;
  return {
    metrics: { ascent: -style.fontSizePx * 0.8, descent: style.fontSizePx * 0.2 },
    advance: (line) => line.length * cell,
    ink: (line): InkBox => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return EMPTY_INK;
      return {
        left: (line.length - line.trimStart().length) * cell,
        top: -style.fontSizePx * 0.7,
        right: (line.length - (line.length - line.trimEnd().length)) * cell,
        bottom: style.fontSizePx * 0.1,
      };
    },
  };
}

/**
 * Layout of a text style using the browser's own metrics, through the SHARED
 * rule in textLayout.ts (mirrored by TextLayoutEngine.cs and pinned by
 * test-vectors/text-layout-vectors.json).
 */
export function measureTextLayout(style: TextStyle): TextLayout {
  const ctx = getMeasureCtx();
  return layoutText(style, ctx ? browserMeasurer(ctx, style) : estimateMeasurer(style));
}

// ---------------------------------------------------------------------------
// Cache keys — any style change must produce a different string
// ---------------------------------------------------------------------------

export function textRasterKey(style: TextStyle): string {
  return JSON.stringify([
    'text',
    // Font catalogue revision: the SAME style measures differently before and
    // after the curated TTF finishes downloading (@font-face, fontCatalogue.ts).
    // Without it the first raster — drawn with the generic fallback — would be
    // cached forever and the preview would never show the export's font.
    fontCatalogueRevision(),
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

  // Move to CONTENT-box coordinates, exactly like the export
  // (SkiaOverlayRasterService: `canvas.Translate(originX, originY)`). Every
  // number below is then the same number the server uses.
  ctx.translate(layout.originXPx, layout.originYPx);

  const background = style.background;
  if (background && background.color && layout.backgroundRect) {
    // CONTENT ± padding — NOT the bbox. Painting the bbox (what this file used
    // to do) also covered the stroke overhang, which is exactly the divergence
    // metin-overlay denetimi bulgu #2 measured (42x34 here vs 30x22 in the export).
    const rect = layout.backgroundRect;
    ctx.fillStyle = background.color;
    roundRectPath(
      ctx,
      rect.left,
      rect.top,
      rect.right - rect.left,
      rect.bottom - rect.top,
      background.radiusPx,
    );
    ctx.fill();
  }

  ctx.font = canvasFontString(style, cssStackFor(style.fontId));
  // ALPHABETIC baseline: the layout hands out real baselines (CSS half-leading
  // model), the same ones SkiaSharp draws at. 'middle' would re-derive the
  // vertical position from the browser's own em box and drift.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Round join AND round cap — SKStrokeJoin.Round + SKStrokeCap.Round in the
  // export. A mitre here would put spikes on the preview's glyph corners.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const stroke = style.stroke;
  for (const line of layout.lines) {
    if (line.text.length === 0) continue;
    // Stroke FIRST, fill after: the fill covers the inner half of the stroke,
    // so only strokeWidth/2 spills outward (what the bbox reserved).
    if (stroke && stroke.widthPx > 0) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.widthPx;
      ctx.strokeText(line.text, line.leftPx, line.baselineYPx);
    }
    ctx.fillStyle = style.fill;
    ctx.fillText(line.text, line.leftPx, line.baselineYPx);
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
