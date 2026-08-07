/**
 * Preload/pool scheduler state machine tests (pure decisions only —
 * <video>/WebGL integration is verified E2E).
 */
import { describe, expect, it } from 'vitest';
import { computeSlotRequests, planPool, type SlotRequest } from './scheduler';
import { mkDoc, mkMediaClip, mkTrack } from './testFixtures';

const SEC = 1_000_000;

function req(clipId: string, priority: number): SlotRequest {
  return { clipId, assetId: `asset-${clipId}`, priority, sourceTimeUs: 0, rate: 1 };
}

describe('computeSlotRequests', () => {
  const clip1 = mkMediaClip({
    id: 'c1',
    assetId: 'A',
    startUs: 0,
    durationUs: 5 * SEC,
    sourceInUs: 0,
    sourceOutUs: 5 * SEC,
  });
  const clip2 = mkMediaClip({
    id: 'c2',
    assetId: 'B',
    startUs: 5 * SEC,
    durationUs: 5 * SEC,
    sourceInUs: 2 * SEC,
    sourceOutUs: 7 * SEC,
  });

  it('mid-clip, far from the cut: only the active clip is wanted', () => {
    const doc = mkDoc([mkTrack('t', [clip1, clip2])]);
    const requests = computeSlotRequests(doc, 1 * SEC, 1 * SEC);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ clipId: 'c1', priority: 0, sourceTimeUs: 1 * SEC });
  });

  it('within 1 s of the cut: active clip + preload of the next at ITS sourceIn', () => {
    const doc = mkDoc([mkTrack('t', [clip1, clip2])]);
    const requests = computeSlotRequests(doc, 4_200_000, 1 * SEC);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ clipId: 'c1', priority: 0 });
    // preload priority encodes time-to-start (800 ms); position = clip2.sourceIn
    expect(requests[1]).toMatchObject({
      clipId: 'c2',
      priority: 1 + 800_000,
      sourceTimeUs: 2 * SEC,
    });
  });

  it('in a gap: only the upcoming clip is wanted (preload)', () => {
    const late = mkMediaClip({ id: 'c3', assetId: 'C', startUs: 2 * SEC, durationUs: SEC });
    const doc = mkDoc([mkTrack('t', [late])]);
    expect(computeSlotRequests(doc, 1_500_000, 1 * SEC)).toHaveLength(1);
    expect(computeSlotRequests(doc, 1_500_000, 1 * SEC)[0]!.clipId).toBe('c3');
    // too far away -> nothing
    expect(computeSlotRequests(doc, 500_000, 1 * SEC)).toHaveLength(0);
  });

  it('active clip source time honors speed (rate 2)', () => {
    const fast = mkMediaClip({
      id: 'f',
      assetId: 'F',
      startUs: 0,
      durationUs: 2 * SEC,
      sourceInUs: 0,
      sourceOutUs: 4 * SEC,
      rate: 2,
    });
    const doc = mkDoc([mkTrack('t', [fast])]);
    expect(computeSlotRequests(doc, 1 * SEC, 1 * SEC)[0]!.sourceTimeUs).toBe(2 * SEC);
  });

  it('image clips never request an element; audio clips do', () => {
    const image = mkMediaClip({ id: 'img', startUs: 0, durationUs: 5 * SEC, kind: 'image', audio: null });
    const audio = mkMediaClip({ id: 'aud', startUs: 0, durationUs: 5 * SEC, kind: 'audio' });
    const doc = mkDoc([mkTrack('t0', [image]), mkTrack('t1', [audio], { type: 'audio' })]);
    const requests = computeSlotRequests(doc, 0, 1 * SEC);
    expect(requests.map((r) => r.clipId)).toEqual(['aud']);
  });

  it('sorts active before preload across tracks', () => {
    const activeB = mkMediaClip({ id: 'b', assetId: 'B', startUs: 0, durationUs: 10 * SEC });
    const doc = mkDoc([mkTrack('t0', [clip1, clip2]), mkTrack('t1', [activeB])]);
    const requests = computeSlotRequests(doc, 4_500_000, 1 * SEC);
    expect(requests.map((r) => r.priority === 0)).toEqual([true, true, false]);
    expect(requests[2]!.clipId).toBe('c2');
  });
});

describe('planPool', () => {
  it('assigns fresh requests to slots 0..n in priority order', () => {
    const plan = planPool([], [req('a', 0), req('b', 5)], 4);
    expect(plan).toEqual([
      { slot: 0, clipId: 'a', assetId: 'asset-a' },
      { slot: 1, clipId: 'b', assetId: 'asset-b' },
    ]);
  });

  it('keeps the slot of a clip that stays wanted (element/decoder stability)', () => {
    const current = [{ slot: 2, clipId: 'a', assetId: 'asset-a' }];
    const plan = planPool(current, [req('b', 1), req('a', 0)], 4);
    expect(plan).toEqual([
      { slot: 0, clipId: 'b', assetId: 'asset-b' },
      { slot: 2, clipId: 'a', assetId: 'asset-a' },
    ]);
  });

  it('evicts assignments that are no longer wanted', () => {
    const current = [
      { slot: 0, clipId: 'stale', assetId: 'asset-stale' },
      { slot: 1, clipId: 'a', assetId: 'asset-a' },
    ];
    const plan = planPool(current, [req('a', 0)], 4);
    expect(plan).toEqual([{ slot: 1, clipId: 'a', assetId: 'asset-a' }]);
  });

  it('over-subscription: actives always win, then the soonest preloads', () => {
    const wanted = [
      req('active1', 0),
      req('active2', 0),
      req('pre-soon', 1 + 200_000),
      req('pre-mid', 1 + 500_000),
      req('pre-late', 1 + 900_000),
    ];
    const plan = planPool([], wanted, 4);
    expect(plan.map((p) => p.clipId).sort()).toEqual(
      ['active1', 'active2', 'pre-mid', 'pre-soon'].sort(),
    );
  });

  it('a preload never steals the slot of a still-wanted active clip', () => {
    const current = [
      { slot: 0, clipId: 'active1', assetId: 'asset-active1' },
      { slot: 1, clipId: 'active2', assetId: 'asset-active2' },
    ];
    const plan = planPool(current, [req('active1', 0), req('active2', 0), req('pre', 2)], 2);
    expect(plan).toEqual(current); // pool full of actives — preload must wait
  });

  it('cut handover: old clip leaves, preloaded clip keeps ITS slot (no reload)', () => {
    // Before the cut: c1 active in slot 0, c2 preloaded in slot 1.
    const current = [
      { slot: 0, clipId: 'c1', assetId: 'A' },
      { slot: 1, clipId: 'c2', assetId: 'B' },
    ];
    // After the cut: c2 active, c3 preloads.
    const plan = planPool(current, [req('c2', 0), req('c3', 1 + 700_000)], 4);
    expect(plan).toEqual([
      { slot: 0, clipId: 'c3', assetId: 'asset-c3' },
      { slot: 1, clipId: 'c2', assetId: 'B' }, // kept — its element is warm
    ]);
  });

  it('ignores stale assignments beyond a shrunken pool size', () => {
    const current = [{ slot: 5, clipId: 'a', assetId: 'asset-a' }];
    const plan = planPool(current, [req('a', 0)], 4);
    expect(plan).toEqual([{ slot: 0, clipId: 'a', assetId: 'asset-a' }]);
  });
});
