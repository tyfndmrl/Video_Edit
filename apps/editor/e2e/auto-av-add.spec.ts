/**
 * Otomatik AV ayrımlı ekleme — ozellik-3 (GERÇEK fare/klavye, GERÇEK medya).
 *
 * CapCut davranışı: SESLİ bir video kütüphaneden timeline'a eklendiğinde video
 * ve ses AYRI şeritlere, LİNKLİ bir çift olarak düşer (tek undo, ikisi seçili);
 * sessiz video ve görsel TEK klip kalır. Karar tablosunun anahtarı varlığın
 * probe olgusudur (`hasAudio`), o yüzden GERÇEK dosya yükleme yolu ŞART: seed
 * asset'lerinin `hasAudio` alanı YOKtur (bilinmeyen → bilerek TEK klip) ve
 * otomatik ayrım seed medyasıyla hiç TETİKLENMEZ. Worker'ın gerçek ffprobe'u
 * "Hazır" satıra hasAudio=true/false yazar — ayrım ancak ondan sonra doğar.
 *
 * KURAL (docs/review-gate.md §3): yalnız gerçek girdi — sürükle-bırak
 * page.mouse, undo page.keyboard, doğrulama readAppState (salt-okur köprü).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import {
  FFMPEG_SKIP_REASON,
  ensureSilentVideo,
  ensureTestVideo,
  ffmpegVersion,
} from './support/media';
import { createEmptyProject } from './support/projects';
import type { AppState } from './support/appBridge';

const SECOND_US = 1_000_000;

/** support/media.ts ile aynı artefakt klasörü (gitignore). */
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/**
 * Görsel negatifin fixture'ı (image-preview.spec.ts deseni): tek karelik JPEG,
 * ffmpeg ile bir kez üretilir. Görselde ses akışı kavramı yoktur — karar
 * tablosunun "image → TEK klip" satırının gerçek-dosya taşıyıcısı.
 */
function ensureTestPhoto(): { path: string; fileName: string } {
  const fileName = 'e2e-av-foto-320x240.jpg';
  const path = join(MEDIA_DIR, fileName);
  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
       '-i', 'testsrc2=size=320x240:rate=1:duration=1', '-frames:v', '1', '-q:v', '2', path],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Test görseli üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }
  expect(statSync(path).size).toBeGreaterThan(0);
  return { path, fileName };
}

/** Kitaplık satırının sol tarafı (rozet/düğmelerden uzak yakalama noktası). */
async function grabPoint(library: LibraryPanelHarness, fileName: string) {
  const box = await library.row(fileName).boundingBox();
  expect(box, `Kitaplıkta "${fileName}" satırı görünmüyor.`).not.toBeNull();
  return { x: box!.x + 40, y: box!.y + box!.height / 2 };
}

