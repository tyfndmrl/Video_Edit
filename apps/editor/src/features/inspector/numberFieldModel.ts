/**
 * numberFieldModel — the DISCRETE half of NumberField, as pure functions.
 *
 * Why it lives outside the component: the editor's vitest environment is
 * `node` (no DOM), so the typed-number path (parse -> clamp -> round -> write
 * or revert) had no unit coverage at all while the scrub-drag path did. That
 * asymmetry is how "type 50 into Ölçek" could quietly write an unexportable
 * value. The rules are small and total, so they belong in a testable module;
 * the component keeps only the wiring, and the REAL DOM behaviour (typing,
 * Enter, blur, stepper arrows) is proven by apps/editor/e2e/inspector.spec.ts
 * with page.keyboard.
 *
 * Contract: the model never mutates the document. It returns what the field
 * should DO, and the caller routes that through the ops (which clamp again —
 * the op stays the single authority, this is only the input-side story).
 */

export interface NumberFieldBounds {
  min: number;
  max: number;
  /** Decimals the document stores this property with. */
  decimals: number;
}

/** `write` = commit this value; `revert` = drop the text, redraw from the doc. */
export type NumberFieldCommit = { kind: 'write'; value: number } | { kind: 'revert' };

/**
 * Parses one typed field value. Accepts a decimal COMMA as well as a dot —
 * a Turkish keyboard's numeric comma must not silently become NaN.
 * Returns null for empty/garbage/non-finite input.
 */
export function parseNumberInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rounds half-away-from-zero at `decimals` (matches the ops' roundTo). */
export function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * What committing `raw` should do.
 *
 * Out-of-range input CLAMPS rather than reverting: a user typing 50 into a
 * field that tops out at 4.266 means "as big as possible", and silently
 * throwing the entry away reads as a broken field. Garbage reverts, because
 * there is no defensible value to guess.
 */
export function commitNumberText(raw: string, bounds: NumberFieldBounds): NumberFieldCommit {
  const parsed = parseNumberInput(raw);
  if (parsed === null) return { kind: 'revert' };
  const clamped = Math.min(bounds.max, Math.max(bounds.min, parsed));
  return { kind: 'write', value: roundToDecimals(clamped, bounds.decimals) };
}

/** Text the input shows while the user is NOT typing ('' = mixed selection). */
export function displayNumberText(value: number | null, decimals: number): string {
  return value === null ? '' : value.toFixed(decimals);
}
