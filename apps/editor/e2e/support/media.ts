/**
 * media — testlerin kullandığı GERÇEK medya dosyalarını üretir (ffmpeg).
 *
 * Neden gerçek dosya: kütüphane/yükleme/export akışının kırılgan yerleri tam
 * olarak sentetik testlerin göremediği yerler — `<input type="file">` seçici
 * zinciri, çok parçalı yükleme, worker'ın ffprobe/ffmpeg ile ürettiği
 * proxy/filmstrip ve export'un gerçek bir kaynak dosyaya ihtiyaç duyması.
 * Repo'ya ikili dosya koymak yerine dosya KOŞUM SIRASINDA üretilir
 * (e2e/.artifacts/media — .gitignore'da) ve koşumlar arasında yeniden
 * kullanılır.
 *
 * ffmpeg yoksa testler net bir mesajla ATLANIR (skip), sessizce yeşil olmaz.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOnFrameGrid, type Rational } from '@videoedit/timeline-schema';

/** e2e/.artifacts/media — koşum artefaktları (gitignore). */
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.artifacts', 'media');

export interface TestVideo {
  /** Mutlak dosya yolu (page.setInputFiles / fileChooser.setFiles bunu alır). */
  path: string;
  fileName: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationUs: number;
  contentType: string;
}

/** Üretilen test videosunun BEKLENEN özellikleri (asset kartı iddiaları bunlara dayanır). */
export const TEST_VIDEO_SPEC = {
  fileName: 'e2e-testsrc-4s.mp4',
  width: 640,
  height: 480,
  durationSeconds: 4,
  contentType: 'video/mp4',
} as const;

let ffmpegProbe: string | null | undefined;

/** ffmpeg PATH'te mi? (bir kez ölçülür) */
export function ffmpegVersion(): string | null {
  if (ffmpegProbe !== undefined) return ffmpegProbe;
  const res = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 15_000 });
  ffmpegProbe = res.status === 0 ? (res.stdout.split('\n')[0] ?? 'ffmpeg') : null;
  return ffmpegProbe;
}

export const FFMPEG_SKIP_REASON =
  'ffmpeg PATH\'te yok — GERÇEK medya üretilemiyor, bu test atlandı. ' +
  'Kurulum: winget install Gyan.FFmpeg (veya paket yöneticiniz).';

/**
 * 4 saniyelik, sesli, ~2-3 MB'lık bir MP4 üretir (bir kez; sonraki çağrılar
 * diskteki dosyayı döndürür).
 *
 * İçerik `testsrc2`: her karesi FARKLI ve renkli — filmstrip'in gerçekten
 * çizildiğini piksel üzerinden iddia edebilmek için şart (düz renkli bir
 * kaynakta "filmstrip mi, düz blok mu?" ayırt edilemezdi).
 */
export function ensureTestVideo(suffix = ''): TestVideo {
  const fileName = suffix
    ? TEST_VIDEO_SPEC.fileName.replace('.mp4', `-${suffix}.mp4`)
    : TEST_VIDEO_SPEC.fileName;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${TEST_VIDEO_SPEC.width}x${TEST_VIDEO_SPEC.height}:rate=30:duration=${TEST_VIDEO_SPEC.durationSeconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${TEST_VIDEO_SPEC.durationSeconds}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        '5000k',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-movflags',
        '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Test videosu üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    width: TEST_VIDEO_SPEC.width,
    height: TEST_VIDEO_SPEC.height,
    durationUs: TEST_VIDEO_SPEC.durationSeconds * 1_000_000,
    contentType: TEST_VIDEO_SPEC.contentType,
  };
}

// ---------------------------------------------------------------------------
// Kare ızgarasına OTURMAYAN kaynak (kırpma sınırlarının gerçek sınıfı)
// ---------------------------------------------------------------------------

/** Projelerin varsayılan kare hızı — "ızgara dışı" iddiası buna göredir. */
const DEFAULT_PROJECT_FPS: Rational = { num: 30, den: 1 };

