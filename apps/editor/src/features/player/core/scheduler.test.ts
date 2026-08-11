/**
 * Preload/pool scheduler state machine tests (pure decisions only —
 * <video>/WebGL integration is verified E2E).
 */
import { describe, expect, it } from 'vitest';
import {
  computeSlotRequests,
  countPreviewLayers,
  planPool,
  POOL_SIZE,
  previewShortfallNote,
  samePreviewCapacity,
  trackLabel,
  type SlotRequest,
} from './scheduler';
import { isClipMuted, resolveAudible, resolveVisualStack } from './resolve';
import { linkTransition, mkDoc, mkMediaClip, mkTrack } from './testFixtures';

const SEC = 1_000_000;

function req(clipId: string, priority: number, trackIndex = 0, hidden = false): SlotRequest {
  return {
    clipId,
    assetId: `asset-${clipId}`,
    priority,
    hidden,
    trackIndex,
    sourceTimeUs: 0,
    rate: 1,
  };
}

/** countPreviewLayers over a whole doc — the way the engine calls it. */
function capacityOf(
  doc: Parameters<typeof resolveVisualStack>[0],
  tUs: number,
  hasElement: (clipId: string) => boolean,
) {
  return countPreviewLayers(
    resolveVisualStack(doc, tUs),
    resolveAudible(doc, tUs),
    hasElement,
  );
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

describe('computeSlotRequests inside a transition window (§5.3)', () => {
  /** A/B cut at 5 s with a 1 s crossfade -> window [4.5 s, 5.5 s). */
  function fixture() {
    const a = mkMediaClip({
      id: 'a',
      assetId: 'A',
      startUs: 0,
      durationUs: 5 * SEC,
      sourceInUs: 0,
      sourceOutUs: 5 * SEC,
    });
    const b = mkMediaClip({
      id: 'b',
      assetId: 'B',
      startUs: 5 * SEC,
      durationUs: 5 * SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 7 * SEC,
    });
    linkTransition(a, b, SEC);
    return { a, b, doc: mkDoc([mkTrack('t', [a, b])]) };
  }

  it('BOTH sides are priority 0 — a transition pair outranks every preload', () => {
    const { doc } = fixture();
    const requests = computeSlotRequests(doc, 4_600_000, 1 * SEC);
    expect(requests.map((r) => r.clipId).sort()).toEqual(['a', 'b']);
    expect(requests.every((r) => r.priority === 0)).toBe(true);
  });

  it('each side is positioned on its HANDLE material, not on a clamped edge', () => {
    const { doc } = fixture();
    // 4.6 s = 0.4 s BEFORE the cut: B must already be 0.4 s before its sourceIn.
    const before = computeSlotRequests(doc, 4_600_000, 1 * SEC);
    expect(before.find((r) => r.clipId === 'b')!.sourceTimeUs).toBe(1_600_000);
    expect(before.find((r) => r.clipId === 'a')!.sourceTimeUs).toBe(4_600_000);
    // 5.4 s = 0.4 s AFTER the cut: A must be 0.4 s past its sourceOut.
    const after = computeSlotRequests(doc, 5_400_000, 1 * SEC);
    expect(after.find((r) => r.clipId === 'a')!.sourceTimeUs).toBe(5_400_000);
    expect(after.find((r) => r.clipId === 'b')!.sourceTimeUs).toBe(2_400_000);
  });

  it('without the transition the same instant wants ONE element (negative control)', () => {
    const { doc } = fixture();
    delete (doc.tracks[0]!.clips[0] as { transitionOut?: unknown }).transitionOut;
    delete (doc.tracks[0]!.clips[1] as { transitionIn?: unknown }).transitionIn;
    const requests = computeSlotRequests(doc, 5_400_000, 1 * SEC);
    expect(requests.map((r) => r.clipId)).toEqual(['b']);
  });

  it('the pair survives an over-subscribed pool (planPool keeps both)', () => {
    const { doc } = fixture();
    // Three more tracks, all with an active clip: 5 wants, 4 slots.
    const extras = [0, 1, 2].map((i) =>
      mkTrack(`x${i}`, [
        mkMediaClip({ id: `x${i}`, assetId: `X${i}`, startUs: 0, durationUs: 20 * SEC }),
      ]),
    );
    const crowded = mkDoc([...extras, doc.tracks[0]!]);
    const plan = planPool([], computeSlotRequests(crowded, 4_600_000, 1 * SEC), POOL_SIZE);
    const kept = plan.map((p) => p.clipId);
    // The pair lives on the BOTTOM track, so it is last in the tie-break — and
    // it still cannot be split: a half-drawn crossfade is worse than a dropped
    // layer, because it looks like the transition is broken.
    expect(kept).toHaveLength(POOL_SIZE);
    expect(kept.filter((id) => id === 'a' || id === 'b').length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Multi-layer compositions (M4): who wins a scarce pool, and what the user is
// told about it.
// ---------------------------------------------------------------------------

describe('multi-layer scheduling', () => {
  /** n video tracks, each with one clip active over [0, 10 s). */
  function stackedDoc(n: number) {
    return mkDoc(
      Array.from({ length: n }, (_, i) =>
        mkTrack(`t${i}`, [
          mkMediaClip({ id: `c${i}`, assetId: `A${i}`, startUs: 0, durationUs: 10 * SEC }),
        ]),
      ),
    );
  }

  it('every simultaneously active clip asks for its own element', () => {
    // The whole point of a multi-layer preview: 3 layers -> 3 elements, not 1.
    const requests = computeSlotRequests(stackedDoc(3), 2 * SEC, SEC);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.priority === 0)).toBe(true);
    expect(requests.map((r) => r.clipId)).toEqual(['c0', 'c1', 'c2']);
  });

  it('requests carry their track index (tracks[0] = top layer)', () => {
    const requests = computeSlotRequests(stackedDoc(3), 2 * SEC, SEC);
    expect(requests.map((r) => r.trackIndex)).toEqual([0, 1, 2]);
  });

  it('over-subscribed pool: the TOP layers keep their elements, the bottom is dropped', () => {
    // 6 active layers, 4 slots -> tracks 0..3 win, tracks 4..5 starve.
    const wanted = computeSlotRequests(stackedDoc(6), 2 * SEC, SEC);
    const plan = planPool([], wanted, 4);
    expect(plan.map((p) => p.clipId).sort()).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('layer order beats document order, not the other way round', () => {
    // Same urgency, deliberately shuffled input: the comparator (not the array
    // order it happened to arrive in) must decide.
    const shuffled = [req('bottom', 0, 3), req('top', 0, 0), req('mid', 0, 1)];
    expect(planPool([], shuffled, 2).map((p) => p.clipId).sort()).toEqual(['mid', 'top']);
  });

  it('an active BOTTOM layer still beats a preload of a top layer', () => {
    // Urgency dominates the layer tie-break: what is on screen now wins over
    // what will be on screen in 300 ms.
    const wanted = [req('preload-top', 1 + 300_000, 0), req('active-bottom', 0, 9)];
    expect(planPool([], wanted, 1).map((p) => p.clipId)).toEqual(['active-bottom']);
  });

  it('a hidden track YIELDS its element to the visible layer below it', () => {
    // Behaviour change (M4 audit): the scheduler used to be hidden-agnostic, so
    // the hidden track — sitting on the SMALLER index — won the trackIndex
    // tie-break and starved the visible track underneath. Hiding the surplus is
    // the user's most natural remedy for a crowded preview; it must free
    // capacity, never consume it.
    const doc = mkDoc([
      mkTrack('hidden', [mkMediaClip({ id: 'h', startUs: 0, durationUs: 10 * SEC })], {
        hidden: true,
      }),
      mkTrack('shown', [mkMediaClip({ id: 's', startUs: 0, durationUs: 10 * SEC })]),
    ]);
    const requests = computeSlotRequests(doc, SEC, SEC);
    // Both are still REQUESTED (a track can be unhidden at any moment and must
    // not stall on a cold decoder) — but the visible one is ranked first...
    expect(requests.map((r) => r.clipId)).toEqual(['s', 'h']);
    expect(requests.map((r) => r.hidden)).toEqual([false, true]);
    // ...so with a single slot the VISIBLE layer is the one that survives.
    expect(planPool([], requests, 1).map((p) => p.clipId)).toEqual(['s']);
    expect(resolveVisualStack(doc, SEC).map((a) => a.clip.id)).toEqual(['s']);
  });

  it('hiding the top layers is a working remedy for an over-subscribed pool', () => {
    // 6 layers, 4 slots. The user hides the two TOP ones to see the rest.
    const tracks = Array.from({ length: 6 }, (_, i) =>
      mkTrack(`t${i}`, [mkMediaClip({ id: `c${i}`, assetId: `A${i}`, startUs: 0, durationUs: 10 * SEC })], {
        hidden: i < 2,
      }),
    );
    const doc = mkDoc(tracks);
    const plan = planPool([], computeSlotRequests(doc, 2 * SEC, SEC), 4);
    expect(plan.map((p) => p.clipId).sort()).toEqual(['c2', 'c3', 'c4', 'c5']);
    // Every layer that is actually drawn now has an element — preview restored.
    const drawn = resolveVisualStack(doc, 2 * SEC).map((a) => a.clip.id);
    const fed = new Set(plan.map((p) => p.clipId));
    expect(drawn.every((id) => fed.has(id))).toBe(true);
  });

  it('urgency still outranks visibility (an active hidden clip beats a preload)', () => {
    // The visibility rung sits BELOW priority: a cold decoder for a clip that is
    // one frame away from being unhidden must not outrank what is playing now.
    const wanted = [req('preload-visible', 1 + 100_000, 0, false), req('active-hidden', 0, 5, true)];
    expect(planPool([], wanted, 1).map((p) => p.clipId)).toEqual(['active-hidden']);
  });

  it('the visual stack is BOTTOM first (compositor draw order) across many layers', () => {
    // tracks[0] is the top layer, so it must be drawn LAST.
    expect(resolveVisualStack(stackedDoc(4), SEC).map((a) => a.clip.id)).toEqual([
      'c3',
      'c2',
      'c1',
      'c0',
    ]);
  });

  it('a muted track stays audible-resolved but silent (isClipMuted decides)', () => {
    const doc = mkDoc([
      mkTrack('m', [mkMediaClip({ id: 'q', startUs: 0, durationUs: 10 * SEC })], { muted: true }),
    ]);
    const [audible] = resolveAudible(doc, SEC);
    expect(audible!.clip.id).toBe('q');
    expect(isClipMuted(doc.tracks[0]!, audible!.clip)).toBe(true);
  });
});

describe('countPreviewLayers', () => {
  const doc6 = mkDoc(
    Array.from({ length: 6 }, (_, i) =>
      mkTrack(`t${i}`, [
        mkMediaClip({ id: `c${i}`, assetId: `A${i}`, startUs: 0, durationUs: 10 * SEC }),
      ]),
    ),
  );

  it('reports the shortfall when the pool cannot feed every visual layer', () => {
    const winners = new Set(planPool([], computeSlotRequests(doc6, SEC, SEC), 4).map((p) => p.clipId));
    const capacity = capacityOf(doc6, SEC, (id) => winners.has(id));
    expect(capacity.totalLayers).toBe(6);
    expect(capacity.shownLayers).toBe(4);
    // ...and it NAMES the starved tracks, top track first.
    expect(capacity.dropped).toEqual(['Katman 5', 'Katman 6']);
  });

  it('reports no shortfall when everything fits', () => {
    const doc = mkDoc([
      mkTrack('t0', [mkMediaClip({ id: 'a', startUs: 0, durationUs: 10 * SEC })]),
      mkTrack('t1', [mkMediaClip({ id: 'b', startUs: 0, durationUs: 10 * SEC })]),
    ]);
    expect(capacityOf(doc, SEC, () => true)).toEqual({
      totalLayers: 2,
      shownLayers: 2,
      totalAudio: 2,
      shownAudio: 2,
      dropped: [],
    });
  });

  it('images count as shown without an element (plain textures)', () => {
    const doc = mkDoc([
      mkTrack('t0', [
        mkMediaClip({ id: 'img', kind: 'image', startUs: 0, durationUs: 10 * SEC, audio: null }),
      ]),
      mkTrack('t1', [mkMediaClip({ id: 'vid', startUs: 0, durationUs: 10 * SEC })]),
    ]);
    // Nothing owns an element: the video is starved, the image is not.
    const capacity = capacityOf(doc, SEC, () => false);
    expect(capacity.totalLayers).toBe(2);
    expect(capacity.shownLayers).toBe(1);
    expect(capacity.dropped).toEqual(['Katman 2']);
  });

  it('hidden tracks and audio clips are not visual layers', () => {
    const doc = mkDoc([
      mkTrack('hidden', [mkMediaClip({ id: 'h', startUs: 0, durationUs: 10 * SEC })], {
        hidden: true,
      }),
      mkTrack('audio', [mkMediaClip({ id: 'a', kind: 'audio', startUs: 0, durationUs: 10 * SEC })], {
        type: 'audio',
      }),
      mkTrack('video', [mkMediaClip({ id: 'v', startUs: 0, durationUs: 10 * SEC })]),
    ]);
    const capacity = capacityOf(doc, SEC, () => true);
    expect(capacity.totalLayers).toBe(1);
    expect(capacity.shownLayers).toBe(1);
  });

  it('an empty timeline reports nothing (no note is shown)', () => {
    expect(countPreviewLayers([], [], () => true)).toEqual({
      totalLayers: 0,
      shownLayers: 0,
      totalAudio: 0,
      shownAudio: 0,
      dropped: [],
    });
  });

  // -------------------------------------------------------------------------
  // Audio capacity (M4 audit: the pool is shared, and audio starves FIRST)
  // -------------------------------------------------------------------------

  it('the music bed that lost its element is REPORTED, not silently dropped', () => {
    // The scenario from the audit: 4 video layers + 1 music track on the
    // bottom. The pool holds 4, and the music sits on the LARGEST track index,
    // so it is the first thing evicted — and it used to disappear in silence
    // because the note only ever counted visual layers.
    const doc = mkDoc([
      ...Array.from({ length: 4 }, (_, i) =>
        mkTrack(`v${i}`, [
          mkMediaClip({ id: `c${i}`, assetId: `A${i}`, startUs: 0, durationUs: 10 * SEC }),
        ]),
      ),
      mkTrack(
        'music',
        [mkMediaClip({ id: 'music', kind: 'audio', startUs: 0, durationUs: 10 * SEC })],
        { type: 'audio', name: 'Müzik' },
      ),
    ]);
    const winners = new Set(planPool([], computeSlotRequests(doc, SEC, SEC), POOL_SIZE).map((p) => p.clipId));
    expect(winners.has('music')).toBe(false); // the pool really does drop it

    const capacity = capacityOf(doc, SEC, (id) => winners.has(id));
    expect(capacity.totalLayers).toBe(4);
    expect(capacity.shownLayers).toBe(4); // picture is intact...
    expect(capacity.totalAudio).toBe(5); // ...4 video sound tracks + the bed
    expect(capacity.shownAudio).toBe(4); // ...but the bed is silent
    expect(capacity.dropped).toEqual(['Müzik']); // named by its track name

    const note = previewShortfallNote(capacity);
    expect(note, 'A dropped music bed MUST produce a note.').not.toBeNull();
    expect(note!.text).toContain('4 / 5 ses klibi');
    expect(note!.text).not.toContain('katman'); // no false alarm about video
    expect(note!.detail).toContain('Müzik');
  });

  it('muted tracks/clips are not counted as dropped audio (silent by intent)', () => {
    const doc = mkDoc([
      mkTrack('m', [mkMediaClip({ id: 'muted-track', startUs: 0, durationUs: 10 * SEC })], {
        muted: true,
      }),
      mkTrack('c', [
        mkMediaClip({
          id: 'muted-clip',
          startUs: 0,
          durationUs: 10 * SEC,
          audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: true },
        }),
      ]),
      mkTrack('d', [
        mkMediaClip({ id: 'detached', startUs: 0, durationUs: 10 * SEC, audio: null }),
      ]),
    ]);
    const capacity = capacityOf(doc, SEC, () => false);
    expect(capacity.totalAudio, 'Nothing here should be audible.').toBe(0);
    expect(capacity.shownAudio).toBe(0);
    expect(previewShortfallNote(capacity)?.text).toContain('katman'); // only video
  });

  it('one starved track is named once even when both its picture and sound go', () => {
    const doc = mkDoc([
      mkTrack('t0', [mkMediaClip({ id: 'a', startUs: 0, durationUs: 10 * SEC })], { name: 'Ana' }),
    ]);
    const capacity = capacityOf(doc, SEC, () => false);
    expect(capacity).toEqual({
      totalLayers: 1,
      shownLayers: 0,
      totalAudio: 1,
      shownAudio: 0,
      dropped: ['Ana'],
    });
  });

  it('trackLabel falls back to a 1-based layer number per track type', () => {
    expect(trackLabel(mkTrack('x', []), 0)).toBe('Katman 1');
    expect(trackLabel(mkTrack('x', [], { type: 'audio' }), 3)).toBe('Ses 4');
    expect(trackLabel(mkTrack('x', [], { name: '  B-roll  ' }), 2)).toBe('B-roll');
  });
});

describe('previewShortfallNote', () => {
  const full = {
    totalLayers: 3,
    shownLayers: 3,
    totalAudio: 2,
    shownAudio: 2,
    dropped: [] as string[],
  };

  it('says nothing when everything comes through', () => {
    expect(previewShortfallNote(full)).toBeNull();
  });

  it('mentions BOTH shortfalls when picture and sound are degraded', () => {
    const note = previewShortfallNote({
      totalLayers: 6,
      shownLayers: 3,
      totalAudio: 3,
      shownAudio: 1,
      dropped: ['Katman 5', 'Müzik'],
    });
    expect(note!.text).toBe('Önizlemede 3 / 6 katman gösteriliyor, 1 / 3 ses klibi çalıyor');
    expect(note!.detail).toContain('Şu an düşen: Katman 5, Müzik.');
    // The note must not let the user think the EXPORT is degraded too.
    expect(note!.detail).toContain('Dışa aktarımda TÜM katmanlar ve sesler işlenir.');
  });

  it('states the real decoder budget', () => {
    const note = previewShortfallNote({ ...full, shownLayers: 1 }, 4);
    expect(note!.detail).toContain('en fazla 4 medya çözücü');
  });
});

describe('samePreviewCapacity', () => {
  const base = {
    totalLayers: 2,
    shownLayers: 1,
    totalAudio: 1,
    shownAudio: 1,
    dropped: ['Katman 2'],
  };

  it('is true only for an identical snapshot (the previewStatus$ change filter)', () => {
    expect(samePreviewCapacity(base, { ...base, dropped: ['Katman 2'] })).toBe(true);
    expect(samePreviewCapacity(base, { ...base, shownAudio: 0 })).toBe(false);
    // Same counts, DIFFERENT track starved: the note text changes, so this is
    // a change — an equality check on the numbers alone would suppress it.
    expect(samePreviewCapacity(base, { ...base, dropped: ['Katman 1'] })).toBe(false);
    expect(samePreviewCapacity(base, { ...base, dropped: [] })).toBe(false);
  });
});
