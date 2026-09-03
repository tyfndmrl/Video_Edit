/**
 * Audio meter maths and wording (preview master bus).
 *
 * PURE on purpose: the editor's vitest environment is `node` and only picks up
 * `src` test files, so a `.tsx` component can never be unit-tested here. Every
 * number the meter draws and every sentence it shows is decided in this module
 * and pinned by meter.test.ts — the same reason core/scheduler keeps its
 * shortfall wording pure instead of eyeballing it in a component.
 *
 * WHAT THE METER MEASURES (honesty contract, rendering-semantics section 8):
 * the PREVIEW mix, not the export mix. Section 8.3 puts the limiter in the
 * export chain only, so a peak above 0 dBFS lights the clip latch here while
 * the exported file stays clean. meterHonestyNote() carries that sentence to
 * the UI; poc-bilinen-sinirlar section 2.6 carries the measurements.
 */
import { linearToDb } from './gain';

/** Bottom of the scale. Below this the bar is empty and the readout says so. */
export const METER_FLOOR_DB = -60;
/** Above this the bar switches to the caution colour (still not clipping). */
export const METER_CAUTION_DB = -6;
/** Scale ticks, top to bottom. */
export const METER_TICKS_DB: readonly number[] = [0, -6, -12, -20, -40, -60];
/** A held peak stays put this long before it starts falling. */
export const METER_HOLD_MS = 1000;
/** Fall rate of the held peak once the hold expires. */
export const METER_DECAY_DB_PER_S = 20;
/** Strictly above this linear peak the clip latch lights (0 dBFS). */
export const METER_CLIP_LINEAR = 1;
/**
 * Minimum spacing between samples — a FLOOR on the interval, not a fixed rate.
 * Sampling rides on the engine's rAF, so the real cadence is this interval
 * rounded UP to a frame: 33.3 ms (30 Hz) on a 60 Hz display, 36.4 ms (27.5 Hz)
 * on a 165 Hz one — both MEASURED. Either way the analyser window
 * (METER_FFT_SIZE, 42.7 ms at 48 kHz) is longer than the step, so consecutive
 * reads OVERLAP and no audio falls between them. Sampling every frame would
 * re-read the same window for nothing.
 */
export const METER_INTERVAL_MS = 33;
/** Analyser window. See METER_INTERVAL_MS for why this size and not 1024. */
export const METER_FFT_SIZE = 2048;

/** Why the meter is (not) reading a live mix. */
export type MeterReason = 'running' | 'no-context' | 'blocked' | 'paused' | 'shuttle';

/** One sampled window of the master bus (linear amplitude; 1.0 = 0 dBFS). */
export interface MeterFrame {
  /** false = there is no mix to measure (see reason); peak/rms are then 0. */
  live: boolean;
  reason: MeterReason;
  /** Window peak per channel — MAY exceed 1.0: preview has no limiter. */
  peak: readonly [number, number];
  rms: readonly [number, number];
  /** Wall clock (performance.now) — the ballistics run on time, not on frames. */
  atMs: number;
}

/** Ballistics state; advanceMeter returns a NEW state (pure reducer). */
export interface MeterState {
  /** Instantaneous window peak, dBFS (-Infinity when silent/not live). */
  instantDb: readonly [number, number];
  /** Window RMS, dBFS — what the bar body draws. */
  rmsDb: readonly [number, number];
  /** Held peak, dBFS. */
  holdDb: readonly [number, number];
  /** When each held peak was set (wall clock). */
  holdSetAtMs: readonly [number, number];
  /** Latched: a window peaked above 0 dBFS since the last reset. */
  clipped: boolean;
  /** Last advance (null before the first sample). */
  lastMs: number | null;
}

