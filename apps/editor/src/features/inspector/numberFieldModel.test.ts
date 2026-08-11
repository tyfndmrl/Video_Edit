/**
 * NumberField — DISCRETE path (type a number + Enter/blur, stepper arrows).
 *
 * Until this file existed only the scrub-drag path was covered, so the typed
 * path could quietly write out-of-contract values (typing 50 into "Ölçek").
 * The real DOM wiring is proven with page.keyboard in
 * apps/editor/e2e/inspector.spec.ts; these are the rules behind it.
 */
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings } from '../../state/docStore';
import { POSITION_DECIMALS, POSITION_LIMIT, SCALE_DECIMALS, SCALE_MIN, maxClipScale } from '../../state/timelineOps';
import {
  commitNumberText,
  displayNumberText,
  parseNumberInput,
  roundToDecimals,
} from './numberFieldModel';

const SCALE_BOUNDS = {
  min: SCALE_MIN,
  max: maxClipScale(defaultProjectSettings),
  decimals: SCALE_DECIMALS,
};
const POSITION_BOUNDS = {
  min: -POSITION_LIMIT,
  max: POSITION_LIMIT,
  decimals: POSITION_DECIMALS,
};

describe('parseNumberInput', () => {
  it('accepts a plain decimal', () => {
    expect(parseNumberInput('1.25')).toBe(1.25);
    expect(parseNumberInput('  -0.5 ')).toBe(-0.5);
  });

  it('accepts a decimal COMMA (Turkish numeric keypad)', () => {
    expect(parseNumberInput('1,25')).toBe(1.25);
  });

  it('rejects empty and garbage instead of producing NaN', () => {
    for (const raw of ['', '   ', 'abc', '1.2.3', '--4']) {
      expect(parseNumberInput(raw), raw).toBeNull();
    }
  });

  it('rejects Infinity (a field must never write a non-finite number)', () => {
    expect(parseNumberInput('Infinity')).toBeNull();
    expect(parseNumberInput('-Infinity')).toBeNull();
  });
});

describe('commitNumberText', () => {
  it('writes an in-range value rounded to the stored precision', () => {
    expect(commitNumberText('1.2345', SCALE_BOUNDS)).toEqual({ kind: 'write', value: 1.235 });
    expect(commitNumberText('1.2344', SCALE_BOUNDS)).toEqual({ kind: 'write', value: 1.234 });
    expect(commitNumberText('0.12345', POSITION_BOUNDS)).toEqual({ kind: 'write', value: 0.1235 });
  });

  it('CLAMPS an over-range entry to the project ceiling instead of reverting', () => {
    // "Type 50 into Ölçek" is the exported-document bug: the compiler caps a
    // layer at 8192 px, which is scale 4.266 at 1080p.
    const result = commitNumberText('50', SCALE_BOUNDS);
    expect(result).toEqual({ kind: 'write', value: 4.266 });
    expect(Math.floor(defaultProjectSettings.width * 4.266 + 0.5)).toBeLessThanOrEqual(8192);
  });

  it('CLAMPS an under-range entry up to the positive floor (scale 0 is unexportable)', () => {
    expect(commitNumberText('0', SCALE_BOUNDS)).toEqual({ kind: 'write', value: SCALE_MIN });
    expect(commitNumberText('-7', SCALE_BOUNDS)).toEqual({ kind: 'write', value: SCALE_MIN });
    expect(SCALE_MIN).toBeGreaterThan(0);
  });

  it('reverts on empty or unparseable text (nothing to guess)', () => {
    expect(commitNumberText('', SCALE_BOUNDS)).toEqual({ kind: 'revert' });
    expect(commitNumberText('abc', SCALE_BOUNDS)).toEqual({ kind: 'revert' });
    expect(commitNumberText('NaN', SCALE_BOUNDS)).toEqual({ kind: 'revert' });
  });

  it('handles the stepper-arrow path identically (it commits the input value)', () => {
    // A stepper arrow just rewrites the input; the commit rules must not differ.
    expect(commitNumberText('4.27', SCALE_BOUNDS)).toEqual({ kind: 'write', value: 4.266 });
    expect(commitNumberText('4.26', SCALE_BOUNDS)).toEqual({ kind: 'write', value: 4.26 });
  });

  it('keeps every clamped scale inside the export contract', () => {
    for (const raw of ['-100', '0', '0.0001', '1', '4.266', '4.267', '999']) {
      const result = commitNumberText(raw, SCALE_BOUNDS);
      expect(result.kind, raw).toBe('write');
      if (result.kind !== 'write') continue;
      expect(result.value, raw).toBeGreaterThan(0);
      expect(
        Math.floor(defaultProjectSettings.width * result.value + 0.5),
        raw,
      ).toBeLessThanOrEqual(8192);
    }
  });
});

describe('roundToDecimals / displayNumberText', () => {
  it('rounds half away from zero at the given precision', () => {
    expect(roundToDecimals(0.1 + 0.2, 4)).toBe(0.3);
    expect(roundToDecimals(1 / 3, 3)).toBe(0.333);
    expect(roundToDecimals(12.3456, 2)).toBe(12.35);
  });

  it('shows an empty string for a mixed selection', () => {
    expect(displayNumberText(null, 3)).toBe('');
    expect(displayNumberText(1, 3)).toBe('1.000');
    expect(displayNumberText(-0.5, 4)).toBe('-0.5000');
  });
});
