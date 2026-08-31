/**
 * progressHub — SignalR canlı ilerleme istemcisi (tasarım 03 §5; DECISIONS 2026-08-31).
 *
 * Akış: worker her progress DB yazımının yanında Redis'e publish eder; API'nin forwarder'ı
 * mesajı `job:{id}` / `asset:{id}` SignalR gruplarına iletir; bu modül gruba abone olur ve
 * gelen mesajları react-query cache'ine işler. POLLING SİLİNMEDİ — YEDEKTİR (tasarım şartı):
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
}

/** Hub yolu/metodu — sunucudaki JobProgressChannel sabitlerinin istemci aynası. */
export const PROGRESS_HUB_PATH = '/hubs/progress';
export const PROGRESS_HUB_METHOD = 'progress';

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

async function invokeQuietly(method: string, id: string): Promise<void> {
  const connection = state.connection;
  if (!connection || connection.state !== HubConnectionState.Connected) return;
  try {
    await connection.invoke(method, id);
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
    // Her mesaj kapsamayı tazeler (sessizlik bekçisinin saati) ve cache'e işlenir.
    const key: CoverageKey = raw.assetId ? `asset:${raw.assetId}` : `job:${raw.jobId}`;
    if (state.covered.has(key)) markCovered(key);
    if (state.client) applyProgressMessage(state.client, raw);
  });

  connection.onreconnecting(() => {
    state.connected = false;
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
  if (state.watchedJobs.size + state.watchedAssets.size === 0) return; // izlenen yoksa ısrar etme
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
  state.covered.clear();
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
