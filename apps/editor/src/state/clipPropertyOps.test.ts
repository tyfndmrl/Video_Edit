/**
 * Clip property ops (Inspector): audio / transform / opacity / detachAudio.
 *
 * These cover the rules a reviewer cannot see from the UI: clamping (the only
 * place it happens), multi-selection semantics, the "one gesture = one history
 * entry" contract, and detachAudio's placement + refusal rules. Every case
 * re-validates the document against the shared schema, because the whole point
 * of routing panel edits through ops is that an invalid document is impossible.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  validateTimelineDoc,
  type Keyframe,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { useEditorStore } from './editorStore';
import {
  SCALE_MIN,
  applyClipAudioToDraft,
  applyClipTransformToDraft,
  clampAudioFadesToDuration,
  detachAudio,
  detachAudioBlockReason,
  knownAssetDurations,
  maxClipScale,
  resetClipTransform,
  setClipAudio,
  setClipOpacity,
  setClipTransform,
  splitClipAt,
  trimClip,
} from './timelineOps';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const A1 = '01890000-0000-7000-8000-000000000102';
const A2 = '01890000-0000-7000-8000-000000000103';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const CLIP_C = '01890000-0000-7000-8000-000000000203';

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

/** Same media clip, but on an audio lane (kind drives which sections apply). */
function audioClip(id: string, startUs: number, durationUs: number): MediaClip {
  const c = videoClip(id, startUs, durationUs);
  c.kind = 'audio';
  return c;
}

function track(id: string, type: Track['type'], clips: MediaClip[], flags: Partial<Track> = {}): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
}

function load(tracks: Track[]): void {
  useDocStore
    .getState()
    .loadDoc({ ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks });
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function findClip(id: string): MediaClip {
  for (const t of currentDoc().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c as MediaClip;
  }
  throw new Error(`clip ${id} not found`);
}

function expectValid(): void {
  const result = validateTimelineDoc(currentDoc(), knownAssetDurations());
  expect(result.success, JSON.stringify(!result.success ? result.error.issues : null)).toBe(true);
}

function historyLength(): number {
  return useDocStore.getState().history.length;
}

beforeEach(() => {
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 60 * US },
  ]);
  useEditorStore.getState().clearSelection();
});

// ---------------------------------------------------------------------------
// setClipAudio
// ---------------------------------------------------------------------------

