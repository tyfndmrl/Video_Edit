/**
 * Text layout — where every line and the bounding box sit, as PURE math.
 *
 * Binding note (rendering-semantics §7): the single source of truth for text
 * layout is SkiaSharp on the SERVER. Everything here is the CLIENT preview
 * layout — it exists so typing gives instant feedback, and it is replaced by
 * the server's `{ lines[], bboxPx }` as soon as that endpoint exists
 * (TODO below). When the two disagree, SkiaSharp wins.
 *
 * The module takes a `measureLine` callback instead of touching a canvas, so
 * the layout rules (line splitting, alignment offsets, the padding a stroke and
 * a background add to the box) are unit-testable without a DOM.
 *
 * MVP scope, stated: no automatic word wrap. `TextClip.text` has no width
 * field, so the box is exactly as wide as the widest EXPLICIT line — the user
 * breaks lines with Enter. Adding wrapping later means adding a width field to
 * the schema on both sides, not changing this file alone.
 */
import type { TextClip } from '@videoedit/timeline-schema';

export type TextStyle = TextClip['text'];

/** Width in project px of one line rendered with `style`. */
export type MeasureLine = (line: string, style: TextStyle) => number;

export interface TextLine {
  text: string;
  widthPx: number;
  /** Left edge of this line inside the bbox (alignment applied), project px. */
  xPx: number;
  /**
   * Vertical CENTRE of the line box inside the bbox, project px. Canvas draws
   * it with `textBaseline = 'middle'`; a baseline would need font metrics the
   * client does not own (the server raster does).
   */
  centerYPx: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** Per-line box height = fontSizePx * lineHeight. */
  lineHeightPx: number;
  /** Ink box of the text block (widest line x line count). */
  textWidthPx: number;
  textHeightPx: number;
  /** Padding added around the ink box by stroke + background. */
  padPx: number;
  /** §7 `bboxPx` — what the raster and the gizmo box measure. */
  bboxWidthPx: number;
  bboxHeightPx: number;
}

/** An empty text still needs a grabbable box; this is its minimum ink width. */
export const EMPTY_TEXT_MIN_WIDTH_RATIO = 0.5;

/**
 * Splits on explicit newlines only (see the no-wrap note above). A trailing
 * newline produces a trailing empty line on purpose — the user pressed Enter
 * and expects the box to grow.
 */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r\n|\r|\n/);
  return lines.length === 0 ? [''] : lines;
}

/**
 * Extra room a stroke and a background need around the ink box.
 * A stroke is centred on the glyph outline, so half of it spills outward; the
 * full width is reserved (cheap, and it keeps round joins inside the raster).
 */
export function textPaddingPx(style: TextStyle): number {
  const stroke = style.stroke?.widthPx ?? 0;
  const background = style.background?.paddingPx ?? 0;
  return Math.max(0, stroke) + Math.max(0, background);
}

export function layoutText(style: TextStyle, measureLine: MeasureLine): TextLayout {
  const fontSizePx = Math.max(1, style.fontSizePx);
  const lineHeightPx = Math.max(1, fontSizePx * Math.max(0.1, style.lineHeight));
  const rawLines = splitLines(style.content);

  const widths = rawLines.map((line) => {
    const w = measureLine(line, style);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  // Only EMPTY text gets the minimum: a genuinely narrow line ("I") must stay
  // narrow, or the gizmo box would not sit on the glyphs.
  const measured = widths.reduce((max, w) => Math.max(max, w), 0);
  const textWidthPx = measured > 0 ? measured : fontSizePx * EMPTY_TEXT_MIN_WIDTH_RATIO;
  const textHeightPx = rawLines.length * lineHeightPx;
  const padPx = textPaddingPx(style);

  const lines: TextLine[] = rawLines.map((text, i) => {
    const widthPx = widths[i] ?? 0;
    const free = textWidthPx - widthPx;
    const offset =
      style.align === 'center' ? free / 2 : style.align === 'right' ? free : 0;
    return {
      text,
      widthPx,
      xPx: padPx + offset,
      centerYPx: padPx + i * lineHeightPx + lineHeightPx / 2,
    };
  });

  return {
    lines,
    lineHeightPx,
    textWidthPx,
    textHeightPx,
    padPx,
    bboxWidthPx: textWidthPx + padPx * 2,
    bboxHeightPx: textHeightPx + padPx * 2,
  };
}

/** Canvas `font` shorthand for a style (also what `measureText` needs). */
export function canvasFontString(style: TextStyle, cssStack: string): string {
  const italic = style.italic ? 'italic ' : '';
  const weight = Math.min(1000, Math.max(1, Math.round(style.fontWeight)));
  const size = Math.max(1, style.fontSizePx);
  return `${italic}${weight} ${size}px ${cssStack}`;
}