/** GERÇEK sürükle-bırak: kitaplık satırından timeline üstündeki noktaya. */
async function dragToTimeline(
  page: Page,
  library: LibraryPanelHarness,
  fileName: string,
  to: { x: number; y: number },
): Promise<void> {
  const from = await grabPoint(library, fileName);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // useAssetDragSource'un 5 px eşiğini aş (library-dnd.spec ile aynı jest).
  await page.mouse.move(from.x + 24, from.y + 6, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/** Dokümandaki tek video + tek ses klibi (sayılar tutmazsa kırmızı). */
function avPair(state: AppState) {
  const clips = state.tracks.flatMap((t) =>
    t.clips.map((c) => ({ ...c, trackId: t.id, trackType: t.type })),
  );
  const videos = clips.filter((c) => c.kind === 'video');
  const audios = clips.filter((c) => c.kind === 'audio');
  expect(videos, 'TAM 1 video klibi bekleniyor.').toHaveLength(1);
  expect(audios, 'TAM 1 ses klibi bekleniyor.').toHaveLength(1);
  return { video: videos[0], audio: audios[0] };
}

test.describe('Otomatik AV ayrımı — kütüphaneden ekleme (gerçek fare)', () => {
  test('sesli video: sürükle-bırak 2 LİNKLİ klip doğurur (ses track\'i EN ALTTA doğar), TEK Ctrl+Z ikisini kaldırır, tekrar ekle + sürükle İKİSİNİ kaydırır', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const video = ensureTestVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E oto AV ayrimi',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    const before = await app.state();
    expect(before.clipCount, 'Test klipsiz projede başlamalı.').toBe(0);
    expect(before.tracks, 'Başlangıçta yalnız 1 video track olmalı.').toHaveLength(1);
    const trackIdsBefore = new Set(before.tracks.map((t) => t.id));

    // (a) GERÇEK sürükle-bırak: video satırına, 2 sn'ye.
    const DROP_TIME_US = 2 * SECOND_US;
    await dragToTimeline(page, library, video.fileName, await app.timeline.point(DROP_TIME_US, 0, before));

    // Bildirim ÖNCE okunur (balon 2 sn'de söner): ses ikizi yeni bir şeride
    // kondu — kullanıcıya SÖYLENİR (feedback NOTICES, TRANSITION_DROPPED ile
    // aynı balon yolu; drop işleyicisi balonu mutate ile eşzamanlı yazar).
    await expect(
      page.getByTestId('timeline-warning'),
      'Yeni ses track\'i açıldığı halde bildirim balonu görünmedi.',
    ).toHaveText("Ses yeni bir track'e yerleştirildi", { timeout: 1_500 });

    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message: 'Sesli videonun bırakılması 2 klip (video + ses ikizi) doğurmalıydı.',
      })
      .toBe(2);

    let st = await app.state();
    let pair = avPair(st);
    // Video, BIRAKILAN track'te; ses YENİ DOĞAN track'te.
    expect(pair.video.trackId).toBe(project.trackId);
    expect(trackIdsBefore.has(pair.audio.trackId), 'Ses track\'i bu drop\'ta DOĞMALIYDI.').toBe(false);
    // Partisyon: yeni ses şeridi EN ALTTA.
    expect(st.tracks[st.tracks.length - 1].id).toBe(pair.audio.trackId);
    expect(st.tracks[st.tracks.length - 1].type).toBe('audio');
    // İkiz: aynı zaman penceresi + ORTAK linkId + İKİSİ birden seçili.
    expect(pair.audio.timelineStartUs).toBe(pair.video.timelineStartUs);
    expect(pair.audio.timelineDurationUs).toBe(pair.video.timelineDurationUs);
    expect(pair.video.linkId, 'Çift LİNKLİ doğmalı.').toBeDefined();
    expect(pair.audio.linkId).toBe(pair.video.linkId);
    expect(st.selection.sort(), 'Ekleme İKİ klibi birden seçmeli.').toEqual(
      [pair.video.id, pair.audio.id].sort(),
    );

    // (b) TEK Ctrl+Z: iki klip de gider, doğan ses track'i de (tek mutate).
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 5_000,
        message: 'TEK undo çiftin İKİSİNİ de kaldırmalıydı (tek mutate sözü).',
      })
      .toBe(0);
    st = await app.state();
    expect(st.tracks, 'Undo doğan ses track\'ini de geri almalı.').toHaveLength(1);

    // (c) Tekrar ekle → videoyu GERÇEK fareyle sürükle → İKİSİ kayar
    // (dilim-2 taşıma kapanışının uçtan uca kanıtı, oto-doğan çiftle).
    await dragToTimeline(page, library, video.fileName, await app.timeline.point(DROP_TIME_US, 0, await app.state()));
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 10_000 })
      .toBe(2);
    st = await app.state();
    pair = avPair(st);
    const startBefore = pair.video.timelineStartUs;
    await app.timeline.dragClipByTime(pair.video.id, 3 * SECOND_US);
    st = await app.state();
    const moved = avPair(st);
    expect(moved.video.timelineStartUs, 'Video sürüklemeyle kaymalı.').toBeGreaterThan(startBefore);
    expect(
      moved.audio.timelineStartUs,
      'Bağlı ses ikizi videoyla AYNI konuma kaymalı (op-içi kapanış).',
    ).toBe(moved.video.timelineStartUs);
  });

  test('negatifler: SESSİZ video (ffmpeg -an) ve GÖRSEL tek klip kalır — ikiz yok, bağ yok, yeni track yok', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const silent = ensureSilentVideo();
    const photo = ensureTestPhoto();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E oto AV negatif',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);
    await library.pickFiles([silent.path, photo.path]);
    await library.waitForReady(silent.fileName);
    await library.waitForReady(photo.fileName);

    const before = await app.state();
    expect(before.clipCount).toBe(0);
    expect(before.tracks).toHaveLength(1);

    // (d) SESSİZ video: worker ffprobe'u hasAudio=false yazdı → TEK klip.
    await dragToTimeline(page, library, silent.fileName, await app.timeline.point(0, 0, before));
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message: 'Sessiz video timeline\'a eklenmedi.',
      })
      .toBe(1);
    let st = await app.state();
    expect(
      st.tracks.flatMap((t) => t.clips.map((c) => c.kind)),
      'Sessiz videodan ses ikizi DOĞMAMALI (hasAudio=false → tek klip).',
    ).toEqual(['video']);
    expect(st.tracks, 'Sessiz ekleme yeni track açmamalı.').toHaveLength(1);
    expect(st.tracks[0].clips[0].linkId).toBeUndefined();

    // (e) GÖRSEL: 6 sn'ye ekle (sessiz klibin dışına) → yine TEK klip.
    await dragToTimeline(page, library, photo.fileName, await app.timeline.point(6 * SECOND_US, 0, st));
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message: 'Görsel timeline\'a eklenmedi.',
      })
      .toBe(2);
    st = await app.state();
    expect(
      st.tracks.flatMap((t) => t.clips.map((c) => c.kind)).sort(),
      'Görselden de ikiz doğmamalı.',
    ).toEqual(['image', 'video']);
    expect(st.tracks).toHaveLength(1);
    expect(st.tracks[0].clips.every((c) => c.linkId === undefined)).toBe(true);
  });
});
