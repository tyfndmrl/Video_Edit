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
