/**
 * timecodeInput — ters zaman kodu dönüşümünün birim defteri.
 *
 * Bu dosyanın ASIL iddiası tek cümlelik: ters fonksiyon (metin -> µs) ileri
 * fonksiyona (`formatTimecode`, şema paketinden GERÇEK haliyle import edilir)
 * çivilidir. Round-trip taraması bunu her fps ailesinde kare kare ölçer;
 * "tavan çivileri" bölümü de farkın NEREDE doğduğunu (ve nerede DOĞMADIĞINI)
 * sabitler — 30/1 ve 24000/1001'de `frameToUs` (half-up) ile tavan ayrışır,
 * 25/1, 30000/1001 ve 60/1'de ayrışmaz.
 */
import { describe, expect, it } from 'vitest';
import { formatTimecode, frameToUs, usToFrame, type Rational } from '@videoedit/timeline-schema';
import {
  commitTimecodeText,
  displayTimecode,
  parseTimecode,
  TIMECODE_CLAMPED_EMPTY,
  TIMECODE_CLAMPED_TO_END,
  TIMECODE_DROP_FRAME,
  TIMECODE_FIELD_OUT_OF_RANGE,
  TIMECODE_NOT_UNDERSTOOD,
  TIMECODE_TOO_LARGE,
} from './timecodeInput';

const FPS30: Rational = { num: 30, den: 1 };
const FPS25: Rational = { num: 25, den: 1 };
const FPS24: Rational = { num: 24, den: 1 };
const FPS2398: Rational = { num: 24000, den: 1001 };
const FPS2997: Rational = { num: 30000, den: 1001 };
const FPS60: Rational = { num: 60, den: 1 };

const US = 1_000_000;

/** Ret olmayan sonuçtan µs alır (ret gelirse testi okunur biçimde düşürür). */
function timeOf(raw: string, fps: Rational = FPS30): number {
  const r = parseTimecode(raw, fps);
  expect(r.ok, `'${raw}' reddedildi: ${r.ok ? '' : r.reason}`).toBe(true);
  return r.ok ? r.timeUs : -1;
}

describe('parseTimecode — geçerli yazımlar (saat okuması)', () => {
  it.each([
    ['0', 0],
    ['90', 90 * US],
    ['3600', 3600 * US],
    ['1:30', 90 * US],
    ['1:3', 63 * US],
    ['0:01:30:12', 90 * US + 400_000],
    // Kullanıcı kararı: ÜÇ alan HH:MM:SS'tir (dk:sn:kare DEĞİL).
    ['1:30:00', 5400 * US],
    ['23:59:59:29', 86_399 * US + 966_667],
  ])('%s -> %i µs', (raw, expected) => {
    expect(timeOf(raw as string)).toBe(expected);
  });

  it('baştaki alan takvim sınırına uymaz (90 sn, 100 dk), iç alanlar uyar', () => {
    expect(timeOf('90')).toBe(90 * US);
    expect(timeOf('100:00')).toBe(6000 * US);
    expect(timeOf('23:00:00')).toBe(82_800 * US);
    // Serbestlik SINIRSIZ değil: baştaki alan takvim sınırına uymaz ama sonuç
    // 24 saatlik akıl sınırına uyar (plan §Dilim 1 `100:00:00` örneğini
    // dilbilgisi serbestliği olarak okur; büyüklük kapısı ayrı bir kuraldır).
    const hundredHours = parseTimecode('100:00:00', FPS30);
    expect(hundredHours.ok).toBe(false);
    expect(hundredHours.ok === false && hundredHours.reason).toBe(TIMECODE_TOO_LARGE);
  });

  it('boşluklar kırpılır', () => {
    expect(timeOf('  00:00:05:00  ')).toBe(5 * US);
  });

  it('tam 24 saat kabul edilir, bir kare fazlası reddedilir', () => {
    expect(timeOf('24:00:00:00')).toBe(86_400 * US);
    const over = parseTimecode('24:00:00:01', FPS30);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toBe(TIMECODE_TOO_LARGE);
  });
});

