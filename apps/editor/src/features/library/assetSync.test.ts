/**
 * assetSync — the server asset poll must MERGE into assetStore (finding 11):
 * presigned URL fields written by the media-urls sync survive the 3 s poll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/queryClient';
import { quotaQueryKey, type AssetDto } from '../../entities/assets';
import { useAssetStore } from '../../state/assetStore';
import { syncServerAssets } from './assetSync';

const A1 = '01890000-0000-7000-8000-00000000000a';
const A2 = '01890000-0000-7000-8000-00000000000b';

function dto(partial: Partial<AssetDto> & { id: string }): AssetDto {
  return {
    fileName: 'clip.mp4',
    sizeBytes: 1000,
    contentType: 'video/mp4',
    kind: 'video',
    status: 'ready',
    durationMicros: 10_000_000,
    width: 1920,
    height: 1080,
    ...partial,
  };
}

beforeEach(() => {
  useAssetStore.getState().setAssets([]);
});

describe('syncServerAssets', () => {
  it('inserts unknown assets', () => {
    syncServerAssets([dto({ id: A1 }), dto({ id: A2, kind: 'audio', fileName: 'a.wav' })]);
    const store = useAssetStore.getState();
    expect(store.assets.size).toBe(2);
    expect(store.getAsset(A1)?.kind).toBe('video');
    expect(store.getAsset(A2)?.kind).toBe('audio');
    expect(store.getAsset(A2)?.name).toBe('a.wav');
  });

  it('MERGES into existing records — presigned URL fields survive the poll', () => {
    syncServerAssets([dto({ id: A1, status: 'processing', durationMicros: undefined })]);
    // media-urls sync wrote the presigned fields in the meantime:
    useAssetStore.getState().updateAsset(A1, {
      proxyUrl: 'https://r2/proxy',
      posterUrl: 'https://r2/poster',
      filmstripManifestUrl: 'https://r2/manifest',
      waveformUrl: 'https://r2/peaks',
      sprites: { 'sprite_000.jpg': 'https://r2/s0' },
    });

    // Next poll tick: asset flipped to ready with fresh metadata.
    syncServerAssets([dto({ id: A1, status: 'ready', durationMicros: 12_000_000 })]);

    const a = useAssetStore.getState().getAsset(A1)!;
    expect(a.status).toBe('ready');
    expect(a.durationUs).toBe(12_000_000);
    // The URL fields were NOT wiped by the poll:
    expect(a.proxyUrl).toBe('https://r2/proxy');
    expect(a.posterUrl).toBe('https://r2/poster');
    expect(a.filmstripManifestUrl).toBe('https://r2/manifest');
    expect(a.waveformUrl).toBe('https://r2/peaks');
    expect(a.sprites).toEqual({ 'sprite_000.jpg': 'https://r2/s0' });
  });

  it('undefined DTO fields do not clobber known values', () => {
    syncServerAssets([dto({ id: A1, durationMicros: 10_000_000, width: 1920, height: 1080 })]);
    syncServerAssets([
      dto({ id: A1, durationMicros: undefined, width: undefined, height: undefined }),
    ]);
    const a = useAssetStore.getState().getAsset(A1)!;
    expect(a.durationUs).toBe(10_000_000);
    expect(a.width).toBe(1920);
    expect(a.height).toBe(1080);
  });

  /**
   * The API serializes an unknown duration as JSON `null`, and a still image
   * has no duration to report (ffprobe's png_pipe demuxer emits none). The DTO
   * type claims `number | undefined`, so nothing complained — but the null then
   * reached the source-bounds invariant, where `4000000 > null` is TRUE and
   * adding a photo to the timeline threw. Cut it at the source.
   */
  it('a null durationMicros off the wire is stored as undefined, never as null', () => {
    syncServerAssets([
      dto({
        id: A1,
        kind: 'image',
        fileName: 'foto.png',
        contentType: 'image/png',
        durationMicros: null as unknown as undefined,
      }),
    ]);
    const a = useAssetStore.getState().getAsset(A1)!;
    expect(a.kind).toBe('image');
    expect(a.durationUs, 'null must not survive into the store.').toBeUndefined();
    expect(a.durationUs).not.toBeNull();
  });

  it('a null durationMicros does not clobber a duration already known', () => {
    syncServerAssets([dto({ id: A1, durationMicros: 10_000_000 })]);
    syncServerAssets([dto({ id: A1, durationMicros: null as unknown as undefined })]);
    expect(useAssetStore.getState().getAsset(A1)?.durationUs).toBe(10_000_000);
  });

  /**
   * `hasAudio` üç değerlidir ve ÜÇÜNCÜ değer (bilinmiyor) tel üzerinde JSON
   * `null` gelir: API olguyu yalnız READY satırda doldurur. `false` ise KESİN
   * bir olgudur (sessiz video) ve `detachAudioBlockReason` yalnız onun üzerine
   * engel kurar — null'un false'a düşmesi sesli ama işlenmemiş videoda yanlış
   * ret, false'un kaybolması sessiz videoda 422 tuzağı demek olurdu.
   */
  it('hasAudio: null off the wire stays unknown; an explicit false is stored and survives', () => {
    syncServerAssets([
      dto({ id: A1, status: 'processing', hasAudio: null as unknown as undefined }),
    ]);
    expect(useAssetStore.getState().getAsset(A1)?.hasAudio).toBeUndefined();

    // Probe bitti: sessiz video olgusu (false) yazılır — false, undefined değildir.
    syncServerAssets([dto({ id: A1, status: 'ready', hasAudio: false })]);
    expect(useAssetStore.getState().getAsset(A1)?.hasAudio).toBe(false);

    // Sonraki poll'lar olguyu korur; sesli varlıkta true da aynı yoldan akar.
    syncServerAssets([dto({ id: A1, status: 'ready', hasAudio: false })]);
    expect(useAssetStore.getState().getAsset(A1)?.hasAudio).toBe(false);
    syncServerAssets([dto({ id: A2, status: 'ready', hasAudio: true })]);
    expect(useAssetStore.getState().getAsset(A2)?.hasAudio).toBe(true);
  });

  /**
   * The server adds DERIVED bytes to the storage quota the moment an asset
   * turns ready (worker-side, no user gesture). The poll observing that flip
   * is the only place that can refresh the header quota indicator — without
   * it the UI diverged from GET /api/quota until a full reload.
   */
  it('invalidates the quota query when the poll observes a flip to ready', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    try {
      syncServerAssets([dto({ id: A1, status: 'processing' })]);
      expect(spy, 'processing tek başına kota sorgusunu tazelememeli.').not.toHaveBeenCalled();

      syncServerAssets([dto({ id: A1, status: 'ready' }), dto({ id: A2, status: 'ready' })]);
      // Batch'te iki asset ready'ye geçse bile TEK invalidation (A2 poll'da
      // ilk kez görülüyor — bilinen bir geçiş değil, sayılmaz).
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ queryKey: quotaQueryKey });

      spy.mockClear();
      // Kararlı ready -> ready poll'ları tekrar tekrar invalidate ETMEZ.
      syncServerAssets([dto({ id: A1, status: 'ready' }), dto({ id: A2, status: 'ready' })]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the fresher local uploading progress over the polled one', () => {
    useAssetStore.getState().setAssets([
      { id: A1, kind: 'video', name: 'clip.mp4', status: 'uploading', progress: 0.8 },
    ]);
    syncServerAssets([dto({ id: A1, status: 'uploading', progress: 0.2 })]);
    expect(useAssetStore.getState().getAsset(A1)?.progress).toBe(0.8);
  });
});
