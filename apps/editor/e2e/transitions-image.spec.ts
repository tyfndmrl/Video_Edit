/**
 * Slayt gösterisi geçişi — GERÇEK fareyle (page.mouse.*), uçtan uca.
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * M4 dalga 2 denetim bulgusu (YÜKSEK): editör ve şema D/2 KAYNAK PAYINI her
 * medya klibine uyguluyordu. Görsel klip `sourceIn = 0, sourceOut = 4 sn` ile
 * doğar — yani payı DAİMA sıfırdır — dolayısıyla iki fotoğrafın arasına geçiş
 * eklemek "no room for a transition" ile reddediliyordu: rozet düzenleyiciyi
 * açmıyor, menü öğesi gri kalıyordu. Oysa export compiler görseli AÇIKÇA muaf
 * tutuyor (`ExportClipPlan.IsStillInput`): dosyada zaman ekseni yoktur, `-loop 1`
 * pencerenin istediği kadar kare üretir. Yani ürün, renderer'ının desteklediği
 * EN YAYGIN geçiş kullanımını (slayt gösterisi) yapamıyordu.
 *
 * Birim testler üç katmanın (invariants / timelineOps / compiler) hizalandığını
 * gösteriyor; burada kanıtlanan şey KULLANICININ o yolu gerçekten yürüyebildiği:
 * kesim rozetine gerçek tıklama → tip seçimi → dokümanda simetrik geçiş.
 *
 * Doküman ön koşulu (iki bitişik GÖRSEL klip) API üzerinden seed edilir —
 * transitions.spec.ts'teki klipler de öyle gelir; jestin kendisi gerçektir.
 */
import {
  frameToUs,
  usToFrame,
  validateTimelineDoc,
  type Rational,
  type TimelineDoc,
} from '@videoedit/timeline-schema';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { readProjectSettings } from './support/appBridge';
import { TRACK_H } from '../src/features/timeline/geometry';
import { SECOND_US, createProject, saveTimeline } from './fixtures/seed';

/** Rozet, şeridin ALTINDA duruyor (geometry.ts TRANSITION_BADGE_*). */
const BADGE_H = 14;
const BADGE_BOTTOM_GAP = 3;

/** Editörün `addClipFromAsset` ile ürettiği görsel klip süresi. */
const IMAGE_DURATION_US = 4 * SECOND_US;

/** Klipler geç bir zamanda durur (auto-fit'e bağımlı kalmamak için ensureContentVisible). */
const START_US = 60 * SECOND_US;

interface DocClip {
  id: string;
  kind: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  sourceInUs?: number;
  transitionIn?: { type: string; durationUs: number };
  transitionOut?: { type: string; durationUs: number };
}

async function readDoc(page: Page): Promise<TimelineDoc> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    return JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as TimelineDoc;
  });
}

function clipOf(doc: TimelineDoc, clipId: string): DocClip {
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip as unknown as DocClip;
  }
  throw new Error(`Klip dokümanda yok: ${clipId}`);
}

function expectDocValid(doc: TimelineDoc, context: string): void {
  const result = validateTimelineDoc(doc, new Map<string, number>());
  if (!result.success) {
    throw new Error(
      `${context}: editörün yazdığı doküman kendi invariant'larından geçmiyor:\n  ` +
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  '),
    );
  }
}

/**
 * İki BİTİŞİK görsel klip — `addClipFromAsset`'in ürettiği şeklin birebir
 * aynısı: kind 'image', sourceIn 0, sourceOut = süre, audio null.
 */
function buildSlideshowDoc(projectId: string): {
  timeline: unknown;
  clipAId: string;
  clipBId: string;
} {
  const clipAId = crypto.randomUUID();
  const clipBId = crypto.randomUUID();
  const imageClip = (id: string, startUs: number) => ({
    id,
    kind: 'image',
    assetId: crypto.randomUUID(),
    timelineStartUs: startUs,
    timelineDurationUs: IMAGE_DURATION_US,
    sourceInUs: 0,
    sourceOutUs: IMAGE_DURATION_US,
    speed: { rate: 1 },
    audio: null,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  });
  return {
    clipAId,
    clipBId,
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
            imageClip(clipAId, START_US),
            imageClip(clipBId, START_US + IMAGE_DURATION_US),
          ],
        },
      ],
      markers: [],
    },
  };
}

