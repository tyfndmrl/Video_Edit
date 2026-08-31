/**
 * devWarn — yut-ama-görünür-kıl yardımcısının iki yüzü:
 * DEV'de console.warn'a düşer, üretim bayrağında TAMAMEN sessizdir.
 * (Üretim yarısı burada bayrak düzeyinde kanıtlanır; çağrı yerleri kendi
 * testlerinde yalnız DEV davranışını ve yutmanın bozulmadığını sabitler.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devWarn } from './devWarn';

// vitest koşumunda import.meta.env.DEV === true (docStore.test.ts ile aynı
// varsayım); üretim yarısı için bayrak geçici olarak elle indirilir.
const env = import.meta.env as unknown as { DEV?: boolean };

afterEach(() => {
  env.DEV = true;
  vi.restoreAllMocks();
});

describe('devWarn', () => {
  it("DEV'de [VideoEdit] önekiyle console.warn çağırır ve hatayı iletir", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = new Error('boom');
    devWarn('abort başarısız', boom);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[VideoEdit] abort başarısız', boom);
  });

  it('hata verilmemişse tek argümanla uyarır (kuyrukta "undefined" yok)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    devWarn('yalnız mesaj');
    expect(warn).toHaveBeenCalledWith('[VideoEdit] yalnız mesaj');
  });

  it('üretim bayrağında (DEV=false) hiçbir şey yazmaz', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.DEV = false;
    devWarn('görünmemeli', new Error('sessiz'));
    expect(warn).not.toHaveBeenCalled();
  });
});
