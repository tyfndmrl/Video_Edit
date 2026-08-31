/**
 * progressHub — canlı kanal / polling-yedek kapıları + mesaj→cache köprüsü.
 *
 * Bağlantı KURULMADAN test edilir (getAccessToken null → ensureStarted no-op): buradaki
 * iddialar saf kapı aritmetiği, cache yamaları ve katkı modelidir. Gerçek WebSocket +
 * gerçek fare kanıtı e2e'dedir (export-progress-hub.spec.ts / progress-fallback.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  ASSETS_POLL_MS,
  applyProgressMessage,
  feedWantedForTests,
  handleProgressMessage,
  hubAwareAssetsInterval,
  hubAwareExportsInterval,
  hubAwareJobInterval,
  resetProgressHubForTests,
  simulateHubStateForTests,
  syncAssetSubscriptions,
  syncJobSubscriptions,
  syncUserFeed,
  watchedForTests,
  type JobProgressMessage,
} from './progressHub';
import {
  EXPORTS_POLL_MS,
  jobQueryKey,
  projectExportsQueryKey,
  type ExportJobDto,
  type ExportListResponse,
} from './exports';
import {
  projectAssetsQueryKey,
  quotaQueryKey,
  type AssetDto,
  type AssetListResponse,
  type QuotaSummaryDto,
} from './assets';

const PROJECT = '01890000-0000-7000-8000-0000000000b1';
const JOB = '01890000-0000-7000-8000-0000000000c1';
const ASSET = '01890000-0000-7000-8000-0000000000a1';

function job(status: ExportJobDto['status'], overrides: Partial<ExportJobDto> = {}): ExportJobDto {
  return {
    id: JOB,
    projectId: PROJECT,
    status,
    profile: '1080p',
    progressPercent: 0,
    progressStage: null,
    error: null,
    downloadUrl: null,
    createdAt: '2026-08-31T10:00:00+00:00',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function asset(status: AssetDto['status'], overrides: Partial<AssetDto> = {}): AssetDto {
  return {
    id: ASSET,
    fileName: 'video.mp4',
    sizeBytes: 1024,
    contentType: 'video/mp4',
    kind: 'video',
    status,
    ...overrides,
  };
}

function exportMsg(
  status: JobProgressMessage['status'],
  overrides: Partial<JobProgressMessage> = {},
): JobProgressMessage {
  return {
    jobId: JOB,
    jobType: 'export',
    assetId: null,
    projectId: PROJECT,
    status,
    progressPercent: 40,
    progressStage: 'render',
    ...overrides,
  };
}

let client: QueryClient;

beforeEach(() => {
  resetProgressHubForTests();
  client = new QueryClient();
});

afterEach(() => {
  resetProgressHubForTests();
  client.clear();
});

describe('polling kapıları (hub-farkındalı refetchInterval)', () => {
  it('hub bağlı değilken bugünkü yoklama aynen döner (yedek sözleşmesi)', () => {
    simulateHubStateForTests({ connected: false });
    expect(hubAwareExportsInterval([job('running')])).toBe(EXPORTS_POLL_MS);
    expect(hubAwareJobInterval(job('queued'))).toBe(EXPORTS_POLL_MS);
    expect(hubAwareAssetsInterval([asset('processing')])).toBe(ASSETS_POLL_MS);
  });

  it('bağlı + tüm aktifler kapsanmışken yoklama durur (canlı kanal devrede)', () => {
    simulateHubStateForTests({ connected: true, coveredJobs: [JOB], coveredAssets: [ASSET] });
    expect(hubAwareExportsInterval([job('running'), job('succeeded', { id: 'diğer' })])).toBe(false);
    expect(hubAwareJobInterval(job('running'))).toBe(false);
    expect(hubAwareAssetsInterval([asset('processing'), asset('ready', { id: 'hazır' })])).toBe(
      false,
    );
  });

  it('tek bir aktif iş bile kapsanmıyorsa liste yoklaması devam eder', () => {
    simulateHubStateForTests({ connected: true, coveredJobs: [JOB] });
    const uncovered = job('running', { id: 'kapsanmayan-is' });
    expect(hubAwareExportsInterval([job('running'), uncovered])).toBe(EXPORTS_POLL_MS);
  });

  it('bağlantı düşünce kapsama tek başına yetmez — yoklama geri gelir', () => {
    simulateHubStateForTests({ connected: true, coveredJobs: [JOB] });
    expect(hubAwareExportsInterval([job('running')])).toBe(false);
    simulateHubStateForTests({ connected: false, coveredJobs: [JOB] });
    // simulate connected=false kapsamayı da anlamsızlaştırır (isJobLive bağlantıyı sorar).
    expect(hubAwareExportsInterval([job('running')])).toBe(EXPORTS_POLL_MS);
  });

  it('aktif iş yoksa hub durumundan bağımsız olarak yoklama yok (bugünkü stop kuralı)', () => {
    simulateHubStateForTests({ connected: false });
    expect(hubAwareExportsInterval([job('succeeded'), job('failed', { id: 'f' })])).toBe(false);
    expect(hubAwareExportsInterval(undefined)).toBe(false);
    expect(hubAwareAssetsInterval([asset('ready')])).toBe(false);
    expect(hubAwareJobInterval(undefined)).toBe(false);
  });
});

describe('mesaj → query cache köprüsü', () => {
  it('terminal olmayan export mesajı liste ve tekil iş cache satırını yamalar', () => {
    client.setQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT), {
      items: [job('queued'), job('succeeded', { id: 'eski' })],
      page: 1,
      pageSize: 20,
      totalCount: 2,
    });
    client.setQueryData<ExportJobDto>(jobQueryKey(JOB), job('queued'));

    applyProgressMessage(client, exportMsg('running', { progressPercent: 55 }));

    const list = client.getQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT))!;
    const patched = list.items.find((j) => j.id === JOB)!;
    expect(patched.status).toBe('running');
    expect(patched.progressPercent).toBe(55);
    expect(patched.progressStage).toBe('render');
    expect(list.items.find((j) => j.id === 'eski')!.status).toBe('succeeded'); // komşuya dokunulmaz
    expect(client.getQueryData<ExportJobDto>(jobQueryKey(JOB))!.progressPercent).toBe(55);
  });

  it('cache satırı olmayan iş için satır UYDURULMAZ (liste üyeliği sunucunun bilgisi)', () => {
    client.setQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT), {
      items: [job('succeeded', { id: 'baska' })],
      page: 1,
      pageSize: 20,
      totalCount: 1,
    });

    applyProgressMessage(client, exportMsg('running'));

    const list = client.getQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT))!;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.id).toBe('baska');
    expect(client.getQueryData(jobQueryKey(JOB))).toBeUndefined();
  });

  it('terminal export mesajı cache YAZMAZ, ilgili sorguları invalidate eder (otoriter GET)', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT), {
      items: [job('running')],
      page: 1,
      pageSize: 20,
      totalCount: 1,
    });

    applyProgressMessage(client, exportMsg('succeeded', { progressPercent: 100 }));

    // Cache'e downloadUrl'süz "succeeded" yazılmadı — satır hâlâ eski hâlinde, çünkü
    // otoriter DTO (downloadUrl dahil) invalidate'in tetiklediği GET ile gelecek.
    const list = client.getQueryData<ExportListResponse>(projectExportsQueryKey(PROJECT))!;
    expect(list.items[0]!.status).toBe('running');
    expect(spy).toHaveBeenCalledTimes(2); // tekil iş + export listeleri
  });

  it('asset mesajı meşgul satırın progress alanını yamalar, terminal mesaj invalidate eder', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT), {
      items: [asset('processing'), asset('ready', { id: 'hazır' })],
      page: 1,
      pageSize: 100,
      totalCount: 2,
    });
    const msg = exportMsg('running', {
      jobType: 'processAsset',
      assetId: ASSET,
      projectId: null,
      progressPercent: 70,
      progressStage: 'filmstrip',
    });

    applyProgressMessage(client, msg);
    const list = client.getQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT))!;
    expect(list.items.find((a) => a.id === ASSET)!.progress).toBe(0.7);
    expect(list.items.find((a) => a.id === 'hazır')!.progress).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    applyProgressMessage(client, { ...msg, status: 'succeeded', progressPercent: 100 });
    expect(spy).toHaveBeenCalledTimes(1); // asset listeleri — Ready meta'sı GET ile gelir
  });
});

describe('user-feed (B6): bilinmeyen-asset tepkisi + yineleme süzgeci', () => {
  const UNKNOWN_ASSET = '01890000-0000-7000-8000-0000000000f9';

  function seedCaches(): void {
    client.setQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT), {
      items: [asset('ready')],
      page: 1,
      pageSize: 100,
      totalCount: 1,
    });
    client.setQueryData<QuotaSummaryDto>([...quotaQueryKey], {
      usedBytes: 100,
      maxBytes: 1000,
      assetCount: 1,
      maxConcurrentUploads: 4,
    });
  }

  function feedMsg(
    status: JobProgressMessage['status'],
    assetId: string,
    overrides: Partial<JobProgressMessage> = {},
  ): JobProgressMessage {
    return exportMsg(status, {
      jobType: 'processAsset',
      assetId,
      projectId: null,
      progressPercent: 0,
      progressStage: 'download',
      ...overrides,
    });
  }

  it('bilinmeyen assetId listeyi + kotayı BİR kez invalidate eder; sonraki adımlar sete takılır', () => {
    seedCaches();
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleProgressMessage(client, feedMsg('running', UNKNOWN_ASSET));

    expect(spy).toHaveBeenCalledTimes(2); // asset listeleri + kota
    // Liste invalidate'i isInvalidated ile OKUNAMAZ: hemen ardından koşan applyAssetMessage
    // yaması (setQueriesData) bayrağı sıfırlar — çağrının hedefi predicate'inden doğrulanır.
    const listPredicate = (
      spy.mock.calls[0]![0] as { predicate: (q: { queryKey: readonly unknown[] }) => boolean }
    ).predicate;
    expect(listPredicate({ queryKey: projectAssetsQueryKey(PROJECT) })).toBe(true);
    expect(listPredicate({ queryKey: [...quotaQueryKey] })).toBe(false);
    expect(client.getQueryState([...quotaQueryKey])!.isInvalidated).toBe(true);
    // Satır UYDURULMADI — liste üyeliği hâlâ sunucunun bilgisi (refetch getirecek).
    const list = client.getQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT))!;
    expect(list.items.map((a) => a.id)).toEqual([ASSET]);

    // Aynı asset'in sonraki %5-adım mesajları fırtına üretmez (noticed seti).
    handleProgressMessage(client, feedMsg('running', UNKNOWN_ASSET, { progressPercent: 20 }));
    handleProgressMessage(client, feedMsg('running', UNKNOWN_ASSET, { progressPercent: 40 }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('bilinen assetId feed yolundan invalidate ÜRETMEZ — mevcut yama yolu işler', () => {
    seedCaches();
    client.setQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT), {
      items: [asset('processing')],
      page: 1,
      pageSize: 100,
      totalCount: 1,
    });
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleProgressMessage(client, feedMsg('running', ASSET, { progressPercent: 70 }));

    expect(spy).not.toHaveBeenCalled();
    const list = client.getQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT))!;
    expect(list.items[0]!.progress).toBe(0.7); // applyAssetMessage yaması aynen çalıştı
  });

  it('export mesajı (assetId yok) kota invalidate etmez', () => {
    seedCaches();
    handleProgressMessage(client, exportMsg('running'));
    expect(client.getQueryState([...quotaQueryKey])!.isInvalidated).toBe(false);
  });

  it('terminal bilinmeyen-asset mesajında liste invalidate\'i TEK (terminal dalından), kota buradan', () => {
    seedCaches();
    const spy = vi.spyOn(client, 'invalidateQueries');

    handleProgressMessage(client, feedMsg('succeeded', UNKNOWN_ASSET, { progressPercent: 100 }));

    // notice: yalnız kota (liste terminal dalına bırakılır) + apply terminal: asset listeleri.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(client.getQueryState([...quotaQueryKey])!.isInvalidated).toBe(true);
    expect(client.getQueryState(projectAssetsQueryKey(PROJECT))!.isInvalidated).toBe(true);
  });

  it('ardışık birebir kopya teslim (asset grubu + feed) BİR kez işlenir; farklı mesaj işlenir', () => {
    seedCaches();
    client.setQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT), {
      items: [asset('processing')],
      page: 1,
      pageSize: 100,
      totalCount: 1,
    });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const terminal = feedMsg('succeeded', ASSET, { progressPercent: 100 });

    handleProgressMessage(client, terminal);
    handleProgressMessage(client, terminal); // ikinci grup teslimi — süzülür

    expect(spy).toHaveBeenCalledTimes(1); // çift değil TEK terminal invalidate

    // Farklı bir mesaj süzgeçten geçer.
    handleProgressMessage(client, feedMsg('running', ASSET, { progressPercent: 45 }));
    const list = client.getQueryData<AssetListResponse>(projectAssetsQueryKey(PROJECT))!;
    expect(list.items[0]!.progress).toBe(0.45);
  });
});

describe('abonelik katkı modeli', () => {
  it('iki owner aynı işi izlerken biri bırakınca abonelik yaşar; ikisi de bırakınca düşer', () => {
    syncJobSubscriptions(client, 'exports-list:p1', [JOB, 'ikinci']);
    syncJobSubscriptions(client, `job:${JOB}`, [JOB]);
    expect(watchedForTests().jobs).toEqual(['ikinci', JOB].sort());

    syncJobSubscriptions(client, 'exports-list:p1', []); // liste unmount/terminal
    expect(watchedForTests().jobs).toEqual([JOB]); // tekil hook hâlâ izliyor

    syncJobSubscriptions(client, `job:${JOB}`, []);
    expect(watchedForTests().jobs).toEqual([]);
  });

  it('asset katkıları job katkılarından bağımsız yaşar', () => {
    syncAssetSubscriptions(client, 'assets-list:p1', [ASSET]);
    syncJobSubscriptions(client, 'exports-list:p1', [JOB]);
    syncAssetSubscriptions(client, 'assets-list:p1', []);
    expect(watchedForTests()).toEqual({ jobs: [JOB], assets: [] });
  });

  it('feed katkısı (B6): iki kitaplık örneğinden biri kapanınca istek yaşar, ikisi de kapanınca düşer', () => {
    syncUserFeed(client, 'assets-list:p1', true);
    syncUserFeed(client, 'assets-list:p2', true);
    expect(feedWantedForTests().owners).toEqual(['assets-list:p1', 'assets-list:p2']);

    syncUserFeed(client, 'assets-list:p1', false);
    expect(feedWantedForTests().owners).toEqual(['assets-list:p2']);

    syncUserFeed(client, 'assets-list:p2', false);
    expect(feedWantedForTests().owners).toEqual([]);
    // Bağlantı hiç kurulmadı (token yok) — abonelik bayrağı da hiç kalkmadı.
    expect(feedWantedForTests().subscribed).toBe(false);
  });
});
