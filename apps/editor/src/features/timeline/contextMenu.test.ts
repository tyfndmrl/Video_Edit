import { describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings } from '../../state/docStore';
import {
  buildTimelineMenu,
  type TimelineMenuActionId,
  type TimelineMenuContext,
  type TimelineMenuEntry,
  type TimelineMenuItem,
} from './contextMenu';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const V1 = '01890000-0000-7000-8000-000000000101';
const V2 = '01890000-0000-7000-8000-000000000102';
const A1 = '01890000-0000-7000-8000-000000000103';
const A2 = '01890000-0000-7000-8000-000000000104';

function clip(id: string, startUs: number, durationUs: number): MediaClip {
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

function track(id: string, type: Track['type'], clips: MediaClip[], flags: Partial<Track> = {}): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
}

function docWith(tracks: Track[]): TimelineDoc {
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks };
}

/** Tek video track + üzerinde 0..10 s arası bir klip. */
function baseDoc(): TimelineDoc {
  return docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]);
}

function ctx(over: Partial<TimelineMenuContext> = {}): TimelineMenuContext {
  return {
    target: { kind: 'clip', clipId: CLIP_A },
    doc: baseDoc(),
    selectionCount: 1,
    playheadUs: 5 * US,
    clipboardHasContent: true,
    mutationAllowed: true,
    ...over,
  };
}

function items(entries: TimelineMenuEntry[]): TimelineMenuItem[] {
  return entries.filter((e): e is TimelineMenuItem => e.kind === 'item');
}

function ids(entries: TimelineMenuEntry[]): TimelineMenuActionId[] {
  return items(entries).map((i) => i.id);
}

function find(entries: TimelineMenuEntry[], id: TimelineMenuActionId): TimelineMenuItem {
  const hit = items(entries).find((i) => i.id === id);
  if (!hit) throw new Error(`menu item ${id} missing`);
  return hit;
}

function disabledIds(entries: TimelineMenuEntry[]): TimelineMenuActionId[] {
  return items(entries)
    .filter((i) => i.disabled)
    .map((i) => i.id);
}

