/**
 * Text layout — where every line, the bounding box and the background rect sit,
 * as PURE math.
 *
 * SINGLE RULE (rendering-semantics §7, M4 dalga-2 denetimi bulgu #2). Until this
 * rewrite the client used `bbox = content + 2*(stroke + backgroundPadding)` and
 * painted the background over the WHOLE bbox, while the server used a union of
 * boxes and painted the background over `content ± padding`. Two rules = two
 * different pictures (measured: 32x24 vs 26x14 at stroke 6). There is now ONE
 * rule and it is the server's, mirrored here line for line:
 *
 * ```
 * lineHeightPx  = fontSizePx * lineHeight
 * halfLeading   = (lineHeightPx - (descent - ascent)) / 2      // ascent NEGATIVE
 * baseline(0)   = halfLeading - ascent
 * baseline(i)   = baseline(0) + i * lineHeightPx
 * contentWidth  = max(advance)  (0 -> fontSizePx * EMPTY_TEXT_MIN_WIDTH_RATIO)
 * contentHeight = lineHeightPx * lineCount
 * ink           = U over lines of ink(i).translate(left(i), baseline(i)).inflate(stroke/2)
 * bbox          = box(0,0,contentW,contentH) U ink U (bg ? content.inflate(pad) : empty)
 *                 then floor(left/top), ceil(right/bottom)
 * bgRect        = content +- padding                          // NOT the bbox
 * ```
 *
 * The rule is locked cross-language by
 * `packages/timeline-schema/test-vectors/text-layout-vectors.json`: this module
 * and `backend/src/VideoEdit.Media/Text/TextLayoutEngine.cs` both read the same
 * file in their tests (the pattern easing/time vectors already use). Changing
 * the math on one side alone turns the OTHER language's test red.
 *
 * The module takes a `GlyphMeasurer` instead of touching a canvas, so the rules
 * are unit-testable without a DOM — and so the vector tests can drive both
 * languages with the SAME synthetic font.
 *
 * MVP scope, stated: no automatic word wrap. `TextClip.text` has no width
 * field, so the box is exactly as wide as the widest EXPLICIT line — the user
 * breaks lines with Enter. (The server engine already carries a `maxWidthPx`
 * wrapper for the day the schema gains a width field; the export pipeline
 * passes null, so both sides split on `\n` only.)
 */
import type { TextClip } from '@videoedit/timeline-schema';

export type TextStyle = TextClip['text'];

/**
 * Vertical font metrics, SKIA CONVENTION: `ascent` is NEGATIVE (above the
 * baseline), `descent` positive. Canvas2D reports both positive, so the browser
 * measurer negates the ascent (see overlayRaster.ts) — the sign convention is
 * part of the contract, not an implementation detail.
 */
export interface FontVerticalMetrics {
  ascent: number;
  descent: number;
}

/** Axis-aligned box. Empty boxes do not take part in a union. */
export interface InkBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const EMPTY_INK: InkBox = { left: 0, top: 0, right: 0, bottom: 0 };

export function isEmptyBox(box: InkBox): boolean {
  return box.right <= box.left || box.bottom <= box.top;
}

