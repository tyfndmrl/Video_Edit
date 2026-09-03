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

// ---------------------------------------------------------------------------
// AŞIRI GENİŞ (afiş/panorama) kaynak — dejenerelik rejiminin tek tetikleyicisi
// ---------------------------------------------------------------------------

/**
 * 1920×100 (**19.2:1**) afiş videosu.
 *
 * Neden ayrı bir fixture: takımdaki bütün medya normal oranlıdır (640×480, 16:9) ve normal oranlı
 * bir kaynak dejenerelik rejimine **hiçbir ölçekte** giremez. 1920×1080 tuvalde ölçek `0.010`
 * yazıldığında kutu `19×11` olur; ffmpeg'in aspect'i koruyarak sığdırdığı yükseklik `0.99 px`'e
 * düşer, filtre o ekseni `0` hesaplar ve `0`'ı *"girdi boyutunu koru"* diye yorumlar → katman
 * `18×100` çizilirdi (**100 kat** yüksek) ve normalize pad `-22` ile ölürdü.
 *
 * Eşik (`rendering-semantics` §2.5): `(ceil(1920/100) − 0.5) / 1920 = 0.010156` → editör
 * ızgarasında **0.011**. Yani `0.010` reddedilir, `0.011` kabul edilir — bir ızgara adımı.
 *
 * Boyut `ensureTestVideo`'nunki gibi ölçülMEZ, ÜRETİLİR ve aşağıda ffprobe ile **doğrulanır**:
 * fixture amacını kaybederse test sessizce yeşile dönmemeli.
 */
export const BANNER_VIDEO_SPEC = {
  fileName: 'e2e-banner-1920x100.mp4',
  width: 1920,
  height: 100,
  durationSeconds: 4,
  contentType: 'video/mp4',
  /** 1920×1080 tuvalde dejenere olan EN BÜYÜK ölçek (reddedilmeli). */
  degenerateScale: '0.010',
  /** Bir ızgara adımı üstü — kabul edilmeli. */
  acceptedScale: '0.011',
} as const;

/** ffprobe ile gerçek kare boyutu (rotation uygulanmış) — `WxH` ya da null. */
export function probeFrameSize(path: string): { width: number; height: number } | null {
  const res = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) return null;
  const [w, h] = (res.stdout ?? '').trim().split('x').map((v) => Number.parseInt(v, 10));
  return Number.isFinite(w) && Number.isFinite(h) ? { width: w!, height: h! } : null;
}

export function ensureBannerVideo(): TestVideo {
  const { fileName, width, height, durationSeconds, contentType } = BANNER_VIDEO_SPEC;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-b:v', '1500k', '-movflags', '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Afiş test videosu üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }

  // Fixture'ın TEK amacı aşırı en-boy oranıdır; ölçmeden kullanmak testi anlamsızlaştırır.
  const size = probeFrameSize(path);
  if (size === null) {
    throw new Error(`"${fileName}" kare boyutu ffprobe ile okunamadı (ffprobe PATH'te mi?).`);
  }
  if (size.width !== width || size.height !== height) {
    throw new Error(
      `"${fileName}" ${size.width}x${size.height} çıktı, beklenen ${width}x${height}. Bu fixture'ın ` +
        'tek amacı 19.2:1 en-boy oranıydı; bu ffmpeg sürümüyle amacını kaybetmiş demektir. ' +
        'Dosyayı silip yeniden üretin: e2e/.artifacts/media.',
    );
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    width,
    height,
    durationUs: durationSeconds * 1_000_000,
    contentType,
  };
}

// ---------------------------------------------------------------------------
// SESSİZ video — "ses klibi + sessiz kaynak" sınıfının tek tetikleyicisi
// ---------------------------------------------------------------------------

