/**
 * Overlay clips end-to-end at the store level: the ops (timelineOps) + the
 * placement policy (overlayActions).
 *
 * What has to hold, and why:
 * - the produced document passes the SHARED contract (validateTimelineDoc) —
 *   the export compiler validates the same rules, so a document that fails here
 *   would be a 422 the user cannot see coming;
 * - one add = ONE history entry and Ctrl+Z removes the clip AND the lane it
 *   created (a half-undone add is what "undo is broken" looks like);
 * - an explicit target REFUSES an overlap instead of silently moving the clip;
 * - the auto policy never refuses (it opens a lane), because a caption the user
 *   asked for must land somewhere visible.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  frameToUs,
  snapUsToFrameGrid,
  validateTimelineDoc,
  type ShapeClip,
  type TextClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useAssetStore } from '../../state/assetStore';
import { useEditorStore } from '../../state/editorStore';
import {
  addShapeClip,
  addStickerClip,
  addTextClip,
  applyClipShapeToDraft,
  applyClipTextToDraft,
  setClipShape,
  setClipText,
} from '../../state/timelineOps';
import { defaultShapeStyle, defaultTextStyle, OVERLAY_DEFAULT_DURATION_US } from './overlayDefaults';
import { addShapeAtPlayhead, addStickerAtPlayhead, addTextAtPlayhead } from './overlayActions';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const IMAGE_ASSET = '01890000-0000-7000-8000-00000000000f';
const VIDEO_ASSET = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const O1 = '01890000-0000-7000-8000-000000000102';

function track(id: string, type: Track['type'], clips: Track['clips'] = []): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips };
}

function docWith(tracks: Track[]): TimelineDoc {
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks };
}

function load(doc: TimelineDoc, playheadUs = 0): void {
  useDocStore.getState().loadDoc(doc);
  useEditorStore.getState().setSelection([]);
  useEditorStore.getState().setPlayheadUs(playheadUs);
}

function doc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function overlayTracks(): Track[] {
  return doc().tracks.filter((t) => t.type === 'overlay');
}

function expectValid(context: string): void {
  const result = validateTimelineDoc(doc());
  const issues = result.success
    ? ''
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  expect(result.success, `${context}: ${issues}`).toBe(true);
}

const style = () => defaultTextStyle(defaultProjectSettings);

beforeEach(() => {
  useAssetStore.getState().setAssets([
    { id: IMAGE_ASSET, kind: 'image', name: 'logo.png', status: 'ready', width: 512, height: 512 },
    {
      id: VIDEO_ASSET,
      kind: 'video',
      name: 'kamera.mp4',
      status: 'ready',
      durationUs: 30 * US,
    },
  ]);
  load(docWith([track(V1, 'video')]));
});

describe('addTextClip / addShapeClip (ops)', () => {
  it('creates an overlay track when the document has none, and selects the clip', () => {
    const result = addTextClip(style(), { newTrack: true }, 2 * US);
    expect(result.ok).toBe(true);
    const lanes = overlayTracks();
    expect(lanes).toHaveLength(1);
    expect(lanes[0].clips).toHaveLength(1);

    const clip = lanes[0].clips[0] as TextClip;
    expect(clip.kind).toBe('text');
    expect(clip.timelineStartUs).toBe(2 * US);
    expect(clip.timelineDurationUs).toBe(OVERLAY_DEFAULT_DURATION_US);
    expect(clip.text.content).toBe('Metin');
    expect([...useEditorStore.getState().selection]).toEqual([clip.id]);
    expectValid('metin eklendikten sonra');
  });

  it('refuses a non-overlay track, a locked track and an overlap', () => {
    expect(addTextClip(style(), { trackId: V1 }, 0)).toMatchObject({
      ok: false,
      reason: 'track type mismatch',
    });

    load(docWith([track(V1, 'video'), track(O1, 'overlay')]));
    expect(addTextClip(style(), { trackId: O1 }, 0).ok).toBe(true);
    // Same range again: the op refuses instead of stacking two clips.
    expect(addTextClip(style(), { trackId: O1 }, 0)).toMatchObject({
      ok: false,
      reason: 'overlaps an existing clip',
    });
    expect(doc().tracks[1].clips).toHaveLength(1);

    const locked = docWith([track(V1, 'video'), { ...track(O1, 'overlay'), locked: true }]);
    load(locked);
    expect(addTextClip(style(), { trackId: O1 }, 0)).toMatchObject({
      ok: false,
      reason: 'track is locked',
    });
  });

  it('snaps the start AND the duration onto the project frame grid', () => {
    // An off-grid start/duration must not survive: preview and export share the
    // same grid (rendering-semantics §1.4), so a clip between frames would draw
    // one frame off in the export.
    const fps = defaultProjectSettings.fps;
    addTextClip(style(), { newTrack: true }, 1_000_017, 5_000_004);
    const clip = overlayTracks()[0].clips[0];
    expect(clip.timelineStartUs).toBe(snapUsToFrameGrid(1_000_017, fps));
    expect(clip.timelineDurationUs).toBe(snapUsToFrameGrid(5_000_004, fps));
    expect(snapUsToFrameGrid(clip.timelineStartUs, fps)).toBe(clip.timelineStartUs);
    expectValid('grid snap sonrası');
  });

  it('never produces a sub-frame clip (a zero-length overlay renders nothing)', () => {
    addTextClip(style(), { newTrack: true }, 0, 1);
    const clip = overlayTracks()[0].clips[0];
    expect(clip.timelineDurationUs).toBeGreaterThanOrEqual(
      frameToUs(1, defaultProjectSettings.fps),
    );
    expectValid('minimum süre sonrası');
  });

  it('is ONE history entry and Ctrl+Z removes the clip together with its lane', () => {
    const before = useDocStore.getState().history.length;
    addShapeClip(defaultShapeStyle('ellipse'), { newTrack: true }, 0);
    expect(useDocStore.getState().history.length).toBe(before + 1);
    expect(useDocStore.getState().history.at(-1)?.label).toBe('Şekil eklendi');

    useDocStore.getState().undo();
    expect(overlayTracks()).toHaveLength(0);
    expectValid('geri alma sonrası');
  });

  it('accepts only a ready IMAGE asset as a sticker', () => {
    expect(addStickerClip(VIDEO_ASSET, { newTrack: true }, 0)).toMatchObject({
      ok: false,
      reason: 'only an image asset can be a sticker',
    });
    expect(addStickerClip('01890000-0000-7000-8000-0000000000ff', { newTrack: true }, 0)).toMatchObject({
      ok: false,
      reason: 'asset not found',
    });
    expect(addStickerClip(IMAGE_ASSET, { newTrack: true }, 0).ok).toBe(true);
    expect(overlayTracks()[0].clips[0]).toMatchObject({ kind: 'sticker', assetId: IMAGE_ASSET });
    expectValid('sticker eklendikten sonra');
  });
});

describe('placement policy (addTextAtPlayhead & co)', () => {
  it('reuses an existing overlay lane at the playhead', () => {
    load(docWith([track(V1, 'video'), track(O1, 'overlay')]), 3 * US);
    expect(addTextAtPlayhead().ok).toBe(true);
    expect(overlayTracks()).toHaveLength(1);
    expect(overlayTracks()[0].clips[0].timelineStartUs).toBe(3 * US);
  });

  it('stacks a NEW lane when the playhead is occupied on every existing lane', () => {
    load(docWith([track(V1, 'video'), track(O1, 'overlay')]), 0);
    expect(addTextAtPlayhead().ok).toBe(true);
    expect(addTextAtPlayhead().ok).toBe(true); // same instant -> second lane
    expect(overlayTracks()).toHaveLength(2);
    expect(overlayTracks()[0].clips).toHaveLength(1);
    expect(overlayTracks()[1].clips).toHaveLength(1);
    expectValid('ikinci katman sonrası');
  });

  it('skips a LOCKED lane instead of failing', () => {
    load(docWith([track(V1, 'video'), { ...track(O1, 'overlay'), locked: true }]), 0);
    expect(addShapeAtPlayhead({ type: 'arrow' }).ok).toBe(true);
    expect(doc().tracks.find((t) => t.id === O1)?.clips).toHaveLength(0); // untouched
    const created = overlayTracks().find((t) => t.id !== O1);
    expect((created?.clips[0] as ShapeClip).shape.type).toBe('arrow');
  });

  /**
   * tracks[0] is the TOP layer. An overlay lane appended like a media track
   * would be composited BEHIND the footage: the user adds a caption, sees
   * nothing, and reports "text does not work".
   */
  it('puts a NEW overlay lane on top of the stack, never under the video', () => {
    load(docWith([track(V1, 'video')]), 0);
    expect(addTextAtPlayhead().ok).toBe(true);
    expect(doc().tracks[0].type).toBe('overlay');
    expect(doc().tracks[doc().tracks.length - 1].id).toBe(V1);
  });

  it('places at an explicit time (the context menu passes the FROZEN playhead)', () => {
    load(docWith([track(V1, 'video')]), 9 * US);
    addTextAtPlayhead({ timeUs: 2 * US });
    expect(overlayTracks()[0].clips[0].timelineStartUs).toBe(2 * US);
  });

  it('reports the asset precondition instead of opening an empty lane', () => {
    const before = doc().tracks.length;
    expect(addStickerAtPlayhead(VIDEO_ASSET)).toMatchObject({ ok: false });
    expect(doc().tracks).toHaveLength(before);
  });
});

