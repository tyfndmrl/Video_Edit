/**
 * EditorApp — sayfayı açan / hazır olmasını bekleyen ince kabuk + yeni
 * özelliklerin UI SÖZLEŞMESİ (locator'lar tek yerde).
 *
 * Sözleşme notu: aşağıdaki `data-testid`'ler paralel çalışan ajanların
 * yazdığı özellikler için beklenen isimlerdir. Her locator'ın bir de
 * testid'siz YEDEĞİ (rol/başlık/metin) vardır; böylece testid eklenmese bile
 * özellik gerçekten varsa test yeşil olur, YOKSA kırmızı — istenen davranış.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { installAppBridge, readAppState, type BridgeSource } from './appBridge';
import { TimelineHarness } from './timeline';

export class EditorApp {
  readonly timeline: TimelineHarness;
  /** Store köprüsünün hangi katmandan kurulduğu (bkz. support/appBridge.ts). */
  bridgeSource: BridgeSource | null = null;

  constructor(readonly page: Page) {
    this.timeline = new TimelineHarness(page);
  }

  /**
   * ?project=<id> derin bağlantısıyla editörü açar ve proje oturumu 'ready'
   * olana kadar bekler. Refresh cookie context'te olduğu için giriş formu
   * normalde görünmez; görünürse GERÇEK klavye/fare ile giriş yapılır (cookie
   * politikası değişirse test opak biçimde düşmesin).
   */
  async open(projectId: string, credentials: { email: string; password: string }): Promise<void> {
    await this.page.goto(`/?project=${projectId}`);

    const loginSubmit = this.page.getByTestId('auth-submit');
    const raced = await Promise.race([
      loginSubmit.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'login' as const),
      this.page
        .locator('canvas')
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .then(() => 'editor' as const),
    ]).catch(() => 'unknown' as const);

    if (raced === 'login') {
      await this.page.getByTestId('auth-email').click();
      await this.page.keyboard.type(credentials.email);
      await this.page.getByTestId('auth-password').click();
      await this.page.keyboard.type(credentials.password);
      await loginSubmit.click();
    }

    await this.page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });
    // installAppBridge KURAR ve CANLILIĞINI DOĞRULAR (oturum 'ready' + doküman
    // dolu). Eskiden buradaki ayrı `waitForFunction` ölü bir köprüde 30 sn
    // sonra opak biçimde düşüyordu; artık hangi katmanın kullanıldığı hatanın
    // içinde yazıyor.
    this.bridgeSource = await installAppBridge(this.page);
    await expect(this.page.getByTestId('timeline-loading-overlay')).toHaveCount(0);
    // İlk çizim + fit efekti için bir kare.
    await this.page.waitForTimeout(250);
  }

  async state() {
    return readAppState(this.page);
  }

  // -------------------------------------------------------------------
  // UI sözleşmesi
  // -------------------------------------------------------------------

  /** "Sığdır" düğmesi (mevcut özellik, TimelinePanel başlığında). */
  get fitButton(): Locator {
    return this.page.getByRole('button', { name: /Sığdır/i });
  }

  /** Geri al / Yinele (TopBar, mevcut). */
  get undoButton(): Locator {
    return this.page.getByRole('button', { name: /Geri al/i });
  }

  get redoButton(): Locator {
    return this.page.getByRole('button', { name: /Yinele/i });
  }

  /** YENİ: timeline sağ tık menüsü. */
  get contextMenu(): Locator {
    return this.page.locator('[data-testid="timeline-context-menu"], [role="menu"]').first();
  }

  contextMenuItem(name: RegExp): Locator {
    return this.contextMenu.getByText(name).first();
  }

  /**
   * YENİ: işlem geçmişi paneli (docStore.jumpTo tüketicisi).
   * Uygulanan sözleşme: Inspector içinde DAİMA görünür bir bölüm,
   * "İşlem Geçmişi" başlığı + satır başına bir <button> (ters kronolojik,
   * en altta "Başlangıç" temel satırı).
   */
  get historyPanel(): Locator {
    return this.page
      .locator('[data-testid="history-panel"]')
      .or(
        this.page
          .locator('section')
          .filter({ has: this.page.getByRole('heading', { name: /İşlem Geçmişi/i }) }),
      )
      .first();
  }

  /**
   * Panel bir toggle'ın arkasındaysa açar; her zaman görünürse hiçbir şey
   * yapmaz (mevcut uygulama: Inspector'da sabit bölüm).
   */
  async openHistoryPanel(): Promise<void> {
    const toggle = this.page
      .locator('[data-testid="history-toggle"]')
      .or(this.page.getByRole('button', { name: /geçmişi (aç|göster)/i }))
      .first();
    if ((await toggle.count()) > 0 && (await toggle.isVisible())) {
      await toggle.click();
    }
  }

  /** Panel satırları (0 = en yeni). */
  historyEntry(index: number): Locator {
    return this.historyPanel.getByRole('button').nth(index);
  }

  /** Etiketiyle bir geçmiş satırı ("Başlangıç", "Klip taşındı", ...). */
  historyEntryByLabel(name: RegExp): Locator {
    return this.historyPanel.getByRole('button').filter({ hasText: name }).first();
  }

  /**
   * YENİ: çakışma/geçersiz işlem geri bildirimi. Sessiz ret kullanıcı
   * şikayetinin ta kendisiydi — bırakma anında görünür bir uyarı beklenir.
   */
  get warningToast(): Locator {
    return this.page
      .locator('[data-testid="timeline-warning"], [data-testid="timeline-toast"]')
      .or(this.page.locator('[role="alert"], [role="status"]').filter({ hasText: /çakış/i }))
      .first();
  }

  /**
   * Etkileşim testlerinin ön koşulu: ilk klip ekranda olsun. Auto-fit
   * özelliği çalışıyorsa hiçbir şey yapmaz; çalışmıyorsa GERÇEK fareyle
   * "Sığdır" düğmesine basar. Böylece auto-fit testi (autofit.spec.ts) tek
   * başına kırmızı olur, diğer 7 test onun rehinesi olmaz.
   */
  async ensureContentVisible(clipId: string): Promise<void> {
    const box = await this.timeline.clipBox(clipId);
    const wrap = await this.timeline.wrapBox();
    const visible = box.x >= wrap.x && box.x + box.width <= wrap.x + wrap.width;
    if (visible) return;
    await this.fitButton.click();
    await this.page.waitForTimeout(150);
  }
}
