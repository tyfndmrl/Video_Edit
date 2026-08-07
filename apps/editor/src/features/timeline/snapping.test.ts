import { describe, expect, it } from 'vitest';
import { snapUsToFrameGrid, type Rational } from '@videoedit/timeline-schema';
import { collectSnapCandidates, resolveMoveSnap, resolveSnap } from './snapping';
import { createEmptyDoc, defaultProjectSettings } from '../../state/docStore';
import type { MediaClip, Track } from '@videoedit/timeline-schema';

const FPS: Rational = { num: 30, den: 1 };
const US = 1_000_000;
// pxPerUs 0.001 -> 8 px threshold = 8000 us.
const PX_PER_US = 0.001;

describe('resolveSnap', () => {
  it('picks the nearest candidate within the 8 px threshold', () => {
    const candidates = [1 * US, 1 * US + 5_000];
    const res = resolveSnap(1 * US + 2_000, candidates, PX_PER_US, FPS, true);
    expect(res.snappedTo).toBe(1 * US); // 2000us vs 3000us -> nearest wins
    expect(res.timeUs).toBe(1 * US);
  });

  it('falls back to the frame grid when no candidate is in range', () => {
    const raw = 1 * US + 500_000 + 7; // ~1.5s, off grid
    const res = resolveSnap(raw, [5 * US], PX_PER_US, FPS, true);
    expect(res.snappedTo).toBeNull();
    expect(res.timeUs).toBe(snapUsToFrameGrid(raw, FPS));
  });

  it('ignores candidates entirely when snapping is disabled (grid only)', () => {
    const raw = 1 * US + 2_000;
    const res = resolveSnap(raw, [1 * US], PX_PER_US, FPS, false);
    expect(res.snappedTo).toBeNull();
    expect(res.timeUs).toBe(snapUsToFrameGrid(raw, FPS));
  });

  it('respects the pixel threshold scaling with zoom', () => {
    // At 0.0001 px/us the threshold is 80_000 us -> candidate at 50_000 away snaps.
    const res = resolveSnap(1 * US, [1 * US + 50_000], 0.0001, FPS, true);
    expect(res.snappedTo).toBe(1 * US + 50_000);
  });
});

describe('resolveMoveSnap', () => {
  it('snaps whichever clip edge is closest to a candidate', () => {
    // Anchor clip [0, 2s); dragging so the END approaches a cut at 5s.
    const res = resolveMoveSnap(0, 2 * US, 2 * US + 995_000, [5 * US], PX_PER_US, FPS, true);
    expect(res.snappedTo).toBe(5 * US);
    expect(res.deltaUs).toBe(3 * US); // start lands at 3s, end exactly at 5s
  });

  it('grid-snaps the start when nothing is in range', () => {
    const res = resolveMoveSnap(0, 2 * US, 1_016_666, [9 * US], PX_PER_US, FPS, true);
    expect(res.snappedTo).toBeNull();
    expect(res.deltaUs).toBe(snapUsToFrameGrid(1_016_666, FPS));
  });
});

describe('collectSnapCandidates', () => {
  it('collects clip edges (excluding dragged clips), markers and the playhead', () => {
    const clip: MediaClip = {
      id: '01890000-0000-7000-8000-000000000201',
      kind: 'video',
      assetId: '01890000-0000-7000-8000-00000000000a',
      timelineStartUs: 2 * US,
      timelineDurationUs: 3 * US,
      sourceInUs: 0,
      sourceOutUs: 3 * US,
      speed: { rate: 1 },
      audio: null,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
      keyframes: {},
      effects: [],
      opacity: 1,
    };
    const excluded: MediaClip = { ...clip, id: '01890000-0000-7000-8000-000000000202', timelineStartUs: 7 * US };
    const track: Track = {
      id: '01890000-0000-7000-8000-000000000101',
      type: 'video', muted: false, hidden: false, locked: false,
      clips: [clip, excluded],
    };
    const doc = { ...createEmptyDoc('01890000-0000-7000-8000-000000000001', { ...defaultProjectSettings }), tracks: [track] };
    doc.markers.push({ id: '01890000-0000-7000-8000-000000000301', timeUs: 11 * US });

    const candidates = collectSnapCandidates(doc, {
      excludeClipIds: new Set([excluded.id]),
      playheadUs: 9 * US,
    });
    expect(candidates).toContain(2 * US);
    expect(candidates).toContain(5 * US);
    expect(candidates).toContain(9 * US); // playhead
    expect(candidates).toContain(11 * US); // marker
    expect(candidates).not.toContain(7 * US); // excluded clip edge
    // sorted ascending
    expect([...candidates].sort((a, b) => a - b)).toEqual(candidates);
  });
});