/**
 * Süresi proje kare ızgarasında OLMAYAN kaynak.
 *
 * Neden ayrı bir fixture: takımdaki bütün medyanın süresi kare hizalıydı
 * (e2e test videosu tam 4.000000 sn, seed klipleri 6 sn, demo medyası 10 sn).
 * Kırpmanın kaynak sınırına dayandığı an — kullanıcının sağ tutamağı kaynağın
 * sonuna kadar çektiği an — klibin kenarı KAYNAĞIN süresine oturur; o süre
 * ızgarada değilse ortaya export'un HTTP 422 ile reddettiği bir belge çıkar.
 * Kare hizalı bir kaynakla bu sınıf test EDİLEMEZ: sınır zaten ızgaradadır.
 *
 * Nasıl garanti ediliyor: video 25 fps üretilir (proje 30 fps), yani kaynağın
 * her kare sınırı proje ızgarasına göre kaymıştır. `ensureMisalignedVideo`
 * dosyayı ürettikten SONRA ffprobe ile ölçer ve süre ızgaraya denk gelirse
 * sessizce yeşile dönmek yerine net bir hatayla düşer (fixture amacını
 * kaybetmişse test de anlamını kaybeder).
 *
 * Ölçülen değer (ffmpeg 8.0, bu makine): format.duration = 7.320000 sn =
 * 7_320_000 µs; 30 fps'te 219.6 kare eder — ızgarada YOKTUR.
 */
export const MISALIGNED_VIDEO_SPEC = {
  fileName: 'e2e-misaligned-25fps.mp4',
  width: 640,
  height: 480,
  /** Kaynağın kendi kare hızı (projeninkinden FARKLI olması işin özü). */
  sourceRate: 25,
  /** ffmpeg'e verilen süre; kapsayıcının gerçek süresi ölçülerek doğrulanır. */
  requestedSeconds: 7.3073,
  contentType: 'video/mp4',
} as const;

/**
 * Kapsayıcının süresi (µs) — sunucunun okuduğu değerin AYNISI: worker da
 * `format.duration` alanını mikrosaniyeye çevirir (MediaProbeParser.cs).
 */
export function probeDurationUs(path: string): number | null {
  const res = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) return null;
  const seconds = Number.parseFloat((res.stdout ?? '').trim());
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000_000) : null;
}

/**
 * Süresi proje kare ızgarasında OLMAYAN gerçek bir MP4 (bir kez üretilir).
 *
 * Döndürülen `durationUs` TAHMİN DEĞİL, ölçümdür — testler beklenen kırpma
 * sınırını bu değerden hesaplar.
 */
export function ensureMisalignedVideo(projectFps: Rational = DEFAULT_PROJECT_FPS): TestVideo {
  const { fileName, width, height, sourceRate, requestedSeconds } = MISALIGNED_VIDEO_SPEC;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${width}x${height}:rate=${sourceRate}:duration=${requestedSeconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${requestedSeconds}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        '3000k',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(
        `Izgara dışı süreli test videosu üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`,
      );
    }
  }

  const durationUs = probeDurationUs(path);
  if (durationUs === null) {
    throw new Error(
      `"${fileName}" süresi ffprobe ile okunamadı — fixture'ın süresi ÖLÇÜLMEDEN kullanılamaz ` +
        '(ffprobe PATH\'te mi?).',
    );
  }
  if (isOnFrameGrid(durationUs, projectFps)) {
    throw new Error(
      `"${fileName}" süresi (${durationUs} µs) ${projectFps.num}/${projectFps.den} fps ızgarasına ` +
        'DENK GELDİ. Bu fixture\'ın tek amacı ızgara DIŞI bir kaynak süresi sağlamaktı; bu ffmpeg ' +
        'sürümüyle amacını kaybetmiş demektir. Süreyi (MISALIGNED_VIDEO_SPEC.requestedSeconds) ' +
        'değiştirip yeniden üretin — dosyayı silmek yeterli: e2e/.artifacts/media.',
    );
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    width,
    height,
    durationUs,
    contentType: MISALIGNED_VIDEO_SPEC.contentType,
  };
}

/**
 * Desteklenmeyen formatı reddetme testi için sahte dosya. İÇERİĞİ önemsiz:
 * reddetme UZANTI üzerinden yapılır (features/library/fileTypes.ts) ve dosya
 * sunucuya hiç gitmez — gerçek bir Matroska üretmek testi yavaşlatır, kanıt
 * değerini artırmaz.
 */
export function unsupportedFixtureFile(fileName = 'kamera-cekimi.mkv'): string {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const path = join(MEDIA_DIR, fileName);
  if (!existsSync(path)) writeFileSync(path, 'bu bir video degil');
  return path;
}