/**
 * SES AKIŞI OLMAYAN gerçek bir MP4.
 *
 * Neden ayrı bir fixture: takımdaki bütün videolar sesli üretilir (`sine`
 * girişi), oysa export'un `asset-clip-type` kapısının "ses klibi + SESSİZ
 * video" hücresi ancak sessiz bir kaynakla tetiklenebilir — "Sesi ayır"
 * sessiz videoda ya griler (doğru davranış) ya da 422'lik bir belge doğurur
 * (ölçülen tuzak). Sesli bir kaynakla bu sınıf test EDİLEMEZ.
 *
 * Fixture amacını ffprobe ile DOĞRULAR (diğer fixture'larla aynı desen):
 * dosyada ses akışı çıkarsa sessizce yeşile dönmek yerine net hatayla düşer.
 */
export const SILENT_VIDEO_SPEC = {
  fileName: 'e2e-sessiz-4s.mp4',
  width: 640,
  height: 480,
  durationSeconds: 4,
  contentType: 'video/mp4',
} as const;

export function ensureSilentVideo(): TestVideo {
  const { fileName, width, height, durationSeconds, contentType } = SILENT_VIDEO_SPEC;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
        // BİLEREK ses girişi yok: -an ile ses akışı hiç yazılmaz.
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-b:v', '2000k', '-movflags', '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Sessiz test videosu üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }

  const kinds = probeStreamKinds(path);
  if (!kinds.includes('video') || kinds.includes('audio')) {
    throw new Error(
      `"${fileName}" akışları [${kinds.join(', ')}] çıktı, beklenen yalnız [video]. Bu fixture'ın ` +
        'tek amacı SES AKIŞI OLMAYAN bir video sağlamaktı; amacını kaybetmiş demektir. ' +
        'Dosyayı silip yeniden üretin: e2e/.artifacts/media.',
    );
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    width,
    height,
    durationUs: durationSeconds * 1_000_000,
    contentType,
  };
}

// ---------------------------------------------------------------------------
// SES PARİTESİ fixture'ları — ZARFI YAPILI (tremolo'lu) kaynaklar
// ---------------------------------------------------------------------------

/**
 * Ses paritesi ölçümü (audio-parity.spec.ts) DÜZ bir sinüsle yapılamaz: sabit
 * genlikli bir tonun RMS zarfı her yerde aynıdır, yani zarf karşılaştırması
 * zaman hizasını (tepe hizalaması) hiç göremezdi. Bu iki fixture'ın sesi
 * bilerek GENLİK MODÜLELİDİR (tremolo): zarf 0.2x–1.0x arasında salınır ve
 * önizleme/export zarflarının çapraz korelasyonu gecikmeyi ölçebilir.
 *
 * Genlik matematiği (ffmpeg `sine` kaynağı 1/8 = 0.125 tepe üretir):
 * volume=6 → 0.75 tepe. Parite belgesindeki klip seviyeleriyle birlikte
 * (0.5 → 0.375) iki katmanlı temiz mikste toplam 0.75 < 0.98 kalır (limiter
 * şeffaf), limiter vakasında 0.75 + 0.75 = 1.5 > 0.98 (limiter devrede).
 */
export const PARITY_VIDEO_SPEC = {
  fileName: 'e2e-parite-video-8s.mp4',
  width: 640,
  height: 480,
  durationSeconds: 8,
  /** 440 Hz ton; zarf 1.5 Hz tremolo (d=0.8) ile modüle, tepe 0.75. */
  audioFilter: 'volume=6,tremolo=f=1.5:d=0.8',
  toneHz: 440,
  contentType: 'video/mp4',
} as const;

export const PARITY_MUSIC_SPEC = {
  fileName: 'e2e-parite-muzik-8s.m4a',
  durationSeconds: 8,
  /** 880 Hz ton; zarf 2.5 Hz tremolo (d=0.8) ile modüle, tepe 0.75. */
  audioFilter: 'volume=6,tremolo=f=2.5:d=0.8',
  toneHz: 880,
  contentType: 'audio/mp4',
} as const;