test.describe('Görsel klipler arası geçiş — gerçek fare', () => {
  test('iki fotoğrafın kesimine tıklayıp crossfade eklenebilir', async ({ editor, seed }) => {
    test.skip(seed.external, 'Hazır proje modunda kendi dokümanımızı seed edemeyiz.');

    // Ön koşul: iki bitişik GÖRSEL klipten oluşan taze bir proje.
    const project = await createProject(
      editor.page.request,
      seed.accessToken,
      `E2E slayt ${Date.now().toString(36)}`,
    );
    const slideshow = buildSlideshowDoc(project.id);
    await saveTimeline(
      editor.page.request,
      seed.accessToken,
      project.id,
      slideshow.timeline,
      project.revisionNumber,
    );
    await editor.open(project.id, { email: seed.email, password: seed.password });
    await editor.ensureContentVisible(slideshow.clipAId);

    const before = await readDoc(editor.page);
    const a0 = clipOf(before, slideshow.clipAId);
    const b0 = clipOf(before, slideshow.clipBId);
    expect(a0.kind, 'Ön koşul: klipler GÖRSEL olmalı.').toBe('image');
    expect(b0.sourceInUs, 'Ön koşul: görselin kaynak payı YOKTUR (bulgunun çekirdeği).').toBe(0);
    const cutUs = a0.timelineStartUs + a0.timelineDurationUs;
    expect(b0.timelineStartUs, 'Ön koşul: klipler bitişik olmalı.').toBe(cutUs);

    // GERÇEK tıklama: kesim rozeti -> geçiş düzenleyicisi açılmalı.
    const box = await editor.timeline.clipBox(slideshow.clipAId);
    await editor.timeline.click({
      x: box.x + box.width,
      y: box.y + TRACK_H - BADGE_BOTTOM_GAP - BADGE_H / 2,
    });
    await expect(
      editor.page.getByTestId('transition-editor'),
      'Görsel kesimde rozet düzenleyiciyi AÇMALI — eskiden "pay yok" diye reddediliyordu.',
    ).toBeVisible();

    await editor.page.getByTestId('transition-type-crossfade').click();
    await editor.page.waitForTimeout(150);

    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;
    const doc = await readDoc(editor.page);
    const a = clipOf(doc, slideshow.clipAId);
    const b = clipOf(doc, slideshow.clipBId);

    expect(a.transitionOut, 'Giden görselde transitionOut olmalı.').toBeDefined();
    expect(a.transitionOut, 'Simetri (§5.2): iki taraf derin-eşit.').toEqual(b.transitionIn);
    expect(a.transitionOut!.type).toBe('crossfade');

    // Kaynak payı muafiyeti PAY DIŞINDAKİ kuralları gevşetmez.
    const durationUs = a.transitionOut!.durationUs;
    const frames = usToFrame(durationUs, fps);
    expect(frameToUs(frames, fps), 'Süre proje kare ızgarasında olmalı.').toBe(durationUs);
    expect(frames % 2, 'Kare sayısı ÇİFT olmalı (D/2 tam kare).').toBe(0);
    expect(durationUs * 2, 'D*2 kısa komşunun süresini aşamaz.').toBeLessThanOrEqual(
      Math.min(a.timelineDurationUs, b.timelineDurationUs),
    );
    expect(b.sourceInUs, 'Görselin sourceIn\'i DEĞİŞMEMELİ (pay kavramı yok).').toBe(0);

    expectDocValid(doc, 'Görsel geçişi eklendikten sonra');
    // Geçiş metadata'dır: kesim yerinde durur (§5.1).
    expect(a.timelineStartUs + a.timelineDurationUs).toBe(cutUs);
    expect(b.timelineStartUs).toBe(cutUs);

    // Sağ tık menüsü de aynı yorumu göstermeli: artık "kaldır" aktif.
    await editor.timeline.click(
      { x: box.x + box.width - 20, y: box.y + TRACK_H / 2 },
      'right',
    );
    await expect(editor.contextMenu).toBeVisible();
    await expect(
      editor.page
        .locator('[data-testid="timeline-context-menu"] button')
        .filter({ hasText: /geçişi kaldır/i })
        .first(),
    ).toBeEnabled();
    await editor.page.keyboard.press('Escape');
  });
});
