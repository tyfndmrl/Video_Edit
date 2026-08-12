/**
 * KeyframeEasingPicker — the easing control that sits next to the Inspector's
 * diamond button, active exactly when a keyframe is at the playhead.
 *
 * WHY THIS EXISTS (it is not a duplicate of the strip's right-click menu)
 * ----------------------------------------------------------------------
 * Before this control, easing had ONE entry point: right-clicking a diamond on
 * the timeline strip. The strip shows at most `KEYFRAME_STRIP_MAX_ROWS`
 * channels, so on a clip animating three or more channels the easing of the
 * folded ones could not be reached at all — the document could hold an easing
 * the UI had no way to read or change. The Inspector already has a row per
 * channel and always shows every one of them, so it is the surface where the
 * control is guaranteed reachable.
 *
 * Positioning: the popover is `fixed` and anchored off the button's own client
 * rect. The Inspector is a scrollable column with `overflow` set, so an
 * absolutely positioned menu would be clipped by it; `fixed` escapes that.
 * (Same reason the strip's own menu is fixed.)
 *
 * Interaction contract:
 * - real buttons, no native <select>: the whole menu must be drivable by a real
 *   mouse in an e2e test, and a native option list is an OS-level popup that
 *   `page.mouse` cannot click;
 * - press anywhere else, or Escape, closes it;
 * - picking an option is ONE `setKeyframeEasing` call = ONE history entry.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Easing, MicroSec, Uuid } from '@videoedit/timeline-schema';
import { CHANNEL_META, EASING_OPTIONS, easingLabel, type KeyframeChannel } from './keyframeModel';
import { setKeyframeEasing } from './keyframeOps';
import { clampMenuPoint } from './menuPosition';

/** Glyph per easing preset — readable in the 20 px button the panel can spare. */
const EASING_GLYPH: Readonly<Record<string, string>> = {
  linear: '╱',
  easeIn: '◞',
  easeOut: '◜',
  easeInOut: '∫',
};

export interface KeyframeEasingPickerProps {
  clipId: Uuid;
  channel: KeyframeChannel;
  /** Clip-relative time of the keyframe at the playhead. */
  timeUs: MicroSec;
  /** That keyframe's current easing. */
  current: Easing;
  /** False for a locked track / loading project — the button stays, disabled. */
  enabled: boolean;
}

export function KeyframeEasingPicker({
  clipId,
  channel,
  timeUs,
  current,
  enabled,
}: KeyframeEasingPickerProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const close = useCallback(() => setAnchor(null), []);

  // The Inspector is the RIGHT-hand column, so a menu anchored to a control's
  // left edge runs off the window — where it is still in the DOM but no real
  // pointer can reach it. Clamp against the measured box, after layout.
  useLayoutEffect(() => {
    if (anchor === null) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuPoint(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.x !== anchor.x || next.y !== anchor.y) setAnchor(next);
  }, [anchor]);

  // Any press outside closes. Capture phase so it lands before a panel drag
  // (the sliders open a docStore transaction on pointerdown).
  useEffect(() => {
    if (anchor === null) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor, close]);

  // The anchor is a screen position: if the panel scrolls (or the playhead
  // moves the keyframe out from under the button) the stale popover would float
  // over unrelated content, so close instead of chasing.
  useEffect(() => {
    close();
  }, [close, clipId, channel, timeUs]);

  const meta = CHANNEL_META[channel];
  const label = easingLabel(current);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={`clip-kf-easing-${channel}`}
        data-easing={current.type}
        data-open={anchor !== null ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`${meta.label} keyframe geçiş eğrisi`}
        title={
          enabled
            ? `${meta.label}: bu keyframe'den sonraki geçiş — ${label}`
            : 'Geçiş eğrisi değiştirilemiyor'
        }
        disabled={!enabled}
        onClick={() => {
          if (anchor !== null) {
            close();
            return;
          }
          const r = buttonRef.current?.getBoundingClientRect();
          if (!r) return;
          setAnchor({ x: r.left, y: r.bottom + 2 });
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-accent/50 text-[10px] leading-none text-accent disabled:pointer-events-none disabled:opacity-40"
      >
        {EASING_GLYPH[current.type] ?? '~'}
      </button>
      {anchor !== null && (
        <div
          ref={menuRef}
          data-testid="clip-kf-easing-menu"
          data-channel={channel}
          role="menu"
          className="fixed z-50 min-w-[150px] rounded border border-edge bg-surface-2 py-1 shadow-lg"
          style={{ left: anchor.x, top: anchor.y }}
        >
          <p className="px-2 pb-1 text-[10px] text-fg-muted">{meta.label} — geçiş eğrisi</p>
          {EASING_OPTIONS.map((option) => (
            <button
              key={option.type}
              type="button"
              role="menuitem"
              data-testid={`clip-kf-easing-option-${option.type}`}
              aria-checked={current.type === option.type}
              className={`block w-full px-2 py-1 text-left text-[11px] hover:bg-surface-3 ${
                current.type === option.type ? 'text-accent' : 'text-fg'
              }`}
              onClick={() => {
                setKeyframeEasing(clipId, channel, timeUs, { type: option.type });
                close();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