/** 8 sn'lik, tremolo zarflı SESLİ video (bir kez üretilir). */
export function ensureParityVideo(): TestVideo {
  const { fileName, width, height, durationSeconds, audioFilter, toneHz, contentType } =
    PARITY_VIDEO_SPEC;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
        '-f', 'lavfi',
        '-i', `sine=frequency=${toneHz}:sample_rate=48000:duration=${durationSeconds}`,
        '-af', audioFilter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '2000k',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Parite test videosu üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    width,
    height,
    durationUs: durationSeconds * 1_000_000,
    contentType,
  };
}

/** 8 sn'lik, tremolo zarflı GERÇEK bir .m4a (bir kez üretilir). */
export function ensureParityMusic(): TestAudio {
  const { fileName, durationSeconds, audioFilter, toneHz, contentType } = PARITY_MUSIC_SPEC;
  const path = join(MEDIA_DIR, fileName);

  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `sine=frequency=${toneHz}:sample_rate=48000:duration=${durationSeconds}`,
        '-af', audioFilter,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Parite test müziği üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }

  return {
    path,
    fileName,
    sizeBytes: statSync(path).size,
    durationUs: durationSeconds * 1_000_000,
    contentType,
  };
}

/**
 * TAM ÖLÇEKLİ test sesi — ölçerin klip mandalı (0 dBFS aşımı) içindir.
 *
 * NEDEN AYRI BİR FIXTURE: normal test sesi ölçüldüğünde kaynak -3,7 dBFS,
 * worker proxy'si mono→stereo matrisiyle -6,5 dBFS oluyor; klip kazancı 2,0
 * (şemanın tavanı, +6 dB) ile bile önizleme tepesi -0,5 dBFS'te kalıyor, yani
 * mandalın eşiğinin (1,0 lineer) ALTINDA. Mandal testi o kaynakla ancak bir
 * decode transient'i eşiği aşarsa yeşil oluyordu (denetimde ~%50 kırılgan).
 * Bu fixture sinüsü stereo ve tam ölçekte üretir: proxy downmix'i uygulanmaz
 * (zaten stereo), 2,0 kazançla tepe ~+6 dB paya çıkar.
 */
export const LOUD_AUDIO_SPEC = {
  fileName: 'e2e-loud-3s.m4a',
  durationSeconds: 3,
  contentType: 'audio/mp4',
} as const;

/**
 * Kabul eşiği, iki fixture'ın ARASINA ölçülerek kondu (ffmpeg volumedetect):
 * `e2e-loud-3s.m4a` mean -3,6 dB / max -0,0 dB · `e2e-muzik-3s.m4a` mean
 * -7,1 dB / max -3,7 dB. Yani normal test sesi bu kapıdan GEÇEMEZ — kapının
 * ayırt etmesi gereken tam olarak o karışıklıktır.
 */
const LOUD_AUDIO_MIN_MEAN_DB = -5;

export const TEST_AUDIO_SPEC = {
  fileName: 'e2e-muzik-3s.m4a',
  durationSeconds: 3,
  contentType: 'audio/mp4',
} as const;

export interface TestAudio {
  path: string;
  fileName: string;
  sizeBytes: number;
  durationUs: number;
  contentType: string;
}

/**
 * 3 saniyelik GERÇEK bir .m4a (AAC) — kullanıcının "müzik ekle" yolunun birebir
 * dosyası (yükleme whitelist'inde `audio/mp4`).
 *
 * Genlik bilerek yükseltilir (`volume=5`): dışa aktarılan MP4'te "ses var mı"
 * sorusu ancak ÖLÇÜLEBİLİR bir seviyeyle yanıtlanabilir — dijital sessizlik de
 * geçerli bir ses stream'idir ve yalnız stream sayan bir kontrol onu yeşil
 * geçirirdi.
 */
