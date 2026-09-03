/**
 * TimelineHarness — canvas timeline üzerinde GERÇEK fare jestleri.
 *
 * KURAL: burada `page.mouse.*` / `page.keyboard.*` dışında hiçbir olay üretimi
 * yoktur. `dispatchEvent`, `element.click()` gibi sentetik yollar bilinçli
 * olarak KULLANILMAZ — kullanıcının şikayet ettiği hatalar tam olarak sentetik
 * testlerin göremediği hatalardı (pointer capture, buton maskesi, wheel
 * modifier'ları, contextmenu zinciri).
 *
 * Piksel geometrisi uygulamanın KENDİ geometry modülünden gelir (tek kaynak):
 * xPx = (timeUs - scrollUs) * pxPerUs, satır yüksekliği TRACK_H + TRACK_GAP.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { RULER_H, TRACK_H, TRACK_GAP } from '../../src/features/timeline/geometry';
import { TIMELINE_HEIGHT_STORAGE_KEY } from '../../src/features/timeline/timelineHeight';
import { findClip, readAppState, type AppState } from './appBridge';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Sürüklemede kullanılan ara adım sayısı — gerçek fare gibi kademeli hareket. */
const DRAG_STEPS = 16;

export class TimelineHarness {
  constructor(private readonly page: Page) {}

