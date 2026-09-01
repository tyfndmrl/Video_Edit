/**
 * "Sesi ayır" × SESSİZ video — ölçülen 422 tuzağının kapısı (gerçek fare).
 *
 * Ölçülen kusur (backlog "Sesi ayır" kaydı → Playwright ile ÜRETİLDİ): ses
 * akışı olmayan bir videoda sağ tık menüsü "Sesi ayır"ı AÇIK sunuyordu
 * (`disabled=false`), gerçek tık ses klibi doğuruyordu ve POST /exports
 * HTTP 422 `asset-clip-type` ("bu videonun ses akışı yok") ile reddediyordu.
 * Kök neden: `buildClipFromAsset` her video klibinde `audio` alanını dolu
 * doğurur, yani `clip.audio` sessizliği AYIRT EDEMEZ; editör varlığın probe
 * olgusunu (`hasAudio`, API zaten dönüyordu) hiç okumuyordu.
 *
 * Bu spec iki yönü birden sabitler (ozellik-3 sonrası şekliyle):
 *  1. sessiz videoda öğe GRİ ve Türkçe gerekçe kullanıcıya asılı (title) —
 *     klip artık `audio: null` doğduğu için gerekçe düz gömülü-ses kuralıdır,
 *  2. SESLİ videoda ekleme OTOMATİK AV ayrımıyla zaten ayrılmış çift doğurur;
 *     menü "yapılacak iş kalmadı" gerekçesiyle griler (elle detach'ın canlı
 *     yolu hasAudio'su bilinmeyen seed medyasında: link-clips.spec.ts).
 *
 * KURAL (docs/review-gate.md §3): yalnız gerçek girdi — yükleme gerçek dosya
 * seçici, timeline'a alma gerçek çift tık, menü gerçek sağ tık.
 */
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

/**
 * Gerçek yükleme + işleme + çift tıkla timeline'a alma; VİDEO klibinin id'sini
 * döndürür. `expectedClips` çağıranın karar-tablosu beklentisidir (ozellik-3):
 * sessiz video 1 klip, sesli video otomatik AV ayrımıyla 2 klip doğurur.
 */
async function uploadAndPlaceOnTimeline(
  page: Page,
  account: {
    context: { request: import('@playwright/test').APIRequestContext };
    accessToken: string;
    email: string;
    password: string;
  },
  label: string,
  media: { path: string; fileName: string },
  expectedClips: number,
): Promise<{ app: EditorApp; clipId: string }> {
  const project = await createEmptyProject(account.context.request, account.accessToken, label);
  const app = new EditorApp(page);
  await app.open(project.projectId, { email: account.email, password: account.password });
  const library = new LibraryPanelHarness(page);

  await library.pickFiles([media.path]);
  await library.waitForReady(media.fileName);

  await library.doubleClickAsset(media.fileName);
  await expect
    .poll(async () => (await app.state()).clipCount, {
      timeout: 15_000,
      message: `Çift tık ${expectedClips} klip eklemeliydi (karar tablosu).`,
    })
    .toBe(expectedClips);
  const clipId = (await app.state())
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.kind === 'video')!.id;
  return { app, clipId };
}

test.describe('"Sesi ayır" — sessiz kaynak kapısı (gerçek fare)', () => {
  test('SESSİZ videoda menü öğesi GRİ ve Türkçe gerekçe görünür (422 tuzağı kapalı)', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const silent = ensureSilentVideo();
    const { app, clipId } = await uploadAndPlaceOnTimeline(
      page,
      account,
      'E2E sessiz detach',
      silent,
      1, // hasAudio=false -> karar tablosu TEK klip der (ikiz yok).
    );

    // GERÇEK sağ tık -> menü.
    await app.timeline.click(await app.timeline.clipCenter(clipId), 'right');
    await expect(app.contextMenu).toBeVisible();

    const item = page.getByTestId('timeline-menu-detachAudio');
    await expect(
      item,
      'Sessiz videoda "Sesi ayır" AÇIK sunuluyor — tuzak geri gelmiş demektir: tıklanınca doğan ' +
        'ses klibi export\'ta 422 `asset-clip-type` alır (ölçüldü).',
    ).toBeDisabled();
    // Gerekçe op'un kendi ret kodudur ve kullanıcıya Türkçesi asılıdır (title).
    // ozellik-3'ten beri kesin-sessiz kaynakta klip `audio: null` DOĞAR
    // (buildClipFromAsset), yani ÖNCE gömülü-ses kuralı konuşur; eski
    // 'source has no audio stream' dalı yalnız legacy (audio dolu) kliplerde
    // yaşar ve birim testte pinlidir (clipPropertyOps.test.ts).
    await expect(item).toHaveAttribute('data-block-reason', 'clip has no embedded audio');
    await expect(item).toHaveAttribute(
      'title',
      'Klipte gömülü ses yok (zaten ayrılmış olabilir)',
    );

    // Gri öğe hiçbir şey üretmez: doküman tek (video) klipte kalır.
    await page.keyboard.press('Escape');
    const st = await app.state();
    expect(st.clipCount).toBe(1);
    expect(st.tracks.flatMap((t) => t.clips.map((c) => c.kind))).toEqual(['video']);
  });

  test('SESLİ videoda ekleme ZATEN ayrılmış çift doğurur; menü "Sesi ayır"ı doğru gerekçeyle griler', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const voiced = ensureTestVideo();
    // ozellik-3: hasAudio=true kaynakta çift tık OTOMATİK AV ayrımı yapar —
    // "Sesi ayır"ın el ile yapacağı işi ekleme kendisi yapmış olur (2 klip).
    const { app, clipId } = await uploadAndPlaceOnTimeline(
      page,
      account,
      'E2E sesli detach',
      voiced,
      2,
    );

    const after = await app.state();
    const kinds = after.tracks
      .flatMap((t) => t.clips.map((c) => ({ kind: c.kind, trackType: t.type })))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(kinds).toEqual([
      { kind: 'audio', trackType: 'audio' },
      { kind: 'video', trackType: 'video' },
    ]);
    // Çift BAĞLI doğar — iki klipte aynı taze linkId (detach formülü).
    const clips = after.tracks.flatMap((t) => t.clips);
    expect(clips[0].linkId).toBeDefined();
    expect(clips.every((c) => c.linkId === clips[0].linkId)).toBe(true);

    // Menü: gömülü ses ikize taşındığı için "Sesi ayır" DOĞRU gerekçeyle gri —
    // yanlış ret değil, yapılacak iş kalmadığının beyanı. (Elle detach'ın canlı
    // yolu hasAudio'su ölçülmemiş seed medyasında sürüyor: link-clips.spec.ts.)
    await app.timeline.click(await app.timeline.clipCenter(clipId), 'right');
    await expect(app.contextMenu).toBeVisible();
    const item = page.getByTestId('timeline-menu-detachAudio');
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute('data-block-reason', 'clip has no embedded audio');

    // Gri öğe hiçbir şey üretmez: klip sayısı 2'de kalır.
    await page.keyboard.press('Escape');
    expect((await app.state()).clipCount).toBe(2);
  });
});
