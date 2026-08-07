/**
 * addToTimeline — çift-tık ekleme politikası:
 * playhead'e sığdır -> çakışıyorsa proje sonuna -> uygun track yoksa yeni track.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaClip } from '@videoedit/timeline-schema';
import { useAssetStore } from '../../state/assetStore';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import { addClipFromAsset, addTrack } from '../../state/timelineOps';
import { addAssetToTimelineAtPlayhead } from './addToTimeline';

const PROJECT_ID = '01890000-0000-7000-8000-0000000000f1';
const VIDEO_ASSET = '01890000-0000-7000-8000-0000000000fa';
const VIDEO_ASSET_B = '01890000-0000-7000-8000-0000000000fb';
const AUDIO_ASSET = '01890000-0000-7000-8000-0000000000fc';

const US = 1_000_000;

function clipsOf(trackIndex: number): MediaClip[] {
  return useDocStore.getState().doc.tracks[trackIndex].clips as MediaClip[];
}

beforeEach(() => {
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore.getState().setAssets([
    { id: VIDEO_ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
    { id: VIDEO_ASSET_B, kind: 'video', name: 'b.mp4', status: 'ready', durationUs: 4 * US },
    { id: AUDIO_ASSET, kind: 'audio', name: 'c.mp3', status: 'ready', durationUs: 6 * US },
  ]);
  useEditorStore.getState().clearSelection();
  useEditorStore.getState().setPlayheadUs(0);
  useProjectSession.setState({
    status: 'ready',
    projectId: PROJECT_ID,
    projectName: 'test',
    error: null,
  });
});

describe('addAssetToTimelineAtPlayhead', () => {
  it('adds at the playhead on the first fitting track of the matching type', () => {
    const trackId = addTrack('video');
    useEditorStore.getState().setPlayheadUs(2 * US);
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trackId).toBe(trackId);
    expect(clipsOf(0)[0].timelineStartUs).toBe(2 * US);
  });

  it('falls back to the project end when the playhead position overlaps', () => {
    addTrack('video');
    expect(addAssetToTimelineAtPlayhead(VIDEO_ASSET).ok).toBe(true); // 0..10s
    useEditorStore.getState().setPlayheadUs(3 * US); // 3s klibin içi -> çakışma
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET_B);
    expect(res.ok).toBe(true);
    const clips = clipsOf(0);
    expect(clips).toHaveLength(2);
    expect(clips[1].timelineStartUs).toBe(10 * US); // proje sonu
  });

  it('creates a new track when no matching track exists (empty timeline)', () => {
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET);
    expect(res.ok).toBe(true);
    const doc = useDocStore.getState().doc;
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].type).toBe('video');
    expect(clipsOf(0)[0].timelineStartUs).toBe(0);
  });

  it('routes audio assets to audio tracks, not video tracks', () => {
    addTrack('video');
    const audioTrackId = addTrack('audio');
    const res = addAssetToTimelineAtPlayhead(AUDIO_ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trackId).toBe(audioTrackId);
    expect(clipsOf(0)).toHaveLength(0);
    expect(clipsOf(1)).toHaveLength(1);
  });

  it('skips locked tracks and opens a new one instead', () => {
    const trackId = addTrack('video');
    useDocStore.getState().mutate('lock', 'kilit', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.locked = true;
    });
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET);
    expect(res.ok).toBe(true);
    const doc = useDocStore.getState().doc;
    expect(doc.tracks).toHaveLength(2);
    if (res.ok) expect(res.trackId).toBe(doc.tracks[1].id);
  });

  it('refuses while the project session is not ready and leaves the doc untouched', () => {
    addTrack('video');
    useProjectSession.setState({ status: 'loading' });
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET);
    expect(res.ok).toBe(false);
    expect(clipsOf(0)).toHaveLength(0);
  });

  it('refuses assets that are not ready', () => {
    addTrack('video');
    useAssetStore.getState().updateAsset(VIDEO_ASSET, { status: 'processing' });
    const res = addAssetToTimelineAtPlayhead(VIDEO_ASSET);
    expect(res.ok).toBe(false);
    expect(clipsOf(0)).toHaveLength(0);
  });

  it('parity: direct addClipFromAsset at project end matches the fallback placement', () => {
    const trackId = addTrack('video');
    expect(addClipFromAsset(VIDEO_ASSET, { trackId }, 0).ok).toBe(true);
    useEditorStore.getState().setPlayheadUs(1 * US);
    const viaDoubleClick = addAssetToTimelineAtPlayhead(VIDEO_ASSET_B);
    expect(viaDoubleClick.ok).toBe(true);
    expect(clipsOf(0)[1].timelineStartUs).toBe(10 * US);
  });
});
