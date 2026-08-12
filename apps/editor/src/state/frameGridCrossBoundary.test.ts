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
  knownAssetDurations,
  moveClips,
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
