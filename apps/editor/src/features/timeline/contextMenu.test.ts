/**
 * contextMenu testleri.
 *
 * Bu dosyanın ASIL yükü iki yapısal testtir (bkz. describe blokları en altta):
 *
 *  - "disabled === (blockReason !== null)": menü öğesinin gri olması ile op'un
 *    ret gerekçesi TEK kaynaktan gelir.
 *  - "op'u gerçekten çağıran eşleme testi": her öğe için runTimelineMenuAction
 *    GERÇEK store üzerinde koşturulur ve `ok === !disabled` doğrulanır. Menü
 *    "Çoğalt"ı aktif gösterip op'un reddetmesi (kullanıcı: "tıklıyorum hiçbir
 *    şey olmuyor, sadece uyarı çıkıyor") bu testle imkânsız hale gelir.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import {
  addTransitionBlockReason,
  clearClipboardForTests,
  copyBlockReason,
  copyClips,
  cutBlockReason,
  deleteBlockReason,
  detachAudioBlockReason,
  duplicateBlockReason,
  pasteBlockReason,
  removeTransitionBlockReason,
  splitBlockReason,
  trackDeleteBlockReason,
  trimToPlayheadBlockReason,
} from '../../state/timelineOps';
import { resolveTransitionEdge } from './transitions';
import {
  buildTimelineMenu,
  type TimelineMenuActionId,
  type TimelineMenuContext,
  type TimelineMenuEntry,
  type TimelineMenuItem,
} from './contextMenu';
import { runTimelineMenuAction } from './menuActions';

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
    selection: [CLIP_A],
    playheadUs: 5 * US,
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

/** Dokümanı GERÇEK store'a yükler (op çağıran testler için). */
function loadIntoStore(d: TimelineDoc, selection: string[] = [], playheadUs = 5 * US): void {
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(d);
  useEditorStore.getState().setSelection(selection);
  useEditorStore.getState().setPlayheadUs(playheadUs);
}

