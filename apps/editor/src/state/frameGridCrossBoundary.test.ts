/**
 * Frame-grid cross-boundary property test.
 *
 * The bug this exists for: the editor and the export compiler each had their
 * own idea of what "on the frame grid" means. The compiler asked for the
 * timelineDURATION to be a grid value; the editor produced clips whose EDGES
 * are grid values. Outside integer fps those two are incompatible (30 fps:
 * frame 1 = 33_333 us, frame 2 = 66_667 us, so a one-frame clip starting on
 * frame 1 is 33_334 us long), and the result was a document the editor saved
 * happily (PUT 200) and the render worker refused (HTTP 422) — for something as
 * ordinary as splitting a clip in a default 30 fps project.
 *
 * So this file does not test a function. It drives the REAL ops (add from
 * asset, split, trim, ripple trim, move, multi-move, overlay insert, speed) at
 * the four fps values that matter — 30, 29.97, 25, 23.976 — with the awkward
 * source durations ffprobe actually reports (7.307300 s, 12.679333 s ...), and
 * after every single op asserts BOTH gates:
 *
 *   1. `validateTimelineDoc` — the document invariants, and
 *   2. `exportFrameGridIssues` — the compiler's frame-grid rule, verbatim.
 *
 * The other half of "cross-boundary" is real, not implied: every document
 * produced here is written to
 * `packages/timeline-schema/test-vectors/frame-grid-corpus.json`, and
 * `backend/tests/VideoEdit.UnitTests/FrameGridCrossBoundaryTests.cs` feeds that
 * file to `ExportCompiler.Validate` — the actual C# compiler, not a replica of
 * it. If the two sides ever disagree again, one of the two suites goes red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  exportFrameGridIssues,
  floorDurationToFrameSpan,
  validateTimelineDoc,
  type MediaClip,
  type ProjectSettings,
  type Rational,
  type TimelineDoc,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { useEditorStore } from './editorStore';
import {
  addClipFromAsset,
  addTextClip,
  addTrack,
  clearClipboardForTests,
  copyClips,
  duplicateClips,
  knownAssetDurations,
  moveClips,
  pasteAtPlayhead,
  setClipSpeed,
  splitClipAt,
  trimClip,
} from './timelineOps';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const ASSET_B = '01890000-0000-7000-8000-00000000000b';
const ASSET_IMG = '01890000-0000-7000-8000-00000000000c';

/**
 * Durations as ffprobe reports them for real files — the point of the test.
 * 7.307300 s and 12.679333 s are microsecond values that are NOT frame
 * boundaries at ANY of the four project rates below.
 */
const DURATION_A = 7_307_300;
const DURATION_B = 12_679_333;

const FPS_CASES: { label: string; fps: Rational }[] = [
  { label: '30', fps: { num: 30, den: 1 } },
  { label: '29.97', fps: { num: 30000, den: 1001 } },
  { label: '25', fps: { num: 25, den: 1 } },
  { label: '23.976', fps: { num: 24000, den: 1001 } },
];

/** Every document the ops below produced, for the C# side of the boundary. */
const corpus: { label: string; fps: string; doc: TimelineDoc }[] = [];

function settingsFor(fps: Rational): ProjectSettings {
  return { ...defaultProjectSettings, fps };
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

/**
 * Both export gates, on the live document. Also records the document for the
 * C# compiler to re-check (see the file header).
 */
function expectGates(label: string): TimelineDoc {
  const d = currentDoc();
  const result = validateTimelineDoc(d, knownAssetDurations());
  expect(
    result.success,
    `${label}: document invariants — ${JSON.stringify(!result.success ? result.error.issues : null)}`,
  ).toBe(true);
  expect(exportFrameGridIssues(d), `${label}: export frame-grid gate`).toEqual([]);
  return d;
}

function record(label: string, fps: Rational): void {
  corpus.push({
    label,
    fps: `${fps.num}/${fps.den}`,
    doc: structuredClone(expectGates(label)),
  });
}

function firstClip(): MediaClip {
  return currentDoc().tracks[0].clips[0] as MediaClip;
}

beforeEach(() => {
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: DURATION_A },
    { id: ASSET_B, kind: 'video', name: 'b.mp4', status: 'ready', durationUs: DURATION_B },
    { id: ASSET_IMG, kind: 'image', name: 'p.png', status: 'ready' },
  ]);
  useEditorStore.getState().clearSelection();
});

