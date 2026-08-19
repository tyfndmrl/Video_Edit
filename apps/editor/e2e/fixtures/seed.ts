/**
 * E2E veri hazırlığı — API üzerinden (UI'dan DEĞİL, hız için).
 *
 * Neden medya yüklemiyoruz: gerçek bir asset yükleyip worker'ın işlemesini
 * beklemek her test için on saniyeler demek. İstemci tarafında asset süresi
 * BİLİNMEYEN klipler için kaynak-sınır invariant'ları atlanır
 * (packages/timeline-schema/src/invariants.ts, kural 2/5); timeline canvas'ı
 * klipleri (filmstrip yerine düz blok olarak) çizer ve tüm kırpma/taşıma/bölme
 * etkileşimleri gerçek yolda çalışır.
 *
 * SUNUCU ÖNERMESİ — DEĞİŞTİ. Bu dosya eskiden "sunucunun timeline doğrulaması
 * YÜZEYSEL'dir, asset varlığını kontrol etmez" diyor ve dokümanı UYDURMA bir
 * assetId ile kuruyordu. O önerme artık YANLIŞ: export isteği SENKRON bir asset
 * kapısından geçiyor. Kapı, belgenin gösterdiği her assetId'yi kullanıcının
 * kütüphanesinde arar ve satır yoksa POST /exports 202 değil 422 'asset-missing'
 * döner (ham API ile ölçüldü). Satır VARKEN aynı kapı ölçülmüş alanları da
 * sorar: kaynak aralığını süreyle ('source-out-of-range'), LUT gösteren efekti
 * dosya adıyla ('lut-asset-type') karşılaştırır. Timeline'ı KAYDETMEK hâlâ
 * yüzeysel doğrulamadır (PUT 200) — kapı yalnız export yolundadır.
 *
 * Bu yüzden seed artık GERÇEK bir asset satırı kurar (createSeedAsset).
 *
 * PLACEHOLDER ASSET — ne olduğu ve ne OLMADIĞI:
 *  - GERÇEK satır, gerçek uçtan (POST /api/projects/{id}/assets): kapının
 *    aradığı sahiplik + silinmemişlik koşulları gerçek yoldan sağlanır;
 *  - BAYT YOK: yükleme tamamlanmaz, worker hiç koşmaz, ffprobe alanları
 *    (süre / boyut / ses) NULL kalır. Sunucunun yazılı sözleşmesi bunu emniyetli
 *    yönde yorumlar — "ölçüm yokluğu yanlış ret üretmez": bir alan null'sa
 *    yalnız O alanın kapısı atlanır (backend ExportAssetFacts).
 *  - KAPSAM DIŞI: ölçülmüş olgu isteyen kapılar (kaynak aralığı, dejenere
 *    boyut, LUT dosya türü) bu seed ile SINANMAZ; onları sınayan testler gerçek
 *    medya yükler (support/media.ts + LibraryPanelHarness). Bu seed'in tek
 *    iddiası "belge, kullanıcının kütüphanesindeki bir varlığı gösteriyor"dur.
 *
 * NEDEN WORKER BAŞINA TEK SATIR: yükleme tamamlanmadığı için satır 'Uploading'
 * durumunda kalır ve sunucu eşzamanlı 'Uploading' sayısını sınırlar (ölçüldü:
 * aynı hesapta altıncı init HTTP 429 — "Too many concurrent uploads (max 5)").
 * Test başına bir satır açılsaydı altıncı testte seed'in KENDİSİ 429 alırdı.
 *
 * NEDEN AYRI BİR "depo" PROJESİ: satır seed projesine bağlansaydı kitaplık
 * panelinde yüklenmeyi bekleyen bir kart olarak görünürdü ve panele bakan
 * testler bundan etkilenirdi. Kapı proje bağını değil SAHİPLİĞİ sorduğu için
 * satırın ayrı bir projede durması yeterlidir (aynı hesap).
 *
 * Gerçek medyalı bir senaryo isteniyorsa E2E_PROJECT_ID ortam değişkeni ile
 * hazır bir proje verilebilir (bkz. fixtures/test.ts).
 */
import type { APIRequestContext } from '@playwright/test';

export const SECOND_US = 1_000_000;

/**
 * Klipler bilinçli olarak GEÇ bir zamanda (60 sn+) durur: varsayılan
 * pxPerUs=0.0001 ile 6000 px uzakta kalırlar, yani "açılışta içerik görünür mü"
 * (auto-fit) testi ancak gerçekten sığdırma yapılıyorsa yeşil olur.
 */
export const SEED_TIMES = {
  clipAStartUs: 60 * SECOND_US,
  clipADurationUs: 6 * SECOND_US,
  clipBStartUs: 76 * SECOND_US,
  clipBDurationUs: 6 * SECOND_US,
  /** clipA sonu (66 sn) ile clipB başı (76 sn) arasındaki BOŞ aralık. */
  gapStartUs: 66 * SECOND_US,
  gapEndUs: 76 * SECOND_US,
  contentEndUs: 82 * SECOND_US,
} as const;

export interface SeededProject {
  projectId: string;
  email: string;
  password: string;
  accessToken: string;
  /** Doküman kimlikleri (store doğrulamalarında kullanılır). */
  trackTopId: string;
  trackBottomId: string;
  clipAId: string;
  clipBId: string;
  /**
   * Her iki seed klibinin gösterdiği asset satırının id'si — kullanıcının
   * kütüphanesinde GERÇEKTEN vardır (bkz. dosya başlığı). Hazır proje modunda
   * dokümanı sunucu verdiği için okunamıyorsa null olur.
   */
  assetId: string | null;
  /** Hazır (E2E_PROJECT_ID) bir projeyle mi çalışıyoruz? */
  external: boolean;
}

