/**
 * KeyframeToggle — the diamond button that sits next to every animatable
 * Inspector field.
 *
 * Three states, all visible at a glance (and all readable by a test through
 * `data-*`, because the difference between "animated" and "keyframe HERE" is
 * exactly what a user gets wrong):
 *   ◇  static        — no keyframes on this channel
 *   ◆  animated      — the channel has keyframes, but none at the playhead
 *   ◆̲  keyed here    — a keyframe sits exactly at the playhead (filled + ring)
 *
 * Clicking toggles the keyframe AT the playhead (add capturing the current
 * value / remove). Alt+click clears the whole channel, which is the only way
 * back to a static property once a curve exists.
 */
import { CHANNEL_META, type ChannelState, type KeyframeChannel } from './keyframeModel';

export interface KeyframeToggleProps {
  channel: KeyframeChannel;
  state: ChannelState;
  /** False when the selection is not a single editable clip, or the playhead
   *  is outside it (there would be no honest time to write at). */
  enabled: boolean;
  /** Why it is disabled — shown in the tooltip instead of a dead button. */
  disabledReason?: string;
  onToggle(): void;
  onClear(): void;
}

export function KeyframeToggle({
  channel,
  state,
  enabled,
  disabledReason,
  onToggle,
  onClear,
}: KeyframeToggleProps) {
  const keyedHere = state.atTime !== null;
  const meta = CHANNEL_META[channel];
  const title = !enabled
    ? (disabledReason ?? 'Keyframe eklenemiyor')
    : keyedHere
      ? `${meta.label}: playhead'deki keyframe'i kaldır (Alt+tık: tüm animasyonu temizle)`
      : state.animated
        ? `${meta.label}: playhead'e keyframe ekle (${state.count} keyframe var, Alt+tık: temizle)`
        : `${meta.label}: keyframe ekle — bu andaki değerden başlar`;

  return (
    <button
      type="button"
      data-testid={`clip-kf-${channel}`}
      data-animated={state.animated ? 'true' : 'false'}
      data-keyed={keyedHere ? 'true' : 'false'}
      data-count={state.count}
      aria-pressed={keyedHere}
      aria-label={`${meta.label} keyframe`}
      title={title}
      disabled={!enabled}
      onClick={(e) => {
        if (e.altKey && state.animated) onClear();
        else onToggle();
      }}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] leading-none disabled:pointer-events-none disabled:opacity-40 ${
        keyedHere
          ? 'border-accent bg-accent/25 text-accent'
          : state.animated
            ? 'border-accent/50 text-accent'
            : 'border-edge text-fg-muted hover:text-fg'
      }`}
    >
      {state.animated ? '◆' : '◇'}
    </button>
  );
}

/**
 * "Animated" badge for a field's readout: says the number shown is a SAMPLE of
 * a curve at the playhead, not the static value stored on the clip. Without it
 * the panel silently shows a different number than the document holds.
 */
export function AnimatedBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="clip-kf-animated-badge"
      className="rounded bg-accent/15 px-1 text-[9px] text-accent"
      title={`Animasyonlu — ${count} keyframe. Gösterilen değer playhead anındaki örnektir.`}
    >
      ANİM
    </span>
  );
}
