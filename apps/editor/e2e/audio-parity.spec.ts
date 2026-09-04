/**
 * SES PARİTESİ (önizleme ↔ export) — poc-bilinen-sinirlar §2.6'nın ÖLÇÜMÜ ve
 * kalıcı muhafızı.
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * "Önizlemedeki ses export'takiyle aynı" iddiası bu teste kadar test edilmiş
 * değil, tasarımla gerekçelendirilmişti. Bu test aynı belge için iki BAĞIMSIZ
 * gerçeklemeyi uçtan uca koşar ve sayısal olarak karşılaştırır:
 *
 *  - ÖNİZLEME TARAFI: gerçek Chromium'da OfflineAudioContext ile, uygulamanın
 *    KENDİ modülleri koşturularak üretilir. Kazanç eğrisi `buildGainCurve`,
 *    micro-fade kararları `shouldMicroFadeIn/Out`, ses ayarı `clipAudioOf` —
 *    hepsi Vite modül grafiğinden import edilir (`/src/features/player/...`),
 *    KOPYA DEĞİL. Graf topolojisi AudioGraph ile birebir aynıdır:
 *    kaynak → klip GainNode (başlangıç 0) → master GainNode(1) → destination;
 *    eğri, motorla aynı örnekleme formülüyle (100 örnek/sn, 2..2000) aynı
 *    `setValueCurveAtTime` çağrısına verilir. Kaynak, oynatıcı havuzunun
 *    gerçekten çözdüğü PROXY türevidir (media-urls `proxy`) ve tarayıcının
 *    kendi çözücüsüyle (`decodeAudioData`) açılır.
 *  - EXPORT TARAFI: gerçek POST /exports → worker → ffmpeg → indirilen MP4'ün
 *    ses akışı (ffmpeg ile f32le'ye çözülür).
 *
 * Karşılaştırma: 10 ms'lik ince zarf (RMS + tepe) üstünden çapraz korelasyonla
 * TEPE HİZALAMASI (gecikme), sonra 100 ms'lik pencerelerde RMS farkı (dB).
 * Vakalar (poc-bilinen-sinirlar §2.6 tablosunun satırları):
 *   düz klip + volume 0.5 · iki katman temiz miks (amix, limiter şeffaf) ·
 *   fade-in/plato/fade-out · iki katman LİMİTER miksi (alimiter devrede —
 *   §8.3 bilinçli asimetri: önizlemede limiter YOK) · kırpılmış klip
 *   (sourceIn>0 + boşluk sonrası adelay) · hız 2x (atempo) · boşluk sessizliği.
 *
 * ---------------------------------------------------------------------------
 * NEDEN AudioGraph'İN KENDİSİ DEĞİL (dürüstlük beyanı)
 * ---------------------------------------------------------------------------
 * AudioGraph kaynağı `createMediaElementSource` ile kurar; Web Audio sözleşmesi
 * bu düğümü yalnız GERÇEK ZAMANLI AudioContext'e verir — OfflineAudioContext'te
 * yoktur (örnek-kesin çevrimdışı render medya elemanıyla tanımsızdır). Gerçek
 * zamanlı kayıt (MediaRecorder) ise ölçüme kayıt kodeği + zamanlayıcı
 * titreşimi katardı. En yakın dürüst yöntem yukarıdaki kurulumdur. Bilinen iki
 * idealizasyon (ölçüm yorumlanırken akılda tutulmalı):
 *  1. Gerçek motor zarfı klip aktifleşince İLK rAF tick'inde kurar (≤1 tick
 *     ≈ 16,7 ms gecikebilir); burada tam klip başına kurulur. Etkisi yalnız
 *     kenar pencerelerindedir; kararlı-durum pencereleri etkilenmez.
 *  2. hız≠1 vakasında gerçek <video> elemanı perde koruyarak (preservesPitch)
 *     zaman-esnetir; AudioBufferSourceNode.playbackRate yeniden örnekler.
 *     RMS ZARFI perdeye duyarsızdır (zarf zamanlaması iki yöntemde de aynı
 *     oranda sıkışır), o yüzden zarf karşılaştırması için adil bir vekildir;
 *     vaka yine de ayrı sınıflandırılır çünkü export tarafı atempo=WSOLA'dır.
 *
 * Bu spec UI etkileşimi İDDİA ETMEZ (review-gate kural 3 kapsamı dışı):
 * yükleme/dışa aktarma REST sözleşmesinden sürülür; UI yolları kendi
 * spec'lerinde gerçek fareyle kanıtlıdır (audio-export, export-flow, library).
 *
 * Eşikler docs/poc-bilinen-sinirlar.md §2.6'daki NORMATİF tablodur — bu test
 * o tablonun muhafızıdır: iki taraftan birinin ses zinciri (gain.ts, ffmpeg
 * zinciri, proxy reçetesi) sözleşmeden saparsa kırmızıya döner.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/test';
import { createProject, saveTimeline } from './fixtures/seed';
import { fetchProxyUrls, uploadAssetViaApi, waitAssetReady } from './support/apiUpload';
// Editör kaynağından import: `e2e/` altında ev deseni (geometry, format, cubeLut,
// timelineHeight… 11 örnek daha). Tek kaynak, kopyadan iyidir. KAYITLI YAN ETKİ:
// bu import `core/meter.ts` ve `core/gain.ts`'i `e2e/tsconfig.json` altında DA tip
// denetimine sokar; o config app'inkinden farklıdır (`jsx`,
// `allowImportingTsExtensions`, `noUncheckedSideEffectImports` yok). Bugün temiz, ama
// o iki dosyaya app tarafında geçerli olup e2e config'inde olmayan bir sözdizimi
// girerse app yeşil kalırken e2e tsc kırılır — belirti orada aranmalı.
import { PARITY_DELTAS_DB } from '../src/features/player/core/meter';
import {
  FFMPEG_SKIP_REASON,
  ensureParityMusic,
  ensureParityVideo,
  ffmpegVersion,
} from './support/media';

const ARTIFACT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

const SEC = 1_000_000;
/** İnce zarf adımı (tepe hizalaması bununla ölçülür). */
const HOP_MS = 10;
/** Görev sözleşmesindeki karşılaştırma penceresi. */
const RMS_WINDOW_MS = 100;
const SAMPLE_RATE = 48_000;
/** Belge toplam süresi (aşağıdaki yerleşimin son klip sonu). */
const TOTAL_US = 17 * SEC;

