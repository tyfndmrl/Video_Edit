/**
 * Raster (text) layer ceiling — the editor half of "blocker 2" (3. tur denetim).
 *
 * MEASURED FAILURE this file pins down: the inspector's scale field capped at
 * `maxClipScale(settings)` (canvas-derived, 4.266 at 1080p) and the font-size
 * field at the constant TEXT_SIZE_MAX (2000). Neither knows that a TEXT layer
 * is drawn at `bbox * scale` (rendering-semantics §7), not fit to the frame. So
 * fontSizePx 2000 + one long line + scale 4 was a document the editor happily
 * saved (PUT 200), the API queued (202) and the worker died on — the layer is
 * ~9600 px, and the compiler caps a layer at MAX_LAYER_DIMENSION (8192).
 *
 * The rule now lives in the ops (`maxClipScaleFor` / `maxTextSizeFor`), derived
 * from the SAME font-independent lower bound the C# `ExportCompiler` uses
 * (ExportCompiler.TextBoxLowerBound). "Lower bound" is the safe direction: it
 * can only under-estimate the box, so the clamp can only ever refuse a value
 * the server would certainly have rejected. The inspector additionally feeds in
 * the browser-measured bbox — see clipInspectorModel.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_LAYER_DIMENSION,
  validateTimelineDoc,
  type ShapeClip,
  type TextClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useEditorStore } from './editorStore';
import {
  SCALE_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  maxClipScale,
  maxClipScaleFor,
  maxScaleForBoxPx,
  maxTextSizeFor,
  setClipText,
  setClipTransform,
  textBoxLowerBoundPx,
} from './timelineOps';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const O1 = '01890000-0000-7000-8000-000000000102';
const TEXT_A = '01890000-0000-7000-8000-000000000301';
const SHAPE_A = '01890000-0000-7000-8000-000000000302';

function textClip(overrides: Partial<TextClip['text']> = {}, scale = 1): TextClip {
  return {
    id: TEXT_A,
    kind: 'text',
    timelineStartUs: 0,
    timelineDurationUs: 5 * US,
    transform: { x: 0, y: 0, scale, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    text: {
      content: 'Merhaba',
      fontId: 'roboto',
      fontSizePx: 64,
      fontWeight: 400,
      italic: false,
      fill: '#ffffff',
      align: 'center',
      lineHeight: 1.2,
      ...overrides,
    },
  };
}

function shapeClip(scale = 0.5): ShapeClip {
  return {
    id: SHAPE_A,
    kind: 'shape',
    timelineStartUs: 6 * US,
    timelineDurationUs: 5 * US,
    transform: { x: 0, y: 0, scale, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    shape: { type: 'rect', fill: '#5a8cff', radiusPx: 0 },
  };
}

function load(clips: Track['clips']): void {
  useDocStore.getState().loadDoc({
    ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }),
    tracks: [{ id: O1, type: 'overlay', muted: false, hidden: false, locked: false, clips }],
  });
  useEditorStore.getState().clearSelection();
}

function doc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function findText(): TextClip {
  return doc().tracks[0].clips.find((c) => c.id === TEXT_A) as TextClip;
}

function expectValid(): void {
  const result = validateTimelineDoc(doc());
  expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
}

beforeEach(() => {
  load([textClip()]);
});

// ---------------------------------------------------------------------------
// The bound itself
// ---------------------------------------------------------------------------

describe('textBoxLowerBoundPx', () => {
  it('counts the CSS line-height model and the background padding', () => {
    // 100 * 1.5 * 3 lines = 450; a background grows the box by padding on all
    // four sides, so height gains 2*20 and width gains exactly that much (there
    // is no font-independent width bound — glyph advances live in the font).
    const box = textBoxLowerBoundPx(
      textClip({
        content: 'a\nb\nc',
        fontSizePx: 100,
        lineHeight: 1.5,
        background: { color: '#000000', paddingPx: 20, radiusPx: 0 },
      }).text,
    );
    expect(box.heightPx).toBe(450 + 40);
    expect(box.widthPx).toBe(40);
  });

  it('treats empty content as ONE line (the box never collapses)', () => {
    expect(textBoxLowerBoundPx(textClip({ content: '', fontSizePx: 50, lineHeight: 2 }).text))
      .toMatchObject({ heightPx: 100 });
    // A trailing newline is a real (empty) line — the user pressed Enter.
    expect(textBoxLowerBoundPx(textClip({ content: 'x\n', fontSizePx: 50, lineHeight: 2 }).text))
      .toMatchObject({ heightPx: 200 });
  });

  it('never exceeds the real box — the direction that makes the clamp safe', () => {
    // The bound omits ink/stroke overhang, so it is <= what layoutText returns.
    // (The measured box only ever ADDS to the content box: layoutText unions.)
    const text = textClip({ content: 'Ağ', fontSizePx: 80, lineHeight: 1.2 }).text;
    expect(textBoxLowerBoundPx(text).heightPx).toBe(96);
  });
});

describe('maxScaleForBoxPx / maxClipScaleFor', () => {
  it('derives a text ceiling from the BOX, not from the canvas', () => {
    const clip = textClip({ fontSizePx: 2000 });          // one line -> 2400 px tall
    const ceiling = maxClipScaleFor(clip, defaultProjectSettings);
    expect(ceiling).toBe(3.413);                          // floor(8192/2400, 3 decimals)
    expect(ceiling).toBeLessThan(maxClipScale(defaultProjectSettings)); // 4.266
    expect(2400 * ceiling).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
  });

  it('leaves ordinary text on the canvas ceiling (no gratuitous tightening)', () => {
    // 64 px single line -> 76.8 px box -> 8192/76.8 = 106; the project ceiling
    // is the binding one, exactly as before this fix.
    expect(maxClipScaleFor(textClip(), defaultProjectSettings))
      .toBe(maxClipScale(defaultProjectSettings));
  });

  it('uses the canvas ceiling for every non-text clip', () => {
    // A shape's natural box IS the frame (ShapeGeometry.cs) and media/sticker
    // are fit=contain, so for them the canvas ceiling is already exact.
    expect(maxClipScaleFor(shapeClip(), defaultProjectSettings))
      .toBe(maxClipScale(defaultProjectSettings));
  });

  it('prefers a MEASURED box when the caller has one', () => {
    // A long single line is wide, not tall: the font-independent bound cannot
    // see it (width has no font-independent bound) but a measurement can.
    const clip = textClip({ content: 'W'.repeat(300), fontSizePx: 100 });
    expect(maxClipScaleFor(clip, defaultProjectSettings))
      .toBe(maxClipScale(defaultProjectSettings));
    expect(maxClipScaleFor(clip, defaultProjectSettings, { widthPx: 16_500, heightPx: 120 }))
      .toBe(0.496);
  });

  it('never inverts the range, however absurd the box', () => {
    expect(maxScaleForBoxPx(defaultProjectSettings, 10_000_000, 10_000_000)).toBe(SCALE_MIN);
  });
});

// ---------------------------------------------------------------------------
// The op clamps (the ONLY place clamping happens)
// ---------------------------------------------------------------------------

describe('setClipTransform on a text clip', () => {
  it('clamps scale to the TEXT box ceiling, not the project ceiling', () => {
    // THE MEASURED FAILURE: fontSizePx 2000 + scale 4 used to be writable and
    // the export died on it. 2400 * 4 = 9600 > 8192.
    load([textClip({ fontSizePx: 2000 })]);
    setClipTransform([TEXT_A], { scale: 4 });

    const scale = findText().transform.scale;
    expect(scale).toBe(3.413);
    expect(scale).toBeLessThan(4);
    expect(2400 * scale).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectValid();
  });

  it('still allows the project ceiling for a normal caption', () => {
    // NEGATIVE CONTROL: the clamp must not tighten every text clip, only the
    // ones whose own box is the binding constraint.
    setClipTransform([TEXT_A], { scale: 999 });
    expect(findText().transform.scale).toBe(maxClipScale(defaultProjectSettings));
    expectValid();
  });
});

describe('setClipText — font size', () => {
  it('clamps the font size against the clip scale and the line count', () => {
    // scale 4 spends a quarter of the 8192 budget per box pixel: at lineHeight
    // 1.2 the ceiling is floor(8192/4/1.2) = 1706 px (whole px: the size field
    // shows integers and would round a fractional ceiling UP past itself).
    load([textClip({}, 4)]);
    setClipText([TEXT_A], { fontSizePx: TEXT_SIZE_MAX });

    const size = findText().text.fontSizePx;
    expect(size).toBe(1706);
    expect(size * 1.2 * 4).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectValid();
  });

  it('shrinks further as lines and background padding eat the same budget', () => {
    load([
      textClip({
        content: 'bir\niki\nüç\ndört',
        background: { color: '#000000', paddingPx: 100, radiusPx: 0 },
      }),
    ]);
    setClipText([TEXT_A], { fontSizePx: TEXT_SIZE_MAX });

    // (8192 - 2*100) / (1.2 * 4 lines) = 1665.0
    expect(findText().text.fontSizePx).toBe(1665);
    expectValid();
  });

  it('applies the ceiling of the text the user will SEE when one patch does both', () => {
    // content is written before fontSizePx in applyClipTextToDraft, so a patch
    // that adds lines and raises the size lands on the NEW line count's ceiling.
    load([textClip()]);
    setClipText([TEXT_A], { content: 'a\nb\nc\nd\ne\nf\ng\nh', fontSizePx: TEXT_SIZE_MAX });
    expect(findText().text.fontSizePx).toBe(853); // floor(8192 / (1.2 * 8))
    expectValid();
  });

  it('reads a MEASURED box as proportional to the font size, not as an offset', () => {
    // A 100 px font whose widest line measures 800 px costs 8 box px per font
    // px. At scale 1 that caps the font at 8192/8 = 1024 — a fixed-offset model
    // would have said ~1500 and let the user build a 12000 px layer.
    const clip = textClip({ content: 'W'.repeat(20), fontSizePx: 100 });
    expect(maxTextSizeFor(clip, { widthPx: 800, heightPx: 120 })).toBe(1024);
    // Consistency with the ceiling itself: the layer at that size still fits.
    expect(1024 * (800 / 100)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);

    // A measurement can never LOOSEN the font-independent bound.
    const tall = textClip({ content: 'a\nb\nc\nd', fontSizePx: 100, lineHeight: 2 });
    expect(maxTextSizeFor(tall, { widthPx: 10, heightPx: 10 })).toBe(maxTextSizeFor(tall));
  });

  it('leaves an ordinary caption alone and keeps the floor usable', () => {
    // NEGATIVE CONTROL: at scale 1 with one line the constant cap still wins.
    load([textClip()]);
    setClipText([TEXT_A], { fontSizePx: 120 });
    expect(findText().text.fontSizePx).toBe(120);
    expect(maxTextSizeFor(findText())).toBe(TEXT_SIZE_MAX);

    // Even a pathological clip keeps min <= max so the field cannot invert:
    // 1001 lines at scale 4 leave 1.7 px per line, and the floor wins.
    const crowded = textClip({ content: 'x\n'.repeat(1000), fontSizePx: 8 }, 4);
    expect(maxTextSizeFor(crowded)).toBe(TEXT_SIZE_MIN);
  });
});
