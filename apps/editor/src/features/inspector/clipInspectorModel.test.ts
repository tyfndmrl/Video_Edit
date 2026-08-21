/**
 * clipInspectorModel — panel derivation rules.
 *
 * The panel is only as trustworthy as this: which sections appear, what a
 * multi-selection with differing values shows, and whether the dB label really
 * matches the linear gain the document stores (rendering-semantics §8.1).
 */
import { describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  type Clip,
  type MediaClip,
  type ShapeClip,
  type TextClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings } from '../../state/docStore';
import { maxClipScale, TEXT_SIZE_MAX } from '../../state/timelineOps';
import {
  buildClipInspectorModel,
  commonBoolean,
  commonNumber,
  commonString,
  dbToLinear,
  formatDb,
  formatGain,
  formatNumber,
  formatSeconds,
  linearToDb,
  MIXED_LABEL,
} from './clipInspectorModel';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const A1 = '01890000-0000-7000-8000-000000000102';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';

function videoClip(id: string, startUs: number, durationUs: number): MediaClip {
  return {
    id,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: startUs,
    timelineDurationUs: clipTimelineDurationUs(0, durationUs, 1),
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function textClip(id: string, startUs = 0, durationUs = 3 * US): TextClip {
  return {
    id,
    kind: 'text',
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    transform: { x: 0, y: 0.2, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    text: {
      content: 'Merhaba',
      fontId: 'inter',
      fontSizePx: 48,
      fontWeight: 600,
      italic: false,
      fill: '#ffffff',
      align: 'center',
      lineHeight: 1.2,
    },
  };
}

function shapeClip(id: string, startUs = 0, durationUs = 3 * US): ShapeClip {
  return {
    id,
    kind: 'shape',
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    shape: { type: 'rect', fill: '#5a8cff', radiusPx: 16 },
  };
}

function track(id: string, type: Track['type'], clips: Clip[], flags: Partial<Track> = {}): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
}

function docWith(tracks: Track[]): TimelineDoc {
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks };
}

const assets = new Map([[ASSET_A, { name: 'kamera-01.mp4' }]]);

const build = (doc: TimelineDoc, ids: string[]) =>
  buildClipInspectorModel(doc, new Set(ids), assets);

describe('buildClipInspectorModel — selection', () => {
  it('reports an empty model when nothing is selected', () => {
    const model = build(docWith([track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)])]), []);
    expect(model.count).toBe(0);
    expect(model.identity).toBeNull();
    expect(model.audio).toBeNull();
    expect(model.visual).toBeNull();
  });

  it('ignores selected ids that are no longer in the document', () => {
    const model = build(docWith([track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)])]), [
      CLIP_A,
      CLIP_B,
    ]);
    expect(model.count).toBe(1);
    expect(model.identity?.clipId).toBe(CLIP_A);
  });

  it('shows the asset file name, source range and timeline placement for one clip', () => {
    const clip = videoClip(CLIP_A, 60 * US, 6 * US);
    clip.sourceInUs = 2 * US;
    clip.sourceOutUs = 8 * US;
    const model = build(docWith([track(V1, 'video', [clip])]), [CLIP_A]);
    expect(model.identity).toMatchObject({
      name: 'kamera-01.mp4',
      kindLabel: 'Video',
      trackLabel: 'Video 1',
      sourceRange: '00:00:02:00 → 00:00:08:00',
      startTc: '00:01:00:00',
      endTc: '00:01:06:00',
      durationTc: '00:00:06:00',
    });
  });

  it('falls back to a stable name when the asset metadata is not loaded', () => {
    const model = buildClipInspectorModel(
      docWith([track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)])]),
      new Set([CLIP_A]),
      new Map(),
    );
    expect(model.identity?.name).toBe('Video klibi');
  });

  it('drops the identity block for a multi-selection but keeps the count', () => {
    const doc = docWith([
      track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US), videoClip(CLIP_B, 6 * US, 5 * US)]),
    ]);
    const model = build(doc, [CLIP_A, CLIP_B]);
    expect(model.count).toBe(2);
    expect(model.identity).toBeNull();
  });

  it('goes read-only when any selected clip sits on a locked track', () => {
    const doc = docWith([
      track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)]),
      track(A1, 'audio', [{ ...videoClip(CLIP_B, 0, 5 * US), kind: 'audio' }], { locked: true }),
    ]);
    expect(build(doc, [CLIP_A]).editable).toBe(true);
    expect(build(doc, [CLIP_A, CLIP_B]).editable).toBe(false);
  });
});