export function translateBox(box: InkBox, dx: number, dy: number): InkBox {
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

export function inflateBox(box: InkBox, amount: number): InkBox {
  if (amount === 0) return box;
  return {
    left: box.left - amount,
    top: box.top - amount,
    right: box.right + amount,
    bottom: box.bottom + amount,
  };
}

export function unionBox(a: InkBox, b: InkBox): InkBox {
  if (isEmptyBox(b)) return a;
  if (isEmptyBox(a)) return b;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * Measurement dependency — the ONLY thing that differs between the browser
 * (Canvas2D) and a test (synthetic font). Mirrors `IGlyphMeasurer` in C#.
 */
export interface GlyphMeasurer {
  readonly metrics: FontVerticalMetrics;
  /** Advance (pen movement) width of a line — the same notion as CSS width. */
  advance(line: string): number;
  /** TIGHT ink bounds of a line, RELATIVE to the pen at (0, baseline). */
  ink(line: string): InkBox;
}

export interface TextLine {
  index: number;
  text: string;
  advanceWidthPx: number;
  /** Left edge of this line inside the CONTENT box (alignment applied). */
  leftPx: number;
  /** Baseline distance from the content box TOP edge. */
  baselineYPx: number;
}

export interface TextLayout {
  lines: TextLine[];
  lineHeightPx: number;
  /** Content (layout) box: widest advance x line count. */
  contentWidthPx: number;
  contentHeightPx: number;
  /** §7 `bboxPx` — what the raster and the gizmo box measure. */
  bboxLeftPx: number;
  bboxTopPx: number;
  bboxWidthPx: number;
  bboxHeightPx: number;
  /** Where the CONTENT box origin sits inside the raster (= -bboxLeft/-bboxTop). */
  originXPx: number;
  originYPx: number;
  /** Background rectangle in CONTENT coordinates, or null when there is none. */
  backgroundRect: InkBox | null;
}

/**
 * An empty text still needs a grabbable box; this is its minimum CONTENT width,
 * as a fraction of fontSizePx. THE SAME CONSTANT LIVES IN
 * TextLayoutEngine.EmptyTextMinWidthRatio — the vector file pins both.
 */
export const EMPTY_TEXT_MIN_WIDTH_RATIO = 0.5;

/**
 * Splits on explicit newlines only (see the no-wrap note above). A trailing
 * newline produces a trailing empty line on purpose — the user pressed Enter
 * and expects the box to grow. Empty content is ONE empty line (the box keeps
 * its height instead of collapsing).
 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [''];
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Background padding of a style (null when the style has no background). */
export function backgroundPaddingPx(style: TextStyle): number | null {
  const background = style.background;
  if (!background) return null;
  return Math.max(0, background.paddingPx);
}

/** Half of the stroke width — the part that spills OUTSIDE the glyph outline. */
export function strokeHalfPx(style: TextStyle): number {
  return Math.max(0, style.stroke?.widthPx ?? 0) / 2;
}

export function layoutText(style: TextStyle, measurer: GlyphMeasurer): TextLayout {
  // NO CLAMPS on fontSizePx / lineHeight: the server multiplies them raw
  // (TextLayoutEngine), and a client-only `Math.max(1, ...)` would silently
  // re-introduce the divergence this rewrite removes. The schema already
  // requires both to be positive, and a degenerate box is caught by the
  // `Math.max(1, ...)` on the FINAL bbox — same as the server.
  const fontSizePx = style.fontSizePx;
  const lineHeightPx = fontSizePx * style.lineHeight;
  const lines = splitLines(style.content);

  const { ascent, descent } = measurer.metrics;
  const halfLeading = (lineHeightPx - (descent - ascent)) / 2;
  const firstBaseline = halfLeading - ascent;

  const advances = lines.map((line) => {
    const w = measurer.advance(line);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const measured = advances.reduce((max, w) => Math.max(max, w), 0);
  // The minimum applies ONLY to text that measures zero: a genuinely narrow
  // line ("I") must stay narrow or the gizmo box would not sit on the glyphs.
  const contentWidthPx = measured > 0 ? measured : fontSizePx * EMPTY_TEXT_MIN_WIDTH_RATIO;
  const contentHeightPx = lineHeightPx * lines.length;

  const half = strokeHalfPx(style);
  const laidOut: TextLine[] = [];
  let ink: InkBox = EMPTY_INK;
  for (let i = 0; i < lines.length; i++) {
    const advanceWidthPx = advances[i] ?? 0;
    const free = contentWidthPx - advanceWidthPx;
    const leftPx = style.align === 'center' ? free / 2 : style.align === 'right' ? free : 0;
    const baselineYPx = firstBaseline + i * lineHeightPx;
    laidOut.push({ index: i, text: lines[i] ?? '', advanceWidthPx, leftPx, baselineYPx });

    const lineInk = measurer.ink(lines[i] ?? '');
    if (!isEmptyBox(lineInk)) {
      ink = unionBox(ink, inflateBox(translateBox(lineInk, leftPx, baselineYPx), half));
    }
  }

  const content: InkBox = {
    left: 0,
    top: 0,
    right: Math.max(0, contentWidthPx),
    bottom: Math.max(0, contentHeightPx),
  };
  let box = unionBox(content, ink);
  const padding = backgroundPaddingPx(style);
  if (padding !== null) {
    box = unionBox(box, inflateBox(content, padding));
  }

  // Outward to whole pixels: nothing gets clipped (no half-pixel ink cut off).
  const bboxLeftPx = Math.floor(box.left);
  const bboxTopPx = Math.floor(box.top);
  const bboxWidthPx = Math.max(1, Math.ceil(box.right) - bboxLeftPx);
  const bboxHeightPx = Math.max(1, Math.ceil(box.bottom) - bboxTopPx);

  return {
    lines: laidOut,
    lineHeightPx,
    contentWidthPx,
    contentHeightPx,
    bboxLeftPx,
    bboxTopPx,
    bboxWidthPx,
    bboxHeightPx,
    // `0 - x` rather than `-x`: negating a zero left edge yields -0, which
    // leaks into JSON caches and `Object.is` comparisons for no reason.
    originXPx: 0 - bboxLeftPx,
    originYPx: 0 - bboxTopPx,
    // The background is the CONTENT box grown by the padding — NOT the bbox.
    // Painting the bbox would also cover the stroke overhang, which is exactly
    // the divergence bulgu #2 measured (42x34 client vs 30x22 server).
    backgroundRect: padding === null ? null : inflateBox(content, padding),
  };
}

/** Canvas `font` shorthand for a style (also what `measureText` needs). */
export function canvasFontString(style: TextStyle, cssStack: string): string {
  const italic = style.italic ? 'italic ' : '';
  const weight = Math.min(1000, Math.max(1, Math.round(style.fontWeight)));
  const size = Math.max(1, style.fontSizePx);
  return `${italic}${weight} ${size}px ${cssStack}`;
}
