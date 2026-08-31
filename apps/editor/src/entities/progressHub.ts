/**
 * progressHub — SignalR canlı ilerleme istemcisi (tasarım 03 §5; DECISIONS 2026-08-31).
 *
 * Akış: worker her progress DB yazımının yanında Redis'e publish eder; API'nin forwarder'ı
 * mesajı `job:{id}` / `asset:{id}` SignalR gruplarına — ve sahibinin `user:{id}` FEED grubuna
 * (B6: pasif sekme, başka istemcinin doğurduğu satırı ancak buradan duyar; bilinmeyen assetId
 * listeyi + kotayı invalidate eder) — iletir; SİLME ise iş doğurmadığından API'nin kendisi
 * feed grubuna `assetRemoved` yollar (istemci satırı cache'ten düşürür + kotayı tazeler —
 * handleAssetRemovedMessage); bu modül gruplara abone olur ve gelen mesajları
 * react-query cache'ine işler. POLLING SİLİNMEDİ — YEDEKTİR (tasarım şartı):
 * hub bağlanamadıysa, düştüyse ya da bir abonelik SUSTUYSA (aşağıdaki bekçi) bugünkü 2 sn /
 * 3 sn aralıklı yoklama AYNEN devreye girer. Doğruluk kaynağı her zaman sunucu DTO'larıdır:
 * terminal mesaj (succeeded/failed/canceled) cache'e yazılMAZ, ilgili sorguyu invalidate
 * eder — downloadUrl gibi imzalı alanlar yalnız GET cevabından gelir.
 *
 * KAPSAMA (coverage) modeli — polling kapısının anahtarı:
 * - Bir iş/asset "canlı" sayılır ⇔ bağlantı ayakta VE aboneliği sunucu tarafından kabul
 *   edilmiş VE son SILENCE_TIMEOUT_MS içinde ya abonelik kurulmuş ya mesaj gelmiş.
 * - Sessizlik bekçisi: hub bağlı ama mesaj akmıyorsa (ör. API'nin Redis aboneliği kopmuş,
 *   worker Redis'e ulaşamıyor, reaper işi dışarıdan bitirdi) kapsama düşürülür ve sorgular
 *   dürtülür → polling kaldığı yerden devam eder. Bekçisiz tasarımda "bağlı ama sağır" hub
 *   kullanıcıyı sonsuza dek %0'da bırakırdı.
 * - Kapı fonksiyonları (hub-aware interval'lar) SAF hesaplardır; react-query her sorgu
 *   güncellemesinde yeniden değerlendirir (v5 QueryObserver, güncellemede zamanlayıcıları
 *   yeniden kurar — gelen her hub mesajı da cache'i güncellediği için kapı taze kalır).
 */
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import type { QueryClient } from '@tanstack/react-query';
import { getAccessToken, refreshAccessToken } from './auth';
import {
  EXPORTS_POLL_MS,
  isJobActive,
  jobQueryKey,
  type ExportJobDto,
  type ExportJobStatusDto,
} from './exports';
import type { AssetDto, AssetListResponse } from './assets';

/** Sunucudaki JobProgressMessage'ın (VideoEdit.Contracts/JobProgress.cs) camelCase teli. */
export interface JobProgressMessage {
  jobId: string;
  jobType: 'export' | 'processAsset' | (string & {});
  assetId: string | null;
  projectId: string | null;
  status: ExportJobStatusDto | (string & {});
  progressPercent: number;
  progressStage: string | null;
  error?: string | null;
  /** İşin sahibi — sunucu feed (user:{id}) hedeflemesi için taşır; istemci okumaz. */
  ownerId?: string | null;
}

/** Sunucudaki AssetRemovedMessage'ın (VideoEdit.Contracts/JobProgress.cs) camelCase teli. */
export interface AssetRemovedMessage {
  assetId: string;
}

/** Hub yolu/metodu — sunucudaki JobProgressChannel sabitlerinin istemci aynası. */
export const PROGRESS_HUB_PATH = '/hubs/progress';
export const PROGRESS_HUB_METHOD = 'progress';

/**
 * İkinci hub metodu (B6'nın SİLME yarısı): API, soft-delete sonrası sahibinin feed grubuna
 * süreç-içi `assetRemoved` yollar — silme worker işi doğurmadığı için `progress` akışına
 * hiç girmez ve pasif sekme onu ancak buradan duyabilir.
 */