describe('buildClipInspectorModel — audio section', () => {
  it('exposes the shared audio values of a single clip', () => {
    const clip = videoClip(CLIP_A, 0, 10 * US);
    clip.audio = { volume: 0.5, fadeInUs: US, fadeOutUs: 2 * US, muted: true };
    const model = build(docWith([track(V1, 'video', [clip])]), [CLIP_A]);
    expect(model.audio).toMatchObject({
      clipIds: [CLIP_A],
      volume: 0.5,
      fadeInUs: US,
      fadeOutUs: 2 * US,
      muted: true,
    });
  });

  it('collapses differing values to null ("—") but keeps the ones that agree', () => {
    const a = videoClip(CLIP_A, 0, 10 * US);
    const b = videoClip(CLIP_B, 12 * US, 10 * US);
    a.audio = { volume: 0.5, fadeInUs: US, fadeOutUs: 0, muted: false };
    b.audio = { volume: 1.5, fadeInUs: US, fadeOutUs: 0, muted: false };
    const model = build(docWith([track(V1, 'video', [a, b])]), [CLIP_A, CLIP_B]);
    expect(model.audio?.volume).toBeNull();
    expect(model.audio?.fadeInUs).toBe(US);
    expect(model.audio?.muted).toBe(false);
    // Writing still targets BOTH clips.
    expect(model.audio?.clipIds).toEqual([CLIP_A, CLIP_B]);
  });

  it('caps the fade slider at the SHORTEST selected clip (max 5 s)', () => {
    const long = videoClip(CLIP_A, 0, 30 * US);
    const short = videoClip(CLIP_B, 40 * US, 2 * US);
    expect(build(docWith([track(V1, 'video', [long])]), [CLIP_A]).audio?.maxFadeUs).toBe(5 * US);
    expect(
      build(docWith([track(V1, 'video', [long, short])]), [CLIP_A, CLIP_B]).audio?.maxFadeUs,
    ).toBe(2 * US);
  });

  it('hides the section for an image clip and for a clip whose audio was detached', () => {
    const image = { ...videoClip(CLIP_A, 0, 5 * US), kind: 'image' as const, audio: null };
    const detached = { ...videoClip(CLIP_B, 6 * US, 5 * US), audio: null };
    const doc = docWith([track(V1, 'video', [image, detached])]);
    expect(build(doc, [CLIP_A]).audio).toBeNull();
    expect(build(doc, [CLIP_B]).audio).toBeNull();
  });

  it('writes only to the clips that actually have audio in a mixed selection', () => {
    const withAudio = videoClip(CLIP_A, 0, 5 * US);
    const image = { ...videoClip(CLIP_B, 6 * US, 5 * US), kind: 'image' as const, audio: null };
    const model = build(docWith([track(V1, 'video', [withAudio, image])]), [CLIP_A, CLIP_B]);
    expect(model.audio?.clipIds).toEqual([CLIP_A]);
  });
});