interface AuthResponse {
  accessToken: string;
}

interface ProjectDetail {
  id: string;
  revisionNumber: number;
}

function uuid(): string {
  return crypto.randomUUID();
}

function mediaClip(id: string, assetId: string, startUs: number, durationUs: number): unknown {
  return {
    id,
    kind: 'video',
    assetId,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    // speed.rate = 1 -> timelineDurationUs === roundHalfUp((out-in)/rate) (invariant 3).
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

export interface SeedDocResult {
  timeline: unknown;
  trackTopId: string;
  trackBottomId: string;
  clipAId: string;
  clipBId: string;
}

/**
 * İki video track: üstte iki klip (aralarında boşluk), altta boş track
 * (katman değiştirme / çakışma testleri için).
 *
 * `assetId` ZORUNLU bir parametredir ve GERÇEK bir asset satırını göstermelidir
 * (createSeedAsset). Eskiden burada uydurma bir id üretiliyordu; sunucunun
 * senkron asset kapısı eklendikten sonra öyle bir doküman export yolunda 422
 * 'asset-missing' alıyor — yani seed'in kurduğu belge, kullanıcının GERÇEKTEN
 * kaydedip dışa aktarabileceği bir belge olmuyordu.
 */
export function buildSeedDoc(projectId: string, assetId: string): SeedDocResult {
  const trackTopId = uuid();
  const trackBottomId = uuid();
  const clipAId = uuid();
  const clipBId = uuid();

  const timeline = {
    schemaVersion: 1,
    projectId,
    settings: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      backgroundColor: '#000000',
    },
    tracks: [
      {
        id: trackTopId,
        type: 'video',
        name: 'V1',
        muted: false,
        hidden: false,
        locked: false,
        clips: [
          mediaClip(clipAId, assetId, SEED_TIMES.clipAStartUs, SEED_TIMES.clipADurationUs),
          mediaClip(clipBId, assetId, SEED_TIMES.clipBStartUs, SEED_TIMES.clipBDurationUs),
        ],
      },
      {
        id: trackBottomId,
        type: 'video',
        name: 'V2',
        muted: false,
        hidden: false,
        locked: false,
        clips: [],
      },
    ],
    markers: [],
  };

  return { timeline, trackTopId, trackBottomId, clipAId, clipBId };
}

/**
 * Kayıt ol -> accessToken + httpOnly refresh cookie. `request` TARAYICI
 * context'inden geliyorsa cookie doğrudan sayfaya düşer ve LoginGate
 * açılışta refresh ile oturumu kurar (giriş formu hiç görünmez).
 */
export async function registerUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request.post('/api/auth/register', {
    data: { email, password, displayName: 'E2E Kullanıcı' },
  });
  if (!res.ok()) {
    throw new Error(`Kayıt başarısız (HTTP ${res.status()}): ${await res.text()}`);
  }
  return ((await res.json()) as AuthResponse).accessToken;
}

export async function loginUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) {
    throw new Error(`Giriş başarısız (HTTP ${res.status()}): ${await res.text()}`);
  }
  return ((await res.json()) as AuthResponse).accessToken;
}

export async function createProject(
  request: APIRequestContext,
  accessToken: string,
  name: string,
): Promise<ProjectDetail> {
  const res = await request.post('/api/projects', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { name },
  });
  if (!res.ok()) {
    throw new Error(`Proje oluşturulamadı (HTTP ${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ProjectDetail;
}

/**
 * Seed kliplerinin gösterdiği asset satırının beyanı. Boyut, doğrulamanın
 * kabul ettiği EN KÜÇÜK değerdir (bayt zaten hiç yüklenmez): hesabın kotasından
 * tek bayt düşer, kota göstergesini karşılaştıran testlerin ölçtüğü FARKLARA
 * dokunmaz.
 */
export const SEED_ASSET = {
  fileName: 'e2e-seed-placeholder.mp4',
  contentType: 'video/mp4',
  sizeBytes: 1,
} as const;

/**
 * Gerçek asset satırı kurar (yalnız yükleme BAŞLATILIR — bayt gönderilmez,
 * complete çağrılmaz). Dönen id seed dokümanlarına yazılır.
 *
 * Sözleşme ve sınırları için dosya başlığına bakın: satır 'Uploading' durumunda
 * kalır, ffprobe alanları null'dır ve ölçülmüş olgu isteyen kapılar bu satırla
 * SINANMAZ.
 */
export async function createSeedAsset(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<string> {
  const res = await request.post(`/api/projects/${projectId}/assets`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {
      fileName: SEED_ASSET.fileName,
      contentType: SEED_ASSET.contentType,
      sizeBytes: SEED_ASSET.sizeBytes,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Seed asset satırı kurulamadı (HTTP ${res.status()}): ${await res.text()}\n` +
        'Seed dokümanları GERÇEK bir asset satırı gösterir; bu satır olmadan ' +
        'export yolundaki senkron kapı belgeyi 422 asset-missing ile reddeder.',
    );
  }
  return ((await res.json()) as { assetId: string }).assetId;
}

export async function saveTimeline(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  timeline: unknown,
  baseRevision: number,
): Promise<void> {
  const res = await request.put(`/api/projects/${projectId}/timeline`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { baseRevision, timeline },
  });
  if (!res.ok()) {
    throw new Error(`Timeline kaydedilemedi (HTTP ${res.status()}): ${await res.text()}`);
  }
}

export async function getProject(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<ProjectDetail> {
  const res = await request.get(`/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok()) {
    throw new Error(`Proje okunamadı (HTTP ${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ProjectDetail;
}
