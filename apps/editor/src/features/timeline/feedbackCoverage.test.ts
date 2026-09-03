/**
 * feedbackCoverage — ret/notice kodları ile Türkçe çeviri tablolarının
 * İKİ YÖNLÜ diff'i, KAYNAKTAN türetilmiş olarak.
 *
 * Sözleşme: op katmanının ürettiği HER İngilizce kod (OpResult.reason /
 * OpResult.notice / *BlockReason dönüşleri) feedback tablolarının birinde bir
 * Türkçe karşılık bulmak ZORUNDADIR — eşlenmemiş kod, kullanıcıya jenerik
 * "İşlem uygulanamadı" olarak düşer ve neden reddedildiğini asla söylemez.
 * Kapsam yalnız OP katmanı değildir: GİRDİ DOĞRULAMA katmanı (transport zaman
 * kodu alanı — `features/player/timecodeInput.ts`) da tipli kodlar üretir ve
 * aynı sözleşmeye tabidir; onun tablosu `features/player/playerFeedback.ts`.
 * Ters yön de bağlayıcıdır: tabloda kaynakta artık üretilmeyen bir anahtar
 * (bayat çeviri) kalamaz.
 *
 * Kod listesi ELLE tutulan bir liste DEĞİL, kaynak taramasıdır — yeni bir
 * `fail('...')` / `reason: '...'` / blockReason literal'i eklendiğinde bu test
 * çeviri eklenene kadar KIRMIZI kalır. Yakalanan kalıplar:
 *   1. `fail('X')` çağrıları,
 *   2. `reason: 'X'` alanları (plan/op sonuç nesneleri),
 *   3. adı `...BlockReason` / `...Target` ile biten fonksiyon gövdelerindeki
 *      çok-kelimeli, küçük-harf İngilizce string literaller,
 *   4. `const SNAKE_CASE = 'ingilizce cümle'` kod sabitleri (REASON_*,
 *      TRANSITION_*, SPEED_*, LUT_DEDUPED... — notice kodları dahil).
 * Türkçe undo etiketleri büyük harfle başladığı ve Türkçe karakter taşıdığı
 * için `^[a-z][a-z0-9 /'-]*$` süzgecine hiçbir zaman takılmaz.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opFailureMessage, opNoticeMessage } from './feedback';
import { inspectorFailureMessage, inspectorNoticeMessage } from '../inspector/inspectorFeedback';
import { timecodeFailureMessage, timecodeNoticeMessage } from '../player/playerFeedback';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * OpResult üreten, blockReason döndüren ya da tipli GİRDİ ret kodu üreten TÜM
 * modüller. Bu iki liste taramanın TEK kör noktasıdır (elle tutulur): yeni bir
 * kod kaynağı eklendiğinde buraya da yazılmalı, yoksa kodları hiç görülmez.
 */
const CODE_SOURCES = [
  'state/timelineOps.ts',
  'features/keyframes/keyframeOps.ts',
  'features/keyframes/keyframeModel.ts',
  'features/timeline/menuActions.ts',
  'features/text/overlayActions.ts',
  'features/player/timecodeInput.ts',
];

/** Çeviri tabloları (timeline balonu + Inspector satır içi + transport alanı). */
const TABLE_SOURCES = [
  'features/timeline/feedback.ts',
  'features/inspector/inspectorFeedback.ts',
  'features/player/playerFeedback.ts',
];

const isEnglishCode = (s: string): boolean => /^[a-z][a-z0-9 /'-]*$/.test(s);

function collectSourceCodes(): Set<string> {
  const codes = new Set<string>();
  for (const rel of CODE_SOURCES) {
    const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\bfail\(\s*'([^']+)'\s*\)/g)) codes.add(m[1]);
    for (const m of src.matchAll(/\breason:\s*'([^']+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/const [A-Z][A-Z_0-9]* =\s*\r?\n?\s*'([a-z][^']*)';/g)) {
      codes.add(m[1]);
    }
    const fnStarts = [...src.matchAll(/^(?:export )?function (\w+)/gm)];
    for (let i = 0; i < fnStarts.length; i++) {
      const name = fnStarts[i][1];
      if (!/BlockReason$|Target$/.test(name)) continue;
      const body = src.slice(fnStarts[i].index, fnStarts[i + 1]?.index ?? src.length);
      for (const m of body.matchAll(/'([^']+)'/g)) {
        const v = m[1];
        if (v.includes(' ') && isEnglishCode(v)) codes.add(v);
      }
    }
  }
  return codes;
}

function collectTableKeys(): Set<string> {
  const keys = new Set<string>();
  for (const rel of TABLE_SOURCES) {
    const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/^\s*'([^']+)':/gm)) keys.add(m[1]);
  }
  return keys;
}

describe('feedback tabloları <-> op ret kodları (kaynak diff)', () => {
  const codes = collectSourceCodes();
  const tableKeys = collectTableKeys();

  it('tarama gerçek envanteri görüyor (boş küme = kalıp bozuldu demektir)', () => {
    // Kalıplardan biri sessizce kırılırsa iki taraf birden boşalır ve diff
    // "yeşil" görünürdü; taban sayılar bunu kırmızıya çevirir. Sayılar alt
    // sınırdır (yeni kod eklendikçe büyür), eşitlik değil.
    expect(codes.size).toBeGreaterThanOrEqual(70);
    expect(tableKeys.size).toBeGreaterThanOrEqual(70);
    expect(codes.has('overlaps an existing clip')).toBe(true);
    expect(codes.has('track already at the top')).toBe(true);
    expect(codes.has('scale clamped by rotation canvas')).toBe(true);
  });

  it('eşlenmemiş kod yok: her üretilen kod bir tabloda çevrili', () => {
    const missing = [...codes].filter((c) => !tableKeys.has(c)).sort();
    expect(missing, 'Bu kodlar için Türkçe çeviri ekleyin (feedback.ts ya da inspectorFeedback.ts)').toEqual([]);
  });

  it('bayat anahtar yok: her tablo anahtarı kaynakta hâlâ üretiliyor', () => {
    const stale = [...tableKeys].filter((c) => !codes.has(c)).sort();
    expect(stale, 'Bu çeviriler artık üretilmeyen kodlara ait — tabloyu temizleyin').toEqual([]);
  });

  it('her kod çalışma zamanında da jenerik olmayan bir Türkçe metne çözülür', () => {
    // Kaynak diff'i tablo DOSYALARINA bakar; bu iddia gerçek fonksiyon
    // zincirinin (inspectorFailureMessage -> opFailureMessage fallback) aynı
    // kümeyi gördüğünü de sabitler. Notice kodları failure tablosunda değildir
    // (ve tersi) — bir kodun EN AZ BİR yüzeyde anlamlı metni olmalı.
    const generic = opFailureMessage('böyle bir kod yok');
    for (const code of codes) {
      const texts = [
        opFailureMessage(code),
        inspectorFailureMessage(code),
        opNoticeMessage(code),
        inspectorNoticeMessage(code),
        timecodeFailureMessage(code),
        timecodeNoticeMessage(code),
      ];
      const resolved = texts.some((t) => t !== null && t !== generic);
      expect(resolved, `'${code}' hiçbir feedback yüzeyinde çözülmüyor`).toBe(true);
    }
  });
});