// ---------------------------------------------------------------------------
// NORMATİF EŞİKLER — poc-bilinen-sinirlar §2.6 tablosuyla BİREBİR aynı.
// Değerler bu spec'in ilk ölçüm koşumlarından türetildi (ölçülen + pay);
// dokümandaki tabloyu değiştirmeden burayı değiştirmek sözleşme ihlalidir.
// ---------------------------------------------------------------------------
const LIMITS = {
  /** Tepe hizalaması, rate=1 malzemede (ince zarf çapraz korelasyonu). */
  globalLagMs: 12,
  /** Kararlı pencerelerde (düz seviye) |ΔRMS| tavanı. */
  steadyMaxDb: 0.8,
  /** Fade rampası pencerelerinde |ΔRMS| tavanı (−45 dBFS tabanı üstünde). */
  rampMaxDb: 1.2,
  /** Limiter vakası: export önizlemeden EN ÇOK bu kadar KISIK olabilir. */
  limiterMaxDb: 4.5,
  /**
   * Limiter vakası yön payı: export, önizlemeden EN ÇOK bu kadar GÜR olabilir.
   * Sıfır değil, çünkü ölçülen sistematik bir +0.18 dB var: alimiter'ın
   * varsayılan `level` (auto-level) davranışı çıkışı 1/limit=1/0.98 ile ölçekler
   * — bu, limiter'ın HİÇ bastırmadığı sinyalde bile export'u +0.175 dB yapar
   * (§2.6 tablosunun "sistematik sapma" satırı).
   */
  limiterWrongWayDb: 0.3,
  /** atempo vakası zarf farkı tavanı ve gecikme tavanı (§8.3: 1 çıkış karesi). */
  atempoMaxDb: 2.5,
  atempoLagMs: 33.4,
  /** Limiter rejim kanıtı: önizleme tepesi 1.0'ı AŞMALI (yoksa vaka boş ölçer). */
  limiterRegimePreviewPeakMin: 1.02,
  /** Limiter çıkış tepesi: limit×auto-level = 0.98×(1/0.98) → 1.0 (+ kodek payı). */
  limiterExportPeakMax: 1.02,
  /** Boşluk/sessizlik pencerelerinde iki tarafın da kalması gereken taban. */
  silenceFloorDb: -50,
} as const;

interface CaseSpec {
  name: string;
  fromSec: number;
  toSec: number;
  kind: 'steady' | 'ramp' | 'limiter' | 'atempo' | 'silence';
}