export const PROGRESS_HUB_ASSET_REMOVED_METHOD = 'assetRemoved';

/** Asset listesi yoklama aralığı (bugünkü değer — assets.ts buradan tüketir). */
export const ASSETS_POLL_MS = 3000;

/**
 * Sessizlik bekçisi eşiği: kapsanan bir abonelikten bu süre mesaj gelmezse kapsama düşer ve
 * polling geri gelir. Worker'ın DB/publish adımları (%5 ya da stage değişimi) kısa işlerde
 * saniyeler mertebesindedir; 2 dk'lık heartbeat'e kadar sessiz kalabilen ÇOK yavaş bir render
 * bekçiyi tetikleyip yoklamayı geri getirir — bu bilinçlidir: yedek kanal, canlı kanalın
 * SUSTUĞU her durumda devreye girmelidir (yanlış tarafta hata = takılı %0'lık UI).
 */
export const HUB_SILENCE_TIMEOUT_MS = 15_000;

/** Bekçi tarama aralığı. */
const WATCHDOG_TICK_MS = 5_000;

/** İlk bağlantı denemeleri başarısızsa yeniden deneme rampası (üstel, tavanlı). */
const START_RETRY_BASE_MS = 5_000;
const START_RETRY_MAX_MS = 30_000;

type CoverageKey = `job:${string}` | `asset:${string}`;

interface HubState {
  client: QueryClient | null;
  connection: HubConnection | null;
  connected: boolean;
  /**
   * İSTENEN abonelikler, KATKI modeliyle: her hook örneği kendi anahtarıyla (owner) kendi
   * listesini yazar; izlenen küme katkıların BİRLEŞİMİDİR. Tek düz küme olsaydı aynı işi
   * farklı pencerelerden izleyen iki hook (liste + tekil iş) birbirinin aboneliğini silerdi.
   */
  jobContributions: Map<string, ReadonlySet<string>>;
  assetContributions: Map<string, ReadonlySet<string>>;
  watchedJobs: Set<string>;
  watchedAssets: Set<string>;
  /**
   * user:{id} feed'ini (B6 — "listende yeni satır doğdu" yayını) isteyen hook örnekleri.
   * Katkı modeli id kümeleriyle aynı; küme boş değilken bağlantı feed'e abonedir. Feed
   * `covered`'a GİRMEZ: bir polling kapısını kapatmaz (bilinmeyen satır için yoklama
   * zaten yok) ve sessizliği normaldir (hiçbir iş koşmuyorken mesaj beklenmez) — bekçi
   * onu düşürmemeli.
   */
  feedOwners: Set<string>;
  /** Feed aboneliği bu bağlantıda sunucuca kabul edildi mi (bağlantıyla ölür). */
  feedSubscribed: boolean;
  /** Kurulmuş + susmamış abonelikler → polling kapısını kapatan küme. */
  covered: Map<CoverageKey, number>;
  startTimer: ReturnType<typeof setTimeout> | null;
  startAttempt: number;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  starting: boolean;
}

const state: HubState = {
  client: null,
  connection: null,
  connected: false,
  jobContributions: new Map(),
  assetContributions: new Map(),
  watchedJobs: new Set(),
  watchedAssets: new Set(),
  feedOwners: new Set(),
  feedSubscribed: false,
  covered: new Map(),
  startTimer: null,
  startAttempt: 0,
  watchdogTimer: null,
  starting: false,
};

// ---------------------------------------------------------------------------
// Polling kapıları (saf — birim testli; hook'lar refetchInterval'dan çağırır)
// ---------------------------------------------------------------------------

/** Bu export işi için canlı kanal ayakta mı? (bağlı + abone + susmamış) */
export function isJobLive(jobId: string): boolean {
  return state.connected && state.covered.has(`job:${jobId}`);
}

/** Bu asset'in işleme akışı için canlı kanal ayakta mı? */
export function isAssetLive(assetId: string): boolean {
  return state.connected && state.covered.has(`asset:${assetId}`);
}

/**
 * Export listesi için hub-farkındalı refetchInterval: aktif işlerin TAMAMI canlı kanaldan
 * izleniyorsa yoklama durur; tek bir iş bile kapsanmıyorsa bugünkü 2 sn yoklama döner.
 */
