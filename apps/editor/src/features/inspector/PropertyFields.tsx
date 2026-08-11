/**
 * PropertyFields — the inspector's input primitives.
 *
 * Two interaction paths on purpose, because they need different undo shapes:
 * - GESTURE (slider thumb, scrub-drag on a label): pointerdown opens a
 *   docStore transaction via liveEdit, every intermediate value coalesces into
 *   it, and the pointerup closes it -> ONE history entry per drag.
 * - DISCRETE (typing a number, Enter/blur, stepper arrows): no transaction, a
 *   single op call -> one history entry per committed edit.
 *
 * A mixed multi-selection renders as "—" (empty text input, dimmed slider at
 * its neutral position). Touching the control writes the new value to EVERY
 * selected clip, which is why the fallback position is neutral rather than the
 * minimum.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MIXED_LABEL } from './clipInspectorModel';
import {
  beginBurstEdit,
  beginLiveEdit,
  endBurstEdit,
  endLiveEdit,
  isBurstEditOpen,
  isGestureActive,
  isLiveEditBlocked,
} from './liveEdit';
import {
  commitNumberText,
  displayNumberText,
  roundToDecimals,
} from './numberFieldModel';

export interface GestureLabel {
  actionType: string;
  label: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function PropertySection({
  title,
  children,
  action,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="border-b border-edge px-3 py-2.5" data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold tracking-wide text-fg-muted uppercase">{title}</h4>
        {action}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-fg" title={value}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderFieldProps {
  id: string;
  label: string;
  /** null = mixed selection. */
  value: number | null;
  /** Slider position used while the selection is mixed (neutral, not min). */
  neutral: number;
  min: number;
  max: number;
  step: number;
  /** Right-aligned readout ("1.00×", "0.25 s", "—"). */
  valueText: string;
  /** Secondary readout (dB label). */
  hint?: string;
  disabled?: boolean;
  gesture: GestureLabel;
  onChange(value: number): void;
  testId?: string;
}