describe('setClipAudio', () => {
  it('writes a linear gain and clamps it into [0, 2] (rendering-semantics §8.1)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(setClipAudio([CLIP_A], { volume: 1.5 }).ok).toBe(true);
    expect(findClip(CLIP_A).audio?.volume).toBe(1.5);

    setClipAudio([CLIP_A], { volume: 9 });
    expect(findClip(CLIP_A).audio?.volume).toBe(2);
    setClipAudio([CLIP_A], { volume: -3 });
    expect(findClip(CLIP_A).audio?.volume).toBe(0);
    expectValid();
  });

  it('applies one call to the whole selection as a SINGLE history entry', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 12 * US, 10 * US)]),
    ]);
    const before = historyLength();
    expect(setClipAudio([CLIP_A, CLIP_B], { volume: 0.25 }).ok).toBe(true);
    expect(findClip(CLIP_A).audio?.volume).toBe(0.25);
    expect(findClip(CLIP_B).audio?.volume).toBe(0.25);
    expect(historyLength()).toBe(before + 1);

    useDocStore.getState().undo();
    expect(findClip(CLIP_A).audio?.volume).toBe(1);
    expect(findClip(CLIP_B).audio?.volume).toBe(1);
    expectValid();
  });

  it('clamps a fade to the clip duration', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 4 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 30 * US });
    expect(findClip(CLIP_A).audio?.fadeInUs).toBe(4 * US);
    expectValid();
  });

  it('never lets fade in and fade out overlap — only the written side is trimmed', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 4 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 3 * US });
    setClipAudio([CLIP_A], { fadeOutUs: 3 * US });
    const audio = findClip(CLIP_A).audio!;
    expect(audio.fadeInUs).toBe(3 * US); // untouched side kept as the user set it
    expect(audio.fadeOutUs).toBe(1 * US); // trimmed into the remaining room
    expect(audio.fadeInUs + audio.fadeOutUs).toBeLessThanOrEqual(4 * US);
    expectValid();
  });

  it('clamps a fade per clip when the selection has different durations', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 12 * US, 2 * US)]),
    ]);
    setClipAudio([CLIP_A, CLIP_B], { fadeInUs: 5 * US });
    expect(findClip(CLIP_A).audio?.fadeInUs).toBe(5 * US);
    expect(findClip(CLIP_B).audio?.fadeInUs).toBe(2 * US);
    expectValid();
  });

  it('rounds a fractional microsecond (integer time discipline, §1.1)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 1234.6 });
    expect(findClip(CLIP_A).audio?.fadeInUs).toBe(1235);
    expect(Number.isInteger(findClip(CLIP_A).audio?.fadeInUs)).toBe(true);
    expectValid();
  });

  it('toggles muted and refuses a selection with no audio at all', () => {
    const image = videoClip(CLIP_A, 0, 10 * US);
    image.kind = 'image';
    image.audio = null;
    load([track(V1, 'video', [image])]);
    const res = setClipAudio([CLIP_A], { muted: true });
    expect(res.ok).toBe(false);
    expect(historyLength()).toBe(0);
    expectValid();
  });

  it('skips clips on a locked track', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true })]);
    expect(setClipAudio([CLIP_A], { volume: 0.5 }).ok).toBe(false);
    expect(findClip(CLIP_A).audio?.volume).toBe(1);
    expect(historyLength()).toBe(0);
  });

  it('coalesces a slider drag into ONE history entry via a transaction', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    const before = historyLength();
    const tx = useDocStore.getState().beginTransaction('clipAudio', 'Ses seviyesi değiştirildi');
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      tx.update((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: v }));
    }
    tx.commit();

    expect(findClip(CLIP_A).audio?.volume).toBe(0.5);
    expect(historyLength()).toBe(before + 1);
    useDocStore.getState().undo();
    expect(findClip(CLIP_A).audio?.volume).toBe(1);
    expectValid();
  });
});

// ---------------------------------------------------------------------------
// Fade re-clamp on duration-shrinking ops
//
// The bug this locks down: fades were only clamped where the FADE was written.
// Every op that shortens a clip (trim, ripple trim, roll, split) left them
// alone, so a 10 s clip with a 5 s fade-in trimmed to 2 s produced a document
// the export compiler answers with HTTP 422 — and the editor never said a word.
// ---------------------------------------------------------------------------

