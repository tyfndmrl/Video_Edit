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
 * Bu spec iki yönü birden sabitler:
 *  1. sessiz videoda öğe GRİ ve Türkçe gerekçe kullanıcıya asılı (title),
 *  2. SESLİ videoda öğe hâlâ AÇIK ve gerçekten çalışıyor — bilinmeyen/sesli
 *     kaynağı da griletmek yanlış ret olurdu (yanlış yönde "düzeltme" bekçisi).
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

/** Gerçek yükleme + işleme + çift tıkla timeline'a alma; klip id'sini döndürür. */
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
      message: 'Çift tık videoyu timeline\'a EKLEMEDİ.',
    })
    .toBe(1);
  const clipId = (await app.state()).tracks.flatMap((t) => t.clips)[0].id;
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
    await expect(item).toHaveAttribute('data-block-reason', 'source has no audio stream');
    await expect(item).toHaveAttribute(
      'title',
      'Kaynak videoda ses akışı yok (sessiz video) — ayrılacak ses yok',
    );

    // Gri öğe hiçbir şey üretmez: doküman tek (video) klipte kalır.
    await page.keyboard.press('Escape');
    const st = await app.state();
    expect(st.clipCount).toBe(1);
    expect(st.tracks.flatMap((t) => t.clips.map((c) => c.kind))).toEqual(['video']);
  });

  test('SESLİ videoda "Sesi ayır" hâlâ AÇIK ve gerçekten ayırıyor (yanlış ret yok)', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const voiced = ensureTestVideo();
    const { app, clipId } = await uploadAndPlaceOnTimeline(
      page,
      account,
      'E2E sesli detach',
      voiced,
    );

    await app.timeline.click(await app.timeline.clipCenter(clipId), 'right');
    await expect(app.contextMenu).toBeVisible();

    const item = page.getByTestId('timeline-menu-detachAudio');
    await expect(
      item,
      'SESLİ videoda "Sesi ayır" grilendi — sessiz-kaynak kapısı yanlış yöne taşmış: ' +
        'kapı yalnız KESİN hasAudio=false üzerinde engel kurmalı.',
    ).toBeEnabled();

    // GERÇEK tık: video klibi resmini korur, ses klibi ses track'ine doğar.
    await item.click();
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 10_000,
        message: '"Sesi ayır" tıklandı ama ses klibi doğmadı.',
      })
      .toBe(2);
    const after = await app.state();
    const kinds = after.tracks
      .flatMap((t) => t.clips.map((c) => ({ kind: c.kind, trackType: t.type })))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(kinds).toEqual([
      { kind: 'audio', trackType: 'audio' },
      { kind: 'video', trackType: 'video' },
    ]);
    // ozellik-2: ayrılan çift BAĞLI doğar — iki klipte aynı taze linkId.
    const clips = after.tracks.flatMap((t) => t.clips);
    expect(clips[0].linkId).toBeDefined();
    expect(clips.every((c) => c.linkId === clips[0].linkId)).toBe(true);
  });
});
