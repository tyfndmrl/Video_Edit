/**
 * J geri taramasında YABANCI KARE regresyon kalkanı (2026-09-02 düzeltmesinin
 * kalıcı e2e damıtması; ham teşhis ölçümü: 6 rejim / 621 örnek, geri
 * taramalarda örneklerin ~%60'ı siyah flaş — scrub seek'inin readyState
 * çukurunda katman arka plana düşüyordu, sınırda ek soğuk-kurulum penceresi).
 *
 * Ölçüm yöntemi teşhisle birebir: renk-ayrımlı iki GERÇEK klip (sol yarı düz
 * KIRMIZI / düz MAVİ), gerçek REST upload + worker proxy'si, gerçek klavye
 * (page.keyboard 'j' ×2 = 2x), motorun aynı-rAF framebuffer probu
 * (window.__videoeditPlayer.probePixel) ile kompozit çıktı playhead'e eşlenir.
 *
 * İhlal tanımı:
 *  - HERHANGİ bir örnekte SİYAH  -> katman düşmesi (arka plan #000; probe
 *    bölgesinde hiçbir klip meşru siyah üretmez)
 *  - playhead A bölgesindeyken MAVİ (ya da B bölgesinde KIRMIZI) -> bayat
 *    karşı-klip karesi (sınır çevresinde scrub-gecikme marjı tanınır)
 * Düzeltme sonrası ikisi de 0 olmalı; düzeltme geri alınırsa siyah sayısı
 * yüzlerle ifade edilir (negatif kontrol imzası).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { FFMPEG_SKIP_REASON, ffmpegVersion, probeDurationUs } from './support/media';
import { uploadAssetViaApi, waitAssetReady } from './support/apiUpload';
import { createProject, saveTimeline } from './fixtures/seed';

const SECOND_US = 1_000_000;
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/** Kompozisyon (proje) koordinatında örnekleme noktası — sol yarının ortası. */
const PROBE_X = 420;
const PROBE_Y = 540;
/** Sınır çevresinde renk yargısından muaf bant (scrub throttle gecikme payı, 2x). */
const MARGIN_US = 700_000;

interface RawSample {
  t: number;
  us: number;
  r: number;
  g: number;
  b: number;
}

type ColorClass = 'kirmizi' | 'mavi' | 'siyah' | 'diger';

function classify(r: number, g: number, b: number): ColorClass {
  if (r <= 48 && g <= 48 && b <= 48) return 'siyah';
  if (r >= 140 && g <= 100 && b <= 100) return 'kirmizi';
  if (b >= 140 && r <= 100) return 'mavi';
  return 'diger';
}

/** Sol yarısı düz renk, sağ yarısı testsrc2 olan 4,8 sn'lik sesli MP4 üretir. */
function ensureColorVideo(name: string, ffColor: string): { path: string; fileName: string } {
  const fileName = `shuttle-fi-${name}-640x360.mp4`;
  const path = join(MEDIA_DIR, fileName);
  if (!existsSync(path)) {
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${ffColor}:size=320x360:rate=30:duration=4.8`,
        '-f', 'lavfi', '-i', 'testsrc2=size=320x360:rate=30:duration=4.8',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4.8',
        '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]',
        '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '2000k',
        '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart',
        path,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Test videosu üretilemedi (${name}, exit ${res.status}):\n${res.stderr}`);
    }
  }
  return { path, fileName };
}

/** 100 ms tabanına aşağı yuvarla — tam sayı µs, 30 fps karesinin katı. */
function floor100ms(us: number): number {
  return Math.floor(us / 100_000) * 100_000;
}

function twoClipDoc(
  projectId: string,
  assetA: string,
  durA: number,
  assetB: string,
  durB: number,
): unknown {
  const clip = (assetId: string, startUs: number, durationUs: number) => ({
    id: crypto.randomUUID(),
    kind: 'video',
    assetId,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  });
  return {
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
        clips: [clip(assetA, 0, durA), clip(assetB, durA, durB)],
      },
    ],
    markers: [],
  };
}

/** Tek seferlik piksel örneği (ısınma/koordinat doğrulaması). */
async function samplePixelOnce(page: Page): Promise<ColorClass> {
  const [r, g, b] = await page.evaluate(
    async ({ px, py }) => {
      const w = window as unknown as {
        __videoeditPlayer?: { probePixel(x: number, y: number): Promise<number[]> };
      };
      if (!w.__videoeditPlayer) throw new Error('__videoeditPlayer DEV kancası yok');
      const c = await w.__videoeditPlayer.probePixel(px, py);
      return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0] as [number, number, number];
    },
    { px: PROBE_X, py: PROBE_Y },
  );
  return classify(r, g, b);
}

/**
 * durMs boyunca her rAF'ta {playhead, renk} çifti toplar (probePixel çözümü
 * kompozit kareyle AYNI rAF'ta servis edilir). Await edilmeden başlatılır;
 * tuş basışları örnekleme sürerken yapılır.
 */
function startSampling(page: Page, durMs: number): Promise<RawSample[]> {
  return page.evaluate(
    async ({ durMs: d, px, py }) => {
      const w = window as unknown as {
        __videoeditPlayer?: { probePixel(x: number, y: number): Promise<number[]> };
        __videoeditTest?: { editorStore: { getState(): { playheadUs: number } } };
      };
      const player = w.__videoeditPlayer;
      const bridge = w.__videoeditTest;
      if (!player || !bridge) throw new Error('DEV kancaları yok');
      const out: { t: number; us: number; r: number; g: number; b: number }[] = [];
      const t0 = performance.now();
      for (;;) {
        if (performance.now() - t0 >= d) break;
        const c = await player.probePixel(px, py);
        out.push({
          t: Math.round(performance.now() - t0),
          us: bridge.editorStore.getState().playheadUs,
          r: c[0] ?? 0,
          g: c[1] ?? 0,
          b: c[2] ?? 0,
        });
      }
      return out;
    },
    { durMs, px: PROBE_X, py: PROBE_Y },
  );
}

