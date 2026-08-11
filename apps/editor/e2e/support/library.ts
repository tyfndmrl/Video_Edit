/**
 * library — Kitaplık paneli üzerinde GERÇEK kullanıcı jestleri.
 *
 * Dosya seçimi `fileChooser` üzerinden yapılır: "Dosya seç" düğmesine GERÇEK
 * fareyle basılır, tarayıcının açtığı dosya seçici olayı yakalanır ve dosya
 * ORAYA verilir. Gizli input'a doğrudan setInputFiles yazmak seçici zincirini
 * (düğme -> input.click() -> change) atlar; tam da bu zincir kırılabilir.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/test';

/** Yükleme + worker işleme için varsayılan üst sınır (worker AYAKTA varsayımı). */
export const ASSET_READY_TIMEOUT_MS = 180_000;

/**
 * Asset "Sırada" durumundan bu süre içinde çıkmazsa işi kimse ALMAMIŞ demektir
 * -> medya worker'ı ayakta değil. Hangfire yerelde işi anında kapar; 60 sn
 * fazlasıyla cömert bir pay.
 */
const QUEUE_PICKUP_GRACE_MS = 60_000;

const WORKER_DOWN_MESSAGE =
  'Medya worker\'ı (VideoEdit.Worker) çalışmıyor görünüyor: asset yüklendi ama ' +
  `${QUEUE_PICKUP_GRACE_MS / 1000} sn boyunca "Sırada" durumundan çıkmadı (kimse işi almadı). ` +
  'Gerçek medya testi atlandı — çalıştırmak için worker\'ı başlatın: ' +
  'dotnet run --project backend/src/VideoEdit.Worker';

export class LibraryPanelHarness {
  constructor(private readonly page: Page) {}

  get dropZoneButton(): Locator {
    return this.page.getByRole('button', { name: 'Dosya seç' });
  }

  /** Yükleme kartı VEYA sunucu listesi satırı — dosya adını taşıyan kutu. */
  row(fileName: string): Locator {
    return this.page.locator('aside').filter({ hasText: 'Kitaplık' }).locator('li').filter({
      has: this.page.getByTitle(fileName, { exact: true }),
    });
  }

  /** Sunucu listesindeki hazır asset satırı (rozet metniyle birlikte). */
  readyBadge(fileName: string): Locator {
    return this.row(fileName).getByText('Hazır', { exact: true });
  }

  /** Desteklenmeyen format / diğer reddetme mesajları. */
  get rejectionMessages(): Locator {
    return this.page.locator('li.text-danger');
  }

  /** Kartın üstünde beliren geçici uyarı (ör. yinelenen dosya). */
  warning(text: string | RegExp): Locator {
    return this.page.getByText(text);
  }

  /**
   * GERÇEK tıklama -> dosya seçici -> dosya(lar). Seçici olayına tıklamadan
   * ÖNCE abone olunur (aksi halde yarış: seçici tıklamayla aynı turda açılır).
   */
  async pickFiles(paths: string[]): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser', { timeout: 15_000 });
    const box = await this.dropZoneButton.boundingBox();
    expect(box, '"Dosya seç" düğmesi görünmüyor.').not.toBeNull();
    await this.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.up();
    const fileChooser = await chooser;
    await fileChooser.setFiles(paths);
  }

  /**
   * Yükleme + sunucu tarafı işleme bitene kadar bekler ("Hazır" rozeti).
   *
   * Üç sonucu BİRBİRİNDEN AYIRIR — çünkü "worker kapalı" ile "worker bozuk"
   * aynı şey değildir ve ikisini de aynı torbaya atmak ya sahte yeşil ya da
   * yanıltıcı kırmızı üretir:
   *  - "Başarısız" rozeti  -> ANINDA kırmızı (sunucu tarafı gerçek hata),
   *  - "Sırada"dan hiç çıkmadı -> SKIP (işi alan yok = worker ayakta değil),
   *  - "İşleniyor"a geçti ama bitmedi -> kırmızı (worker AYAKTA ve takıldı).
   */
  async waitForReady(fileName: string, timeoutMs = ASSET_READY_TIMEOUT_MS): Promise<void> {
    const row = this.row(fileName);
    const deadline = Date.now() + timeoutMs;
    /** Kuyruk sayacının başlangıcı — yükleme sürerken sürekli ileri itilir. */
    let queueClock = Date.now();
    let leftQueue = false;

    for (;;) {
      const text = ((await row.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
      if (text.includes('Hazır')) return;
      if (text.includes('Başarısız')) {
        throw new Error(`"${fileName}" sunucu tarafında BAŞARISIZ oldu — kart metni: "${text}"`);
      }
      if (text.includes('İşleniyor')) leftQueue = true;
      // Hâlâ yükleme kartındayız (byte'lar akıyor): kuyruk sayacı işlemez.
      if (/Yükleniyor|Başlatılıyor|Tamamlanıyor|Duraklatıldı/.test(text)) queueClock = Date.now();

      if (!leftQueue && Date.now() - queueClock > QUEUE_PICKUP_GRACE_MS) {
        test.skip(true, WORKER_DOWN_MESSAGE);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `"${fileName}" için "Hazır" rozeti ${timeoutMs} ms içinde gelmedi. ` +
            `Worker işi ALDI (işleme başladı) ama bitmedi — son kart metni: "${text}"`,
        );
      }
      await this.page.waitForTimeout(500);
    }
  }

  /** Satırın ikinci satırındaki meta metni ("00:00:04:00 · 640×480 · 1,7 MB"). */
  async metaText(fileName: string): Promise<string> {
    return (await this.row(fileName).locator('div.truncate').last().innerText()).trim();
  }

  /** Asset satırına GERÇEK çift tık — timeline'a ekleme yedek yolu. */
  async doubleClickAsset(fileName: string): Promise<void> {
    const box = await this.row(fileName).boundingBox();
    expect(box, `Kitaplıkta "${fileName}" satırı yok.`).not.toBeNull();
    await this.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await this.page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await this.page.waitForTimeout(200);
  }
}

interface AssetListItem {
  id: string;
  fileName: string;
  status: string;
  durationMicros?: number;
  width?: number;
  height?: number;
}

/** Projedeki asset'leri API'den okur (assetId'yi doküman iddialarında kullanmak için). */
export async function listProjectAssets(
  request: import('@playwright/test').APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<AssetListItem[]> {
  const res = await request.get(`/api/projects/${projectId}/assets?page=1&pageSize=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok()) throw new Error(`Asset listesi alınamadı (HTTP ${res.status()})`);
  return ((await res.json()) as { items: AssetListItem[] }).items;
}