describe('parseTimecode — ret tablosu', () => {
  const cases: [string, string, Rational, number | undefined][] = [
    ['', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['   ', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['abc', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1:2:3:4:5', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['00;00;00;00', TIMECODE_DROP_FRAME, FPS30, undefined],
    ['-1', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1.5', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1,5', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1: 30', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1234567', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1:234', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['1:60:00', TIMECODE_FIELD_OUT_OF_RANGE, FPS30, undefined],
    ['1:60', TIMECODE_FIELD_OUT_OF_RANGE, FPS30, undefined],
    ['00:00:00:30', TIMECODE_FIELD_OUT_OF_RANGE, FPS30, 29],
    ['00:00:00:25', TIMECODE_FIELD_OUT_OF_RANGE, FPS25, 24],
    ['00:00:00:24', TIMECODE_FIELD_OUT_OF_RANGE, FPS24, 23],
    ['٠٩', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['00:00:', TIMECODE_NOT_UNDERSTOOD, FPS30, undefined],
    ['99:59:59:29', TIMECODE_TOO_LARGE, FPS30, undefined],
  ];

  it.each(cases)('%j -> %s', (raw, reason, fps, maxFrame) => {
    const r = parseTimecode(raw, fps);
    expect(r.ok, `'${raw}' beklenmedik biçimde KABUL edildi`).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(reason);
    expect(r.maxFrame).toBe(maxFrame);
  });

  it('kare üst sınırı fps ile birlikte kayar (25 fps -> 24 geçerli)', () => {
    expect(timeOf('00:00:00:24', FPS25)).toBe(960_000);
  });

  it('kullanılamaz fps sessizce varsayılana düşmez, tipli ret verir', () => {
    for (const fps of [{ num: 0, den: 1 }, { num: 30, den: 0 }, { num: 29.97, den: 1 }]) {
      const r = parseTimecode('00:00:01:00', fps as Rational);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe(TIMECODE_NOT_UNDERSTOOD);
    }
  });
});

describe('hedef µs = formatTimecode\'u metne eşitleyen EN KÜÇÜK tamsayı (tavan)', () => {
  it('30/1: bir kare 33 334 µs, frameToUs (33 333) DEĞİL', () => {
    expect(timeOf('00:00:00:01', FPS30)).toBe(33_334);
    expect(frameToUs(1, FPS30)).toBe(33_333);
    expect(timeOf('00:00:00:01', FPS30)).not.toBe(frameToUs(1, FPS30));
    // Farkın NEDEN önemli olduğu: half-up değer bir önceki kareyi gösterir.
    expect(formatTimecode(frameToUs(1, FPS30), FPS30)).toBe('00:00:00:00');
    expect(formatTimecode(timeOf('00:00:00:01', FPS30), FPS30)).toBe('00:00:00:01');
  });

  it('24000/1001: bir kare 41 709 µs, frameToUs (41 708) DEĞİL', () => {
    expect(timeOf('00:00:00:01', FPS2398)).toBe(41_709);
    expect(frameToUs(1, FPS2398)).toBe(41_708);
    expect(formatTimecode(frameToUs(1, FPS2398), FPS2398)).toBe('00:00:00:00');
  });

  it('25/1, 30000/1001 ve 60/1: tavan ile frameToUs AYNI (fark burada doğmaz)', () => {
    expect(timeOf('00:00:00:01', FPS25)).toBe(40_000);
    expect(timeOf('00:00:00:01', FPS2997)).toBe(33_367);
    expect(timeOf('00:00:00:01', FPS60)).toBe(16_667);
    expect(frameToUs(1, FPS25)).toBe(40_000);
    expect(frameToUs(1, FPS2997)).toBe(33_367);
    expect(frameToUs(1, FPS60)).toBe(16_667);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: ters fonksiyon ileri fonksiyona çivili
// ---------------------------------------------------------------------------

/** Kare indeksinden kanonik HH:MM:SS:FF (bağımsız, apaçık ileri eşleme). */
function timecodeOfFrame(frame: number, nominal: number): string {
  const ff = frame % nominal;
  const totalSeconds = Math.floor(frame / nominal);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

describe('round-trip: format(parse(tc)) === tc ve usToFrame(parse) === kare', () => {
  const fpsList: [string, Rational, number][] = [
    ['30/1', FPS30, 30],
    ['25/1', FPS25, 25],
    ['24000/1001', FPS2398, 24],
    ['30000/1001', FPS2997, 30],
    ['60/1', FPS60, 60],
  ];

  it.each(fpsList)('%s — ilk kareler ve saniye/dakika/saat sınırları', (_name, fps, nominal) => {
    const frames: number[] = [];
    for (let f = 0; f <= 2 * nominal + 3; f++) frames.push(f);
    for (const seconds of [59, 60, 3599, 3600, 7200]) {
      for (const d of [-1, 0, 1]) {
        const f = seconds * nominal + d;
        if (f >= 0) frames.push(f);
      }
    }
    for (const f of frames) {
      const tc = timecodeOfFrame(f, nominal);
      const parsed = parseTimecode(tc, fps);
      expect(parsed.ok, `${tc} reddedildi`).toBe(true);
      if (!parsed.ok) continue;
      expect(formatTimecode(parsed.timeUs, fps), `format(parse(${tc}))`).toBe(tc);
      expect(usToFrame(parsed.timeUs, fps), `usToFrame(parse(${tc}))`).toBe(f);
    }
  });
});

describe('commitTimecodeText — kelepçe politikası (kullanıcı kararı: hepsi kelepçelenir)', () => {
  const fps = FPS30;

  it('proje içindeki hedef olduğu gibi geçer (bildirim yok)', () => {
    expect(commitTimecodeText('00:00:05:00', { fps, durationUs: 82 * US })).toEqual({
      kind: 'seek',
      timeUs: 5 * US,
      notice: null,
    });
  });

  it('proje sonunun ötesi SONA oturur ve bunu SÖYLER', () => {
    expect(commitTimecodeText('90', { fps, durationUs: 82 * US })).toEqual({
      kind: 'seek',
      timeUs: 82 * US,
      notice: TIMECODE_CLAMPED_TO_END,
    });
  });

  it('boş projede (süre 0) playhead başta kalır — ayrı kod', () => {
    expect(commitTimecodeText('5', { fps, durationUs: 0 })).toEqual({
      kind: 'seek',
      timeUs: 0,
      notice: TIMECODE_CLAMPED_EMPTY,
    });
    // Zaten 0 isteniyorsa kelepçe DEĞİL, normal bir seek'tir.
    expect(commitTimecodeText('0', { fps, durationUs: 0 })).toEqual({
      kind: 'seek',
      timeUs: 0,
      notice: null,
    });
  });

  it('ret kodları kelepçeye uğramadan geçer (maxFrame dahil)', () => {
    expect(commitTimecodeText('abc', { fps, durationUs: 82 * US })).toEqual({
      kind: 'reject',
      reason: TIMECODE_NOT_UNDERSTOOD,
    });
    expect(commitTimecodeText('00:00:00:30', { fps, durationUs: 82 * US })).toEqual({
      kind: 'reject',
      reason: TIMECODE_FIELD_OUT_OF_RANGE,
      maxFrame: 29,
    });
  });
});

describe('displayTimecode — formatTimecode RangeError yüzeyini UI\'dan uzak tutar', () => {
  it('negatif ve ondalıklı playhead fırlatmaz', () => {
    expect(displayTimecode(-1, FPS30)).toBe('00:00:00:00');
    expect(displayTimecode(33_333.7, FPS30)).toBe('00:00:00:01');
    expect(displayTimecode(Number.NaN, FPS30)).toBe('00:00:00:00');
  });

  it('kullanılamaz fps fırlatmaz (boş metin — uydurma zaman kodu yazmaz)', () => {
    expect(displayTimecode(5 * US, { num: 0, den: 1 } as Rational)).toBe('');
  });
});

describe('toplamsallık: hiçbir girdide fırlatmaz', () => {
  it('200 rastgele dize + tipsiz girdiler tipli sonuç döner', () => {
    // Deterministik PRNG (mulberry32) — rastgele ama TEKRARLANABİLİR.
    let seed = 0x9e3779b9;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = '0123456789:;.,- \tabcXY٠九+/\\\'"e';
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rnd() * 12);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseTimecode(s, FPS30);
      expect(typeof r.ok, `girdi: ${JSON.stringify(s)}`).toBe('boolean');
      if (r.ok) {
        expect(Number.isInteger(r.timeUs)).toBe(true);
        expect(r.timeUs).toBeGreaterThanOrEqual(0);
        // Kabul edilen her değer ileri fonksiyondan da geçebilmeli.
        expect(() => formatTimecode(r.timeUs, FPS30)).not.toThrow();
      } else {
        expect(typeof r.reason).toBe('string');
      }
      expect(() => commitTimecodeText(s, { fps: FPS30, durationUs: 82 * US })).not.toThrow();
    }
    for (const weird of [null, undefined, 42, {}, [], Number.NaN]) {
      const r = parseTimecode(weird, FPS30);
      expect(r.ok).toBe(false);
    }
  });
});