  /**
   * Canvas yığınını saran öğenin ekran kutusu. Öncelik `data-testid`; yoksa
   * "içinde 3 canvas barındıran div" (ruler + body + overlay) sezgisi.
   */
  async wrapBox(): Promise<Box> {
    const box = await this.page.evaluate(() => {
      const tagged = document.querySelector('[data-testid="timeline-canvas"]');
      const wrap =
        tagged ??
        [...document.querySelectorAll('div')].find(
          (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
        );
      if (!wrap) return null;
      const r = wrap.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    expect(box, 'Timeline canvas sarmalayıcısı bulunamadı (3 canvas içeren div).').not.toBeNull();
    return box as Box;
  }

  async state(): Promise<AppState> {
    return readAppState(this.page);
  }

  // ---------------------------------------------------------------------
  // Dikey boyutlandırma (panel-2b)
  // ---------------------------------------------------------------------

  /** Timeline'ı barındıran grid hücresi (yükseklik sözleşmesinin ölçüldüğü kutu). */
  async sectionBox(): Promise<Box> {
    const box = await this.page.evaluate(() => {
      const el = document.getElementById('timeline-section');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    expect(box, 'Timeline grid hücresi bulunamadı (#timeline-section).').not.toBeNull();
    return box as Box;
  }

  /** Boyutlandırma tutamağı (role="separator"). */
  resizeHandle(): Locator {
    return this.page.locator('[data-testid="timeline-resize-handle"]');
  }

  async resizeHandleBox(): Promise<Box> {
    const box = await this.resizeHandle().boundingBox();
    expect(box, 'Boyutlandırma tutamağı görünür değil.').not.toBeNull();
    return box as Box;
  }

  /**
   * Tutamağı `dy` piksel sürükler (negatif = YUKARI = timeline büyür).
   * Gerçek fare: bas -> kademeli hareket -> bırak.
   */
  async dragHandleBy(dy: number): Promise<void> {
    const box = await this.resizeHandleBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    // İlk küçük hareket (jest tanınsın), sonra kademeli tam mesafe.
    await this.page.mouse.move(from.x, from.y + Math.sign(dy || 1) * 4, { steps: 2 });
    await this.page.mouse.move(from.x, from.y + dy, { steps: DRAG_STEPS });
    await this.page.mouse.move(from.x, from.y + dy);
    await this.page.mouse.up();
    await this.settle();
  }

  /**
   * Kalıcı yükseklik anahtarını SİLER. E2E context'i worker-scope olduğu için
   * localStorage spec'ler ARASINDA yaşar: yükseklik tercihini bırakan bir
   * spec, sonraki spec'lerin timeline geometrisini sessizce değiştirirdi.
   */
  static async clearStoredHeight(page: Page): Promise<void> {
    await page.evaluate((key: string) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // Engellenmiş depolama: silinecek bir şey de yok.
      }
    }, TIMELINE_HEIGHT_STORAGE_KEY);
  }

  /** Kalıcı yükseklik anahtarının ham değeri (yoksa null). */
  static async readStoredHeight(page: Page): Promise<string | null> {
    return page.evaluate((key: string) => {
      try {
        return localStorage.getItem(key);
      } catch {
        // Engellenmiş depolama: okunamayan değer "yok" sayılır.
        return null;
      }
    }, TIMELINE_HEIGHT_STORAGE_KEY);
  }

  /**
   * Gövde canvas'ının piksel imzası (toDataURL üzerinden ucuz hash).
   *
   * Seçili klip için canvas DIŞINDA bir DOM göstergesi yok (seçim çerçevesi
   * canvas'a çiziliyor), bu yüzden "UI gerçekten tepki verdi mi?" sorusunun
   * store'dan bağımsız tek yanıtı budur: imza değiştiyse timeline yeniden
   * boyanmıştır.
   */
  async bodySignature(): Promise<string> {
    const sig = await this.page.evaluate(() => {
      const tagged = document.querySelector('[data-testid="timeline-canvas"]');
      const wrap =
        tagged ??
        [...document.querySelectorAll('div')].find(
          (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
        );
      if (!wrap) return null;
      // Canvas sırası: ruler, body, overlay (TimelinePanel render'ı).
      const body = wrap.querySelectorAll('canvas')[1] as HTMLCanvasElement | undefined;
      if (!body) return null;
      const url = body.toDataURL('image/png');
      let h = 0;
      for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
      return `${url.length}:${h}`;
    });
    expect(sig, 'Timeline gövde canvas\'ı okunamadı.').not.toBeNull();
    return sig as string;
  }

  /** Zaman + track satırı -> sayfa koordinatı (canvas gövdesi içinde). */
  async point(timeUs: number, trackIndex: number, state?: AppState): Promise<{ x: number; y: number }> {
    const st = state ?? (await this.state());
    const wrap = await this.wrapBox();
    return {
      x: wrap.x + (timeUs - st.scrollUs) * st.pxPerUs,
      y: wrap.y + RULER_H + trackIndex * (TRACK_H + TRACK_GAP) + TRACK_H / 2,
    };
  }

  /** Cetvel (ruler) üzerinde bir zamanın sayfa koordinatı. */
  async rulerPoint(timeUs: number, state?: AppState): Promise<{ x: number; y: number }> {
    const st = state ?? (await this.state());
    const wrap = await this.wrapBox();
    return { x: wrap.x + (timeUs - st.scrollUs) * st.pxPerUs, y: wrap.y + RULER_H / 2 };
  }

  /** Klibin ekrandaki kutusu (sol kenar, genişlik dahil). */
  async clipBox(clipId: string, state?: AppState): Promise<Box> {
    const st = state ?? (await this.state());
    const { clip, trackIndex } = findClip(st, clipId);
    const wrap = await this.wrapBox();
    return {
      x: wrap.x + (clip.timelineStartUs - st.scrollUs) * st.pxPerUs,
      y: wrap.y + RULER_H + trackIndex * (TRACK_H + TRACK_GAP),
      width: clip.timelineDurationUs * st.pxPerUs,
      height: TRACK_H,
    };
  }

  /** Klibin gövde ortası (trim tutamaklarından uzak). */
  async clipCenter(clipId: string, state?: AppState): Promise<{ x: number; y: number }> {
    const box = await this.clipBox(clipId, state);
    return { x: box.x + box.width / 2, y: box.y + TRACK_H / 2 };
  }

  // ---------------------------------------------------------------------
  // Gerçek fare jestleri
  // ---------------------------------------------------------------------

  async click(point: { x: number; y: number }, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await this.page.mouse.move(point.x, point.y);
    await this.page.mouse.down({ button });
    await this.page.mouse.up({ button });
    await this.settle();
  }

  /** Olay -> store -> rAF çizim zinciri tamamlansın. */
  private async settle(): Promise<void> {
    await this.page.waitForTimeout(120);
  }

  /**
   * Basılı tut + kademeli hareket + bırak. Ara hareketler şart: TimelinePanel
   * 4 px sürükleme eşiğinden sonra "pendingClip -> move" terfisi yapar ve
   * bırakma anında SON pointermove'daki plana göre commit eder.
   */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    button: 'left' | 'middle' = 'left',
  ): Promise<void> {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down({ button });
    // Eşiği aşan ilk küçük hareket (jest "sürükleme" olarak tanınsın).
    await this.page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 6, from.y, { steps: 2 });
    await this.page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
    // Son konumu bir kez daha teyit et (yuvarlama/rAF gecikmesine karşı).
    await this.page.mouse.move(to.x, to.y);
    await this.page.mouse.up({ button });
    await this.settle();
  }

  /** Klibi gövdesinden yakalayıp verilen süre kadar öteler (opsiyonel track değişimi). */
  async dragClipByTime(clipId: string, deltaUs: number, trackDelta = 0): Promise<void> {
    const st = await this.state();
    const from = await this.clipCenter(clipId, st);
    const to = {
      x: from.x + deltaUs * st.pxPerUs,
      y: from.y + trackDelta * (TRACK_H + TRACK_GAP),
    };
    await this.drag(from, to);
  }

  /**
   * Sağ kenardan (trim tutamağı) sürükleyerek kırpma — GÖRELİ.
   *
   * Nicel iddia kuran testler `dragRightEdgeToTime`i tercih etmeli: burada
   * yakalama noktası kenardan 3 px içeride olduğu için sonuç, istenen deltadan
   * o 3 pikselin zaman karşılığı kadar sapar.
   */
  async dragRightEdgeByTime(clipId: string, deltaUs: number): Promise<void> {
    const st = await this.state();
    const box = await this.clipBox(clipId, st);
    const from = { x: box.x + box.width - 3, y: box.y + TRACK_H / 2 };
    await this.drag(from, { x: from.x + deltaUs * st.pxPerUs, y: from.y });
  }

  /**
   * Sağ kenardan (trim tutamağı) sürükleyip klibin sonunu HEDEF ZAMANA taşır.
   *
   * Neden "hedef zaman", "delta" değil: kırpma imlecin BULUNDUĞU zamanı yeni
   * kenar yapar (TimelinePanel `xToTime(x)` -> `applyTrimToDraft`), yakalama
   * noktasının kenardan kaç piksel içeride olduğu sonucu etkilemez. Hedefi
   * doğrudan vermek, testin BEKLENEN DEĞERİ (frame ızgarasına oturmuş hedef)
   * hesaplayabilmesini sağlar — "kısaldı mı?" yerine "tam olarak buraya mı?".
   */
  async dragRightEdgeToTime(clipId: string, targetEndUs: number): Promise<void> {
    const st = await this.state();
    const box = await this.clipBox(clipId, st);
    const wrap = await this.wrapBox();
    // Tutamak genişliği min(8, w/3); 3 px içeriden yakala.
    const from = { x: box.x + box.width - 3, y: box.y + TRACK_H / 2 };
    const to = { x: wrap.x + (targetEndUs - st.scrollUs) * st.pxPerUs, y: from.y };
    await this.drag(from, to);
  }

  /** `px` piksellik konum belirsizliğinin mikrosaniye karşılığı (tolerans hesabı). */
  static pxToUs(px: number, pxPerUs: number): number {
    return px / pxPerUs;
  }

  /** Cetvele gerçek tıklama -> playhead o zamana gider (scrub). */
  async scrubTo(timeUs: number): Promise<void> {
    await this.click(await this.rulerPoint(timeUs));
  }

  /**
   * Ctrl+wheel: imleç çapalı zoom. Modifier gerçek klavye durumundan gelir.
   *
   * `settle()` ŞART: `page.mouse.wheel` olayın İŞLENMESİNİ beklemez
   * ("does not wait for the scroll to finish"). Beklemeden okunan store, wheel
   * ÖNCESİ pxPerUs'u verebilir — bu yarış nicel iddialarda gerçek bir yanlış
   * kırmızı üretti (ölçüldü: bir sonraki jest 1.2 kat büyümüş zoom'u
   * kullanırken beklenen değer eski zoom'dan hesaplandı).
   */
  async ctrlWheel(deltaY: number, at?: { x: number; y: number }): Promise<void> {
    const point = at ?? (await this.centerOfBody());
    await this.page.mouse.move(point.x, point.y);
    await this.page.keyboard.down('Control');
    await this.page.mouse.wheel(0, deltaY);
    await this.page.keyboard.up('Control');
    await this.settle();
  }

  /**
   * Modifier'sız wheel: DİKEY kaydırma. (Bekleme gerekçesi için bkz. ctrlWheel.)
   * Pozitif deltaY aşağı kaydırır (alttaki track'ler görünür).
   */
  async wheel(deltaY: number, at?: { x: number; y: number }): Promise<void> {
    const point = at ?? (await this.centerOfBody());
    await this.page.mouse.move(point.x, point.y);
    await this.page.mouse.wheel(0, deltaY);
    await this.settle();
  }

  /**
   * `index` numaralı track başlığı satırının EKRAN üstü (px).
   *
   * Başlık kolonu canvas gövdesiyle AYNI scrollY'yi paylaşır (translateY):
   * kelepçe doğru çalışıyorsa scrollY 0 iken ilk satırın üstü, sarmalayıcının
   * üstü + RULER_H'dir. Kelepçe yoksa bayat scrollY kolonu yukarıda tutar ve
   * bu sayı küçülür — hem kullanıcının gördüğü hem hit-test'in kullandığı kayma.
   */
  async trackHeaderTop(index: number): Promise<number> {
    const top = await this.page.evaluate((i: number) => {
      const rows = document.querySelectorAll('[data-testid="track-header"]');
      const el = rows[i] as HTMLElement | undefined;
      return el ? el.getBoundingClientRect().top : null;
    }, index);
    expect(top, `Track başlığı satırı bulunamadı (index ${index}).`).not.toBeNull();
    return top as number;
  }

  /** Shift+wheel: yatay pan. (Bekleme gerekçesi için bkz. ctrlWheel.) */
  async shiftWheel(deltaY: number, at?: { x: number; y: number }): Promise<void> {
    const point = at ?? (await this.centerOfBody());
    await this.page.mouse.move(point.x, point.y);
    await this.page.keyboard.down('Shift');
    await this.page.mouse.wheel(0, deltaY);
    await this.page.keyboard.up('Shift');
    await this.settle();
  }

  /** Canvas gövdesinin ortası (cetvelin altı). */
  async centerOfBody(): Promise<{ x: number; y: number }> {
    const wrap = await this.wrapBox();
    return { x: wrap.x + wrap.width / 2, y: wrap.y + RULER_H + (wrap.height - RULER_H) / 2 };
  }
}