describe('buildTimelineMenu — klip bağlamı', () => {
  it('offers the clip actions in order, with a separator before the trim pair', () => {
    const entries = buildTimelineMenu(ctx());
    expect(ids(entries)).toEqual([
      'splitAtPlayhead',
      'cut',
      'copy',
      'duplicate',
      'delete',
      'rippleDelete',
      'trimStartToPlayhead',
      'trimEndToPlayhead',
      'detachAudio',
    ]);
    expect(entries.filter((e) => e.kind === 'separator')).toHaveLength(2);
    // Ayraç ripple sil ile kırpma çifti arasında.
    expect(entries.findIndex((e) => e.kind === 'separator')).toBe(6);
    // İkinci ayraç kırpma çifti ile "Sesi ayır" arasında.
    expect(entries.map((e) => e.kind).lastIndexOf('separator')).toBe(9);
  });

  it('carries the shortcut hints of the existing keyboard actions', () => {
    const entries = buildTimelineMenu(ctx());
    expect(find(entries, 'splitAtPlayhead').shortcut).toBe('C');
    expect(find(entries, 'cut').shortcut).toBe('Ctrl+X');
    expect(find(entries, 'copy').shortcut).toBe('Ctrl+C');
    expect(find(entries, 'duplicate').shortcut).toBe('Ctrl+D');
    expect(find(entries, 'delete').shortcut).toBe('Delete');
    expect(find(entries, 'rippleDelete').shortcut).toBe('Shift+Delete');
    expect(find(entries, 'trimStartToPlayhead').shortcut).toBe('Q');
    expect(find(entries, 'trimEndToPlayhead').shortcut).toBe('W');
  });

  it('enables everything when the playhead is inside the clip', () => {
    expect(disabledIds(buildTimelineMenu(ctx()))).toEqual([]);
  });

  it('greys out playhead-relative actions when the playhead is outside the clip', () => {
    const entries = buildTimelineMenu(ctx({ playheadUs: 20 * US }));
    expect(disabledIds(entries)).toEqual([
      'splitAtPlayhead',
      'trimStartToPlayhead',
      'trimEndToPlayhead',
    ]);
    // Silme/kopyalama playhead'den bağımsız çalışmaya devam eder.
    expect(find(entries, 'delete').disabled).toBe(false);
  });

  it('treats the clip edges as outside (same rule as clipsAtTime)', () => {
    expect(find(buildTimelineMenu(ctx({ playheadUs: 0 })), 'splitAtPlayhead').disabled).toBe(true);
    expect(find(buildTimelineMenu(ctx({ playheadUs: 10 * US })), 'splitAtPlayhead').disabled).toBe(
      true,
    );
  });

  it('greys out mutations on a locked track but still allows copy', () => {
    const doc = docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)], { locked: true })]);
    const entries = buildTimelineMenu(ctx({ doc }));
    expect(find(entries, 'copy').disabled).toBe(false);
    for (const id of [
      'splitAtPlayhead',
      'cut',
      'duplicate',
      'delete',
      'rippleDelete',
      'trimStartToPlayhead',
      'trimEndToPlayhead',
      'detachAudio',
    ] as const) {
      expect(find(entries, id).disabled, id).toBe(true);
    }
  });

  describe('"Sesi ayır"', () => {
    it('is enabled only on a video clip that still owns its audio', () => {
      expect(find(buildTimelineMenu(ctx()), 'detachAudio').disabled).toBe(false);
    });

    it('is disabled once the audio has already been detached', () => {
      const detached = clip(CLIP_A, 0, 10 * US);
      detached.audio = null;
      const doc = docWith([track(V1, 'video', [detached])]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(true);
    });

    it('is disabled on an audio clip (nothing to separate)', () => {
      const audioClip = clip(CLIP_A, 0, 10 * US);
      audioClip.kind = 'audio';
      const doc = docWith([track(A1, 'audio', [audioClip])]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(true);
    });

    it('is disabled on an image clip (no embedded audio)', () => {
      const imageClip = clip(CLIP_A, 0, 10 * US);
      imageClip.kind = 'image';
      imageClip.audio = null;
      const doc = docWith([track(V1, 'video', [imageClip])]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(true);
    });

    /**
     * The op refuses when no unlocked audio track has room at that range; the
     * menu used to offer the item anyway and the user got a warning bubble
     * instead of a greyed-out row. Disabled state = the op's FULL refusal set.
     */
    it('is disabled when every audio track is blocked by an overlapping clip', () => {
      const blocker = clip(CLIP_B, 5 * US, 10 * US);
      blocker.kind = 'audio';
      const doc = docWith([
        track(V1, 'video', [clip(CLIP_A, 0, 10 * US)]),
        track(A1, 'audio', [blocker]),
      ]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(true);
    });

    it('is disabled when the only audio track is locked', () => {
      const doc = docWith([
        track(V1, 'video', [clip(CLIP_A, 0, 10 * US)]),
        track(A1, 'audio', [], { locked: true }),
      ]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(true);
    });

    it('stays ENABLED when a blocked audio track is followed by a free one', () => {
      const blocker = clip(CLIP_B, 5 * US, 10 * US);
      blocker.kind = 'audio';
      const doc = docWith([
        track(V1, 'video', [clip(CLIP_A, 0, 10 * US)]),
        track(A1, 'audio', [blocker]),
        track(A2, 'audio', []),
      ]);
      expect(find(buildTimelineMenu(ctx({ doc })), 'detachAudio').disabled).toBe(false);
    });

    it('stays ENABLED with no audio track at all (the op creates one)', () => {
      expect(find(buildTimelineMenu(ctx()), 'detachAudio').disabled).toBe(false);
    });
  });

  it('greys everything out when document mutation is not allowed (project loading)', () => {
    const entries = buildTimelineMenu(ctx({ mutationAllowed: false }));
    expect(disabledIds(entries)).toEqual(
      ids(entries).filter((id) => id !== 'copy'),
    );
  });

  it('greys out selection-driven actions when nothing is selected', () => {
    const entries = buildTimelineMenu(ctx({ selectionCount: 0 }));
    expect(find(entries, 'copy').disabled).toBe(true);
    expect(find(entries, 'cut').disabled).toBe(true);
    expect(find(entries, 'delete').disabled).toBe(true);
  });

  it('marks the destructive items as danger', () => {
    const entries = buildTimelineMenu(ctx());
    expect(find(entries, 'delete').danger).toBe(true);
    expect(find(entries, 'rippleDelete').danger).toBe(true);
    expect(find(entries, 'copy').danger).toBeUndefined();
  });

  it('returns no menu when the clip is gone from the document', () => {
    expect(buildTimelineMenu(ctx({ doc: docWith([]) }))).toEqual([]);
  });
});

describe('buildTimelineMenu — track bağlamı', () => {
  const trackCtx = (over: Partial<TimelineMenuContext> = {}): TimelineMenuContext =>
    ctx({ target: { kind: 'track', trackId: V1 }, ...over });

  it('offers paste, the three flags and track deletion', () => {
    const entries = buildTimelineMenu(trackCtx({ doc: docWith([track(V1, 'video', []), track(V2, 'video', [])]) }));
    expect(ids(entries)).toEqual([
      'paste',
      'toggleMuted',
      'toggleHidden',
      'toggleLocked',
      'deleteTrack',
    ]);
    expect(entries.filter((e) => e.kind === 'separator')).toHaveLength(1);
  });

  it('flips the toggle labels with the track flags', () => {
    const off = buildTimelineMenu(trackCtx());
    expect(find(off, 'toggleMuted').label).toBe('Sessize al');
    expect(find(off, 'toggleHidden').label).toBe('Gizle');
    expect(find(off, 'toggleLocked').label).toBe('Kilitle');

    const on = buildTimelineMenu(
      trackCtx({
        doc: docWith([track(V1, 'video', [], { muted: true, hidden: true, locked: true })]),
      }),
    );
    expect(find(on, 'toggleMuted').label).toBe('Sesi aç');
    expect(find(on, 'toggleHidden').label).toBe('Göster');
    expect(find(on, 'toggleLocked').label).toBe('Kilidi aç');
  });

  it('greys out paste when the clipboard is empty', () => {
    expect(find(buildTimelineMenu(trackCtx({ clipboardHasContent: false })), 'paste').disabled).toBe(
      true,
    );
    expect(find(buildTimelineMenu(trackCtx()), 'paste').disabled).toBe(false);
  });

  it('greys out deleting the LAST video track (matches the op guard)', () => {
    expect(find(buildTimelineMenu(trackCtx()), 'deleteTrack').disabled).toBe(true);

    const two = docWith([track(V1, 'video', []), track(V2, 'video', [])]);
    expect(find(buildTimelineMenu(trackCtx({ doc: two })), 'deleteTrack').disabled).toBe(false);
  });

  it('allows deleting an audio track even when it is the only one', () => {
    const doc = docWith([track(V1, 'video', []), track(A1, 'audio', [])]);
    const entries = buildTimelineMenu(ctx({ target: { kind: 'track', trackId: A1 }, doc }));
    expect(find(entries, 'deleteTrack').disabled).toBe(false);
  });

  it('greys out deleting a locked track', () => {
    const doc = docWith([track(V1, 'video', []), track(V2, 'video', [], { locked: true })]);
    const entries = buildTimelineMenu(ctx({ target: { kind: 'track', trackId: V2 }, doc }));
    expect(find(entries, 'deleteTrack').disabled).toBe(true);
  });

  it('returns no menu for a track that no longer exists', () => {
    expect(buildTimelineMenu(trackCtx({ doc: docWith([]) }))).toEqual([]);
  });
});

describe('buildTimelineMenu — ruler / boş alan', () => {
  it('offers the marker action on the ruler', () => {
    const entries = buildTimelineMenu(ctx({ target: { kind: 'ruler', timeUs: 3 * US } }));
    expect(ids(entries)).toEqual(['addMarker']);
    expect(find(entries, 'addMarker').shortcut).toBe('M');
    expect(find(entries, 'addMarker').disabled).toBe(false);
  });

  it('greys the marker action out while the project is not ready', () => {
    const entries = buildTimelineMenu(
      ctx({ target: { kind: 'ruler', timeUs: 0 }, mutationAllowed: false }),
    );
    expect(find(entries, 'addMarker').disabled).toBe(true);
  });

  it('offers only paste outside the track rows', () => {
    const entries = buildTimelineMenu(ctx({ target: { kind: 'empty' } }));
    expect(ids(entries)).toEqual(['paste']);
    expect(find(entries, 'paste').disabled).toBe(false);
    expect(
      find(buildTimelineMenu(ctx({ target: { kind: 'empty' }, clipboardHasContent: false })), 'paste')
        .disabled,
    ).toBe(true);
  });
});