beforeEach(() => {
  clearClipboardForTests();
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 60 * US },
  ]);
  loadIntoStore(baseDoc(), [CLIP_A]);
});

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
      'addTransition',
      'removeTransition',
      'detachAudio',
    ]);
    expect(entries.filter((e) => e.kind === 'separator')).toHaveLength(3);
    // Ayraç ripple sil ile kırpma çifti arasında.
    expect(entries.findIndex((e) => e.kind === 'separator')).toBe(6);
    // İkinci ayraç kırpma çifti ile geçiş çifti arasında.
    expect(entries.map((e) => e.kind).indexOf('separator', 7)).toBe(9);
    // Üçüncü ayraç geçiş çifti ile "Sesi ayır" arasında.
    expect(entries.map((e) => e.kind).lastIndexOf('separator')).toBe(12);
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

  /**
   * `baseDoc` TEK klipli: klibin hiçbir kenarında kesim yoktur, dolayısıyla
   * geçiş çifti daima gri kalır. (Bitişik/paylı bir kesimde aktif olduklarını
   * kanıtlayan testler "geçiş öğeleri" describe'ında.)
   */
  it('enables everything except the transition pair when the playhead is inside the clip', () => {
    expect(disabledIds(buildTimelineMenu(ctx()))).toEqual(['addTransition', 'removeTransition']);
  });

  it('greys out playhead-relative actions when the playhead is outside the clip', () => {
    const entries = buildTimelineMenu(ctx({ playheadUs: 20 * US }));
    expect(disabledIds(entries)).toEqual([
      'splitAtPlayhead',
      'trimStartToPlayhead',
      'trimEndToPlayhead',
      'addTransition',
      'removeTransition',
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
      'addTransition',
      'removeTransition',
      'detachAudio',
    ] as const) {
      expect(find(entries, id).disabled, id).toBe(true);
    }
  });

  /**
   * Denetim bulgusu 3'ün ta kendisi: bitişik komşusu olan bir klibin
   * kopyasına yer YOKTUR (duplicate klibi kendi süresi kadar sağa koyar).
   * Menü bunu aktif gösterip op'un reddetmesi kullanıcıya "çalışmıyor"
   * hissi veriyordu.
   */
  it('greys out "Çoğalt" when the duplicate would not fit (adjacent neighbour)', () => {
    const doc = docWith([
      track(V1, 'video', [clip(CLIP_A, 0, 10 * US), clip(CLIP_B, 10 * US, 10 * US)]),
    ]);
    const item = find(buildTimelineMenu(ctx({ doc })), 'duplicate');
    expect(item.disabled).toBe(true);
    expect(item.blockReason).toBe('overlaps an existing clip');

    // Aynı klip, komşusu uzaktayken: kopyaya yer var -> aktif.
    const roomy = docWith([
      track(V1, 'video', [clip(CLIP_A, 0, 10 * US), clip(CLIP_B, 40 * US, 10 * US)]),
    ]);
    expect(find(buildTimelineMenu(ctx({ doc: roomy })), 'duplicate').disabled).toBe(false);
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
    const entries = buildTimelineMenu(ctx({ selection: [] }));
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
    expect(find(buildTimelineMenu(trackCtx()), 'paste').disabled).toBe(true);
    expect(find(buildTimelineMenu(trackCtx()), 'paste').blockReason).toBe('clipboard empty');
  });

  /**
   * Yapıştırma da op'un ret kuralına bağlandı: pano dolu OLSA BİLE hedef
   * aralık doluysa öğe kapalıdır (eskiden yalnız "pano boş mu" bakılıyordu).
   */
  it('greys out paste when the clipboard content would overlap at the playhead', () => {
    const doc = docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]);
    loadIntoStore(doc, [CLIP_A]);
    expect(copyClips([CLIP_A])).toBe(true);

    // Playhead klibin içinde -> yapıştırılan kopya çakışır.
    expect(find(buildTimelineMenu(trackCtx({ doc, playheadUs: 5 * US })), 'paste').disabled).toBe(
      true,
    );
    // Playhead klibin sonrasında -> yer var.
    expect(find(buildTimelineMenu(trackCtx({ doc, playheadUs: 30 * US })), 'paste').disabled).toBe(
      false,
    );
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

  it('offers paste and "Metin ekle" outside the track rows', () => {
    const doc = docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]);
    loadIntoStore(doc, [CLIP_A]);
    copyClips([CLIP_A]);
    const entries = buildTimelineMenu(ctx({ target: { kind: 'empty' }, doc, playheadUs: 30 * US }));
    expect(ids(entries)).toEqual(['paste', 'addText']);
    expect(find(entries, 'paste').disabled).toBe(false);
    // Metin yerleşimi asla reddedilmez (gerekirse yeni overlay track açar), bu
    // yüzden tek ret gerekçesi mutasyon kapısıdır.
    expect(find(entries, 'addText').disabled).toBe(false);
    expect(
      find(
        buildTimelineMenu(ctx({ target: { kind: 'empty' }, doc, mutationAllowed: false })),
        'addText',
      ).disabled,
    ).toBe(true);

    clearClipboardForTests();
    expect(
      find(buildTimelineMenu(ctx({ target: { kind: 'empty' }, doc })), 'paste').disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sözleşme testleri (denetim bulgusu 3)
// ---------------------------------------------------------------------------

/** Bir öğenin ret gerekçesini op tarafındaki KAYNAK kuraldan hesaplar. */
function reasonFromOps(id: TimelineMenuActionId, c: TimelineMenuContext): string | null {
  const selection = new Set(c.selection);
  const clipId = c.target.kind === 'clip' ? c.target.clipId : null;
  const trackId = c.target.kind === 'track' ? c.target.trackId : null;
  const gate = (r: string | null): string | null => (c.mutationAllowed ? r : 'blocked');
  switch (id) {
    case 'splitAtPlayhead':
      return gate(splitBlockReason(c.doc, c.playheadUs, selection));
    case 'cut':
      return gate(cutBlockReason(c.doc, c.selection));
    case 'copy':
      return copyBlockReason(c.doc, c.selection);
    case 'duplicate':
      return gate(duplicateBlockReason(c.doc, c.selection));
    case 'delete':
    case 'rippleDelete':
      return gate(deleteBlockReason(c.doc, c.selection));
    case 'trimStartToPlayhead':
    case 'trimEndToPlayhead':
      return gate(trimToPlayheadBlockReason(c.doc, c.playheadUs, selection));
    case 'detachAudio':
      return gate(clipId === null ? 'no clip' : detachAudioBlockReason(c.doc, clipId));
    case 'paste':
      return gate(pasteBlockReason(c.doc, c.playheadUs));
    case 'toggleMuted':
    case 'toggleHidden':
    case 'toggleLocked':
      return gate(null);
    case 'deleteTrack':
      return gate(trackId === null ? 'no track' : trackDeleteBlockReason(c.doc, trackId));
    case 'addMarker':
      return gate(null);
    case 'addText':
      // overlayActions: playhead'de sığan ilk overlay track, yoksa yeni katman
      // -> yerleşim başarısız olamaz.
      return gate(null);
    // Geçiş çifti: kenar seçimi menüyle AYNI çözücüden gelmeli, yoksa test
    // menünün gösterdiğinden başka bir kesimin kuralını doğrulardı.
    case 'addTransition': {
      if (clipId === null) return gate('no clip');
      const edge = resolveTransitionEdge(c.doc, clipId, { timeUs: clipTimeUs(c), require: 'cut' });
      return gate(addTransitionBlockReason(c.doc, clipId, edge));
    }
    case 'removeTransition': {
      if (clipId === null) return gate('no clip');
      const edge = resolveTransitionEdge(c.doc, clipId, {
        timeUs: clipTimeUs(c),
        require: 'transition',
      });
      return gate(removeTransitionBlockReason(c.doc, clipId, edge));
    }
  }
}

function clipTimeUs(c: TimelineMenuContext): number | undefined {
  return c.target.kind === 'clip' ? c.target.timeUs : undefined;
}

describe('menü disabled durumu === op ret gerekçesi (tablo testi)', () => {
  const twoAdjacent = docWith([
    track(V1, 'video', [clip(CLIP_A, 0, 10 * US), clip(CLIP_B, 10 * US, 10 * US)]),
    track(A1, 'audio', []),
  ]);
  const lockedTrack = docWith([
    track(V1, 'video', [clip(CLIP_A, 0, 10 * US)], { locked: true }),
    track(V2, 'video', []),
  ]);
  /**
   * Bitişik iki klip, GİDEN olanı animasyonlu. Derleyici bu kesimde geçişi
   * reddeder ("transition-keyframes"), dolayısıyla "Geçiş ekle" öğesi de gri
   * olmalı — bu satır, kapı sökülürse tabloyu kırmızıya çeviren yerdir.
   */
  const animatedNeighbour = docWith([
    track(V1, 'video', [
      {
        ...clip(CLIP_A, 0, 10 * US),
        keyframes: { opacity: [{ timeUs: 0, value: 1, easing: { type: 'linear' } }] },
      },
      clip(CLIP_B, 10 * US, 10 * US),
    ]),
    track(A1, 'audio', []),
  ]);

  const cases: { name: string; ctx: TimelineMenuContext }[] = [
    { name: 'klip / playhead içeride', ctx: ctx() },
    { name: 'klip / playhead dışarıda', ctx: ctx({ playheadUs: 40 * US }) },
    { name: 'klip / seçim yok', ctx: ctx({ selection: [] }) },
    { name: 'klip / bitişik komşu (çoğaltmaya yer yok)', ctx: ctx({ doc: twoAdjacent }) },
    { name: 'klip / komşu animasyonlu (geçiş yasak)', ctx: ctx({ doc: animatedNeighbour }) },
    { name: 'klip / kilitli track', ctx: ctx({ doc: lockedTrack }) },
    { name: 'klip / mutasyon yasak', ctx: ctx({ mutationAllowed: false }) },
    { name: 'track', ctx: ctx({ target: { kind: 'track', trackId: V1 }, doc: twoAdjacent }) },
    { name: 'track / mutasyon yasak', ctx: ctx({ target: { kind: 'track', trackId: V1 }, doc: twoAdjacent, mutationAllowed: false }) },
    { name: 'ruler', ctx: ctx({ target: { kind: 'ruler', timeUs: 3 * US } }) },
    { name: 'boş alan', ctx: ctx({ target: { kind: 'empty' } }) },
  ];

  it.each(cases)('$name', ({ ctx: c }) => {
    const entries = items(buildTimelineMenu(c));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.disabled, `${entry.id}: disabled`).toBe(reasonFromOps(entry.id, c) !== null);
      // blockReason ile disabled ASLA ayrışmaz.
      expect(entry.disabled, `${entry.id}: blockReason tutarlılığı`).toBe(
        entry.blockReason !== null,
      );
    }
  });
});