const SILENT: readonly [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

export function createMeterState(): MeterState {
  return {
    instantDb: SILENT,
    rmsDb: SILENT,
    holdDb: SILENT,
    holdSetAtMs: [0, 0],
    clipped: false,
    lastMs: null,
  };
}

/** Linear amplitude to dBFS. 0 (and anything non-positive) is -Infinity. */
export function dbfs(linear: number): number {
  return linearToDb(linear);
}

/**
 * Bar fill for a dBFS value: 0 at the floor, 1 at 0 dBFS. Values ABOVE 0 dBFS
 * clamp to 1 — the bar cannot grow past full, the clip latch is what reports
 * the overshoot.
 */
export function barFraction(db: number): number {
  if (!Number.isFinite(db) || db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB);
}

/** Readout text. Keeps the sign so +1.3 reads as an overshoot, not a typo. */
export function formatDbfs(db: number): string {
  if (!Number.isFinite(db)) return '-∞ dBFS';
  if (db < METER_FLOOR_DB) return `< ${METER_FLOOR_DB.toFixed(1)} dBFS`;
  const rounded = Math.round(db * 10) / 10;
  // -0.04 would render as "-0.0" without this; the sign would flicker.
  const safe = rounded === 0 ? 0 : rounded;
  const sign = safe > 0 ? '+' : '';
  return `${sign}${safe.toFixed(1)} dBFS`;
}

function advanceChannel(
  hold: number,
  setAt: number,
  instant: number,
  nowMs: number,
  lastMs: number | null,
): { hold: number; setAt: number } {
  // Attack is instant: a transient must be visible on the frame it happens.
  if (!(hold > instant)) return { hold: instant, setAt: nowMs };
  if (nowMs - setAt <= METER_HOLD_MS) return { hold, setAt };
  const dtSec = lastMs === null ? 0 : Math.max(0, nowMs - lastMs) / 1000;
  const decayed = hold - METER_DECAY_DB_PER_S * dtSec;
  // Never fall below the current signal — and never below the scale floor:
  // an unbounded decay published values like -401 dBFS on the probe surface
  // (measured in review) while the UI clamped them anyway.
  return { hold: Math.max(METER_FLOOR_DB, Math.max(instant, decayed)), setAt };
}

/**
 * Fold one sampled window into the ballistics. Wall-clock driven on purpose:
 * the rAF cadence is not constant (background tabs and headless runs throttle
 * it), and a frame-counted decay would then lie about the fall rate.
 */
export function advanceMeter(state: MeterState, frame: MeterFrame): MeterState {
  const instant: readonly [number, number] = frame.live
    ? [dbfs(frame.peak[0]), dbfs(frame.peak[1])]
    : SILENT;
  const rms: readonly [number, number] = frame.live
    ? [dbfs(frame.rms[0]), dbfs(frame.rms[1])]
    : SILENT;
  // The latch survives pause/scrub: silencing the mix does not un-clip what
  // already happened; only an explicit reset clears it.
  const clipped =
    state.clipped ||
    (frame.live && (frame.peak[0] > METER_CLIP_LINEAR || frame.peak[1] > METER_CLIP_LINEAR));
  const l = advanceChannel(
    state.holdDb[0],
    state.holdSetAtMs[0],
    instant[0],
    frame.atMs,
    state.lastMs,
  );
  const r = advanceChannel(
    state.holdDb[1],
    state.holdSetAtMs[1],
    instant[1],
    frame.atMs,
    state.lastMs,
  );
  return {
    instantDb: instant,
    rmsDb: rms,
    holdDb: [l.hold, r.hold],
    holdSetAtMs: [l.setAt, r.setAt],
    clipped,
    lastMs: frame.atMs,
  };
}

/** Clear the clip latch and drop the held peaks onto the current signal. */
export function resetMeter(state: MeterState, nowMs: number): MeterState {
  return {
    ...state,
    holdDb: state.instantDb,
    holdSetAtMs: [nowMs, nowMs],
    clipped: false,
    lastMs: nowMs,
  };
}

/** The number under the bars: the louder of the two held peaks. */
export function meterReadoutDb(state: MeterState): number {
  return Math.max(state.holdDb[0], state.holdDb[1]);
}

/** Short label shown INSTEAD of a level when there is no mix to measure. */
export function meterInactiveLabel(reason: MeterReason, shuttleActive: boolean): string | null {
  if (reason === 'running') return null;
  if (reason === 'no-context') return 'Ölçüm yok';
  if (reason === 'blocked') return 'Engellendi';
  // Shuttle silence is structural (the engine stays paused) — say the same
  // sentence the transport badge says instead of inventing a second one.
  return shuttleActive || reason === 'shuttle' ? 'Ses kapalı' : 'Duraklatıldı';
}

/** Tooltip for the inactive label — why there is nothing to measure. */
export function meterInactiveHint(reason: MeterReason, shuttleActive: boolean): string | null {
  if (reason === 'running') return null;
  if (reason === 'no-context') {
    return 'Ses motoru ilk oynatmaya kadar kurulmaz (tarayıcı otomatik oynatma kuralı). Oynatınca ölçüm başlar.';
  }
  if (reason === 'blocked') {
    return 'Tarayıcı otomatik oynatmayı engelledi; oynatmak için oynatıcıya tıklayın.';
  }
  return shuttleActive || reason === 'shuttle'
    ? 'Geri tarama sessizdir: motor duraklı kalır, ses zarfı hiç kurulmaz.'
    : 'Motor duraklatılmışken ses zarfı sıfırlanır — ölçülecek miks yoktur.';
}

/**
 * The honesty note (rendering-semantics section 8.3, poc-bilinen-sinirlar 2.6).
 * Kept here so the claim is unit-tested rather than drifting inside JSX.
 */
export function meterHonestyNote(): string {
  return [
    'Bu ölçer ÖNİZLEME miksini ölçer, dışa aktarma miksini değil.',
    'Önizlemede limiter yoktur: 0 dBFS aşımında burada kırmızı yanar, dışa aktarımda alimiter (limit=0,98) onu yakalar ve çıktı temiz çıkar (ölçüm: önizleme tepesi 1,163 / export 0,950).',
    'Önizleme proxy sesi çalar, dışa aktarma orijinali çözer; ölçülen önizleme-export RMS farkı tipik rejimlerde 0,70 dB’ye kadar, limiter rejiminde 1,20 dB, ölçülen EN BÜYÜK fark hız 2x rejiminde 1,24 dB.',
    'Önizleme aynı anda en fazla 4 medya çözücü kullanır: oynatıcıda eksik-ses notu görünürken ölçer EKSİK miksi ölçüyordur.',
    'Tam ölçekli sinüs RMS değeri -3,0 dBFS okur (sinüs referans ofseti uygulanmaz).',
  ].join(' ');
}