describe('buildClipInspectorModel — visual section', () => {
  it('exposes the normalized transform and opacity', () => {
    const clip = videoClip(CLIP_A, 0, 5 * US);
    clip.transform = { x: 0.25, y: -0.1, scale: 1.5, rotationDeg: 30, anchorX: 0.5, anchorY: 0.5 };
    clip.opacity = 0.75;
    const model = build(docWith([track(V1, 'video', [clip])]), [CLIP_A]);
    expect(model.visual).toMatchObject({
      x: 0.25,
      y: -0.1,
      scale: 1.5,
      rotationDeg: 30,
      opacity: 0.75,
    });
  });

  it('is absent for an audio-only selection', () => {
    const audioOnly = { ...videoClip(CLIP_A, 0, 5 * US), kind: 'audio' as const };
    const model = build(docWith([track(A1, 'audio', [audioOnly])]), [CLIP_A]);
    expect(model.visual).toBeNull();
    expect(model.audio).not.toBeNull();
  });

  it('excludes audio clips from a mixed selection so a transform edit cannot touch them', () => {
    const video = videoClip(CLIP_A, 0, 5 * US);
    const audioOnly = { ...videoClip(CLIP_B, 0, 5 * US), kind: 'audio' as const };
    const doc = docWith([track(V1, 'video', [video]), track(A1, 'audio', [audioOnly])]);
    const model = build(doc, [CLIP_A, CLIP_B]);
    expect(model.visual?.clipIds).toEqual([CLIP_A]);
    expect(model.audio?.clipIds).toEqual([CLIP_A, CLIP_B]);
  });

  it('covers a text clip (overlay), naming it after its content', () => {
    const text: TextClip = {
      id: CLIP_A,
      kind: 'text',
      timelineStartUs: 0,
      timelineDurationUs: 3 * US,
      transform: { x: 0, y: 0.2, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
      keyframes: {},
      effects: [],
      opacity: 1,
      text: {
        content: 'Merhaba',
        fontId: 'inter',
        fontSizePx: 48,
        fontWeight: 600,
        italic: false,
        fill: '#ffffff',
        align: 'center',
        lineHeight: 1.2,
      },
    };
    const model = build(docWith([track(A1, 'overlay', [text])]), [CLIP_A]);
    expect(model.identity?.name).toBe('Merhaba');
    expect(model.identity?.sourceRange).toBeNull();
    expect(model.visual?.y).toBe(0.2);
    expect(model.audio).toBeNull();
  });
});

/**
 * Derived ceilings (3. tur denetim, blocker 2). The panel used to offer
 * `maxClipScale(settings)` and the constant TEXT_SIZE_MAX for every clip, so a
 * text layer could be pushed past MAX_LAYER_DIMENSION: the document saved, the
 * API queued the export and the worker died on it. The model derives both
 * ceilings now — per clip, and from the MEASURED box when one is available.
 */
describe('buildClipInspectorModel — layer size ceilings', () => {
  it('keeps the canvas ceiling for media clips', () => {
    const model = build(docWith([track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)])]), [CLIP_A]);
    expect(model.visual?.maxScale).toBe(maxClipScale(defaultProjectSettings));
    expect(model.visual?.maxScaleFromTextBox).toBe(false);
  });

  it('tightens the scale ceiling for a large text clip and says where it came from', () => {
    const clip = textClip(CLIP_A);
    clip.text.fontSizePx = 2000; // one line -> at least 2400 px tall
    const model = build(docWith([track(A1, 'overlay', [clip])]), [CLIP_A]);

    expect(model.visual?.maxScale).toBe(3.413);
    expect(model.visual?.maxScale).toBeLessThan(maxClipScale(defaultProjectSettings));
    expect(model.visual?.maxScaleFromTextBox).toBe(true);
    expect(model.text?.maxFontSizePx).toBe(TEXT_SIZE_MAX); // at scale 1 the cap still wins
  });

  it('derives the font-size ceiling from line count, padding and the clip scale', () => {
    const clip = textClip(CLIP_A);
    clip.transform.scale = 4;
    clip.text.content = 'bir\niki';
    clip.text.background = { color: '#000000', paddingPx: 92, radiusPx: 0 };
    const model = build(docWith([track(A1, 'overlay', [clip])]), [CLIP_A]);

    // floor((8192/4 - 2*92) / (1.2 * 2 lines)) = 776 — WHOLE px, because the
    // panel's size field shows integers and would round a fractional ceiling UP
    // past itself.
    expect(model.text?.maxFontSizePx).toBe(776);
  });

  it('takes the STRICTEST ceiling of a multi-selection (one write hits them all)', () => {
    const small = textClip(CLIP_A);
    const huge = textClip(CLIP_B, 4 * US);
    huge.text.fontSizePx = 2000;
    const model = build(docWith([track(A1, 'overlay', [small, huge])]), [CLIP_A, CLIP_B]);

    expect(model.visual?.clipIds).toEqual([CLIP_A, CLIP_B]);
    expect(model.visual?.maxScale).toBe(3.413); // the huge clip's ceiling, not 4.266
  });

  it('uses a MEASURED box when the caller supplies a measurer', () => {
    // A long single line is WIDE, not tall — invisible to the font-independent
    // bound, which is exactly why the panel measures instead of guessing.
    const clip = textClip(CLIP_A);
    clip.text.content = 'W'.repeat(300);
    const doc = docWith([track(A1, 'overlay', [clip])]);

    expect(build(doc, [CLIP_A]).visual?.maxScale).toBe(maxClipScale(defaultProjectSettings));

    const measured = buildClipInspectorModel(doc, new Set([CLIP_A]), assets, () => ({
      widthPx: 16_500,
      heightPx: 120,
    }));
    expect(measured.visual?.maxScale).toBe(0.496);
    expect(measured.visual?.maxScaleFromTextBox).toBe(true);
  });

  it('ignores a measurer that cannot measure (no DOM, font still loading)', () => {
    const doc = docWith([track(A1, 'overlay', [textClip(CLIP_A)])]);
    const model = buildClipInspectorModel(doc, new Set([CLIP_A]), assets, () => null);
    expect(model.visual?.maxScale).toBe(maxClipScale(defaultProjectSettings));
    expect(model.text?.maxFontSizePx).toBe(TEXT_SIZE_MAX);
  });

  it('lowers the ceiling for a ROTATED clip and flags the rotation (1080p 45° -> 3.718)', () => {
    const clip = videoClip(CLIP_A, 0, 5 * US);
    clip.transform.rotationDeg = 45;
    const model = build(docWith([track(V1, 'video', [clip])]), [CLIP_A]);
    expect(model.visual?.maxScale).toBe(3.718);
    expect(model.visual?.maxScaleLoweredByRotation).toBe(true);
    // Dönme metin kutusu DEĞİL: rozet yanlış sebebi göstermemeli.
    expect(model.visual?.maxScaleFromTextBox).toBe(false);
  });

  it('does not flag rotation for unrotated clips (multiples of 360 included)', () => {
    const clip = videoClip(CLIP_A, 0, 5 * US);
    clip.transform.rotationDeg = 720;
    const model = build(docWith([track(V1, 'video', [clip])]), [CLIP_A]);
    expect(model.visual?.maxScale).toBe(maxClipScale(defaultProjectSettings));
    expect(model.visual?.maxScaleLoweredByRotation).toBe(false);
  });

  it('a rotated CAPTION is attributed to its text box only when the box really binds', () => {
    // Küçük metin: dönmüş halde bile tavanı canvas köşegeni belirler — rozet
    // "metin kutusundan" DEMEMELİ (iki taraf da aynı dönme çarpanını taşır).
    const small = textClip(CLIP_A);
    small.transform.rotationDeg = 45;
    const modelSmall = build(docWith([track(A1, 'overlay', [small])]), [CLIP_A]);
    expect(modelSmall.visual?.maxScaleFromTextBox).toBe(false);
    expect(modelSmall.visual?.maxScaleLoweredByRotation).toBe(true);

    // Dev metin: kutu gerçekten bağlayıcı — rozet doğru sebebi gösterir.
    const huge = textClip(CLIP_B);
    huge.transform.rotationDeg = 45;
    huge.text.fontSizePx = 2000;
    const modelHuge = build(docWith([track(A1, 'overlay', [huge])]), [CLIP_B]);
    expect(modelHuge.visual?.maxScaleFromTextBox).toBe(true);
  });
});

