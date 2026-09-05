/**
 * Damga tazeliği muhafızı — CLAUDE.md P3'ün mekanik yarısı.
 *
 * NEDEN VAR: aynı kusur bu projede ÜÇ kez tekrarladı ve üçünde de denetim
 * yakaladı, ben değil. Kapanışta `docs/CHANGELOG.md`'ye yeni bir gün eklendi,
 * `docs/STATE.md`'nin GÖVDESİ güncellendi, ama dosyanın İLK PARAGRAFINDAKİ
 * "Son güncelleme" damgası eski commit'te kaldı. STATE, CLAUDE.md'nin okuma
 * sırasında BİRİNCİ dosyadır: yeni bir session'ın okuduğu ilk cümle bayat
 * olduğunda, set hiç olmamasından kötüdür (CLAUDE.md'nin kendi ifadesi).
 *
 * İDDİA: STATE'in damgası, CHANGELOG'un EN YENİ gün başlığından eski olamaz.
 * Bu, "her kapanışta CHANGELOG + STATE birlikte güncellenir" protokolünün
 * doğrudan mekanik karşılığıdır.
 *
 * KAPSAM — fazla iddia etmemek için tek tek yazılıyor:
 *  - Muhafız TARİHE bakar, İÇERİĞE değil. Damgayı elle ileri almak testi
 *    susturur; muhafızın işi kazayla unutmayı yakalamaktır, kasti delmeyi değil.
 *  - KAPSAMDA: `STATE.md`'nin damgası (her kapanışta güncellenmesi ZORUNLU,
 *    CLAUDE.md P3) ile `SKILLS.md` ve `DECISIONS.md`'nin kendi içindeki
 *    tutarlılığı (damga, dosyanın İÇİNDEKİ en yeni tarihten eski olamaz).
 *  - KAPSAM DIŞI, adıyla: `CLAUDE.md`, `STRUCTURE.md`, `WORKFLOWS.md` ve tek tek
 *    SKILLS girdilerinin "Son doğrulanma" tarihleri. Bunlar P3'e göre yalnız
 *    DOKUNULDUĞUNDA tazelenir; "dokunuldu mu" sorusunu yanıtlamak git geçmişi
 *    okumayı gerektirir ve bu muhafız git'e BAKMAZ. Denetimde ölçüldü:
 *    `STRUCTURE.md` damgası 34 gün, `CLAUDE.md` damgası 6 yıl geriye alındığında
 *    bu dosya YEŞİL kalıyor. O boşluk bilinçli açık — kapatıldığı SANILMASIN.
 *    Bayat damga sınıfı bu projede ALTI kez tekrarladı; mekanik kapı yalnız
 *    aşağıdaki üç iddia kadardır, gerisi prosedürdür (CLAUDE.md P3).
 *  - Yanlış-pozitif profili: CHANGELOG'a GELECEK tarihli bir gün başlığı
 *    eklenirse muhafız haksız kırmızı verir. Önlenmedi (böyle bir girdi zaten
 *    kayıt hatasıdır).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');

function read(name: string): string {
  return readFileSync(join(DOCS, name), 'utf8');
}

/** `## 2026-09-04` biçimindeki en yeni gün başlığı. */
function newestChangelogDate(): string {
  const dates = [...read('CHANGELOG.md').matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  expect(dates.length, 'CHANGELOG gün başlığı bulunamadı — muhafız kör kaldı.').toBeGreaterThan(0);
  return dates.reduce((a, b) => (b > a ? b : a));
}

function stampOf(name: string): string {
  const m = /^Son güncelleme: (\d{4}-\d{2}-\d{2})/m.exec(read(name));
  expect(m, `${name} içinde "Son güncelleme: YYYY-MM-DD" satırı yok.`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

describe('doküman damgaları (CLAUDE.md P3)', () => {
  it('STATE.md damgası CHANGELOG’un en yeni gününden eski DEĞİL', () => {
    const newest = newestChangelogDate();
    const stamp = stampOf('STATE.md');
    // ISO tarihler sözlük sırasında karşılaştırılır; sayısal matcher'lar string
    // kabul etmediği için iddia açık bir boolean üzerinden kurulur.
    expect(
      stamp >= newest,
      `STATE.md "Son güncelleme" damgası ${stamp}, CHANGELOG'un en yeni günü ${newest}. ` +
        'Kapanışta gövdeyi güncelleyip başlığı unutmak bu projede üç kez tekrarladı — ' +
        'ilk paragraf yeni session’ın okuduğu ilk cümledir.',
    ).toBe(true);
  });

  it('SKILLS.md damgası, İÇİNDEKİ en yeni "Son doğrulanma"dan eski DEĞİL', () => {
    // İç tutarlılık: bir girdi 2026-09-04'te doğrulandıysa dosya o gün
    // DOKUNULMUŞTUR, dolayısıyla dosyanın kendi damgası da o günden eski olamaz.
    // Bu, git'e bakmadan kurulabilen tek dürüst SKILLS iddiasıdır.
    const body = read('SKILLS.md');
    const verified = [...body.matchAll(/^- Son doğrulanma: (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
    expect(verified.length, 'SKILLS girdilerinde "Son doğrulanma" satırı yok.').toBeGreaterThan(0);
    const newestEntry = verified.reduce((a, b) => (b > a ? b : a));
    const stamp = stampOf('SKILLS.md');
    expect(
      stamp >= newestEntry,
      `SKILLS.md damgası ${stamp}, ama içindeki en yeni "Son doğrulanma" ${newestEntry}. ` +
        'Bir girdi doğrulandıysa dosya o gün dokunulmuştur; başlık damgası da tazelenmeli.',
    ).toBe(true);
  });

  it('DECISIONS.md damgası, tablodaki en yeni karar tarihinden eski DEĞİL', () => {
    // SKILLS ile aynı git'siz iç tutarlılık kalıbı: bir karar 2026-09-04'te
    // eklendiyse dosya o gün DOKUNULMUŞTUR. Denetimde ölçüldü — damga
    // 2026-09-03'te kalmışken tabloya iki kez 2026-09-04 satırı yazılmıştı.
    const rows = [...read('DECISIONS.md').matchAll(/^\|[^|]*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map(
      (m) => m[1],
    );
    expect(rows.length, 'DECISIONS tablosunda tarihli satır yok — muhafız kör.').toBeGreaterThan(0);
    const newestRow = rows.reduce((a, b) => (b > a ? b : a));
    const stamp = stampOf('DECISIONS.md');
    expect(
      stamp >= newestRow,
      `DECISIONS.md damgası ${stamp}, ama tablodaki en yeni karar ${newestRow}. ` +
        'Karar eklendiyse dosya o gün dokunulmuştur; başlık damgası da tazelenmeli.',
    ).toBe(true);
  });

  it('damga biçimi ayrıştırılabilir kalır (muhafız sessizce körelmesin)', () => {
    // Biçim değişirse yukarıdaki iddia "bulamadım" diye susmaz, BURASI kırmızı olur.
    expect(stampOf('STATE.md')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stampOf('SKILLS.md')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stampOf('DECISIONS.md')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(newestChangelogDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
