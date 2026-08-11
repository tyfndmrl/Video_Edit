/**
 * clipInspectorModel — SPEED and COLOUR sections (M5).
 *
 * Two derivations the component cannot be trusted to do for itself:
 *  - the speed section has to know how much ROOM the clip has on its track,
 *    so the panel can say "0.5x will not fit" BEFORE the click. Getting that
 *    bound from the clip alone is impossible, and a wrong bound turns into a
 *    button that refuses (or one that promises and then refuses);
 *  - the colour section has to present a clip with NO colorAdjust effect as
 *    "all zero, switched off" rather than disappearing, or the section would
 *    flicker in and out as the user works.
 */
import { describe, expect, it } from 'vitest';
import type { MediaClip, ShapeClip, TimelineDoc, Track } from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings } from '../../state/docStore';
import { buildClipInspectorModel, formatSpeed, gapAfterClip, MIXED_LABEL } from './clipInspectorModel';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const OV1 = '01890000-0000-7000-8000-000000000102';
const A1 = '01890000-0000-7000-8000-000000000103';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const EFFECT_1 = '01890000-0000-7000-8000-000000000301';

function videoClip(
  id: string,
  startUs: number,
  durationUs: number,
  overrides: Partial<MediaClip> = {},
): MediaClip {
  return {
    id,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    ...overrides,
  };
}

function shapeClip(id: string): ShapeClip {
  return {
    id,
    kind: 'shape',
    timelineStartUs: 0,
    timelineDurationUs: 5 * US,
    shape: { type: 'rect', fill: '#ff0000' },
    transform: { x: 0, y: 0, scale: 0.5, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function track(id: string, type: Track['type'], clips: Track['clips']): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips };
}

function docWith(tracks: Track[]): TimelineDoc {
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks };
}

function build(tracks: Track[], ids: string[]) {
  return buildClipInspectorModel(docWith(tracks), new Set(ids));
}

// ---------------------------------------------------------------------------
// Speed section
// ---------------------------------------------------------------------------

describe('speed section', () => {
  it('appears for video/audio clips and reports the stored rate + duration', () => {
    const model = build(
      [track(V1, 'video', [videoClip(CLIP_A, 0, 5 * US, { speed: { rate: 2 }, sourceOutUs: 10 * US })])],
      [CLIP_A],
    );

    expect(model.speed).not.toBeNull();
    expect(model.speed!.rate).toBe(2);
    expect(model.speed!.durationUs).toBe(5 * US);
    expect(model.speed!.clipIds).toEqual([CLIP_A]);
  });

  it('does NOT appear for images (no time axis) or shapes', () => {
    const image = videoClip(CLIP_A, 0, 4 * US, { kind: 'image', audio: null });
    expect(build([track(V1, 'video', [image])], [CLIP_A]).speed).toBeNull();
    expect(build([track(OV1, 'overlay', [shapeClip(CLIP_B)])], [CLIP_B]).speed).toBeNull();
  });

  it('a mixed selection shows "—" for the rate but still writes to both clips', () => {
    const model = build(
      [
        track(V1, 'video', [
          videoClip(CLIP_A, 0, 10 * US),
          videoClip(CLIP_B, 20 * US, 5 * US, { speed: { rate: 2 }, sourceOutUs: 10 * US }),
        ]),
      ],
      [CLIP_A, CLIP_B],
    );

    expect(model.speed!.rate).toBeNull();
    expect(formatSpeed(model.speed!.rate)).toBe(MIXED_LABEL);
    expect(model.speed!.clipIds).toEqual([CLIP_A, CLIP_B]);
  });

  it('reports the gap to the next clip — the room a slow-down may grow into', () => {
    const model = build(
      [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 12 * US, 4 * US)])],
      [CLIP_A],
    );
    expect(model.speed!.nextGapUs).toBe(2 * US);
  });

  it('derives the slowest rate that fits without rippling', () => {
    // 10 s of source + a 2 s gap = 12 s of room -> rate >= 10/12 = 0.834 (ceil).
    const model = build(
      [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 12 * US, 4 * US)])],
      [CLIP_A],
    );
    expect(model.speed!.minRateWithoutRipple).toBe(0.834);
  });

  it('no clip after it = no bound at all (slowing down is free)', () => {
    const model = build([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])], [CLIP_A]);
    expect(model.speed!.nextGapUs).toBeNull();
    expect(model.speed!.minRateWithoutRipple).toBeNull();
  });

  it('the STRICTEST clip of a multi-selection sets the bound', () => {
    const model = build(
      [
        track(V1, 'video', [
          videoClip(CLIP_A, 0, 10 * US), // 2 s gap -> 0.834
          videoClip(CLIP_B, 12 * US, 4 * US), // 0 gap? nothing after -> unbounded
        ]),
        track(A1, 'audio', [
          videoClip('01890000-0000-7000-8000-000000000203', 0, 4 * US, { kind: 'audio' }),
          videoClip('01890000-0000-7000-8000-000000000204', 5 * US, 1 * US, { kind: 'audio' }),
        ]),
      ],
      [CLIP_A, '01890000-0000-7000-8000-000000000203'],
    );
    // clipA: 10/(10+2) = 0.834 ; audio clip: 4/(4+1) = 0.8 -> the strictest wins
    expect(model.speed!.minRateWithoutRipple).toBe(0.834);
  });

  it('flags a transition on either edge (the handle grows with the rate)', () => {
    const a = videoClip(CLIP_A, 0, 10 * US, {
      transitionOut: { type: 'crossfade', durationUs: 1 * US },
    });
    const b = videoClip(CLIP_B, 10 * US, 10 * US, {
      sourceInUs: 5 * US,
      sourceOutUs: 15 * US,
      transitionIn: { type: 'crossfade', durationUs: 1 * US },
    });
    expect(build([track(V1, 'video', [a, b])], [CLIP_A]).speed!.hasTransition).toBe(true);
    expect(
      build([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])], [CLIP_A]).speed!.hasTransition,
    ).toBe(false);
  });
});