describe("menü öğesi -> op eşlemesi (op'u gerçekten çağırır)", () => {
  /**
   * Her aktif öğe op'a inince BAŞARILI, her gri öğe op'a inince BAŞARISIZ
   * olmalı. "Gri olanı da çalıştır" kısmı bilinçli: menü bir eylemi haksız
   * yere kapatıyorsa (aşırı-kısıtlama) bu test de kırmızıya döner.
   */
  function assertMappingMatches(c: TimelineMenuContext, selection: string[]): void {
    for (const entry of items(buildTimelineMenu(c))) {
      // Her öğe için taze doküman: op'lar birbirinin zeminini kaydırmasın.
      loadIntoStore(structuredClone(c.doc), selection, c.playheadUs);
      const result = runTimelineMenuAction(entry.id, {
        target: c.target,
        selection,
        playheadUs: c.playheadUs,
      });
      expect(result.ok, `${entry.id}: disabled=${entry.disabled} -> ok=${result.ok}`).toBe(
        !entry.disabled,
      );
    }
  }

  it('klip menüsü — playhead klibin içinde, her öğe aktif ve op kabul ediyor', () => {
    const c = ctx({ doc: docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]) });
    assertMappingMatches(c, [CLIP_A]);
  });

  it('klip menüsü — playhead dışarıda: gri öğeleri op da reddediyor', () => {
    const c = ctx({
      doc: docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]),
      playheadUs: 40 * US,
    });
    assertMappingMatches(c, [CLIP_A]);
  });

  it('klip menüsü — bitişik komşu: "Çoğalt" hem gri hem op tarafından reddediliyor', () => {
    const c = ctx({
      doc: docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US), clip(CLIP_B, 10 * US, 10 * US)])]),
    });
    expect(find(buildTimelineMenu(c), 'duplicate').disabled).toBe(true);
    assertMappingMatches(c, [CLIP_A]);
  });

  it('klip menüsü — kilitli track: op da her mutasyonu reddediyor', () => {
    const c = ctx({
      doc: docWith([
        track(V1, 'video', [clip(CLIP_A, 0, 10 * US)], { locked: true }),
        track(V2, 'video', []),
      ]),
    });
    assertMappingMatches(c, [CLIP_A]);
  });

  it('track menüsü — bayraklar ve track silme', () => {
    const c = ctx({
      target: { kind: 'track', trackId: V2 },
      doc: docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)]), track(V2, 'video', [])]),
    });
    assertMappingMatches(c, [CLIP_A]);
  });

  it('ruler menüsü — marker eylemi', () => {
    const c = ctx({ target: { kind: 'ruler', timeUs: 3 * US } });
    assertMappingMatches(c, [CLIP_A]);
    expect(useDocStore.getState().doc.markers).toHaveLength(1);
    expect(useDocStore.getState().doc.markers[0].timeUs).toBe(3 * US);
  });

  /**
   * Bulgu 4'ün op tarafı: menü DONMUŞ playhead ile açıldıysa, araya playhead'i
   * oynatan bir olay girse bile bölme MENÜNÜN gösterdiği yerde olmalıdır.
   */
  it('donmuş playhead: split, canlı playhead değil MENÜNÜN değeriyle böler', () => {
    const doc = docWith([track(V1, 'video', [clip(CLIP_A, 0, 10 * US)])]);
    loadIntoStore(doc, [CLIP_A], 4 * US);
    const frozen = useEditorStore.getState().playheadUs;

    // Menü açıkken playhead klibin DIŞINA kaçıyor (ArrowDown / oynatma).
    useEditorStore.getState().setPlayheadUs(40 * US);

    const result = runTimelineMenuAction('splitAtPlayhead', {
      target: { kind: 'clip', clipId: CLIP_A },
      selection: [CLIP_A],
      playheadUs: frozen,
    });
    expect(result.ok, 'donmuş playhead ile bölme başarılı olmalı').toBe(true);
    const clips = useDocStore.getState().doc.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[1].timelineStartUs).toBe(4 * US); // canlı 40 s değil, donmuş 4 s
  });
});