export function hubAwareExportsInterval(items: ExportJobDto[] | undefined): number | false {
  if (!items) return false;
  const active = items.filter((j) => isJobActive(j.status));
  if (active.length === 0) return false;
  return active.every((j) => isJobLive(j.id)) ? false : EXPORTS_POLL_MS;
}

/** Tek iş sorgusu için aynı kapı. */
export function hubAwareJobInterval(job: ExportJobDto | undefined): number | false {
  if (!job || !isJobActive(job.status)) return false;
  return isJobLive(job.id) ? false : EXPORTS_POLL_MS;
}

/** Asset listesi: uploaded/processing satırların tamamı canlı izleniyorsa yoklama durur. */
export function hubAwareAssetsInterval(items: AssetDto[] | undefined): number | false {
  if (!items) return false;
  const busy = items.filter((a) => a.status === 'uploaded' || a.status === 'processing');
  if (busy.length === 0) return false;
  return busy.every((a) => isAssetLive(a.id)) ? false : ASSETS_POLL_MS;
}

// ---------------------------------------------------------------------------
// Mesaj → query cache köprüsü (saf yardımcı — birim testli)
// ---------------------------------------------------------------------------

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

/** ['projects', <id>, 'exports'] deseni — projectExportsQueryKey ile aynı şekil. */
function isExportsListKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === 'projects' && key[2] === 'exports';
}

function isAssetsListKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === 'projects' && key[2] === 'assets';
}

/** ['quota'] deseni — assets.ts'teki quotaQueryKey ile aynı şekil (değer importu döngü kurardı). */
function isQuotaKey(key: readonly unknown[]): boolean {
  return key.length === 1 && key[0] === 'quota';
}

/**
 * Bağlantı handler'ının giriş noktası — üç katman (dışa açık: birim testleri gerçek
 * QueryClient ile çağırır):
 *  1. YİNELEME SÜZGECİ: aynı mesaj birden çok gruptan gelebilir (meşgul satırı izleyen
 *     sekme hem `asset:{id}` hem feed üyesidir) — ardışık birebir kopya bir kez işlenir
 *     (terminal mesajın çift invalidate'i çift GET olurdu). İki FARKLI yazım hiçbir zaman
 *     birebir aynı değildir (JobProgressWriter yalnız stage/≥5 puan/heartbeat'te yazar).
 *  2. BİLİNMEYEN-ASSET tepkisi (B6): feed'den gelen, hiçbir liste cache'inde olmayan
 *     assetId listeyi + kotayı invalidate eder — pasif sekme yeni satırı böyle duyar.
 *  3. applyProgressMessage: bugüne kadarki cache köprüsü, değişmedi.
 */
export function handleProgressMessage(client: QueryClient, msg: JobProgressMessage): void {
  const sig =
    `${msg.jobId}|${msg.assetId ?? ''}|${msg.status}|${msg.progressPercent}` +
    `|${msg.progressStage ?? ''}|${msg.error ?? ''}`;
  if (sig === lastDeliverySig) return;
  lastDeliverySig = sig;
  noticeUnknownAsset(client, msg);
  applyProgressMessage(client, msg);
}

let lastDeliverySig: string | null = null;

/**
 * FIRTINA KORUMASI iki katmandır: bilinen id'ye çarpan olaylar buradan hiç geçmez (mevcut
 * `asset:{id}` yaması işler, liste çekilmez); bilinmeyen id ise `noticedNewAssets` ile BİR
 * kez invalidate tetikler — aynı asset'in sonraki %5-adım mesajları sete takılır. Terminal
 * mesajda liste invalidate'i applyAssetMessage'ın terminal dalına bırakılır (tek refetch);
 * kota her halükârda buradan tazelenir (upload'ın orijinal baytları complete anında sayılır,
 * türev baytlarını da ready akışındaki assetSync yakalar).
 */
const noticedNewAssets = new Set<string>();

function noticeUnknownAsset(client: QueryClient, msg: JobProgressMessage): void {
  const assetId = msg.assetId;
  if (assetId === null || assetId === undefined || noticedNewAssets.has(assetId)) return;
  const known = client
    .getQueriesData<AssetListResponse>({ predicate: (q) => isAssetsListKey(q.queryKey) })
    .some(([, data]) => data?.items.some((a) => a.id === assetId) ?? false);
  if (known) return;
  noticedNewAssets.add(assetId);
  if (!isTerminal(msg.status)) {
    void client.invalidateQueries({ predicate: (q) => isAssetsListKey(q.queryKey) });
  }
  void client.invalidateQueries({ predicate: (q) => isQuotaKey(q.queryKey) });
}

