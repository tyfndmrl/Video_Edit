/**
 * Text layout rules — the CLIENT half of the SINGLE layout rule
 * (rendering-semantics §7; M4 dalga-2 denetimi bulgu #2).
 *
 * The measurer is faked so the assertions are about the RULES — line splitting,
 * alignment offsets, what stroke/background add to the box, where the
 * background rectangle sits — and not about a particular browser's font
 * metrics. Cross-language agreement is proved separately, by
 * `textLayoutVectors.test.ts` + `TextLayoutVectorParityTests.cs` reading the
 * same vector file; these are the local, hand-computed rule tests.
 */
import { describe, expect, it } from 'vitest';
import type { TextClip } from '@videoedit/timeline-schema';
import {
  EMPTY_INK,
  EMPTY_TEXT_MIN_WIDTH_RATIO,
  backgroundPaddingPx,
  canvasFontString,
  layoutText,
  splitLines,
  strokeHalfPx,
  type GlyphMeasurer,
  type InkBox,
  type TextStyle,
} from './textLayout';

/**
 * 10 px per character at fontSizePx = 100 — easy arithmetic. Ink sits 1 px
 * inside each end of the advance box and spans -70..+10 around the baseline.
 */
function measurer(fontSizePx = 100): GlyphMeasurer {
  const cell = fontSizePx * 0.1;
  return {
    metrics: { ascent: -fontSizePx * 0.8, descent: fontSizePx * 0.2 },
    advance: (line) => line.length * cell,
    ink: (line): InkBox => {
      if (line.trim().length === 0) return EMPTY_INK;
      return {
        left: 1,
        top: -fontSizePx * 0.7,
        right: line.length * cell - 1,
        bottom: fontSizePx * 0.1,
      };
    },
  };
}

function style(patch: Partial<TextClip['text']> = {}): TextStyle {
  return {
    content: 'abc',
    fontId: 'roboto',
    fontSizePx: 100,
    fontWeight: 700,
    italic: false,
    fill: '#ffffff',
    align: 'left',
    lineHeight: 1.2,
    ...patch,
  };
}

describe('splitLines', () => {
  it('splits on every newline flavour and keeps a trailing empty line', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual(['']);
  });
});

describe('layoutText', () => {
  it('sizes the CONTENT box from the widest advance and the line-height multiplier', () => {
    const l = layoutText(style({ content: 'abc\nabcdef' }), measurer());
    expect(l.lines).toHaveLength(2);
    expect(l.lineHeightPx).toBe(120);
    expect(l.contentWidthPx).toBe(60); // 6 chars * 10 px
    expect(l.contentHeightPx).toBe(240);
    // No stroke, no background: ink is inside the content box -> bbox = content.
    expect(l.bboxWidthPx).toBe(60);
    expect(l.bboxHeightPx).toBe(240);
    expect(l.originXPx).toBe(0);
    expect(l.originYPx).toBe(0);
  });

  it('offsets lines per alignment (left / center / right), on ADVANCE not ink', () => {
    const content = 'abc\nabcdef';
    expect(layoutText(style({ content, align: 'left' }), measurer()).lines.map((l) => l.leftPx)) //
      .toEqual([0, 0]);
    expect(
      layoutText(style({ content, align: 'center' }), measurer()).lines.map((l) => l.leftPx),
    ).toEqual([15, 0]); // (60-30)/2
    expect(layoutText(style({ content, align: 'right' }), measurer()).lines.map((l) => l.leftPx)) //
      .toEqual([30, 0]);
  });

  it('places baselines with the CSS half-leading model (the export uses the same)', () => {
    // fontBox = 100 (ascent 80 + descent 20); lineHeightPx = 120 -> halfLeading 10.
    const l = layoutText(style({ content: 'a\nb\nc' }), measurer());
    expect(l.lines.map((line) => line.baselineYPx)).toEqual([90, 210, 330]);
  });

  it('grows the bbox by HALF the stroke width, not the whole width', () => {
    // Stroke is centred on the outline: only widthPx/2 spills outward. The old
    // client rule reserved the FULL width on every side and disagreed with the
    // export by exactly that much (bulgu #2).
    const l = layoutText(style({ content: 'abc', stroke: { color: '#000', widthPx: 20 } }), measurer());
    expect(strokeHalfPx(style({ stroke: { color: '#000', widthPx: 20 } }))).toBe(10);
    // ink 1..29 inflated by 10 -> -9..39 ; content 0..30 -> union -9..39
    expect(l.bboxLeftPx).toBe(-9);
    expect(l.bboxWidthPx).toBe(48);
    expect(l.originXPx).toBe(9);
  });

  it('puts the background rectangle on CONTENT ± padding, never on the bbox', () => {
    const s = style({
      content: 'abc',
      stroke: { color: '#000000', widthPx: 20 },
      background: { color: '#000000', paddingPx: 4, radiusPx: 2 },
    });
    expect(backgroundPaddingPx(s)).toBe(4);
    const l = layoutText(s, measurer());
    expect(l.backgroundRect).toEqual({ left: -4, top: -4, right: 34, bottom: 124 });
    // Stroke half (10) is larger than the padding (4), so the bbox is WIDER
    // than the background rect. If the background were painted over the bbox
    // these two numbers would be equal.
    expect(l.bboxWidthPx).toBe(48);
    expect(l.backgroundRect!.right - l.backgroundRect!.left).toBe(38);
  });

  it('has no background rectangle when the style has no background', () => {
    expect(layoutText(style(), measurer()).backgroundRect).toBeNull();
  });

  it('keeps a grabbable box for empty text (a zero-width clip cannot be selected)', () => {
    const l = layoutText(style({ content: '' }), measurer());
    expect(l.contentWidthPx).toBe(100 * EMPTY_TEXT_MIN_WIDTH_RATIO);
    expect(l.bboxWidthPx).toBe(50);
    expect(l.bboxHeightPx).toBe(120);
  });

  it('applies the minimum ONLY to zero-advance text (a space keeps its width)', () => {
    const l = layoutText(style({ content: ' ' }), measurer());
    expect(l.contentWidthPx).toBe(10);
  });

  it('survives a measurer that returns garbage (no DOM, NaN metrics)', () => {
    const broken: GlyphMeasurer = {
      metrics: { ascent: -80, descent: 20 },
      advance: () => Number.NaN,
      ink: () => EMPTY_INK,
    };
    const l = layoutText(style({ content: 'abc' }), broken);
    expect(Number.isFinite(l.bboxWidthPx)).toBe(true);
    expect(l.bboxWidthPx).toBeGreaterThan(0);
  });

  it('never collapses the bbox when lineHeight is pathological', () => {
    const l = layoutText(style({ lineHeight: 0.001 }), measurer());
    expect(l.bboxHeightPx).toBeGreaterThanOrEqual(1);
  });
});

describe('canvasFontString', () => {
  it('emits the CSS shorthand Canvas2D (and measureText) expects', () => {
    expect(canvasFontString(style(), '"ve-roboto", sans-serif')).toBe(
      '700 100px "ve-roboto", sans-serif',
    );
    expect(canvasFontString(style({ italic: true, fontWeight: 400, fontSizePx: 32 }), 'X')).toBe(
      'italic 400 32px X',
    );
  });
});