/**
 * Madde 2(d) kanıtı: SES klibi seçiliyken görsel bölümler hiç sunulmaz —
 * "grileme"nin bu paneldeki karşılığı bölümün yokluğudur (çizilmeyen şey
 * animasyonlanamaz/renklendirilemez; keyframe elmasları da keyframeModel
 * channelIsAvailable ile aynı kuralı okur).
 */
describe('buildClipInspectorModel — audio-kind selection has no visual surfaces', () => {
  const audioClip = (id: string): MediaClip => ({
    ...videoClip(id, 0, 5 * US),
    kind: 'audio',
  });

  it('audio-only selection: visual/color/lut sections are null, audio stays', () => {
    const model = build(docWith([track(A1, 'audio', [audioClip(CLIP_A)])]), [CLIP_A]);
    expect(model.count).toBe(1);
    expect(model.visual).toBeNull();
    expect(model.color).toBeNull();
    expect(model.lut).toBeNull();
    expect(model.audio).not.toBeNull();
    expect(model.speed).not.toBeNull();
  });

  it('mixed selection: the sections write ONLY to the drawn clips', () => {
    const model = build(
      docWith([
        track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)]),
        track(A1, 'audio', [audioClip(CLIP_B)]),
      ]),
      [CLIP_A, CLIP_B],
    );
    expect(model.visual?.clipIds).toEqual([CLIP_A]);
    expect(model.color?.clipIds).toEqual([CLIP_A]);
    expect(model.lut?.clipIds).toEqual([CLIP_A]);
    // Ses bölümü iki klibe de yazar (ikisinin de sesi var).
    expect(model.audio?.clipIds).toEqual([CLIP_A, CLIP_B]);
  });
});