/** Pencere sınırları, klip kenarlarından ≥150 ms içeride tutulur (rAF tick idealizasyonu). */
const CASES: CaseSpec[] = [
  { name: 'duz-volume-0.5', fromSec: 0.15, toSec: 1.85, kind: 'steady' },
  { name: 'miks-temiz', fromSec: 2.15, toSec: 3.85, kind: 'steady' },
  { name: 'bosluk', fromSec: 4.15, toSec: 4.85, kind: 'silence' },
  { name: 'fade-in', fromSec: 5.05, toSec: 5.95, kind: 'ramp' },
  { name: 'miks-limiter', fromSec: 6.15, toSec: 6.85, kind: 'limiter' },
  { name: 'fade-plato', fromSec: 7.15, toSec: 7.85, kind: 'steady' },
  { name: 'fade-out', fromSec: 8.05, toSec: 8.95, kind: 'ramp' },
  { name: 'kirpilmis-adelay', fromSec: 10.15, toSec: 12.85, kind: 'steady' },
  { name: 'hiz-2x-atempo', fromSec: 14.15, toSec: 16.85, kind: 'atempo' },
];

/** Beş vakayı tek belgede kuran, şema+derleyici-geçerli doküman. */
function parityDoc(
  projectId: string,
  videoAssetId: string,
  musicAssetId: string,
): { timeline: unknown } {
  const media = (
    id: string,
    kind: 'video' | 'audio',
    assetId: string,
    startUs: number,
    durationUs: number,
    sourceInUs: number,
    sourceOutUs: number,
    rate: number,
    audio: { volume: number; fadeInUs: number; fadeOutUs: number },
  ): unknown => ({
    id,
    kind,
    assetId,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs,
    sourceOutUs,
    speed: { rate },
    audio: { ...audio, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  });

  const noFade = { fadeInUs: 0, fadeOutUs: 0 };
  return {
    timeline: {
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
          id: crypto.randomUUID(),
          type: 'video',
          name: 'V1',
          muted: false,
          hidden: false,
          locked: false,
          clips: [
            // A: düz klip + volume 0.5 (vaka 1; [0,4))
            media('a1000000-0000-4000-8000-000000000001', 'video', videoAssetId,
              0, 4 * SEC, 0, 4 * SEC, 1, { volume: 0.5, ...noFade }),
            // B: fade-in 1 sn + fade-out 1 sn (vaka 2; boşluktan sonra → adelay; [5,9))
            media('a1000000-0000-4000-8000-000000000002', 'video', videoAssetId,
              5 * SEC, 4 * SEC, 0, 4 * SEC, 1, { volume: 1, fadeInUs: SEC, fadeOutUs: SEC }),
            // C: kırpılmış klip (sourceIn=2 sn) + boşluk (vaka 4; [10,13))
            media('a1000000-0000-4000-8000-000000000003', 'video', videoAssetId,
              10 * SEC, 3 * SEC, 2 * SEC, 5 * SEC, 1, { volume: 1, ...noFade }),
            // D: hız 2x (vaka 5 — atempo; [14,17))
            media('a1000000-0000-4000-8000-000000000004', 'video', videoAssetId,
              14 * SEC, 3 * SEC, 0, 6 * SEC, 2, { volume: 1, ...noFade }),
          ],
        },
        {
          id: crypto.randomUUID(),
          type: 'audio',
          name: 'A1',
          muted: false,
          hidden: false,
          locked: false,
          clips: [
            // M1: A ile TEMİZ miks (vaka 3a; toplam tepe 0.75 < 0.98; [2,4))
            media('a1000000-0000-4000-8000-000000000005', 'audio', musicAssetId,
              2 * SEC, 2 * SEC, 0, 2 * SEC, 1, { volume: 0.5, ...noFade }),
            // M2: B platosuyla LİMİTER miksi (vaka 3b; [6,7)). volume 1.5 →
            // müzik TEK BAŞINA 0.75×1.5 = 1.125 > 0.98 tepe yapar: limiter
            // rejimi iki tremolo zarfının tesadüfen çakışmasına bağlı DEĞİL
            // (ilk ölçümde volume 1 ile çakışma pencereye denk gelmedi, tepe
            // 0.907'de kaldı ve rejim hiç tetiklenmedi — ölçülen düzeltme).
            media('a1000000-0000-4000-8000-000000000006', 'audio', musicAssetId,
              6 * SEC, 1 * SEC, 4 * SEC, 5 * SEC, 1, { volume: 1.5, ...noFade }),
          ],
        },
      ],
      markers: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Zarf matematiği (node tarafı)
// ---------------------------------------------------------------------------

interface Envelope {
  /** Hop başına (L²+R² toplamı) — RMS türetmek için. */
  sumSquares: number[];
  /** Hop başına örnek sayısı (kanal dahil). */
  countPerHop: number;
  /** Hop başına tepe |örnek|. */
  peak: number[];
}

function envelopeOfInterleaved(f32: Float32Array, hopMs: number, sampleRate: number): Envelope {
  const hopFrames = Math.round((hopMs / 1000) * sampleRate);
  const frames = Math.floor(f32.length / 2);
  const hops = Math.floor(frames / hopFrames);
  const sumSquares = new Array<number>(hops).fill(0);
  const peak = new Array<number>(hops).fill(0);
  for (let h = 0; h < hops; h++) {
    let ss = 0;
    let pk = 0;
    const start = h * hopFrames * 2;
    const end = start + hopFrames * 2;
    for (let i = start; i < end; i++) {
      const v = f32[i];
      ss += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
    }
    sumSquares[h] = ss;
    peak[h] = pk;
  }
  return { sumSquares, countPerHop: hopFrames * 2, peak };
}

function rmsDb(sumSquares: number, count: number): number {
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

/**
 * İnce zarfların çapraz korelasyonuyla gecikme (ms). Pozitif = export GEÇ.
 * Aday aralığı ±maxLagHops; parabolik arıtma ile hop-altı çözünürlük.
 */
function envelopeLagMs(
  a: number[], // önizleme (RMS-benzeri: sqrt(sumSquares))
  b: number[], // export
  fromHop: number,
  toHop: number,
  maxLagHops: number,
): number {
  const scoreAt = (lag: number): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = fromHop; i < toHop; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length || i >= a.length) continue;
      dot += a[i] * b[j];
      na += a[i] * a[i];
      nb += b[j] * b[j];
    }
    return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
  };
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLagHops; lag <= maxLagHops; lag++) {
    const s = scoreAt(lag);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // Parabolik arıtma (üç nokta) — tepe hop'lar arasındaysa kesiri bul.
  const s0 = scoreAt(best - 1);
  const s1 = scoreAt(best);
  const s2 = scoreAt(best + 1);
  const denom = s0 - 2 * s1 + s2;
  const frac = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / denom)) : 0;
  return (best + frac) * HOP_MS;
}