describe('audio fades survive duration changes (export contract)', () => {
  const fades = (id: string): { inUs: number; outUs: number; durUs: number } => {
    const c = findClip(id);
    return {
      inUs: c.audio!.fadeInUs,
      outUs: c.audio!.fadeOutUs,
      durUs: c.timelineDurationUs,
    };
  };
  const expectFadesFit = (id: string): void => {
    const f = fades(id);
    expect(f.inUs + f.outUs, `fades must fit in ${f.durUs}us`).toBeLessThanOrEqual(f.durUs);
    expect(Number.isInteger(f.inUs) && Number.isInteger(f.outUs)).toBe(true);
  };

  it('right-edge trim re-clamps a fade in that no longer fits (denetim #1)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 5 * US });
    expect(fades(CLIP_A).inUs).toBe(5 * US);

    expect(trimClip(CLIP_A, 'right', 2 * US).ok).toBe(true);
    expect(fades(CLIP_A).durUs).toBe(2 * US);
    expect(fades(CLIP_A).inUs).toBe(2 * US);
    expectFadesFit(CLIP_A);
    expectValid();
  });

  it('left-edge trim re-clamps both fades', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 4 * US });
    setClipAudio([CLIP_A], { fadeOutUs: 4 * US });

    expect(trimClip(CLIP_A, 'left', 7 * US).ok).toBe(true);
    expect(fades(CLIP_A).durUs).toBe(3 * US);
    expectFadesFit(CLIP_A);
    expectValid();
  });

  it('shrinks overlapping fades PROPORTIONALLY instead of picking a winner', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 3 * US });
    setClipAudio([CLIP_A], { fadeOutUs: 6 * US });

    expect(trimClip(CLIP_A, 'right', 3 * US).ok).toBe(true);
    const f = fades(CLIP_A);
    expect(f.durUs).toBe(3 * US);
    // 3:6 ratio kept -> 1 s in, 2 s out.
    expect(f.inUs).toBe(1 * US);
    expect(f.outUs).toBe(2 * US);
    expectFadesFit(CLIP_A);
    expectValid();
  });

  it('ripple trim re-clamps too (followers move, fades still have to fit)', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 10 * US, 5 * US)]),
    ]);
    setClipAudio([CLIP_A], { fadeOutUs: 5 * US });
    expect(trimClip(CLIP_A, 'right', 2 * US, 'ripple').ok).toBe(true);
    expect(fades(CLIP_A).durUs).toBe(2 * US);
    expectFadesFit(CLIP_A);
    expectValid();
  });

  it('roll re-clamps BOTH clips around the moved cut', () => {
    // B needs source head-room to grow leftwards when the cut moves back.
    const b = videoClip(CLIP_B, 10 * US, 10 * US);
    b.sourceInUs = 10 * US;
    b.sourceOutUs = 20 * US;
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), b])]);
    setClipAudio([CLIP_A], { fadeOutUs: 5 * US });
    setClipAudio([CLIP_B], { fadeInUs: 5 * US });

    expect(trimClip(CLIP_A, 'right', 2 * US, 'roll').ok).toBe(true);
    expect(fades(CLIP_A).durUs).toBe(2 * US);
    expectFadesFit(CLIP_A);
    expectFadesFit(CLIP_B);
    expectValid();
  });

  it('split re-clamps the fade each half INHERITS', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 4 * US });
    setClipAudio([CLIP_A], { fadeOutUs: 4 * US });

    expect(splitClipAt(CLIP_A, 2 * US).ok).toBe(true);
    const secondId = currentDoc().tracks[0].clips[1].id;
    // A keeps the fade-in (now longer than its 2 s), B keeps the fade-out.
    expect(fades(CLIP_A).durUs).toBe(2 * US);
    expect(fades(CLIP_A).inUs).toBe(2 * US);
    expect(fades(CLIP_A).outUs).toBe(0);
    expect(fades(secondId).outUs).toBe(4 * US);
    expectFadesFit(CLIP_A);
    expectFadesFit(secondId);
    expectValid();
  });

  it('a clip trimmed to the minimum keeps a schema-valid (zero) fade pair', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { fadeInUs: 5 * US });
    setClipAudio([CLIP_A], { fadeOutUs: 5 * US });
    // One frame at 30 fps = 33333 us.
    expect(trimClip(CLIP_A, 'right', 33_333).ok).toBe(true);
    expectFadesFit(CLIP_A);
    expectValid();
  });

  it('clampAudioFadesToDuration leaves fitting fades and non-audio clips untouched', () => {
    // Direct unit check on a DRAFT-shaped clip (store documents are frozen).
    const fitting = videoClip(CLIP_A, 0, 10 * US);
    fitting.audio = { volume: 1, fadeInUs: 2 * US, fadeOutUs: 3 * US, muted: false };
    clampAudioFadesToDuration(fitting);
    expect(fitting.audio).toEqual({ volume: 1, fadeInUs: 2 * US, fadeOutUs: 3 * US, muted: false });

    const symmetric = videoClip(CLIP_A, 0, 3 * US);
    symmetric.audio = { volume: 1, fadeInUs: 4 * US, fadeOutUs: 4 * US, muted: false };
    clampAudioFadesToDuration(symmetric);
    expect(symmetric.audio.fadeInUs).toBe(1.5 * US);
    expect(symmetric.audio.fadeOutUs).toBe(1.5 * US);

    const image = videoClip(CLIP_B, 0, 4 * US);
    image.kind = 'image';
    image.audio = null;
    expect(() => clampAudioFadesToDuration(image)).not.toThrow();
    expect(image.audio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setClipTransform / setClipOpacity / resetClipTransform
// ---------------------------------------------------------------------------

describe('setClipTransform / setClipOpacity', () => {
  it('keeps the normalized coordinate contract and clamps out-of-range values', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipTransform([CLIP_A], { x: 0.25, y: -0.125, scale: 1.5, rotationDeg: 90 });
    const t = findClip(CLIP_A).transform;
    expect(t).toMatchObject({ x: 0.25, y: -0.125, scale: 1.5, rotationDeg: 90 });
    // Anchor is not editable from the panel and must survive untouched.
    expect(t.anchorX).toBe(0.5);
    expect(t.anchorY).toBe(0.5);

    setClipTransform([CLIP_A], { x: 99, y: -99, scale: 999, rotationDeg: 5000 });
    const clamped = findClip(CLIP_A).transform;
    expect(clamped.x).toBe(2);
    expect(clamped.y).toBe(-2);
    // Scale ceiling is derived from the PROJECT, not a constant: 1080p caps at
    // 8192/1920 = 4.266 because the compiler refuses a bigger layer box.
    expect(clamped.scale).toBe(maxClipScale(defaultProjectSettings));
    expect(clamped.scale).toBe(4.266);
    expect(clamped.rotationDeg).toBe(360);
    expectValid();
  });

  it('derives the scale ceiling from the project resolution (4K is stricter)', () => {
    const uhd = { ...defaultProjectSettings, width: 3840, height: 2160 };
    useDocStore.getState().loadDoc({
      ...createEmptyDoc(PROJECT_ID, uhd),
      tracks: [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])],
    });
    setClipTransform([CLIP_A], { scale: 999 });
    expect(findClip(CLIP_A).transform.scale).toBe(2.133);
    // The compiler measures roundHalfUp(dimension * scale) against 8192.
    expect(Math.floor(3840 * findClip(CLIP_A).transform.scale + 0.5)).toBeLessThanOrEqual(8192);
    expectValid();
  });

  it('refuses to park a clip at scale 0 — the export compiler rejects scale <= 0', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipTransform([CLIP_A], { scale: 0 });
    expect(findClip(CLIP_A).transform.scale).toBe(SCALE_MIN);
    expect(SCALE_MIN).toBeGreaterThan(0);
    setClipTransform([CLIP_A], { scale: -5 });
    expect(findClip(CLIP_A).transform.scale).toBe(SCALE_MIN);
    expectValid();
  });

  it('rounds so undo patches stay clean', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipTransform([CLIP_A], { x: 0.1 + 0.2, scale: 1 / 3, rotationDeg: 12.3456 });
    const t = findClip(CLIP_A).transform;
    expect(t.x).toBe(0.3);
    expect(t.scale).toBe(0.333);
    expect(t.rotationDeg).toBe(12.35);
  });

  it('ignores non-finite input instead of writing NaN into the document', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipTransform([CLIP_A], { scale: Number.NaN });
    expect(findClip(CLIP_A).transform.scale).toBe(1);
    expectValid();
  });

  it('leaves audio clips alone (nothing draws them)', () => {
    const audioOnly = videoClip(CLIP_A, 0, 10 * US);
    audioOnly.kind = 'audio';
    load([track(A1, 'audio', [audioOnly])]);
    expect(setClipTransform([CLIP_A], { scale: 2 }).ok).toBe(false);
    expect(findClip(CLIP_A).transform.scale).toBe(1);
    expect(historyLength()).toBe(0);
  });

  it('clamps opacity into [0, 1]', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipOpacity([CLIP_A], 0.4);
    expect(findClip(CLIP_A).opacity).toBe(0.4);
    setClipOpacity([CLIP_A], 5);
    expect(findClip(CLIP_A).opacity).toBe(1);
    setClipOpacity([CLIP_A], -5);
    expect(findClip(CLIP_A).opacity).toBe(0);
    expectValid();
  });

  it('resets transform AND opacity of the whole selection in one entry', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 12 * US, 10 * US)]),
    ]);
    setClipTransform([CLIP_A, CLIP_B], { x: 0.4, scale: 2, rotationDeg: 45 });
    setClipOpacity([CLIP_A, CLIP_B], 0.2);
    const before = historyLength();

    expect(resetClipTransform([CLIP_A, CLIP_B]).ok).toBe(true);
    expect(historyLength()).toBe(before + 1);
    for (const id of [CLIP_A, CLIP_B]) {
      expect(findClip(id).transform).toEqual({
        x: 0,
        y: 0,
        scale: 1,
        rotationDeg: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      });
      expect(findClip(id).opacity).toBe(1);
    }
    useDocStore.getState().undo();
    expect(findClip(CLIP_A).transform.scale).toBe(2);
    expect(findClip(CLIP_A).opacity).toBe(0.2);
    expectValid();
  });

  it('coalesces a scrub drag into ONE history entry', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    const before = historyLength();
    const tx = useDocStore.getState().beginTransaction('clipTransform', 'Konum değiştirildi');
    for (const x of [0.01, 0.02, 0.03, 0.04]) {
      tx.update((d) => void applyClipTransformToDraft(d, [CLIP_A], { x }));
    }
    tx.commit();
    expect(findClip(CLIP_A).transform.x).toBe(0.04);
    expect(historyLength()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// detachAudio
// ---------------------------------------------------------------------------

describe('detachAudio', () => {
  it('creates an audio track when the document has none, with an exact audio twin', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 3 * US, 10 * US)])]);
    const before = historyLength();
    expect(detachAudio(CLIP_A).ok).toBe(true);

    const doc = currentDoc();
    expect(doc.tracks).toHaveLength(2);
    const audioTrack = doc.tracks[1];
    expect(audioTrack.type).toBe('audio');
    const twin = audioTrack.clips[0] as MediaClip;
    const source = findClip(CLIP_A);
    expect(twin.kind).toBe('audio');
    expect(twin.assetId).toBe(source.assetId);
    expect(twin.timelineStartUs).toBe(3 * US);
    expect(twin.timelineDurationUs).toBe(10 * US);
    expect(twin.sourceInUs).toBe(source.sourceInUs);
    expect(twin.sourceOutUs).toBe(source.sourceOutUs);
    expect(twin.speed).toEqual(source.speed);
    // Video clip keeps the picture and loses the sound.
    expect(source.audio).toBeNull();
    expect(historyLength()).toBe(before + 1);
    expectValid();
  });

  it('carries the audio settings (level, fades, mute) over to the new clip', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipAudio([CLIP_A], { volume: 0.4 });
    setClipAudio([CLIP_A], { fadeInUs: 2 * US });
    setClipAudio([CLIP_A], { muted: true });

    expect(detachAudio(CLIP_A).ok).toBe(true);
    const twin = currentDoc().tracks[1].clips[0] as MediaClip;
    expect(twin.audio).toEqual({ volume: 0.4, fadeInUs: 2 * US, fadeOutUs: 0, muted: true });
    expectValid();
  });

  it('moves the volume keyframe track with the sound', () => {
    const clip = videoClip(CLIP_A, 0, 10 * US);
    const kfs: Keyframe[] = [
      { timeUs: 0, value: 0, easing: { type: 'linear' } },
      { timeUs: 5 * US, value: 1, easing: { type: 'linear' } },
    ];
    clip.keyframes = { volume: kfs, opacity: [{ timeUs: 0, value: 1, easing: { type: 'linear' } }] };
    load([track(V1, 'video', [clip])]);

    expect(detachAudio(CLIP_A).ok).toBe(true);
    expect(findClip(CLIP_A).keyframes.volume).toBeUndefined();
    expect(findClip(CLIP_A).keyframes.opacity).toHaveLength(1); // picture keyframes stay
    expect((currentDoc().tracks[1].clips[0] as MediaClip).keyframes.volume).toEqual(kfs);
    expectValid();
  });

  it('uses the FIRST audio track with room instead of creating a new one', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 20 * US, 10 * US)]),
      track(A1, 'audio', [audioClip(CLIP_B, 0, 5 * US)]),
      track(A2, 'audio', []),
    ]);
    expect(detachAudio(CLIP_A).ok).toBe(true);
    const doc = currentDoc();
    expect(doc.tracks).toHaveLength(3); // no new track
    expect(doc.tracks[1].clips.map((c) => c.id)).toHaveLength(2);
    expect(doc.tracks[2].clips).toHaveLength(0);
    expectValid();
  });

  it('skips an occupied audio track and lands on the next free one', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [audioClip(CLIP_B, 0, 10 * US)]),
      track(A2, 'audio', []),
    ]);
    expect(detachAudio(CLIP_A).ok).toBe(true);
    expect(currentDoc().tracks).toHaveLength(3);
    expect(currentDoc().tracks[2].clips).toHaveLength(1);
    expectValid();
  });

  it('REFUSES when every audio track is blocked by an overlapping clip', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [audioClip(CLIP_B, 5 * US, 10 * US)]),
    ]);
    const res = detachAudio(CLIP_A);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('overlaps an existing clip');
    // Nothing half-applied: the video clip keeps its audio, history is clean.
    expect(findClip(CLIP_A).audio).not.toBeNull();
    expect(historyLength()).toBe(0);
    expectValid();
  });

  it('REFUSES when the only audio track is locked', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [], { locked: true }),
    ]);
    const res = detachAudio(CLIP_A);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('target track is locked');
    expect(findClip(CLIP_A).audio).not.toBeNull();
    expect(historyLength()).toBe(0);
  });

  it('undoes the whole separation with a single undo', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    detachAudio(CLIP_A);
    expect(currentDoc().tracks).toHaveLength(2);

    useDocStore.getState().undo();
    expect(currentDoc().tracks).toHaveLength(1);
    expect(findClip(CLIP_A).audio).toEqual({
      volume: 1,
      fadeInUs: 0,
      fadeOutUs: 0,
      muted: false,
    });
    expectValid();
  });

  it('refuses a second detach of the same clip', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(detachAudio(CLIP_A).ok).toBe(true);
    const second = detachAudio(CLIP_A);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('clip has no embedded audio');
  });

  it('detachAudioBlockReason mirrors the op exactly (menu disabled rule)', () => {
    const image = videoClip(CLIP_C, 12 * US, 4 * US);
    image.kind = 'image';
    image.audio = null;
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), image]),
      track(A1, 'audio', [], { locked: false }),
    ]);
    const doc = currentDoc();
    expect(detachAudioBlockReason(doc, CLIP_A)).toBeNull();
    expect(detachAudioBlockReason(doc, CLIP_C)).toBe('only a video clip has detachable audio');
    expect(detachAudioBlockReason(doc, CLIP_B)).toBe('clip not found');
  });

  /**
   * The block reason used to stop at the clip preconditions, so the context
   * menu offered "Sesi ayır" on a clip the op then refused with a warning
   * bubble. Every refusal the op can produce must be visible to the menu.
   */
  it('detachAudioBlockReason covers the PLACEMENT refusals too (denetim #4)', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [audioClip(CLIP_B, 5 * US, 10 * US)]),
    ]);
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBe('overlaps an existing clip');
    expect(detachAudio(CLIP_A).ok).toBe(false);

    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [], { locked: true }),
    ]);
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBe('target track is locked');
    expect(detachAudio(CLIP_A).ok).toBe(false);
  });

  it('block reason and op agree on EVERY fixture (no menu offers a refused op)', () => {
    const fixtures: { name: string; tracks: Track[] }[] = [
      { name: 'no audio track', tracks: [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])] },
      {
        name: 'free audio track',
        tracks: [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]), track(A1, 'audio', [])],
      },
      {
        name: 'blocked audio track',
        tracks: [
          track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
          track(A1, 'audio', [audioClip(CLIP_B, 5 * US, 10 * US)]),
        ],
      },
      {
        name: 'locked audio track',
        tracks: [
          track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
          track(A1, 'audio', [], { locked: true }),
        ],
      },
      {
        name: 'blocked + free audio track',
        tracks: [
          track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
          track(A1, 'audio', [audioClip(CLIP_B, 5 * US, 10 * US)]),
          track(A2, 'audio', []),
        ],
      },
      {
        name: 'locked source track',
        tracks: [track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true })],
      },
    ];
    for (const fixture of fixtures) {
      load(fixture.tracks);
      const reason = detachAudioBlockReason(currentDoc(), CLIP_A);
      const result = detachAudio(CLIP_A);
      expect(result.ok, fixture.name).toBe(reason === null);
      if (!result.ok) expect(result.reason, fixture.name).toBe(reason);
    }
  });

  it('refuses a clip on a locked track', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true })]);
    const res = detachAudio(CLIP_A);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('track is locked');
  });

  /**
   * SESSİZ kaynak (ölçülen tuzak): buildClipFromAsset her video klibinde
   * `audio` alanını dolu doğurur, yani `clip.audio` sessiz videoyu AYIRT
   * EDEMEZ — varlığın probe olgusu (`hasAudio === false`) eder. Bu dal yokken
   * menü "Sesi ayır"ı sunuyor, doğan ses klibi export'ta 422 `asset-clip-type`
   * alıyordu (ExportCompiler.IsTypeMismatch: Ready video + HasAudio=false).
   */
  it('REFUSES on a video whose SOURCE has no audio stream (silent video)', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET_A, kind: 'video', name: 'sessiz.mp4', status: 'ready', durationUs: 60 * US, hasAudio: false },
    ]);
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBe('source has no audio stream');
    const res = detachAudio(CLIP_A);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('source has no audio stream');
    // Yarım iş yok: klip sesini korur, tarih temiz kalır.
    expect(findClip(CLIP_A).audio).not.toBeNull();
    expect(historyLength()).toBe(0);
    expectValid();
  });

  it('still ALLOWS a video whose source audibly has audio (hasAudio: true)', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET_A, kind: 'video', name: 'sesli.mp4', status: 'ready', durationUs: 60 * US, hasAudio: true },
    ]);
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBeNull();
    expect(detachAudio(CLIP_A).ok).toBe(true);
    expectValid();
  });

  /**
   * Bilinmeyen olgu ENGELLEMEZ: API `hasAudio`'yu yalnız READY satırda döner
   * ve export kapısı da soruyu ancak cevabın kesin olduğu yerde sorar —
   * bilinmeyeni reddetmek sesli videoda yanlış ret üretirdi. (Varlık kaydı hiç
   * yokken de aynı: eski belge/başka kullanıcının medyası senaryosu.)
   */
  it('does NOT block when the audio fact is unknown (undefined or asset missing)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    // beforeEach ASSET_A'yı hasAudio ALANSIZ kurar (undefined = bilinmiyor).
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBeNull();

    useAssetStore.getState().setAssets([]);
    expect(detachAudioBlockReason(currentDoc(), CLIP_A)).toBeNull();
    expect(detachAudio(CLIP_A).ok).toBe(true);
    expectValid();
  });
});