/**
 * `assetRemoved` mesajını işler (B6'nın silme yarısı — dışa açık: birim testleri gerçek
 * QueryClient ile çağırır). TEK OLAY = TEK INVALIDATE sözleşmesi: satır liste
 * cache'lerinden CERRAHİYLE düşürülür (liste GET'i yok — üyelik bilgisi zaten sunucudan,
 * 204 dönen silmenin duyurusudur) ve yalnız kota invalidate edilir (gösterge sunucu
 * otoritesidir). Silinen id `noticedNewAssets`'e yazılır: işlenmekte olan bir asset
 * silindiyse worker'ın GEÇ progress mesajları "bilinmeyen asset" sayılıp listeyi yeniden
 * çektiremez (diriltme fırtınası yok); terminal mesajın liste invalidate'i zararsızdır —
 * sunucu listesi silineni zaten içermez (sunucu-otoriter liste).
 */
export function handleAssetRemovedMessage(client: QueryClient, msg: AssetRemovedMessage): void {
  const assetId = msg.assetId;
  if (!assetId) return;
  noticedNewAssets.add(assetId);
  state.covered.delete(`asset:${assetId}`);
  client.setQueriesData<AssetListResponse>(
    { predicate: (q) => isAssetsListKey(q.queryKey) },
    (old) => {
      if (!old || !old.items.some((a) => a.id === assetId)) return old;
      return {
        ...old,
        items: old.items.filter((a) => a.id !== assetId),
        totalCount: Math.max(0, old.totalCount - 1),
      };
    },
  );
  void client.invalidateQueries({ predicate: (q) => isQuotaKey(q.queryKey) });
}

/**
 * Bir hub mesajını cache'e işler. Terminal olmayan mesaj mevcut satırları YAMALAR (yeni
 * satır uydurmaz — liste üyeliği sunucunun bilgisidir); terminal mesaj ilgili sorguları
 * invalidate eder ki otoriter DTO (downloadUrl / asset'in Ready meta'sı dahil) TEK bir
 * GET ile gelsin. Dışa açık: birim testleri gerçek QueryClient ile çağırır.
 */
export function applyProgressMessage(client: QueryClient, msg: JobProgressMessage): void {
  if (msg.assetId !== null && msg.assetId !== undefined) {
    applyAssetMessage(client, msg);
    return;
  }
  applyExportMessage(client, msg);
}

function applyExportMessage(client: QueryClient, msg: JobProgressMessage): void {
  if (isTerminal(msg.status)) {
    void client.invalidateQueries({ queryKey: jobQueryKey(msg.jobId) });
    void client.invalidateQueries({ predicate: (q) => isExportsListKey(q.queryKey) });
    return;
  }

  const patch = (job: ExportJobDto): ExportJobDto => ({
    ...job,
    status: msg.status as ExportJobStatusDto,
    progressPercent: msg.progressPercent,
    progressStage: msg.progressStage,
  });

  client.setQueryData<ExportJobDto>(jobQueryKey(msg.jobId), (old) =>
    old ? patch(old) : old,
  );
  client.setQueriesData<{ items: ExportJobDto[] }>(
    { predicate: (q) => isExportsListKey(q.queryKey) },
    (old) =>
      old && old.items.some((j) => j.id === msg.jobId)
        ? { ...old, items: old.items.map((j) => (j.id === msg.jobId ? patch(j) : j)) }
        : old,
  );
}