export function SliderField({
  id,
  label,
  value,
  neutral,
  min,
  max,
  step,
  valueText,
  hint,
  disabled = false,
  gesture,
  onChange,
  testId,
}: SliderFieldProps) {
  const mixed = value === null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <label htmlFor={id} className="shrink-0 text-fg-muted">
          {label}
        </label>
        <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-fg">
          {valueText}
          {hint !== undefined && <span className="text-[10px] text-fg-muted">{hint}</span>}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={mixed ? neutral : value}
        disabled={disabled}
        data-testid={testId}
        data-mixed={mixed ? 'true' : undefined}
        className={`h-4 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40 ${
          mixed ? 'opacity-50' : ''
        }`}
        // Gesture start: everything until pointerup collapses into one entry.
        onPointerDown={() => {
          if (!disabled) beginLiveEdit(gesture.actionType, gesture.label);
        }}
        onChange={(e) => {
          // beginLiveEdit refused (project loading, or a timeline/gizmo drag
          // owns the store): writing anyway would spray one history entry per
          // pixel of this drag. Keyboard arrows never open a gesture, so they
          // still fall through to the plain op.
          if (isLiveEditBlocked()) return;
          onChange(Number(e.target.value));
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numeric field with a scrub-draggable label
// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  id: string;
  label: string;
  /** null = mixed selection (input shows an empty "—" placeholder). */
  value: number | null;
  min: number;
  max: number;
  step: number;
  decimals: number;
  /** Value change per pixel of horizontal scrub-drag on the label. */
  perPixel: number;
  unit?: string;
  disabled?: boolean;
  gesture: GestureLabel;
  onChange(value: number): void;
  testId?: string;
}

export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  decimals,
  perPixel,
  unit,
  disabled = false,
  gesture,
  onChange,
  testId,
}: NumberFieldProps) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ startX: number; base: number } | null>(null);

  // While the user is not typing, the input mirrors the document.
  useEffect(() => {
    if (editing) return;
    setText(displayNumberText(value, decimals));
  }, [value, decimals, editing]);

  /**
   * DISCRETE path (Enter, blur, stepper arrows). Parse/clamp/round rules live
   * in numberFieldModel so they are unit-testable without a DOM.
   *
   * Reentrancy guard: a pointer gesture anywhere in the panel owns the open
   * transaction, and a mousedown on a scrub label BLURS whatever input had
   * focus. Committing then would fold a stale typed number into someone else's
   * drag, under someone else's history label. Stand down instead; the effect
   * above redraws the field from the document.
   */
  const commit = (raw: string): void => {
    if (isGestureActive()) {
      setText(displayNumberText(value, decimals));
      return;
    }
    const result = commitNumberText(raw, { min, max, decimals });
    if (result.kind === 'revert') {
      setText(displayNumberText(value, decimals));
      return;
    }
    onChange(result.value);
  };

  const onScrubDown = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    if (disabled) return;
    // The store refused a transaction (project loading, or the timeline/gizmo
    // owns it): do not start a drag at all rather than emit one history entry
    // per pixel. beginLiveEdit still marks the gesture, so the pointerup
    // safety net clears it.
    if (!beginLiveEdit(gesture.actionType, gesture.label)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, base: value ?? 0 };
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const d = drag.current;
    if (d === null) return;
    const next = clamp(d.base + (e.clientX - d.startX) * perPixel, min, max);
    onChange(roundToDecimals(next, decimals));
  };
  const onScrubUp = (): void => {
    if (drag.current === null) return;
    drag.current = null;
    // liveEdit also listens on window; calling end() here keeps the commit
    // adjacent to the gesture even if the window listener never installed.
    endLiveEdit();
  };

  return (
    <div className="flex items-center gap-2">
      <span
        // Scrub area: dragging the LABEL is the fast path, the input is the
        // exact path. touch-none stops the browser from panning instead.
        role="presentation"
        data-testid={testId !== undefined ? `${testId}-scrub` : undefined}
        className={`w-16 shrink-0 touch-none select-none text-[11px] text-fg-muted ${
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ew-resize hover:text-fg'
        }`}
        title={`${label} — sürükleyerek değiştir`}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        onLostPointerCapture={onScrubUp}
      >
        {label}
      </span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        placeholder={value === null ? MIXED_LABEL : undefined}
        disabled={disabled}
        data-testid={testId}
        className="min-w-0 flex-1 rounded border border-edge bg-surface-2 px-2 py-1 text-right font-mono text-[11px] text-fg disabled:opacity-40"
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={(e) => {
          setEditing(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          // A scrub drag is mid-flight: keys must not reach into its
          // transaction (see commit()).
          if (isGestureActive()) return;
          if (e.key === 'Enter') {
            setEditing(false);
            commit((e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            setEditing(false);
            setText(displayNumberText(value, decimals));
          }
        }}
        onKeyUp={(e) => {
          if (isGestureActive()) return;
          // Stepper arrows change the input value directly; commit them so the
          // field does not silently hold an uncommitted number.
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            setEditing(false);
            commit((e.target as HTMLInputElement).value);
          }
        }}
      />
      {unit !== undefined && (
        <span className="w-5 shrink-0 text-[10px] text-fg-muted">{unit}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-line text (the text clip's content)
// ---------------------------------------------------------------------------

export interface TextAreaFieldProps {
  id: string;
  label: string;
  /** null = mixed selection (empty box with a "—" placeholder). */
  value: string | null;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** History label for the whole typing burst (see liveEdit.beginBurstEdit). */
  burst: GestureLabel;
  onChange(value: string): void;
  testId?: string;
}

/**
 * Typing writes to the document on EVERY keystroke (the preview raster is the
 * feedback the user is typing for), but the whole burst collapses into ONE
 * history entry and one autosave PUT — the field owns the burst lifecycle and
 * the parent decides where the value goes, exactly like the slider/scrub split.
 */
export function TextAreaField({
  id,
  label,
  value,
  rows = 3,
  placeholder,
  disabled = false,
  burst,
  onChange,
  testId,
}: TextAreaFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);

  // While the user is not typing, the box mirrors the document (undo, a new
  // selection, another client's edit).
  useEffect(() => {
    if (editing) return;
    setText(value ?? '');
  }, [value, editing]);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-fg-muted">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        value={text}
        placeholder={value === null ? MIXED_LABEL : placeholder}
        disabled={disabled}
        data-testid={testId}
        spellCheck={false}
        className="w-full resize-y rounded border border-edge bg-surface-2 px-2 py-1 text-[12px] leading-snug text-fg disabled:opacity-40"
        onChange={(e) => {
          if (disabled) return;
          // Could not open a burst (project loading, or a timeline/gizmo drag
          // owns the store): write NOTHING rather than one history entry per
          // keystroke — same stance as isLiveEditBlocked() on the slider path.
          if (!isBurstEditOpen() && !beginBurstEdit(burst.actionType, burst.label, (t) => t === ref.current)) {
            return;
          }
          setEditing(true);
          setText(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => {
          setEditing(false);
          endBurstEdit();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colour (hex text + native swatch)
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface ColorFieldProps {
  id: string;
  label: string;
  /** null = mixed selection. */
  value: string | null;
  disabled?: boolean;
  /** History label used while dragging inside the native picker. */
  burst: GestureLabel;
  onChange(value: string): void;
  testId?: string;
}

/**
 * Two inputs, one value. The swatch is the pleasant path (and its live drag is
 * coalesced through a burst); the hex box is the EXACT path — and the only one
 * a keyboard, a screen reader or a Playwright `page.keyboard.type()` can drive,
 * which is why it is not optional decoration.
 */
export function ColorField({
  id,
  label,
  value,
  disabled = false,
  burst,
  onChange,
  testId,
}: ColorFieldProps) {
  const swatchRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return;
    setText(value ?? '');
  }, [value, editing]);

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (!HEX_RE.test(trimmed)) {
      setText(value ?? ''); // invalid: revert, never write a broken color
      return;
    }
    onChange(trimmed);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-fg-muted">{label}</span>
      <input
        ref={swatchRef}
        id={`${id}-swatch`}
        type="color"
        value={value ?? '#000000'}
        disabled={disabled}
        data-testid={testId !== undefined ? `${testId}-swatch` : undefined}
        aria-label={`${label} (renk seçici)`}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-edge bg-surface-2 disabled:opacity-40"
        onChange={(e) => {
          if (disabled) return;
          if (
            !isBurstEditOpen() &&
            !beginBurstEdit(burst.actionType, burst.label, (t) => t === swatchRef.current)
          ) {
            return;
          }
          onChange(e.target.value);
        }}
        onBlur={() => endBurstEdit()}
      />
      <input
        id={id}
        type="text"
        value={text}
        placeholder={value === null ? MIXED_LABEL : '#rrggbb'}
        disabled={disabled}
        data-testid={testId}
        spellCheck={false}
        className="min-w-0 flex-1 rounded border border-edge bg-surface-2 px-2 py-1 text-right font-mono text-[11px] text-fg disabled:opacity-40"
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={(e) => {
          setEditing(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setEditing(false);
            commit((e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            setEditing(false);
            setText(value ?? '');
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select / segmented choice
// ---------------------------------------------------------------------------

export interface SelectFieldProps<T extends string> {
  id: string;
  label: string;
  /** null = mixed selection (renders an extra, non-selectable "—" option). */
  value: T | null;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange(value: T): void;
  testId?: string;
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  disabled = false,
  onChange,
  testId,
}: SelectFieldProps<T>) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-16 shrink-0 text-[11px] text-fg-muted">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        data-testid={testId}
        className="min-w-0 flex-1 rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-fg disabled:opacity-40"
        onChange={(e) => onChange(e.target.value as T)}
      >
        {value === null && (
          <option value="" disabled>
            {MIXED_LABEL}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Small button row for 2-4 exclusive choices (alignment, shape type). */
export function SegmentedField<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
  testId,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string; title?: string }[];
  disabled?: boolean;
  onChange(value: T): void;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-1 gap-1" role="group" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.title ?? o.label}
            disabled={disabled}
            aria-pressed={value === o.value}
            data-testid={testId !== undefined ? `${testId}-${o.value}` : undefined}
            className={`min-w-0 flex-1 rounded border px-1 py-1 text-[11px] disabled:pointer-events-none disabled:opacity-40 ${
              value === o.value
                ? 'border-accent/60 bg-accent/10 text-fg'
                : 'border-edge bg-surface-2 text-fg-muted hover:text-fg'
            }`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export function ToggleField({
  label,
  /** null = mixed selection. */
  value,
  disabled = false,
  onChange,
  testId,
}: {
  label: string;
  value: boolean | null;
  disabled?: boolean;
  onChange(value: boolean): void;
  testId?: string;
}) {
  const mixed = value === null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? 'mixed' : value}
      disabled={disabled}
      data-testid={testId}
      // A mixed selection turns the toggle ON first (the useful direction:
      // "mute everything"), then it behaves normally.
      onClick={() => onChange(mixed ? true : !value)}
      className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-[11px] disabled:pointer-events-none disabled:opacity-40 ${
        value === true
          ? 'border-accent/60 bg-accent/10 text-fg'
          : 'border-edge bg-surface-2 text-fg-muted hover:text-fg'
      }`}
    >
      <span>{label}</span>
      <span className="font-mono text-[10px]">
        {mixed ? MIXED_LABEL : value ? 'Açık' : 'Kapalı'}
      </span>
    </button>
  );
}
