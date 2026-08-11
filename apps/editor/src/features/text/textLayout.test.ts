/**
 * Text layout rules — the CLIENT preview half of rendering-semantics §7.
 *
 * The measurer is faked (1 px per character per em/10) so the assertions are
 * about the RULES — line splitting, alignment offsets, what stroke/background
 * add to the box — and not about a particular browser's font metrics.
 */
import { describe, expect, it } from 'vitest';
import type { TextClip } from '@videoedit/timeline-schema';
import {
  canvasFontString,
  layoutText,
  splitLines,
  textPaddingPx,
  type MeasureLine,
  type TextStyle,
} from './textLayout';

/** 10 px per character at fontSizePx = 100 — easy arithmetic. */
const measure: MeasureLine = (line, style) => line.length * style.fontSizePx * 0.1;

function style(patch: Partial<TextClip['text']> = {}): TextStyle {
  return {
    content: 'abc',
    fontId: 'inter',
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
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual(['']);
  });
});

describe('layoutText', () => {
  it('sizes the box from the widest line and the line-height multiplier', () => {
    const l = layoutText(style({ content: 'abc\nabcdef' }), measure);
    expect(l.lines).toHaveLength(2);
    expect(l.lineHeightPx).toBe(120);
    expect(l.textWidthPx).toBe(60); // 6 chars * 10 px
    expect(l.textHeightPx).toBe(240);
    expect(l.bboxWidthPx).toBe(60); // no stroke, no background -> no padding
    expect(l.bboxHeightPx).toBe(240);
  });

  it('offsets lines per alignment (left / center / right)', () => {
    const content = 'abc\nabcdef';
    expect(layoutText(style({ content, align: 'left' }), measure).lines.map((l) => l.xPx)).toEqual([
      0, 0,
    ]);
    expect(
      layoutText(style({ content, align: 'center' }), measure).lines.map((l) => l.xPx),
    ).toEqual([15, 0]); // (60-30)/2
    expect(layoutText(style({ content, align: 'right' }), measure).lines.map((l) => l.xPx)).toEqual([
      30, 0,
    ]);
  });

  it('puts each line box centre half a line-height apart (Canvas "middle" baseline)', () => {
    const l = layoutText(style({ content: 'a\nb\nc' }), measure);
    expect(l.lines.map((line) => line.centerYPx)).toEqual([60, 180, 300]);
  });

  it('grows the box by stroke width AND background padding, on both sides', () => {
    const s = style({
      content: 'abc',
      stroke: { color: '#000000', widthPx: 4 },
      background: { color: '#000000', paddingPx: 10, radiusPx: 2 },
    });
    expect(textPaddingPx(s)).toBe(14);
    const l = layoutText(s, measure);
    expect(l.padPx).toBe(14);
    expect(l.bboxWidthPx).toBe(30 + 28);
    expect(l.bboxHeightPx).toBe(120 + 28);
    // The text block starts INSIDE the padding.
    expect(l.lines[0].xPx).toBe(14);
    expect(l.lines[0].centerYPx).toBe(14 + 60);
  });

  it('keeps a grabbable box for empty text (a zero-width clip cannot be selected)', () => {
    const l = layoutText(style({ content: '' }), measure);
    expect(l.bboxWidthPx).toBeGreaterThan(0);
    expect(l.bboxHeightPx).toBe(120);
  });

  it('survives a measurer that returns garbage (no DOM, NaN metrics)', () => {
    const l = layoutText(style({ content: 'abc' }), () => Number.NaN);
    expect(Number.isFinite(l.bboxWidthPx)).toBe(true);
    expect(l.bboxWidthPx).toBeGreaterThan(0);
  });

  it('never collapses the line box when lineHeight is pathological', () => {
    expect(layoutText(style({ lineHeight: 0.01 }), measure).lineHeightPx).toBeGreaterThan(0);
  });
});

describe('canvasFontString', () => {
  it('emits the CSS shorthand Canvas2D (and measureText) expects', () => {
    expect(canvasFontString(style(), 'Inter, sans-serif')).toBe('700 100px Inter, sans-serif');
    expect(canvasFontString(style({ italic: true, fontWeight: 400, fontSizePx: 32 }), 'X')).toBe(
      'italic 400 32px X',
    );
  });
});