describe.each(FPS_CASES)('frame-grid cross-boundary @ $label fps', ({ label, fps }) => {
  beforeEach(() => {
    useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, settingsFor(fps)));
  });

  it('asset drops land on the grid even with ffprobe durations', () => {
    const trackId = addTrack('video');
    // Start times chosen to be nasty: 0, an off-grid microsecond value, and a
    // value that only rounds onto the grid at some of the four rates.
    expect(addClipFromAsset(ASSET_A, { trackId }, 0).ok).toBe(true);
    record(`${label}: add @0`, fps);
    expect(addClipFromAsset(ASSET_B, { trackId }, 9_123_456).ok).toBe(true);
    record(`${label}: add @9_123_456`, fps);

    // The clip must end at or before the source runs out — the tail snap only
    // ever shortens, so a 7.3073 s file can never ask for source it lacks.
    const clip = firstClip();
    expect(clip.sourceOutUs).toBeLessThanOrEqual(DURATION_A);
    expect(clip.timelineDurationUs).toBeLessThanOrEqual(DURATION_A);
    expect(clip.sourceOutUs).toBe(clip.timelineDurationUs);
  });

  it('a still image lands on the grid too (the 4 s default is not a frame boundary in NTSC)', () => {
    const trackId = addTrack('video');
    expect(addClipFromAsset(ASSET_IMG, { trackId }, 1_234_567).ok).toBe(true);
    record(`${label}: image add`, fps);
  });

  it('split / trim / ripple trim / move keep both gates satisfied', () => {
    const trackId = addTrack('video');
    expect(addClipFromAsset(ASSET_A, { trackId }, 0).ok).toBe(true);
    const first = firstClip();

    // SPLIT at three points inside the clip, including one that is not a frame
    // boundary at any of the four rates.
    expect(splitClipAt(first.id, 3_141_592).ok).toBe(true);
    record(`${label}: split @3_141_592`, fps);
    const second = currentDoc().tracks[0].clips[1];
    expect(splitClipAt(second.id, 5_000_000).ok).toBe(true);
    record(`${label}: split @5_000_000`, fps);

    // TRIM both edges of the middle clip (normal), then a ripple trim of the
    // last one so the followers are shifted too.
    const clips = currentDoc().tracks[0].clips;
    expect(trimClip(clips[1].id, 'left', 3_500_000).ok).toBe(true);
    record(`${label}: trim left`, fps);
    expect(trimClip(clips[1].id, 'right', 4_800_000).ok).toBe(true);
    record(`${label}: trim right`, fps);
    expect(trimClip(clips[0].id, 'right', 2_000_000, 'ripple').ok).toBe(true);
    record(`${label}: ripple trim`, fps);

    // MOVE: single clip, then the whole selection (the case where a uniform
    // microsecond delta used to push the non-anchor clips off the grid).
    const after = currentDoc().tracks[0].clips;
    expect(moveClips([after[2].id], 700_000).ok).toBe(true);
    record(`${label}: move single`, fps);
    const all = currentDoc().tracks[0].clips.map((c) => c.id);
    expect(moveClips(all, 1_234_567).ok).toBe(true);
    record(`${label}: move selection`, fps);
    expect(moveClips([...all].reverse(), -333_333).ok).toBe(true);
    record(`${label}: move selection back`, fps);
  });

  /**
   * DUPLICATE + PASTE (BG-1). Copies used to land at "start + raw microsecond
   * offset"; outside frame counts divisible by the rate's residue cycle the
   * copy's far edge fell 1 us off the grid (30 fps, 140 frames: end 9_333_334,
   * nearest boundary 9_333_333) — saved fine, export 422. The ops now walk in
   * FRAMES and re-fit each copy, so the corpus carries them to the C# compiler.
   */
  it('duplicate and paste keep both gates satisfied', () => {
    clearClipboardForTests();
    const trackId = addTrack('video');
    expect(addClipFromAsset(ASSET_A, { trackId }, 0).ok).toBe(true);
    const first = firstClip();
    // An awkward length: trim to ~4.67 s so the frame count is not a multiple
    // of the residue cycle at any of the four rates (140 @ 30, ...).
    expect(trimClip(first.id, 'right', 4_666_667).ok).toBe(true);
    expectGates(`${label}: pre-duplicate trim`);

    expect(duplicateClips([first.id]).ok).toBe(true);
    record(`${label}: duplicate`, fps);

    // Paste BOTH clips (the multi-clip offset walk) at an off-grid playhead.
    const ids = currentDoc().tracks[0].clips.map((c) => c.id);
    expect(copyClips(ids)).toBe(true);
    expect(pasteAtPlayhead(11_111_111).ok).toBe(true);
    record(`${label}: paste two clips @11_111_111`, fps);

    // Duplicate the whole selection too (span measured in frames).
    expect(duplicateClips(currentDoc().tracks[0].clips.map((c) => c.id)).ok).toBe(true);
    record(`${label}: duplicate selection`, fps);
  });

  /**
   * SOURCE-BOUND CLAMPS (measured review blocker).
   *
   * Every trim path clamps the edge against the SOURCE — `assetDurationUs` on
   * the right, `sourceInUs >= 0` on the left. Those bounds are raw ffprobe
   * microseconds (7.307300 s), never frame boundaries, and the clamp used to
   * run AFTER the grid snap: the snapped target was thrown away and the
   * duration re-derived from source microseconds, so the clip's far edge landed
   * off the grid — measured at 99.9% of "over-trim, then drag the edge back
   * out" gestures (1602/1604 across the four rates) and rejected by the export
   * compiler with HTTP 422.
   *
   * The gesture is reproduced here with the ops themselves, so the corpus
   * carries it into ExportCompiler.Validate on the C# side as well.
   */
  it('the right edge dragged back out to the source end stays on the grid', () => {
    // Three starts, because "one frame" is a different number of microseconds
    // depending on where the clip sits (the grid is not closed under addition):
    // time zero, the first frame boundary, and an arbitrary drop position.
    for (const dropUs of [0, 33_333, 1_234_567]) {
      useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, settingsFor(fps)));
      const trackId = addTrack('video');
      expect(addClipFromAsset(ASSET_A, { trackId }, dropUs).ok).toBe(true);
      const clip = firstClip();
      const start = clip.timelineStartUs;

      expect(trimClip(clip.id, 'right', start + 3_000_000).ok).toBe(true);
      expectGates(`${label}: over-trim right @${dropUs}`);
      // ... and back out, well past the end of the media.
      expect(trimClip(clip.id, 'right', start + 30_000_000).ok).toBe(true);
      record(`${label}: right edge back out past the source end @${dropUs}`, fps);

      const grown = firstClip();
      expect(grown.sourceOutUs).toBeLessThanOrEqual(DURATION_A);
      expect(grown.timelineStartUs).toBe(start);
      // The clip reaches as far as the media allows AND no further: the whole
      // remaining source, floored to a whole frame span at this start. (Up to
      // one frame of media is unusable there — the honest price of an end that
      // the export ledger can name.)
      expect(grown.timelineDurationUs).toBe(
        floorDurationToFrameSpan(start, DURATION_A - grown.sourceInUs, fps),
      );

      // Ripple mode takes the same clamp path (and drags followers with it).
      expect(trimClip(grown.id, 'right', start + 2_500_000, 'ripple').ok).toBe(true);
      expectGates(`${label}: ripple over-trim right @${dropUs}`);
      expect(trimClip(grown.id, 'right', start + 30_000_000, 'ripple').ok).toBe(true);
      record(`${label}: ripple right edge back out past the source end @${dropUs}`, fps);
      expect(firstClip().sourceOutUs).toBeLessThanOrEqual(DURATION_A);
    }
  });

  it('the left edge dragged back out to the source start stays on the grid', () => {
    // A SWEEP, not one shape: with the start anchored (ripple) the far edge is
    // `start + <the whole source window>`, and whether that sum is a frame
    // boundary depends on BOTH the clip's length and the size of the source
    // handle — the grid is not closed under addition, so two grid values can
    // add up to a non-grid one (30 fps: 1_033_333 + 4_033_333 = 5_066_666,
    // nearest frame 5_066_667). Which pairs are unlucky differs per rate.
    // Every op below runs docStore's dev gate (both export gates, every
    // commit); the first three shapes also go into the corpus for the C# side.
    let recorded = 0;
    for (const lengthUs of [4_000_000, 4_033_333, 5_566_667, 6_100_000]) {
      for (const handleUs of [1_000_000, 1_033_333, 1_500_000, 2_166_667]) {
        useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, settingsFor(fps)));
        const trackId = addTrack('video');
        expect(addClipFromAsset(ASSET_B, { trackId }, 0).ok).toBe(true);
        const clip = firstClip();
        const shape = `len ${lengthUs} handle ${handleUs}`;

        expect(trimClip(clip.id, 'right', lengthUs).ok, shape).toBe(true);
        // Trim IN so there is a source handle to give back.
        expect(trimClip(clip.id, 'left', handleUs).ok, shape).toBe(true);
        // RIPPLE (start anchored): the start stays put, so the far edge is the
        // END, and it is the source floor (`sourceInUs >= 0`) that decides it.
        expect(trimClip(clip.id, 'left', 0, 'ripple').ok, shape).toBe(true);

        const back = firstClip();
        // Everything the source has, floored to a whole frame span at the
        // (pinned) start — `sourceInUs` lands at 0 or at most one frame above.
        expect(back.timelineDurationUs, shape).toBe(
          floorDurationToFrameSpan(back.timelineStartUs, back.sourceOutUs, fps),
        );
        expect(back.sourceInUs, shape).toBe(back.sourceOutUs - back.timelineDurationUs);
        expect(back.sourceOutUs, shape).toBeLessThanOrEqual(DURATION_B);
        if (recorded < 3) {
          record(`${label}: ripple left back out past the source start (${shape})`, fps);
          recorded++;
        }
      }
    }
  });

  it('a left trim back out at a non-1x rate keeps both edges on the grid', () => {
    // At rate != 1 the source window is no longer a frame span of the timeline,
    // so `end - clipTimelineDurationUs(0, sourceOut, rate)` (the left trim's
    // source floor) is an arbitrary microsecond value in both anchor modes.
    for (const mode of ['normal', 'ripple'] as const) {
      useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, settingsFor(fps)));
      const trackId = addTrack('video');
      expect(addClipFromAsset(ASSET_A, { trackId }, 1_000_000).ok).toBe(true);
      const clip = firstClip();
      expect(setClipSpeed([clip.id], 1.235).ok).toBe(true);
      expectGates(`${label}: speed 1.235 before left trim (${mode})`);

      const spedUp = firstClip();
      const start = spedUp.timelineStartUs;
      expect(trimClip(spedUp.id, 'left', start + 2_000_000).ok).toBe(true);
      record(`${label}: left trim in at 1.235x (${mode})`, fps);
      expect(trimClip(spedUp.id, 'left', 0, mode).ok).toBe(true);
      record(`${label}: left edge back out at 1.235x (${mode})`, fps);

      const out = firstClip();
      expect(out.sourceInUs).toBeGreaterThanOrEqual(0);
      expect(out.sourceOutUs).toBeLessThanOrEqual(DURATION_A);
    }
  });

  it('a roll pushed to the source limit keeps the shared cut on the grid', () => {
    const trackId = addTrack('video');
    expect(addClipFromAsset(ASSET_A, { trackId }, 0).ok).toBe(true);
    const whole = firstClip();
    expect(splitClipAt(whole.id, 3_000_000).ok).toBe(true);
    record(`${label}: split before roll`, fps);

    const [a, b] = currentDoc().tracks[0].clips;
    // Roll the shared cut as far right as A's source allows — the clamp lands
    // on the raw asset duration, which is not a frame boundary.
    expect(trimClip(a.id, 'right', 30_000_000, 'roll').ok).toBe(true);
    record(`${label}: roll to A's source end`, fps);
    const rolled = currentDoc().tracks[0].clips as MediaClip[];
    // A roll keeps the cut SHARED: no gap, no overlap.
    expect(rolled[0].timelineStartUs + rolled[0].timelineDurationUs).toBe(
      rolled[1].timelineStartUs,
    );
    expect(rolled[0].id).toBe(a.id);
    expect(rolled[1].id).toBe(b.id);

    // ... and as far left as B's source allows.
    expect(trimClip(a.id, 'right', 0, 'roll').ok).toBe(true);
    record(`${label}: roll to B's source start`, fps);
    const back = currentDoc().tracks[0].clips as MediaClip[];
    expect(back[0].timelineStartUs + back[0].timelineDurationUs).toBe(back[1].timelineStartUs);
  });

  it('overlay insert and speed changes stay on the grid', () => {
    const trackId = addTrack('video');
    expect(addClipFromAsset(ASSET_A, { trackId }, 33_333).ok).toBe(true);
    record(`${label}: add @33_333`, fps);

    expect(addTextClip(
      {
        content: 'Merhaba',
        fontId: 'inter-v1',
        fontSizePx: 48,
        fontWeight: 700,
        italic: false,
        fill: '#ffffff',
        align: 'center',
        lineHeight: 1.2,
      },
      { newTrack: true },
      1_500_000,
    ).ok).toBe(true);
    record(`${label}: text overlay`, fps);

    for (const rate of [2, 0.5, 1.235]) {
      const clip = currentDoc().tracks.flatMap((t) => t.clips).find((c) => c.kind === 'video')!;
      expect(setClipSpeed([clip.id], rate).ok, `rate ${rate}`).toBe(true);
      record(`${label}: speed ${rate}`, fps);
    }
  });
});

afterAll(() => {
  // Deterministic ids: the ops mint uuidv7 values, and a corpus that changes on
  // every run is a corpus nobody can review in a diff.
  const ids = new Map<string, string>();
  const stable = (raw: string): string => {
    const existing = ids.get(raw);
    if (existing !== undefined) return existing;
    const next = `00000000-0000-7000-8000-${String(ids.size + 1).padStart(12, '0')}`;
    ids.set(raw, next);
    return next;
  };
  const cases = corpus.map(({ label, fps, doc }) => {
    for (const track of doc.tracks) {
      track.id = stable(track.id);
      for (const clip of track.clips) clip.id = stable(clip.id);
    }
    return { label, fps, doc };
  });
  const path = fileURLToPath(
    new URL(
      '../../../../packages/timeline-schema/test-vectors/frame-grid-corpus.json',
      import.meta.url,
    ),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $comment:
          'GENERATED by apps/editor/src/state/frameGridCrossBoundary.test.ts. Every doc here was produced by the real editor ops and must pass ExportCompiler.Validate (backend/tests/VideoEdit.UnitTests/FrameGridCrossBoundaryTests.cs).',
        cases,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});