describe('buildClipInspectorModel — text / shape sections (M4 dalga 2)', () => {
  it('exposes the whole text style of a single clip, stroke/background flattened', () => {
    const clip = textClip(CLIP_A);
    clip.text.stroke = { color: '#101010', widthPx: 6 };
    const model = build(docWith([track(A1, 'overlay', [clip])]), [CLIP_A]);
    expect(model.text).toMatchObject({
      clipIds: [CLIP_A],
      content: 'Merhaba',
      fontId: 'inter',
      fontSizePx: 48,
      fontWeight: 600,
      italic: false,
      fill: '#ffffff',
      align: 'center',
      lineHeight: 1.2,
      strokeEnabled: true,
      strokeColor: '#101010',
      strokeWidthPx: 6,
      // No background object -> the toggle is OFF, and the (absent) colour is
      // null rather than a made-up default.
      backgroundEnabled: false,
      backgroundColor: null,
    });
    expect(model.shape).toBeNull();
    // A text clip is drawn, so it still gets the transform section.
    expect(model.visual?.clipIds).toEqual([CLIP_A]);
  });

  it('collapses differing values of a multi-selection to null (mixed)', () => {
    const a = textClip(CLIP_A);
    const b = textClip(CLIP_B, 4 * US);
    b.text.content = 'Başka';
    b.text.fill = '#ff0000';
    b.text.fontSizePx = 48; // agrees on purpose
    const model = build(docWith([track(A1, 'overlay', [a, b])]), [CLIP_A, CLIP_B]);
    expect(model.text?.clipIds).toEqual([CLIP_A, CLIP_B]);
    expect(model.text?.content).toBeNull();
    expect(model.text?.fill).toBeNull();
    expect(model.text?.fontSizePx).toBe(48);
  });

  it('keeps the two sections independent in a mixed text+shape selection', () => {
    const t = textClip(CLIP_A);
    const s = shapeClip(CLIP_B, 4 * US);
    const model = build(docWith([track(A1, 'overlay', [t, s])]), [CLIP_A, CLIP_B]);
    expect(model.text?.clipIds).toEqual([CLIP_A]);
    expect(model.shape).toMatchObject({
      clipIds: [CLIP_B],
      type: 'rect',
      fill: '#5a8cff',
      strokeEnabled: false,
      radiusPx: 16,
    });
    // Both are drawn -> both are in the transform section.
    expect(model.visual?.clipIds).toEqual([CLIP_A, CLIP_B]);
  });

  it('has no text/shape section for a media selection', () => {
    const model = build(docWith([track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US)])]), [CLIP_A]);
    expect(model.text).toBeNull();
    expect(model.shape).toBeNull();
  });
});

describe('common value helpers', () => {
  it('returns the shared value or null', () => {
    expect(commonNumber([2, 2, 2])).toBe(2);
    expect(commonNumber([2, 3])).toBeNull();
    expect(commonNumber([])).toBeNull();
    expect(commonBoolean([true, true])).toBe(true);
    expect(commonBoolean([true, false])).toBeNull();
    expect(commonString(['a', 'a'])).toBe('a');
    expect(commonString(['a', 'b'])).toBeNull();
    expect(commonString([])).toBeNull();
  });
});

describe('gain <-> dB (rendering-semantics §8.1)', () => {
  it('maps the normative anchor points', () => {
    expect(linearToDb(1)).toBe(0);
    expect(linearToDb(2)).toBeCloseTo(6.0206, 4);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(linearToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('round-trips through dbToLinear', () => {
    for (const v of [0.1, 0.5, 1, 1.5, 2]) {
      expect(dbToLinear(linearToDb(v))).toBeCloseTo(v, 10);
    }
    expect(dbToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('formats the label the panel shows', () => {
    expect(formatDb(1)).toBe('0.0 dB');
    expect(formatDb(2)).toBe('+6.0 dB');
    expect(formatDb(0.5)).toBe('-6.0 dB');
    expect(formatDb(0)).toBe('-∞ dB');
    expect(formatDb(null)).toBe(MIXED_LABEL);
    // 0.9999 rounds to -0.0 dB; the sign must not flicker.
    expect(formatDb(0.99999)).toBe('0.0 dB');
  });
});

describe('value formatting', () => {
  it('renders gains, seconds and plain numbers, collapsing mixed to "—"', () => {
    expect(formatGain(1)).toBe('1.00×');
    expect(formatGain(null)).toBe(MIXED_LABEL);
    expect(formatSeconds(1_250_000)).toBe('1.25 s');
    expect(formatSeconds(null)).toBe(MIXED_LABEL);
    expect(formatNumber(0.5, 3)).toBe('0.500');
    expect(formatNumber(null, 3)).toBe(MIXED_LABEL);
  });
});