function applyAssetMessage(client: QueryClient, msg: JobProgressMessage): void {
  if (isTerminal(msg.status)) {
    // Asset satırının yeni hâli (ready/failed + probe meta + hasAudio) yalnız listede döner.
    void client.invalidateQueries({ predicate: (q) => isAssetsListKey(q.queryKey) });
    return;
  }

  client.setQueriesData<AssetListResponse>(
    { predicate: (q) => isAssetsListKey(q.queryKey) },
    (old) => {
      if (!old || !old.items.some((a) => a.id === msg.assetId)) return old;
      return {
        ...old,
        items: old.items.map((a) =>
          a.id === msg.assetId && (a.status === 'uploaded' || a.status === 'processing')
            ? { ...a, status: 'processing', progress: msg.progressPercent / 100 }
            : a,
        ),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Abonelik senkronu (hook'lar çağırır)
// ---------------------------------------------------------------------------

/**
 * Bir hook örneğinin (owner) izlemek istediği export işleri katkısını senkronlar: küme
 * birleşimindeki yenilere abone olunur, birleşimden düşenlerin aboneliği bırakılır.
 * Idempotent — hook her veri gelişinde çağırır; unmount'ta boş listeyle çağrılır.
 */
export function syncJobSubscriptions(
  client: QueryClient,
  owner: string,
  jobIds: readonly string[],
): void {
  syncContribution(client, state.jobContributions, state.watchedJobs, owner, jobIds, 'job');
}

/** Aynı senkron, işlenmekte olan asset'ler için (`asset:{id}` grupları). */
export function syncAssetSubscriptions(
  client: QueryClient,
  owner: string,
  assetIds: readonly string[],
): void {
  syncContribution(
    client, state.assetContributions, state.watchedAssets, owner, assetIds, 'asset');
}

/**
 * user:{id} feed katkısı (B6): kitaplığı açık tutan hook (useProjectAssets) mount'ta ister,
 * unmount'ta bırakır. Feed, meşgul satır olmasa da bağlantıyı AYAKTA tutar — pasif sekmenin
 * tek dinleme nedeni "başka istemcide yeni satır doğdu" yayınıdır. Abonelik kurulamazsa
 * davranış SignalR-öncesi kabul edilmiş hale düşer (yeni satır odak/yenilemede görünür).
 */
export function syncUserFeed(client: QueryClient, owner: string, wanted: boolean): void {
  state.client = client;
  if (wanted) state.feedOwners.add(owner);
  else state.feedOwners.delete(owner);

  if (state.feedOwners.size > 0) {
    ensureStarted();
    void subscribeUserFeed();
  } else if (state.feedSubscribed) {
    state.feedSubscribed = false;
    void invokeQuietly('UnsubscribeUserFeed');
  }
}

async function subscribeUserFeed(): Promise<void> {
  if (state.feedSubscribed) return;
  const connection = state.connection;
  if (!connection || connection.state !== HubConnectionState.Connected) {
    return; // bağlantı gelince resubscribeAll kurar
  }
  try {
    await connection.invoke('SubscribeUserFeed');
    if (state.feedOwners.size > 0) state.feedSubscribed = true;
    else void invokeQuietly('UnsubscribeUserFeed'); // istek beklerken küme boşaldı (yarış)
  } catch {
    // Feed aboneliği kurulamadı → kapatacağı bir polling kapısı yok, sessiz düşüş bilinçli:
    // pasif sekme yeni satırı SignalR-öncesi gibi odak/yenilemede görür.
  }
}

function syncContribution(
  client: QueryClient,
  contributions: Map<string, ReadonlySet<string>>,
  watched: Set<string>,
  owner: string,
  wanted: readonly string[],
  kind: 'job' | 'asset',
): void {
  state.client = client;
  if (wanted.length === 0) contributions.delete(owner);
  else contributions.set(owner, new Set(wanted));

  const union = new Set<string>();
  for (const ids of contributions.values()) {
    for (const id of ids) union.add(id);
  }

  for (const id of watched) {
    if (!union.has(id)) {
      watched.delete(id);
      state.covered.delete(`${kind}:${id}`);
      void invokeQuietly(kind === 'job' ? 'UnsubscribeJob' : 'UnsubscribeAsset', id);
    }
  }

  for (const id of union) {
    if (!watched.has(id)) {
      watched.add(id);
      void subscribe(kind, id);
    }
  }

  if (state.watchedJobs.size + state.watchedAssets.size > 0) {
    ensureStarted();
    ensureWatchdog();
  }
}

async function subscribe(kind: 'job' | 'asset', id: string): Promise<void> {
  const connection = state.connection;
  if (!connection || connection.state !== HubConnectionState.Connected) {
    return; // bağlantı gelince resubscribeAll kurar
  }
  try {
    await connection.invoke(kind === 'job' ? 'SubscribeJob' : 'SubscribeAsset', id);
    // İstek listeden düştüyse (yarış) kapsama yazılmaz.
    const still = kind === 'job' ? state.watchedJobs.has(id) : state.watchedAssets.has(id);
    if (still) markCovered(`${kind}:${id}`);
  } catch {
    // Abonelik reddi/hatası → kapsama YOK → polling bu işi taşımaya devam eder. Sahiplik
    // reddi normal akışta görülmez (istemci yalnız kendi listesindeki id'lerle çağırır).
  }
}

function markCovered(key: CoverageKey): void {
  state.covered.set(key, Date.now());
}

async function invokeQuietly(method: string, id?: string): Promise<void> {
  const connection = state.connection;
  if (!connection || connection.state !== HubConnectionState.Connected) return;
  try {
    // Parametresiz metotlar (UnsubscribeUserFeed) argümansız çağrılır — invoke(m, undefined)
    // tek elemanlı argüman listesi gönderir ve sunucuda imza uyuşmazlığına düşerdi.
    await (id === undefined ? connection.invoke(method) : connection.invoke(method, id));
  } catch {
    // best-effort — gruptan düşmemek zararsızdır (sunucu bağlantı kapanınca zaten düşürür)
  }
}

// ---------------------------------------------------------------------------
// Bağlantı yaşam döngüsü
// ---------------------------------------------------------------------------

function ensureStarted(): void {
  if (state.connection || state.starting) return;
  if (!getAccessToken()) return; // oturum yokken bağlanma (login sonrası sync'ler tekrar gelir)

  const connection = new HubConnectionBuilder()
    .withUrl(PROGRESS_HUB_PATH, {
      // WebSocket handshake başlık taşıyamaz — sunucu token'ı YALNIZ bu yolda query'den
      // kabul eder (Program.cs OnMessageReceived; access log query'yi yazmaz).
      accessTokenFactory: () => getAccessToken() ?? '',
    })
    .withAutomaticReconnect([0, 2000, 5000, 10_000, 30_000])
    .configureLogging(LogLevel.None) // konsolu kirletme; durum zaten kapsama/polling'de görünür
    .build();

  connection.on(PROGRESS_HUB_METHOD, (raw: JobProgressMessage) => {
    // Her mesaj kapsamayı tazeler (sessizlik bekçisinin saati; yineleme süzgecinin ÖNÜNDE —
    // kopya teslim de kanalın canlı olduğunun kanıtıdır) ve cache'e işlenir.
    const key: CoverageKey = raw.assetId ? `asset:${raw.assetId}` : `job:${raw.jobId}`;
    if (state.covered.has(key)) markCovered(key);
    if (state.client) handleProgressMessage(state.client, raw);
  });

  connection.on(PROGRESS_HUB_ASSET_REMOVED_METHOD, (raw: AssetRemovedMessage) => {
    // Silme duyurusu yalnız sahibinin feed grubundan gelir (sunucu hedefler) — kapsama
    // saatine dokunmaz: feed `covered` dışıdır (sessizliği normaldir, bekçi saymaz).
    if (state.client) handleAssetRemovedMessage(state.client, raw);
  });

  connection.onreconnecting(() => {
    state.connected = false;
    state.feedSubscribed = false; // gruplar bağlantıyla ölür — feed de yeniden kurulacak
    dropAllCoverage(); // yoklama DERHAL devralsın; yeniden bağlanınca abonelikler kurulur
  });

  connection.onreconnected(() => {
    state.connected = true;
    void resubscribeAll();
  });

  connection.onclose(() => {
    // withAutomaticReconnect pes etti → bağlantı öldü. Kapsamayı düşür (polling devralır),
    // taze bir bağlantıyı rampalı zamanlayıcıyla yeniden dene.
    state.connected = false;
    state.connection = null;
    state.feedSubscribed = false;
    dropAllCoverage();
    scheduleRestart();
  });

  state.connection = connection;
  void startConnection(connection);
}

async function startConnection(connection: HubConnection): Promise<void> {
  state.starting = true;
  try {
    await connection.start();
    state.connected = true;
    state.startAttempt = 0;
    await resubscribeAll();
  } catch {
    // Negotiate düştü (hub kapalı/engelli). Polling zaten kapsanmamış her şeyi taşıyor.
    // 401 sınıfı için bir kez token tazele, sonra rampayla yeniden dene.
    state.connected = false;
    state.connection = null;
    void refreshAccessToken();
    scheduleRestart();
  } finally {
    state.starting = false;
  }
}

function scheduleRestart(): void {
  if (state.startTimer) return;
  // İzlenen id yoksa VE feed istenmemişse ısrar etme; feed isteği tek başına yeniden
  // bağlanma nedenidir (pasif sekmenin tek kanalı odur — B6).
  if (state.watchedJobs.size + state.watchedAssets.size + state.feedOwners.size === 0) return;
  const delay = Math.min(
    START_RETRY_BASE_MS * 2 ** Math.min(state.startAttempt, 5),
    START_RETRY_MAX_MS,
  );
  state.startAttempt += 1;
  state.startTimer = setTimeout(() => {
    state.startTimer = null;
    ensureStarted();
  }, delay);
}

async function resubscribeAll(): Promise<void> {
  // Gruplar bağlantıya bağlıdır — her (yeniden) bağlantıda sıfırdan kurulur.
  for (const id of state.watchedJobs) await subscribe('job', id);
  for (const id of state.watchedAssets) await subscribe('asset', id);
  if (state.feedOwners.size > 0) await subscribeUserFeed();
}

function dropAllCoverage(): void {
  if (state.covered.size === 0) return;
  state.covered.clear();
  kickQueries();
}

/**
 * Kapsama düştüğünde sorguları dürt: invalidate aktif sorguları yeniden çeker; çekim
 * sonucunda refetchInterval yeniden değerlendirilir ve (kapsama yoksa) yoklama geri gelir.
 */
function kickQueries(): void {
  const client = state.client;
  if (!client) return;
  void client.invalidateQueries({
    predicate: (q) => isExportsListKey(q.queryKey) || isAssetsListKey(q.queryKey),
  });
}

function ensureWatchdog(): void {
  if (state.watchdogTimer) return;
  state.watchdogTimer = setInterval(() => {
    if (state.watchedJobs.size + state.watchedAssets.size === 0) {
      // İzlenecek şey kalmadıysa bekçi de durur (boşta zamanlayıcı bırakma).
      clearInterval(state.watchdogTimer!);
      state.watchdogTimer = null;
      return;
    }
    if (!state.connected || state.covered.size === 0) return;
    const now = Date.now();
    let dropped = false;
    for (const [key, lastSeenAt] of state.covered) {
      if (now - lastSeenAt > HUB_SILENCE_TIMEOUT_MS) {
        state.covered.delete(key);
        dropped = true;
      }
    }
    if (dropped) kickQueries(); // susan kanalın işini yoklama devralır
  }, WATCHDOG_TICK_MS);
}

// ---------------------------------------------------------------------------
// Test kancaları (yalnız vitest — üretim kodu çağırmaz)
// ---------------------------------------------------------------------------

/** Birim testleri modül durumunu sıfırlar (bağlantı kurulmadan saf kapı testleri için). */
export function resetProgressHubForTests(): void {
  state.client = null;
  if (state.startTimer) clearTimeout(state.startTimer);
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  state.startTimer = null;
  state.watchdogTimer = null;
  state.startAttempt = 0;
  state.starting = false;
  // stop() reddi yutulur: kapanan/yarı-açık bağlantının söküm hatasında yapılacak şey yok
  void state.connection?.stop().catch(() => undefined);
  state.connection = null;
  state.connected = false;
  state.jobContributions.clear();
  state.assetContributions.clear();
  state.watchedJobs.clear();
  state.watchedAssets.clear();
  state.feedOwners.clear();
  state.feedSubscribed = false;
  state.covered.clear();
  noticedNewAssets.clear();
  lastDeliverySig = null;
}

/** Birim testleri feed katkı durumunu okur (watchedForTests'in feed yarısı). */
export function feedWantedForTests(): { owners: string[]; subscribed: boolean } {
  return { owners: [...state.feedOwners].sort(), subscribed: state.feedSubscribed };
}

/** Birim testleri izlenen kümeleri okur (katkı birleşiminin doğruluğu için). */
export function watchedForTests(): { jobs: string[]; assets: string[] } {
  return {
    jobs: [...state.watchedJobs].sort(),
    assets: [...state.watchedAssets].sort(),
  };
}

/** Birim testleri kapsama/bağlantı durumunu bağlantısız taklit eder. */
export function simulateHubStateForTests(opts: {
  connected: boolean;
  coveredJobs?: readonly string[];
  coveredAssets?: readonly string[];
}): void {
  state.connected = opts.connected;
  state.covered.clear();
  for (const id of opts.coveredJobs ?? []) state.covered.set(`job:${id}`, Date.now());
  for (const id of opts.coveredAssets ?? []) state.covered.set(`asset:${id}`, Date.now());
}