describe('gapAfterClip', () => {
  it('measures to the NEAREST following clip, not the last one', () => {
    const a = videoClip(CLIP_A, 0, 5 * US);
    const b = videoClip(CLIP_B, 8 * US, 1 * US);
    const c = videoClip('01890000-0000-7000-8000-000000000205', 20 * US, 1 * US);
    expect(gapAfterClip(track(V1, 'video', [a, b, c]), a)).toBe(3 * US);
  });

  it('is 0 for a touching neighbour (a cut, not a gap)', () => {
    const a = videoClip(CLIP_A, 0, 5 * US);
    const b = videoClip(CLIP_B, 5 * US, 5 * US);
    expect(gapAfterClip(track(V1, 'video', [a, b]), a)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Colour section
// ---------------------------------------------------------------------------

describe('colour section', () => {
  it('a clip with no effect reads as all-zero and OFF (the section never vanishes)', () => {
    const model = build([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])], [CLIP_A]);

    expect(model.color).not.toBeNull();
    expect(model.color!.present).toBe(false);
    expect(model.color!.enabled).toBe(false);
    expect(model.color!.brightness).toBe(0);
    expect(model.color!.saturation).toBe(0);
  });

  it('reads the six §4.1 params off the effect', () => {
    const clip = videoClip(CLIP_A, 0, 10 * US, {
      effects: [
        {
          id: EFFECT_1,
          type: 'colorAdjust',
          enabled: true,
          params: {
            brightness: 0.1,
            contrast: -0.2,
            saturation: 0.3,
            temperature: -0.4,
            tint: 0.5,
            exposure: -0.6,
          },
        },
      ],
    });

    const color = build([track(V1, 'video', [clip])], [CLIP_A]).color!;

    expect(color.present).toBe(true);
    expect(color.enabled).toBe(true);
    expect(color).toMatchObject({
      brightness: 0.1,
      contrast: -0.2,
      saturation: 0.3,
      temperature: -0.4,
      tint: 0.5,
      exposure: -0.6,
    });
  });

  it('a param the effect never stored defaults to the identity, like the shader', () => {
    const clip = videoClip(CLIP_A, 0, 10 * US, {
      effects: [{ id: EFFECT_1, type: 'colorAdjust', enabled: true, params: { brightness: 0.4 } }],
    });
    const color = build([track(V1, 'video', [clip])], [CLIP_A]).color!;
    expect(color.brightness).toBe(0.4);
    expect(color.exposure).toBe(0);
  });

  it('a disabled effect keeps its values but reports enabled=false', () => {
    const clip = videoClip(CLIP_A, 0, 10 * US, {
      effects: [{ id: EFFECT_1, type: 'colorAdjust', enabled: false, params: { brightness: 0.4 } }],
    });
    const color = build([track(V1, 'video', [clip])], [CLIP_A]).color!;
    expect(color.enabled).toBe(false);
    expect(color.present).toBe(true);
    expect(color.brightness).toBe(0.4);
  });

  it('differing values across a selection collapse to "—"', () => {
    const a = videoClip(CLIP_A, 0, 10 * US, {
      effects: [{ id: EFFECT_1, type: 'colorAdjust', enabled: true, params: { brightness: 0.4 } }],
    });
    const b = videoClip(CLIP_B, 20 * US, 10 * US);
    const color = build([track(V1, 'video', [a, b])], [CLIP_A, CLIP_B]).color!;
    expect(color.brightness).toBeNull();
    expect(color.enabled).toBeNull();
    expect(color.present, 'at least one clip owns an effect').toBe(true);
  });

  it('covers overlay clips (a shape can be graded) but not audio', () => {
    expect(build([track(OV1, 'overlay', [shapeClip(CLIP_B)])], [CLIP_B]).color).not.toBeNull();
    const audio = videoClip(CLIP_A, 0, 10 * US, { kind: 'audio' });
    expect(build([track(A1, 'audio', [audio])], [CLIP_A]).color).toBeNull();
  });
});

describe('formatSpeed', () => {
  it('drops trailing zeros so the presets read cleanly', () => {
    expect(formatSpeed(2)).toBe('2x');
    expect(formatSpeed(0.25)).toBe('0.25x');
    expect(formatSpeed(1.235)).toBe('1.235x');
    expect(formatSpeed(null)).toBe(MIXED_LABEL);
  });
});