/** İndirilen MP4'ün ses akışı → interleaved f32le stereo 48 kHz (dosya üzerinden). */
function decodeExportAudio(mp4Path: string): Float32Array {
  const pcmPath = `${mp4Path}.f32le`;
  const res = spawnSync(
    'ffmpeg',
    [
      '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', mp4Path,
      '-vn', '-acodec', 'pcm_f32le', '-f', 'f32le', '-ac', '2', '-ar', String(SAMPLE_RATE),
      pcmPath,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (res.status !== 0) {
    throw new Error(`Export sesi çözülemedi (ffmpeg exit ${String(res.status)}):\n${res.stderr}`);
  }
  const bytes = readFileSync(pcmPath);
  rmSync(pcmPath, { force: true });
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

test.describe('Ses paritesi — önizleme (OfflineAudioContext, uygulama modülleri) ↔ export (ffmpeg)', () => {
  test('aynı belgenin iki ses yolu §2.6 normatif sınırları içinde örtüşür', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    const video = ensureParityVideo();
    const music = ensureParityMusic();
    const request = account.context.request;

    // ── 1) Proje + GERÇEK medya (worker proxy'leri üretir) ──
    const project = await createProject(
      request,
      account.accessToken,
      `E2E ses paritesi ${Date.now().toString(36)}`,
    );
    const [videoAsset, musicAsset] = [
      await uploadAssetViaApi(
        request, account.accessToken, project.id, video.path, video.fileName, video.contentType),
      await uploadAssetViaApi(
        request, account.accessToken, project.id, music.path, music.fileName, music.contentType),
    ];
    await waitAssetReady(request, account.accessToken, videoAsset.assetId, video.fileName);
    await waitAssetReady(request, account.accessToken, musicAsset.assetId, music.fileName);

    // ── 2) Beş vakalı belge ──
    const doc = parityDoc(project.id, videoAsset.assetId, musicAsset.assetId);
    await saveTimeline(request, account.accessToken, project.id, doc.timeline, project.revisionNumber);

    // ── 3) EXPORT: gerçek iş, gerçek ffmpeg, indirilen MP4 ──
    const exportRes = await request.post(`/api/projects/${project.id}/exports`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      data: {},
    });
    expect(exportRes.status(), await exportRes.text()).toBe(202);
    const { jobId } = (await exportRes.json()) as { jobId: string };

    let job: { status: string; downloadUrl: string | null } = { status: '', downloadUrl: null };
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${account.accessToken}` },
          });
          job = (await res.json()) as typeof job;
          return job.status;
        },
        { timeout: 300_000, intervals: [2_000], message: 'Export işi bitmedi (worker ayakta mı?)' },
      )
      .toMatch(/succeeded|failed/);
    expect(job.status, 'Export işi başarısız — parite ölçülemeden düştü.').toBe('succeeded');
    expect(job.downloadUrl).toBeTruthy();

    const download = await request.get(job.downloadUrl!);
    expect(download.ok()).toBe(true);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const mp4Path = join(ARTIFACT_DIR, `ses-parite-${jobId}.mp4`);
    writeFileSync(mp4Path, await download.body());

    // ── 4) ÖNİZLEME TARAFI: proxy baytları + uygulamanın kendi kazanç kodu ──
    const proxyUrls = await fetchProxyUrls(request, account.accessToken, project.id);
    expect(proxyUrls[videoAsset.assetId], 'video proxy URL yok').toBeTruthy();
    expect(proxyUrls[musicAsset.assetId], 'müzik proxy URL yok').toBeTruthy();
    const proxyB64: Record<string, string> = {};
    for (const [assetId, url] of Object.entries(proxyUrls)) {
      const res = await request.get(url);
      expect(res.ok(), `proxy indirilemedi: ${assetId}`).toBe(true);
      proxyB64[assetId] = (await res.body()).toString('base64');
    }

    await page.goto('/');
    const preview = await page.evaluate(
      async (arg: {
        tracks: unknown;
        proxyB64: Record<string, string>;
        totalUs: number;
        sampleRate: number;
        hopMs: number;
        fpsNum: number;
        fpsDen: number;
      }) => {
        // Uygulamanın KENDİ modülleri — Vite modül grafiği (kopya değil).
        // (Değişken üzerinden import: appBridge ile aynı desen — TS modül
        //  çözümlemesi devre dışı, runtime'da document URL'sine göre çözülür.)
        const imp = (specifier: string): Promise<Record<string, unknown>> =>
          import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
        const gainMod = (await imp('/src/features/player/core/gain.ts')) as unknown as {
          buildGainCurve(
            audio: unknown, clipDurUs: number, startClipUs: number, endClipUs: number,
            sampleCount: number, opts: Record<string, unknown>,
          ): Float32Array;
          shouldMicroFadeIn(
            prev: unknown, clip: unknown, startClipUs: number, frameDurationUs: number,
          ): boolean;
          shouldMicroFadeOut(clip: unknown, next: unknown): boolean;
        };
        const resolveMod = (await imp('/src/features/player/core/resolve.ts')) as unknown as {
          clipAudioOf(clip: unknown): { muted: boolean } | null;
          isClipMuted(track: unknown, clip: unknown): boolean;
        };

        const b64ToBuf = (b64: string): ArrayBuffer => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };

        const totalSec = arg.totalUs / 1e6;
        const ctx = new OfflineAudioContext(
          2, Math.ceil(totalSec * arg.sampleRate), arg.sampleRate);

        // decodeAudioData buffer'ı tüketir — asset başına BİR kez çöz.
        const buffers = new Map<string, AudioBuffer>();
        for (const [assetId, b64] of Object.entries(arg.proxyB64)) {
          buffers.set(assetId, await ctx.decodeAudioData(b64ToBuf(b64)));
        }

        // AudioGraph topolojisi: klip gain (0'dan başlar) → master(1) → çıkış.
        const master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);

        interface DocClip {
          id: string;
          kind: string;
          assetId: string;
          timelineStartUs: number;
          timelineDurationUs: number;
          sourceInUs: number;
          sourceOutUs: number;
          speed: { rate: number };
          keyframes: { volume?: unknown[] };
        }
        const tracks = arg.tracks as { muted: boolean; clips: DocClip[] }[];
        const frameDurationUs = (1e6 * arg.fpsDen) / arg.fpsNum;

        for (const track of tracks) {
          const clips = track.clips;
          for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
            const audio = resolveMod.clipAudioOf(clip);
            if (audio === null || resolveMod.isClipMuted(track, clip)) continue;
            const buffer = buffers.get(clip.assetId);
            if (!buffer) throw new Error(`proxy çözülmedi: ${clip.assetId}`);

            const prev = i > 0 ? clips[i - 1] : null;
            const next = i + 1 < clips.length ? clips[i + 1] : null;
            const clipDur = clip.timelineDurationUs;

            // engineV1.ensureAudioEnvelope ile aynı pencere/örnekleme (geçişsiz
            // belge; oynatma 0'dan → startClipUs=0, endClipUs=clipDur).
            const microFadeIn = gainMod.shouldMicroFadeIn(prev, clip, 0, frameDurationUs);
            const microFadeOut = gainMod.shouldMicroFadeOut(clip, next);
            const durationSec = clipDur / 1e6;
            const samples = Math.max(2, Math.min(2000, Math.ceil(durationSec * 100)));
            const curve = gainMod.buildGainCurve(audio, clipDur, 0, clipDur, samples, {
              microFadeIn,
              microFadeOut,
              volumeKeyframes: clip.keyframes.volume,
            });

            const startSec = clip.timelineStartUs / 1e6;
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = clip.speed.rate;
            const gain = ctx.createGain();
            gain.gain.value = 0; // AudioGraph.connectElement ile aynı başlangıç
            source.connect(gain);
            gain.connect(master);
            gain.gain.setValueCurveAtTime(curve, startSec, durationSec);
            // start(when, offset, duration): offset/duration KAYNAK ekseninde.
            source.start(
              startSec,
              clip.sourceInUs / 1e6,
              (clip.sourceOutUs - clip.sourceInUs) / 1e6,
            );
          }
        }

        const rendered = await ctx.startRendering();
        const left = rendered.getChannelData(0);
        const right = rendered.getChannelData(1);
        const hopFrames = Math.round((arg.hopMs / 1000) * arg.sampleRate);
        const hops = Math.floor(rendered.length / hopFrames);
        const sumSquares = new Array<number>(hops).fill(0);
        const peak = new Array<number>(hops).fill(0);
        for (let h = 0; h < hops; h++) {
          let ss = 0;
          let pk = 0;
          for (let f = h * hopFrames; f < (h + 1) * hopFrames; f++) {
            const l = left[f];
            const r = right[f];
            ss += l * l + r * r;
            const a = Math.max(Math.abs(l), Math.abs(r));
            if (a > pk) pk = a;
          }
          sumSquares[h] = ss;
          peak[h] = pk;
        }
        return { sumSquares, peak, countPerHop: hopFrames * 2, hops };
      },
      {
        tracks: (doc.timeline as { tracks: unknown }).tracks,
        proxyB64,
        totalUs: TOTAL_US,
        sampleRate: SAMPLE_RATE,
        hopMs: HOP_MS,
        fpsNum: 30,
        fpsDen: 1,
      },
    );

    // ── 5) Export zarfı (node, ffmpeg çözümü) ──
    const exportPcm = decodeExportAudio(mp4Path);
    const exportDurSec = exportPcm.length / 2 / SAMPLE_RATE;
    // §8.3 uzunluk kilidi: ses akışı belge süresine sabitlenir.
    expect(Math.abs(exportDurSec - TOTAL_US / 1e6)).toBeLessThanOrEqual(0.05);
    const exportEnv = envelopeOfInterleaved(exportPcm, HOP_MS, SAMPLE_RATE);

    const hopsPerWindow = RMS_WINDOW_MS / HOP_MS;
    const fineA = preview.sumSquares.map((s) => Math.sqrt(s));
    const fineB = exportEnv.sumSquares.map((s) => Math.sqrt(s));

    // ── 6) TEPE HİZALAMASI: rate=1 malzeme [0,13 sn) üstünden global gecikme ──
    const globalLag = envelopeLagMs(fineA, fineB, 0, Math.floor(13_000 / HOP_MS), 15);
    const atempoCase = CASES.find((c) => c.kind === 'atempo')!;
    const atempoLag = envelopeLagMs(
      fineA, fineB,
      Math.floor((atempoCase.fromSec * 1000) / HOP_MS),
      Math.floor((atempoCase.toSec * 1000) / HOP_MS),
      15,
    );

    // İçerik karşılaştırması hizalanmış zarfta yapılır (yalnız TAM hop kaydırma;
    // zamanlama iddiası yukarıdaki gecikme ölçümünün kendisidir).
    const shift = Math.round(globalLag / HOP_MS);

    // ── 7) 100 ms RMS pencereleri, vaka vaka ──
    interface CaseResult {
      name: string;
      kind: CaseSpec['kind'];
      windows: number;
      meanAbsDb: number;
      maxAbsDb: number;
      meanSignedDb: number;
      previewMeanDb: number;
      exportMeanDb: number;
      previewPeak: number;
      exportPeak: number;
    }
    const results: CaseResult[] = [];
    for (const c of CASES) {
      const fromWin = Math.round((c.fromSec * 1000) / RMS_WINDOW_MS);
      const toWin = Math.round((c.toSec * 1000) / RMS_WINDOW_MS);
      let n = 0;
      let sumAbs = 0;
      let maxAbs = 0;
      let sumSigned = 0;
      let sumPrevDb = 0;
      let sumExpDb = 0;
      let previewPeak = 0;
      let exportPeak = 0;
      for (let h = fromWin * hopsPerWindow; h < toWin * hopsPerWindow; h++) {
        previewPeak = Math.max(previewPeak, preview.peak[h] ?? 0);
        exportPeak = Math.max(exportPeak, exportEnv.peak[h + shift] ?? 0);
      }
      for (let w = fromWin; w < toWin; w++) {
        let ssA = 0;
        let ssB = 0;
        for (let h = w * hopsPerWindow; h < (w + 1) * hopsPerWindow; h++) {
          ssA += preview.sumSquares[h] ?? 0;
          const j = h + shift;
          ssB += exportEnv.sumSquares[j] ?? 0;
        }
        const dbA = rmsDb(ssA, hopsPerWindow * preview.countPerHop);
        const dbB = rmsDb(ssB, hopsPerWindow * exportEnv.countPerHop);
        if (c.kind === 'silence') {
          n++;
          sumPrevDb += dbA;
          sumExpDb += dbB;
          continue;
        }
        // Sessizliğe yakın pencerelerde dB farkı tanımsızlaşır — taban altı atlanır.
        if (dbA < -45 || dbB < -45) continue;
        const d = dbA - dbB; // + = önizleme daha gür
        n++;
        sumAbs += Math.abs(d);
        maxAbs = Math.max(maxAbs, Math.abs(d));
        sumSigned += d;
        sumPrevDb += dbA;
        sumExpDb += dbB;
      }
      results.push({
        name: c.name,
        kind: c.kind,
        windows: n,
        meanAbsDb: n ? sumAbs / n : 0,
        maxAbsDb: maxAbs,
        meanSignedDb: n ? sumSigned / n : 0,
        previewMeanDb: n ? sumPrevDb / n : -99,
        exportMeanDb: n ? sumExpDb / n : -99,
        previewPeak,
        exportPeak,
      });
    }

    // ── 8) RAPOR (eşik geçse de sayılar görünür kalsın) ──
    console.log(
      `[SES PARITE] hiza(global)=${globalLag.toFixed(1)} ms hiza(atempo)=${atempoLag.toFixed(1)} ms ` +
        `kaydirma=${shift} hop | pencere=${RMS_WINDOW_MS} ms`,
    );
    for (const r of results) {
      console.log(
        `[SES PARITE] ${r.name.padEnd(16)} n=${String(r.windows).padStart(2)} ` +
          `|d|ort=${r.meanAbsDb.toFixed(2)} dB |d|max=${r.maxAbsDb.toFixed(2)} dB ` +
          `isaretli=${r.meanSignedDb >= 0 ? '+' : ''}${r.meanSignedDb.toFixed(2)} dB ` +
          `onizleme=${r.previewMeanDb.toFixed(1)} dBFS export=${r.exportMeanDb.toFixed(1)} dBFS ` +
          `tepe=${r.previewPeak.toFixed(3)}/${r.exportPeak.toFixed(3)}`,
      );
    }

    // ── 9) NORMATİF sınırlar (§2.6 tablosu) ──
    expect(Math.abs(globalLag), 'tepe hizalaması (rate=1)').toBeLessThanOrEqual(LIMITS.globalLagMs);
    expect(Math.abs(atempoLag), 'tepe hizalaması (atempo)').toBeLessThanOrEqual(LIMITS.atempoLagMs);
    for (const r of results) {
      const label = `${r.name} (${r.windows} pencere)`;
      if (r.kind === 'silence') {
        expect(r.previewMeanDb, `${label}: önizleme boşlukta sessiz değil`).toBeLessThanOrEqual(
          LIMITS.silenceFloorDb,
        );
        expect(r.exportMeanDb, `${label}: export boşlukta sessiz değil`).toBeLessThanOrEqual(
          LIMITS.silenceFloorDb,
        );
        continue;
      }
      expect(r.windows, `${label}: karşılaştırılabilir pencere kalmadı`).toBeGreaterThan(0);
      if (r.kind === 'steady') {
        expect(r.maxAbsDb, label).toBeLessThanOrEqual(LIMITS.steadyMaxDb);
      } else if (r.kind === 'ramp') {
        expect(r.maxAbsDb, label).toBeLessThanOrEqual(LIMITS.rampMaxDb);
      } else if (r.kind === 'limiter') {
        // §8.3 bilinçli asimetri — TEPE kanıtıyla: önizleme grafiğinde limiter
        // yok (tepe 1.0'ı aşar, float render kırpmaz), export alimiter'dan
        // geçer (tepe ≈ 1.0'a kilitli). Rejim gerçekten devredeyse önizleme
        // tepesi 1'in üstünde olmalı — yoksa vaka limiter'ı hiç uyandırmamış,
        // ölçüm boşa düşmüş demektir.
        expect(
          r.previewPeak,
          `${label}: önizleme tepesi 1.0'ı aşmadı — limiter rejimi tetiklenmemiş`,
        ).toBeGreaterThanOrEqual(LIMITS.limiterRegimePreviewPeakMin);
        expect(
          r.exportPeak,
          `${label}: export tepesi limit×auto-level (≈1.0) üstünde — alimiter zincirden düşmüş`,
        ).toBeLessThanOrEqual(LIMITS.limiterExportPeakMax);
        expect(r.meanSignedDb, `${label}: export önizlemeden GÜR çıktı`).toBeGreaterThanOrEqual(
          -LIMITS.limiterWrongWayDb,
        );
        expect(r.maxAbsDb, label).toBeLessThanOrEqual(LIMITS.limiterMaxDb);
      } else {
        expect(r.maxAbsDb, label).toBeLessThanOrEqual(LIMITS.atempoMaxDb);
      }
    }

    // -----------------------------------------------------------------------
    // ÖLÇERİN KULLANICIYA GÖSTERDİĞİ TABLO, BU ÖLÇÜMÜN KENDİSİNE BAĞLANIR.
    //
    // Yukarıdaki `LIMITS` TAVANDIR (ölçülen + pay): 0,8 / 1,2 / 4,5 / 2,5.
    // Ölçerin dürüstlük notundaki sayılar ise ÖLÇÜLEN değerlerdir
    // (0,70 / 1,20 / 1,24) ve denetime kadar yalnız KENDİ birim testindeki
    // literallere karşı sınanıyordu — kopya kopyayı sınıyordu. Ölçülen değer
    // tavanın ALTINDA kayarsa (ör. tipik rejim 0,70 -> 0,79) her şey yeşil kalır
    // ve ölçer kullanıcıya BAYAT bir sayıyı "ölçülen" diye gösterirdi. Bu iddia
    // o boşluğu kapatır: tabloyu HER tam koşumda ölçümün kendisine bağlar.
    //
    // Yön: yalnız ÜST taraf çivilenir. Ölçülen fark tablodakinden KÜÇÜK çıkarsa
    // (iyileşme) kullanıcı kötümser bir sayı görür — güvenli taraf. BÜYÜK çıkarsa
    // gösterilen sayı yalan olur. Pay 0,10 dB: gözlenen koşumlarda değerler
    // bit-birebir tekrarlandı; pay yalnız ffmpeg/çözücü sürüm oynamaları içindir.
    // -----------------------------------------------------------------------
    const TABLE_TOLERANCE_DB = 0.1;
    const measuredMax = (kinds: readonly string[]): number =>
      Math.max(...results.filter((r) => kinds.includes(r.kind)).map((r) => r.maxAbsDb));
    const measuredByRegime: Record<string, number> = {
      'tipik rejimlerde': measuredMax(['steady', 'ramp']),
      'limiter rejiminde': measuredMax(['limiter']),
      'hız 2x rejiminde': measuredMax(['atempo']),
    };
    for (const entry of PARITY_DELTAS_DB) {
      const measured = measuredByRegime[entry.regime];
      expect(
        measured,
        `${entry.regime}: ölçerin tablosunda bu rejimin ölçüm vakası yok — eşleme koptu`,
      ).toBeGreaterThan(0);
      expect(
        measured,
        `ölçerin dürüstlük notu "${entry.regime} ${entry.db} dB" diyor ama ÖLÇÜLEN ` +
          `${measured.toFixed(2)} dB — gösterilen sayı BAYAT. Bu bir SÖZLEŞME İHLALİ ` +
          `DEĞİLDİR (§2.6 normatif tavanları ayrı ve daha geniştir; onları yukarıdaki ` +
          `LIMITS iddiaları sınar). Doğru yanıt: core/meter.ts PARITY_DELTAS_DB ile ` +
          'poc-bilinen-sinirlar §2.6 tablosunu BİRLİKTE yeniden ölçüp güncellemek — ' +
          'buradaki payı gevşetmek DEĞİL.',
      ).toBeLessThanOrEqual(entry.db + TABLE_TOLERANCE_DB);
    }
  });
});
