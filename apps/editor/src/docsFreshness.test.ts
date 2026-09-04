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
 * KAPSAM (fazla iddia etmemek için): bu muhafız TARİHE bakar, İÇERİĞE değil.
 * Damgayı elle ileri almak testi susturur — ama o, protokolü bilerek delmektir;
 * muhafızın işi kazayla unutmayı yakalamaktır.
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

  it('damga biçimi ayrıştırılabilir kalır (muhafız sessizce körelmesin)', () => {
    // Biçim değişirse yukarıdaki iddia "bulamadım" diye susmaz, BURASI kırmızı olur.
    expect(stampOf('STATE.md')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stampOf('SKILLS.md')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(newestChangelogDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