test.describe('J geri tarama — kare bütünlüğü', () => {
  test('2x sınır-geçişli taramada siyah flaş ve bayat karşı-klip karesi yok', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(120_000);

    // --- Gerçek medya + gerçek upload + worker proxy'si --------------------
    const red = ensureColorVideo('kirmizi', 'red');
    const blue = ensureColorVideo('mavi', 'blue');
    const durAUs = floor100ms(probeDurationUs(red.path) ?? 0);
    const durBUs = floor100ms(probeDurationUs(blue.path) ?? 0);
    expect(durAUs, 'Kırmızı video süresi ölçülemedi.').toBeGreaterThan(4 * SECOND_US);
    expect(durBUs, 'Mavi video süresi ölçülemedi.').toBeGreaterThan(4 * SECOND_US);

    const request = account.context.request;
    const project = await createProject(request, account.accessToken, 'Shuttle kare bütünlüğü');
    const upA = await uploadAssetViaApi(
      request, account.accessToken, project.id, red.path, red.fileName, 'video/mp4');
    const upB = await uploadAssetViaApi(
      request, account.accessToken, project.id, blue.path, blue.fileName, 'video/mp4');
    await waitAssetReady(request, account.accessToken, upA.assetId, red.fileName);
    await waitAssetReady(request, account.accessToken, upB.assetId, blue.fileName);

    const boundaryUs = durAUs; // A=[0,dA) KIRMIZI, B=[dA,dA+dB) MAVİ
    await saveTimeline(
      request,
      account.accessToken,
      project.id,
      twoClipDoc(project.id, upA.assetId, durAUs, upB.assetId, durBUs),
      project.revisionNumber,
    );

    // --- Editör + ısınma (koordinat/sınıflandırma doğrulaması) -------------
    const app = new EditorApp(page);
    await app.open(project.id, { email: account.email, password: account.password });
    const badge = page.getByTestId('transport-shuttle-note');

    await app.timeline.scrubTo(Math.round(durAUs / 2));
    await expect
      .poll(() => samplePixelOnce(page), {
        timeout: 20_000,
        message: 'A (kırmızı) klibi önizlemede hiç görünmedi — ölçüm kurulamıyor.',
      })
      .toBe('kirmizi');
    await app.timeline.scrubTo(boundaryUs + Math.round(durBUs / 2));
    await expect
      .poll(() => samplePixelOnce(page), {
        timeout: 20_000,
        message: 'B (mavi) klibi önizlemede hiç görünmedi — ölçüm kurulamıyor.',
      })
      .toBe('mavi');

    // --- Rejim: B içinden 2x J ile sınırı geriye geç -----------------------
    // 3,2 sn örnekleme × 2x = 6,4 sn yol: B'de 2,4 sn klip-içi tarama + sınır
    // geçişi + A'da ~4 sn (BOF'a varmadan biter) — klip-içi VE sınır sınıfları
    // tek rejimde kapsanır.
    const startUs = boundaryUs + 2_400_000;
    await app.timeline.scrubTo(startUs);
    await page.waitForTimeout(400); // settle hassas seek otursun
    const sampling = startSampling(page, 3_200);
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(badge).toHaveText('Geri tarama 2x — ses kapalı');
    const samples = await sampling;
    await page.keyboard.press('k');
    await expect(badge).toBeHidden();

    // --- Yabancı kare taraması --------------------------------------------
    // Bu bir ÖN KOŞUL, iddia değil: örnekleme gerçekten koştu mu? Eşik ölçümle
    // seçildi — yalıtımda 86-87 örnek (≈27 fps) toplanıyor, TAM suite yükü
    // altında 57'ye (≈18 fps) düşebiliyor; 60'lık eski eşik payı olmadığı için
    // yükte YANLIŞ kırmızı veriyordu. 40, 'hiç örnek toplanmadı' ile 'yavaş ama
    // çalıştı' arasını hâlâ ayırır; asıl iddia aşağıdaki yabancı-kare taramasıdır.
    expect(samples.length, 'örnekleme çalışmadı').toBeGreaterThan(40);
    let siyah = 0;
    let yanlisRenk = 0;
    let usMin = Number.POSITIVE_INFINITY;
    for (const s of samples) {
      const cls = classify(s.r, s.g, s.b);
      usMin = Math.min(usMin, s.us);
      if (cls === 'siyah') siyah++;
      else if (cls === 'mavi' && s.us < boundaryUs - MARGIN_US) yanlisRenk++;
      else if (cls === 'kirmizi' && s.us > boundaryUs + MARGIN_US) yanlisRenk++;
    }
    expect(
      usMin,
      'Tarama sınırı geçip A içine inmedi — rejim kurulamadı.',
    ).toBeLessThan(boundaryUs - 2 * SECOND_US);
    expect(
      siyah,
      `Yabancı kare taraması: ${samples.length} örnekte siyah=${siyah} — ` +
        'geri taramada katman arka plana düşüyor (scrub çukuru örtüsü/geriye-preload bozulmuş).',
    ).toBe(0);
    expect(
      yanlisRenk,
      `Yabancı kare taraması: ${samples.length} örnekte yanlisRenk=${yanlisRenk} — ` +
        'playhead bölgesiyle çelişen bayat karşı-klip karesi çizilmiş.',
    ).toBe(0);
  });
});