describe('text / shape property ops', () => {
  function seedText(): string {
    const result = addTextClip(style(), { newTrack: true }, 0);
    expect(result.ok).toBe(true);
    return (result as { clipId: string }).clipId;
  }

  function textOf(clipId: string): TextClip['text'] {
    for (const t of doc().tracks) {
      for (const c of t.clips) if (c.id === clipId && c.kind === 'text') return c.text;
    }
    throw new Error('text clip not found');
  }

  it('writes content, size, colour and alignment, one history entry each', () => {
    const id = seedText();
    const before = useDocStore.getState().history.length;
    setClipText([id], { content: 'Merhaba\nDünya' });
    setClipText([id], { fontSizePx: 120 });
    setClipText([id], { fill: '#ff0000' });
    setClipText([id], { align: 'left' });
    expect(useDocStore.getState().history.length).toBe(before + 4);
    expect(textOf(id)).toMatchObject({
      content: 'Merhaba\nDünya',
      fontSizePx: 120,
      fill: '#ff0000',
      align: 'left',
    });
    expect(useDocStore.getState().history.at(-1)?.label).toMatch(/hizalama/i);
    expectValid('metin biçimi yazıldıktan sonra');
  });

  it('clamps out-of-range numbers and IGNORES an invalid colour', () => {
    const id = seedText();
    setClipText([id], { fontSizePx: 99_999 });
    expect(textOf(id).fontSizePx).toBe(2000);
    setClipText([id], { fontSizePx: 0 });
    expect(textOf(id).fontSizePx).toBe(4);
    setClipText([id], { lineHeight: 99 });
    expect(textOf(id).lineHeight).toBe(4);
    setClipText([id], { fontWeight: 12_000 });
    expect(textOf(id).fontWeight).toBe(1000);

    const fill = textOf(id).fill;
    setClipText([id], { fill: 'crimson' });
    expect(textOf(id).fill, 'geçersiz renk dokümanı bozmamalı').toBe(fill);
    setClipText([id], { fill: '#AABBCCDD' });
    expect(textOf(id).fill).toBe('#AABBCCDD');
    expectValid('kırpma sonrası');
  });

  it('adds/removes the optional stroke and background objects via the toggles', () => {
    const id = seedText();
    setClipText([id], { strokeEnabled: false });
    expect(textOf(id).stroke).toBeUndefined();
    setClipText([id], { strokeEnabled: true });
    expect(textOf(id).stroke).toMatchObject({ color: '#000000' });
    setClipText([id], { strokeColor: '#123456', strokeWidthPx: 9 });
    expect(textOf(id).stroke).toEqual({ color: '#123456', widthPx: 9 });

    expect(textOf(id).background).toBeUndefined();
    setClipText([id], { backgroundEnabled: true });
    expect(textOf(id).background).toMatchObject({ paddingPx: 16, radiusPx: 8 });
    // A field write on a DISABLED section must not resurrect the object.
    setClipText([id], { backgroundEnabled: false, backgroundColor: '#00ff00' });
    expect(textOf(id).background).toBeUndefined();
    expectValid('kontur/arka plan geçişleri sonrası');
  });

  it('writes the whole selection in ONE entry and skips clips of the other kind', () => {
    const a = seedText();
    const shape = addShapeClip(defaultShapeStyle(), { newTrack: true }, 0) as { clipId: string };
    const b = seedText();
    const before = useDocStore.getState().history.length;
    expect(setClipText([a, b, shape.clipId], { fill: '#00ff00' }).ok).toBe(true);
    expect(useDocStore.getState().history.length).toBe(before + 1);
    expect(textOf(a).fill).toBe('#00ff00');
    expect(textOf(b).fill).toBe('#00ff00');

    // The shape kept its own fill — a text patch never leaks into it.
    const shapeClip = doc()
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === shape.clipId) as ShapeClip;
    expect(shapeClip.shape.fill).toBe('#5a8cff');
  });

  it('refuses a patch that matches no clip of its kind', () => {
    const id = seedText();
    expect(setClipShape([id], { fill: '#ffffff' })).toMatchObject({ ok: false });
  });

  it('never writes through a locked track (draft helpers included)', () => {
    const id = seedText();
    useDocStore.getState().mutate('trackFlag', 'kilit', (d) => {
      const t = d.tracks.find((x) => x.type === 'overlay');
      if (t) t.locked = true;
    });
    expect(setClipText([id], { content: 'x' })).toMatchObject({ ok: false });
    expect(textOf(id).content).toBe('Metin');

    const draftDoc = structuredClone(doc());
    expect(applyClipTextToDraft(draftDoc, [id], { content: 'x' })).toMatchObject({ ok: false });
    expect(applyClipShapeToDraft(draftDoc, [id], { fill: '#ffffff' })).toMatchObject({ ok: false });
  });
});