export function ensureTestAudio(): TestAudio {
  const path = join(MEDIA_DIR, TEST_AUDIO_SPEC.fileName);

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
        `sine=frequency=440:duration=${TEST_AUDIO_SPEC.durationSeconds}`,
        '-af',
        'volume=5',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Test sesi üretilemedi: ${res.stderr ?? ''}`);
    }
  }

  return {
    path,
    fileName: TEST_AUDIO_SPEC.fileName,
    sizeBytes: statSync(path).size,
    durationUs: TEST_AUDIO_SPEC.durationSeconds * 1_000_000,
    contentType: TEST_AUDIO_SPEC.contentType,
  };
}

/**
 * Tam ölçekli STEREO sinüs (bkz. LOUD_AUDIO_SPEC gerekçesi). `volume` filtresi
 * ÖLÇÜLDÜ: ffmpeg'in `sine` filtresi -18,1 dBFS üretir (mevcut test sesinin
 * `volume=5`'i de bu yüzden var); `volume=8` (+18,06 dB) tam ölçeğe getirir —
 * ölçüm: max_volume -0,0 dB. Sinüs iki kanala kopyalanır, böylece
 * worker proxy'sinin mono→stereo matris zayıflatması devreye girmez.
 */
export function ensureLoudAudio(): TestAudio {
  const path = join(MEDIA_DIR, LOUD_AUDIO_SPEC.fileName);

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
        `sine=frequency=440:duration=${LOUD_AUDIO_SPEC.durationSeconds}:sample_rate=48000`,
        '-af',
        'volume=8,pan=stereo|c0=c0|c1=c0',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Yüksek seviyeli test sesi üretilemedi: ${res.stderr ?? ''}`);
    }
  }

  // Kardeşleri (ensureSilentVideo/ensureBannerVideo/ensureMisalignedVideo) gibi
  // ÖLÇEREK doğrular. Dosya koşumlar arasında önbelleklenir; bayat ya da yanlış
  // bir kopya sessizce kalırsa klip mandalı e2e'si ÜRÜNÜ suçlayarak düşer —
  // denetimde ölçüldü: dosya sessiz kardeşiyle değiştirildiğinde test
  // "0 dBFS aşımında klip mandalı yanmalıydı" diyor, fikstür hiç şikâyet
  // etmiyordu. Bu fixture'ın TEK amacı tam ölçekli olmasıdır.
  const meanDb = probeMeanVolumeDb(path);
  if (meanDb === null || meanDb < LOUD_AUDIO_MIN_MEAN_DB) {
    throw new Error(
      `"${LOUD_AUDIO_SPEC.fileName}" ortalama seviyesi ${meanDb ?? 'ölçülemedi'} dBFS çıktı, ` +
        `beklenen ≥ ${LOUD_AUDIO_MIN_MEAN_DB} dBFS. Bu fixture'ın tek amacı TAM ÖLÇEKLİ ses ` +
        'sağlamaktı (klip mandalı 0 dBFS aşımıyla yanar); amacını kaybetmiş demektir. ' +
        'Dosyayı silip yeniden üretin: e2e/.artifacts/media.',
    );
  }

  return {
    path,
    fileName: LOUD_AUDIO_SPEC.fileName,
    sizeBytes: statSync(path).size,
    durationUs: LOUD_AUDIO_SPEC.durationSeconds * 1_000_000,
    contentType: LOUD_AUDIO_SPEC.contentType,
  };
}

/**
 * Bir medya dosyasında ses akışı var mı ve ORTALAMA SEVİYESİ kaç dBFS?
 * `null` = ses akışı yok (ya da ölçülemedi). ffmpeg `volumedetect` kullanılır.
 */
export function probeMeanVolumeDb(path: string): number | null {
  const res = spawnSync(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(res.stderr ?? '');
  return match ? Number(match[1]) : null;
}

/** Dosyadaki stream türleri (ffprobe) — ör. `['video', 'audio']`. */
export function probeStreamKinds(path: string): string[] {
  const res = spawnSync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-show_entries',
      'stream=codec_type',
      path,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (res.status !== 0) return [];
  const parsed = JSON.parse(res.stdout) as { streams?: { codec_type?: string }[] };
  return (parsed.streams ?? []).map((s) => s.codec_type ?? '');
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
