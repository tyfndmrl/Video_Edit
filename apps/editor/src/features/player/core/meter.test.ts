import { describe, expect, it } from 'vitest';

import {
  METER_CLIP_LINEAR,
  METER_FLOOR_DB,
  PARITY_DELTAS_DB,
  largestParityDelta,
  advanceMeter,
  barFraction,
  createMeterState,
  dbfs,
  formatDbfs,
  meterHonestyNote,
  meterInactiveHint,
  meterInactiveLabel,
  meterReadoutDb,
  resetMeter,
  type MeterFrame,
  type MeterState,
} from './meter';

function live(peak: number, atMs: number, rms = peak / 2): MeterFrame {
  return { live: true, reason: 'running', peak: [peak, peak], rms: [rms, rms], atMs };
}

function idle(atMs: number, reason: MeterFrame['reason'] = 'paused'): MeterFrame {
  return { live: false, reason, peak: [0, 0], rms: [0, 0], atMs };
}

function run(frames: readonly MeterFrame[], from: MeterState = createMeterState()): MeterState {
  return frames.reduce(advanceMeter, from);
}

describe('dbfs / barFraction / formatDbfs', () => {
  it('converts linear amplitude to dBFS', () => {
    expect(dbfs(1)).toBe(0);
    expect(dbfs(2)).toBeCloseTo(6.0206, 4);
    expect(dbfs(0.5)).toBeCloseTo(-6.0206, 4);
    expect(dbfs(0)).toBe(Number.NEGATIVE_INFINITY);
    // The measured preview overshoot from poc-bilinen-sinirlar §2.6.
    expect(dbfs(1.163)).toBeCloseTo(1.31, 2);
  });

  it('maps the scale so 0 dBFS is full and the floor is empty', () => {
    expect(barFraction(0)).toBe(1);
    expect(barFraction(METER_FLOOR_DB)).toBe(0);
    expect(barFraction(-30)).toBeCloseTo(0.5, 10);
    expect(barFraction(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('clamps ABOVE 0 dBFS to a full bar (the latch reports the overshoot)', () => {
    expect(barFraction(6)).toBe(1);
    expect(barFraction(0.1)).toBe(1);
  });

  it('formats the readout with a sign and no -0.0 flicker', () => {
    expect(formatDbfs(Number.NEGATIVE_INFINITY)).toBe('-∞ dBFS');
    expect(formatDbfs(-80)).toBe('< -60.0 dBFS');
    expect(formatDbfs(-12.44)).toBe('-12.4 dBFS');
    expect(formatDbfs(1.31)).toBe('+1.3 dBFS');
    expect(formatDbfs(-0.04)).toBe('0.0 dBFS');
  });
});

describe('ballistics', () => {
  it('attacks instantly: the peak is held on the very frame it happens', () => {
    const s = run([live(0.5, 1000)]);
    expect(s.holdDb[0]).toBeCloseTo(dbfs(0.5), 10);
    expect(meterReadoutDb(s)).toBeCloseTo(dbfs(0.5), 10);
  });

  it('holds for a second before falling', () => {
    const start = run([live(1, 0)]);
    const held = run([live(0.001, 999)], start);
    expect(held.holdDb[0]).toBe(0);
    const falling = run([live(0.001, 1001), live(0.001, 1501)], start);
    expect(falling.holdDb[0]).toBeLessThan(0);
  });

  it('falls at 20 dB/s once the hold expires', () => {
    const start = run([live(1, 0)]);
    // t=1000 still inside the hold window; from there two seconds of decay.
    const s = run([live(0, 1000), live(0, 2000), live(0, 3000)], start);
    expect(s.holdDb[0]).toBeCloseTo(-40, 6);
  });

  it('never falls below the current signal', () => {
    const start = run([live(1, 0)]);
    const s = run([live(0.5, 1000), live(0.5, 5000)], start);
    expect(s.holdDb[0]).toBeCloseTo(dbfs(0.5), 10);
  });

  it('never decays below the scale floor (probe surface stays meaningful)', () => {
    const start = run([live(1, 0)]);
    // 30 s of silence: an unbounded decay would publish about -600 dBFS.
    const s = run([idle(1000), idle(16_000), idle(31_000)], start);
    expect(s.holdDb[0]).toBe(METER_FLOOR_DB);
    expect(meterReadoutDb(s)).toBe(METER_FLOOR_DB);
  });

  it('is cadence independent: 30 Hz and 12 Hz steps land on the same hold', () => {
    const start = run([live(1, 0)]);
    const fast: MeterFrame[] = [];
    for (let t = 1000; t <= 2000; t += 33) fast.push(live(0, t));
    fast.push(live(0, 2000));
    const slow: MeterFrame[] = [];
    for (let t = 1000; t <= 2000; t += 83) slow.push(live(0, t));
    slow.push(live(0, 2000));
    const a = run(fast, start);
    const b = run(slow, start);
    expect(a.holdDb[0]).toBeCloseTo(b.holdDb[0], 6);
    expect(a.holdDb[0]).toBeCloseTo(-20, 6);
  });
});

describe('clip latch', () => {
  it('does not light AT 0 dBFS, lights strictly above it, and needs one window', () => {
    expect(run([live(METER_CLIP_LINEAR, 0)]).clipped).toBe(false);
    expect(run([live(1.0000001, 0)]).clipped).toBe(true);
  });

  it('stays latched after the signal drops and while paused', () => {
    const s = run([live(1.5, 0), live(0.1, 100), idle(200)]);
    expect(s.clipped).toBe(true);
  });

  it('is cleared only by an explicit reset, which also drops the held peaks', () => {
    const clipped = run([live(1.5, 0), live(0.02, 100)]);
    const cleared = resetMeter(clipped, 200);
    expect(cleared.clipped).toBe(false);
    expect(cleared.holdDb[0]).toBeCloseTo(dbfs(0.02), 10);
    // A new overshoot after the reset lights it again.
    expect(advanceMeter(cleared, live(2, 300)).clipped).toBe(true);
  });
});

describe('inactive regimes', () => {
  it('reads as silence, not as a level, when there is no mix', () => {
    const s = run([live(1, 0), idle(100)]);
    expect(s.instantDb[0]).toBe(Number.NEGATIVE_INFINITY);
    expect(s.rmsDb[0]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('labels each reason and never labels a running meter', () => {
    expect(meterInactiveLabel('running', false)).toBeNull();
    expect(meterInactiveLabel('no-context', false)).toBe('Ölçüm yok');
    expect(meterInactiveLabel('blocked', false)).toBe('Engellendi');
    expect(meterInactiveLabel('paused', false)).toBe('Duraklatıldı');
    expect(meterInactiveLabel('paused', true)).toBe('Ses kapalı');
    expect(meterInactiveLabel('shuttle', false)).toBe('Ses kapalı');
  });

  it('explains each reason in the hint', () => {
    expect(meterInactiveHint('running', false)).toBeNull();
    expect(meterInactiveHint('no-context', false)).toContain('ilk oynatmaya kadar kurulmaz');
    expect(meterInactiveHint('blocked', false)).toContain('otomatik oynatmayı engelledi');
    expect(meterInactiveHint('paused', false)).toContain('ses zarfı sıfırlanır');
    expect(meterInactiveHint('paused', true)).toContain('Geri tarama sessizdir');
  });
});

describe('honesty note', () => {
  it('carries the measured preview/export asymmetry, not a vague disclaimer', () => {
    const note = meterHonestyNote();
    expect(note).toContain('ÖNİZLEME');
    expect(note).toContain('0,98'); // export limiter
    expect(note).toContain('1,163'); // measured preview peak
    expect(note).toContain('0,950'); // measured export peak
    // §2.6 tablosunun ÜÇ satırı da geçmeli: tipik (fade-out 0,70), limiter (1,20)
    // ve ölçülen MAKSİMUM (hız 2x 1,24). Yalnız 0,70'i çivilemek, tablonun kendi
    // maksimumundan küçük bir sayıyı kullanıcıya "en çok" diye gösteriyordu.
    // Tablonun HER satırı notta görünmeli — biri sessizce düşerse kullanıcı
    // eksik bir sınır tablosu okur.
    for (const d of PARITY_DELTAS_DB) {
      expect(note, `${d.regime} satırı notta yok`).toContain(d.regime);
    }
    expect(note).toContain('0,70 dB');
    expect(note).toContain('1,20 dB');
    expect(note).toContain('1,24 dB');
    expect(note).toContain('4 medya çözücü'); // pool cap
    expect(note).toContain('-3,0 dBFS'); // RMS convention
  });

  it('üstünlük cümlesi TABLODAN türer — elle seçilmiş bir sayı olamaz', () => {
    // Önceki iki muhafız da bu iddiada YETERSİZ çıktı: ilki yalnız sayıların
    // VARLIĞINI sınadı, ikincisi tek cümleye bakan bir regex'ti ve noktalama
    // değişince "EN BÜYÜK ... 0,70 dB" yalanı yeşil geçti (denetimde ölçüldü).
    // Bu yüzden iddia artık metne değil VERİYE bağlı: en büyüğü test de
    // tablodan hesaplar, cümle de.
    const worst = largestParityDelta();
    expect(worst.db).toBe(Math.max(...PARITY_DELTAS_DB.map((d) => d.db)));
    expect(meterHonestyNote()).toContain(`EN BÜYÜĞÜ ${worst.regime} 1,24 dB'dir`);
  });

  it('tablo poc-bilinen-sinirlar §2.6 ölçümüyle ÇİVİLİ', () => {
    // audio-parity.spec.ts her tam koşumda bu üç sayıyı yeniden ölçer; burası
    // ölçümün UI'ya taşınan kopyasının kaymadığını çiviler.
    expect(PARITY_DELTAS_DB.map((d) => [d.regime, d.db])).toEqual([
      ['tipik rejimlerde', 0.7],
      ['limiter rejiminde', 1.2],
      ['hız 2x rejiminde', 1.24],
    ]);
  });
});
