import { afterEach, describe, expect, it } from 'vitest';
import { NEW_TRACK_ZONE_H, RULER_H, TRACK_GAP, TRACK_H } from './geometry';
import {
  DEFAULT_TIMELINE_H,
  MIN_PLAYER_H,
  SANE_MAX_TIMELINE_H,
  TIMELINE_HEIGHT_STORAGE_KEY,
  clampTimelineHeight,
  maxTimelineHeight,
  minTimelineHeight,
  readStoredTimelineHeight,
  writeStoredTimelineHeight,
} from './timelineHeight';

const ROW = RULER_H + TRACK_H + TRACK_GAP + NEW_TRACK_ZONE_H;

describe('minTimelineHeight (bir satır + yeni-track bölgesi hep erişilebilir)', () => {
  it('is the measured header plus ruler + one full row + the new-track zone', () => {
    expect(minTimelineHeight(30)).toBe(30 + ROW);
    expect(minTimelineHeight(0)).toBe(ROW);
  });

  it('rounds the measured header and degrades safely', () => {
    expect(minTimelineHeight(29.6)).toBe(30 + ROW);
    expect(minTimelineHeight(-5)).toBe(ROW);
    expect(minTimelineHeight(Number.NaN)).toBe(ROW);
  });
});

describe('maxTimelineHeight (oynatıcıya pay bırakır)', () => {
  it('leaves MIN_PLAYER_H to the player', () => {
    expect(maxTimelineHeight(30, 800)).toBe(800 - MIN_PLAYER_H);
  });

  it('never inverts the range: a tiny window falls back to the minimum', () => {
    const min = minTimelineHeight(30);
    expect(maxTimelineHeight(30, 200)).toBe(min);
    expect(maxTimelineHeight(30, 200)).toBeGreaterThanOrEqual(min);
  });

  it('applies only a sane ceiling while the available space is unmeasured', () => {
    expect(maxTimelineHeight(30, null)).toBe(SANE_MAX_TIMELINE_H);
    expect(maxTimelineHeight(30, Number.NaN)).toBe(SANE_MAX_TIMELINE_H);
  });
});

describe('clampTimelineHeight (niyet + ölçümler -> efektif piksel)', () => {
  const measured = { headerPx: 30, availablePx: 800 };

  it('keeps an in-range intent untouched', () => {
    expect(clampTimelineHeight({ preferredPx: 400, ...measured })).toBe(400);
  });

  it('clamps to the minimum and to the player margin', () => {
    expect(clampTimelineHeight({ preferredPx: 10, ...measured })).toBe(minTimelineHeight(30));
    expect(clampTimelineHeight({ preferredPx: 5000, ...measured })).toBe(800 - MIN_PLAYER_H);
  });

  it('is DEFAULT_TIMELINE_H for an unmeasured, unset state (bugünkü grid satırı)', () => {
    // Depolama boş + ölçüm yok: görünüm özellik ÖNCESİYLE birebir aynı.
    expect(
      clampTimelineHeight({ preferredPx: DEFAULT_TIMELINE_H, headerPx: 0, availablePx: null }),
    ).toBe(DEFAULT_TIMELINE_H);
  });

  it('falls back to DEFAULT_TIMELINE_H on a NaN/Infinite intent', () => {
    expect(clampTimelineHeight({ preferredPx: Number.NaN, ...measured })).toBe(DEFAULT_TIMELINE_H);
    expect(clampTimelineHeight({ preferredPx: Number.POSITIVE_INFINITY, ...measured })).toBe(
      DEFAULT_TIMELINE_H,
    );
  });

  it('can never overflow the grid, even when the minimum does not fit', () => {
    // Pencere absürt kısa: alt sınır (30 + ROW) alandan büyük -> satır alanı aşmaz.
    const available = 100;
    expect(minTimelineHeight(30)).toBeGreaterThan(available);
    expect(clampTimelineHeight({ preferredPx: 400, headerPx: 30, availablePx: available })).toBe(
      available,
    );
  });

  it('KULLANICI NİYETİ pencere küçülüp büyüyünce hayatta kalır', () => {
    // Aynı preferredPx: dar pencerede kelepçelenir, pencere büyüyünce GERİ GELİR.
    const intent = 600;
    const small = clampTimelineHeight({ preferredPx: intent, headerPx: 30, availablePx: 500 });
    const large = clampTimelineHeight({ preferredPx: intent, headerPx: 30, availablePx: 900 });
    expect(small).toBe(500 - MIN_PLAYER_H);
    expect(large).toBe(intent);
  });
});

// ---------------------------------------------------------------------------
// localStorage sarmalayıcısı (vitest ortamı 'node': global elle kurulur)
// ---------------------------------------------------------------------------

interface FakeStorage {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function installFakeStorage(): FakeStorage {
  const fake: FakeStorage = {
    store: new Map<string, string>(),
    getItem(key) {
      return this.store.get(key) ?? null;
    },
    setItem(key, value) {
      this.store.set(key, value);
    },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = fake;
  return fake;
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe('kalıcılık (bozuk değer sessizce DÜZELTİLMEZ, yok sayılır)', () => {
  it('round-trips a written height', () => {
    const fake = installFakeStorage();
    writeStoredTimelineHeight(412.4);
    expect(fake.store.get(TIMELINE_HEIGHT_STORAGE_KEY)).toBe('412');
    expect(readStoredTimelineHeight()).toBe(412);
  });

  it('returns null when nothing is stored', () => {
    installFakeStorage();
    expect(readStoredTimelineHeight()).toBeNull();
  });

  it('ignores garbage and out-of-range values', () => {
    const fake = installFakeStorage();
    for (const raw of ['abc', '', 'NaN', '-40', '0', String(SANE_MAX_TIMELINE_H + 1)]) {
      fake.store.set(TIMELINE_HEIGHT_STORAGE_KEY, raw);
      expect(readStoredTimelineHeight(), `"${raw}" kabul edilmemeli`).toBeNull();
    }
  });

  it('reads null when storage does not exist at all (SSR / blocked)', () => {
    expect(readStoredTimelineHeight()).toBeNull();
    // Yazmak da patlamamalı — kalıcılık bir kolaylıktır.
    expect(() => writeStoredTimelineHeight(300)).not.toThrow();
  });
});
