/**
 * lutMedia — LUT e2e'sinin GERÇEK dosyaları + parite ölçüm araçları.
 *
 * Kaynaklar koşum sırasında üretilir (e2e/.artifacts/media, gitignore):
 *  - degrade PNG: r = X/(W-1), g = Y/(H-1), b sabit — DÜZ (lineer) içerik.
 *    Bilinçli: önizleme POSTER'i (JPEG) ve export ORİJİNAL PNG'yi okur; iki yol
 *    farklı ölçekleyicilerden geçer ve lineer bir degrade her makul yeniden
 *    örnekleyicide AYNI kalır — parite ölçümü böylece ölçekleyici gürültüsünü
 *    değil LUT matematiğini ölçer.
 *  - teal .cube (17³): kanal başına LİNEER karışım — trilinear interpolasyonun
 *    TAM temsil ettiği bir tablo, yani örnekleme şeması farkı sıfırdır; kalan
 *    her fark boru hattından gelir ve rapora girer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegVersion, FFMPEG_SKIP_REASON } from './media';

const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.artifacts', 'media');

export const GRADIENT_SPEC = {
  fileName: 'e2e-lut-gradient.png',
  width: 640,
  height: 360,
} as const;

/** Degrade PNG — ffmpeg geq ile deterministik üretim (repo'ya ikili girmez). */
export function ensureGradientImage(): string {
  const path = join(MEDIA_DIR, GRADIENT_SPEC.fileName);
  if (existsSync(path)) return path;
  if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
  mkdirSync(MEDIA_DIR, { recursive: true });
  const { width, height } = GRADIENT_SPEC;
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
      `nullsrc=size=${width}x${height},format=rgb24,` +
        `geq=r='X/(W-1)*255':g='Y/(H-1)*255':b=128`,
      '-frames:v',
      '1',
      path,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (res.status !== 0) {
    throw new Error(`Degrade PNG üretilemedi: ${res.stderr}`);
  }
  return path;
}

export const TEAL_CUBE_SIZE = 17;

/**
 * §4.2 CPU referansının (cubeLut.sampleCubeLut) besleyeceği tablo AYNI formülle
 * burada da üretilir — .cube metni tek kaynaktan çıkar, test hem dosyayı yükler
 * hem beklenen pikseli bu fonksiyondan türetir.
 */
export function tealMap(r: number, g: number, b: number): [number, number, number] {
  return [0.8 * r + 0.2 * b, 0.9 * g + 0.05, 0.3 * r + 0.7 * b];
}

/** Kanal-lineer "teal" 17³ .cube dosyası (kırmızı en hızlı — .cube standardı). */
export function ensureTealCube(): string {
  const path = join(MEDIA_DIR, 'e2e-teal-17.cube');
  if (existsSync(path)) return path;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const n = TEAL_CUBE_SIZE;
  const lines: string[] = ['TITLE "e2e-teal"', `LUT_3D_SIZE ${n}`];
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        const [r, g, b] = tealMap(ri / (n - 1), gi / (n - 1), bi / (n - 1));
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/** Worker'ın 'invalid-lut' ile reddedeceği bozuk .cube (satır sayısı boyutla çelişir). */
export function ensureBrokenCube(): string {
  const path = join(MEDIA_DIR, 'e2e-broken.cube');
  if (existsSync(path)) return path;
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(path, 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7), 'utf8');
  return path;
}

/** MP4'ün İLK karesini ham RGBA olarak çıkarır (ffmpeg -f rawvideo). */
export function extractFirstFrameRgba(
  mp4Path: string,
  outName: string,
): { width: number; height: number; pixels: Uint8Array } {
  if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      mp4Path,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (probe.status !== 0) throw new Error(`ffprobe başarısız: ${probe.stderr}`);
  const [width, height] = probe.stdout.trim().split(',').map((v) => Number.parseInt(v, 10));
  const rawPath = join(MEDIA_DIR, outName);
  const res = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp4Path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', rawPath],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (res.status !== 0) throw new Error(`Kare çıkarılamadı: ${res.stderr}`);
  const pixels = new Uint8Array(readFileSync(rawPath));
  if (pixels.length !== width * height * 4) {
    throw new Error(`Ham kare boyutu tutmadı: ${pixels.length} != ${width * height * 4}`);
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Parite metrikleri (rendering-semantics §9.3)
// ---------------------------------------------------------------------------

export interface ChannelStats {
  meanAbs: number;
  max: number;
  /** Mutlak farkların 99. yüzdelik değeri (tek tük kenar pikseli maskelemesin). */
  p99: number;
}

/** RGBA tamponlar arasında kanal başına |fark| istatistikleri (alfa hariç). */
export function channelDiffStats(a: Uint8Array, b: Uint8Array): ChannelStats {
  if (a.length !== b.length) throw new Error(`Tampon boyutları farklı: ${a.length} != ${b.length}`);
  const diffs: number[] = [];
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      diffs.push(d);
      sum += d;
      if (d > max) max = d;
    }
  }
  diffs.sort((x, y) => x - y);
  return {
    meanAbs: sum / diffs.length,
    max,
    p99: diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.99))],
  };
}

/**
 * Global SSIM, gri tonlamada (§9.3 "SSIM (gri, global)"): 8×8 pencereler,
 * 4 px adım, pencere SSIM'lerinin ortalaması. Standart sabitler
 * C1=(0.01·255)², C2=(0.03·255)².
 */
export function ssimGray(
  a: { width: number; height: number; pixels: Uint8Array },
  b: { width: number; height: number; pixels: Uint8Array },
): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Kare boyutları farklı: ${a.width}x${a.height} != ${b.width}x${b.height}`);
  }
  const { width, height } = a;
  const grayOf = (src: Uint8Array): Float64Array => {
    const g = new Float64Array(width * height);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      g[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }
    return g;
  };
  const ga = grayOf(a.pixels);
  const gb = grayOf(b.pixels);

  const WIN = 8;
  const STEP = 4;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  for (let y = 0; y + WIN <= height; y += STEP) {
    for (let x = 0; x + WIN <= width; x += STEP) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let wy = 0; wy < WIN; wy++) {
        const row = (y + wy) * width + x;
        for (let wx = 0; wx < WIN; wx++) {
          const va = ga[row + wx];
          const vb = gb[row + wx];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const n = WIN * WIN;
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const cov = sumAB / n - muA * muB;
      total +=
        ((2 * muA * muB + C1) * (2 * cov + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      windows++;
    }
  }
  return windows === 0 ? 1 : total / windows;
}
