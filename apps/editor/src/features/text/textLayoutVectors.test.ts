/**
 * CROSS-LANGUAGE text-layout parity (TS half).
 *
 * Reads packages/timeline-schema/test-vectors/text-layout-vectors.json — the
 * SAME file `backend/tests/VideoEdit.UnitTests/TextLayoutVectorParityTests.cs`
 * reads. The vectors drive both implementations with the same SYNTHETIC font,
 * so what is pinned is the LAYOUT RULE (bbox union, background rect, empty-text
 * minimum width, baseline math), not a particular TTF's metrics.
 *
 * This is the mechanism M4 dalga-2 denetimi bulgu #2 asked for: before it, the
 * client grew the box by `stroke + backgroundPadding` on every side and painted
 * the background over the WHOLE bbox while the server used a union of boxes and
 * painted `content ± padding`. The two could drift silently. Now a change on
 * one side turns the OTHER language's test red.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TextClip } from '@videoedit/timeline-schema';
import {
  EMPTY_INK,
  EMPTY_TEXT_MIN_WIDTH_RATIO,
  layoutText,
  type GlyphMeasurer,
  type InkBox,
  type TextStyle,
} from './textLayout';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEXT_LAYOUT_VECTORS_PATH = resolve(
  HERE,
  '../../../../../packages/timeline-schema/test-vectors/text-layout-vectors.json',
);

interface SyntheticFont {
  ascentRatio: number;
  descentRatio: number;
  advanceRatio: number;
  inkAscentRatio: number;
  inkDescentRatio: number;
  inkSideBearingRatio: number;
}

interface VectorLine {
  index: number;
  text: string;
  advanceWidthPx: number;
  leftPx: number;
  baselineYPx: number;
}

interface VectorCase {
  name: string;
  why: string;
  style: {
    content: string;
    fontSizePx: number;
    lineHeight: number;
    align: 'left' | 'center' | 'right';
    strokeWidthPx: number;
    backgroundPaddingPx: number | null;
  };
  expected: {
    lineHeightPx: number;
    contentWidthPx: number;
    contentHeightPx: number;
    bboxLeftPx: number;
    bboxTopPx: number;
    bboxWidthPx: number;
    bboxHeightPx: number;
    originXPx: number;
    originYPx: number;
    backgroundRect: InkBox | null;
    lines: VectorLine[];
  };
}

interface VectorFile {
  vectorVersion: number;
  tolerance: number;
  emptyTextMinWidthRatio: number;
  font: SyntheticFont;
  cases: VectorCase[];
}

const vectors = JSON.parse(readFileSync(TEXT_LAYOUT_VECTORS_PATH, 'utf8')) as VectorFile;

/**
 * The synthetic font the vector file describes, implemented EXACTLY as the
 * file's rules block spells it out (the C# test implements the same rules).
 */
function syntheticMeasurer(font: SyntheticFont, fontSizePx: number): GlyphMeasurer {
  const cell = fontSizePx * font.advanceRatio;
  const bearing = fontSizePx * font.inkSideBearingRatio;
  return {
    metrics: {
      ascent: fontSizePx * font.ascentRatio,
      descent: fontSizePx * font.descentRatio,
    },
    advance: (line) => line.length * cell,
    ink: (line): InkBox => {
      let first = -1;
      let last = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== ' ') {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) return EMPTY_INK;
      return {
        left: first * cell + bearing,
        top: -fontSizePx * font.inkAscentRatio,
        right: (last + 1) * cell - bearing,
        bottom: fontSizePx * font.inkDescentRatio,
      };
    },
  };
}

function styleOf(c: VectorCase): TextStyle {
  const style: TextStyle = {
    content: c.style.content,
    fontId: 'roboto',
    fontSizePx: c.style.fontSizePx,
    fontWeight: 400,
    italic: false,
    fill: '#ffffff',
    align: c.style.align,
    lineHeight: c.style.lineHeight,
  } as TextClip['text'];
  if (c.style.strokeWidthPx > 0) {
    style.stroke = { color: '#000000', widthPx: c.style.strokeWidthPx };
  }
  if (c.style.backgroundPaddingPx !== null) {
    style.background = {
      color: '#000000',
      paddingPx: c.style.backgroundPaddingPx,
      radiusPx: 0,
    };
  }
  return style;
}

describe('text-layout vector file', () => {
  it('has the shape both languages expect (a silently pruned file proves nothing)', () => {
    expect(vectors.vectorVersion).toBe(1);
    expect(vectors.cases).toHaveLength(10);
    expect(vectors.tolerance).toBe(1e-9);
    // The empty-text minimum is a CONTRACT constant, not an implementation
    // detail: it has to be the same number in both languages.
    expect(vectors.emptyTextMinWidthRatio).toBe(EMPTY_TEXT_MIN_WIDTH_RATIO);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const layout = layoutText(styleOf(c), syntheticMeasurer(vectors.font, c.style.fontSizePx));
    const tol = vectors.tolerance;
    const e = c.expected;

    expect(layout.lineHeightPx).toBeCloseTo(e.lineHeightPx, 9);
    expect(layout.contentWidthPx).toBeCloseTo(e.contentWidthPx, 9);
    expect(layout.contentHeightPx).toBeCloseTo(e.contentHeightPx, 9);
    expect(layout.bboxLeftPx).toBeCloseTo(e.bboxLeftPx, 9);
    expect(layout.bboxTopPx).toBeCloseTo(e.bboxTopPx, 9);
    expect(layout.bboxWidthPx).toBeCloseTo(e.bboxWidthPx, 9);
    expect(layout.bboxHeightPx).toBeCloseTo(e.bboxHeightPx, 9);
    expect(layout.originXPx).toBeCloseTo(e.originXPx, 9);
    expect(layout.originYPx).toBeCloseTo(e.originYPx, 9);

    if (e.backgroundRect === null) {
      expect(layout.backgroundRect).toBeNull();
    } else {
      expect(layout.backgroundRect).not.toBeNull();
      for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
        expect(Math.abs(layout.backgroundRect![edge] - e.backgroundRect[edge])).toBeLessThanOrEqual(
          tol,
        );
      }
    }

    expect(layout.lines).toHaveLength(e.lines.length);
    for (const [i, expectedLine] of e.lines.entries()) {
      const line = layout.lines[i]!;
      expect(line.index).toBe(expectedLine.index);
      expect(line.text).toBe(expectedLine.text);
      expect(line.advanceWidthPx).toBeCloseTo(expectedLine.advanceWidthPx, 9);
      expect(line.leftPx).toBeCloseTo(expectedLine.leftPx, 9);
      expect(line.baselineYPx).toBeCloseTo(expectedLine.baselineYPx, 9);
    }
  });
});
