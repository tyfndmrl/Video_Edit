/**
 * useKeyframeInspector — the keyframe layer of the Inspector, packaged so the
 * property panel only has to ask three questions per field:
 *   - `adornment(channel)`      what to render next to the field
 *   - `display(channel, base)`  which number to show
 *   - `writeChannel(ch, v)`     did this edit belong to a keyframe?
 *
 * Keeping it here (instead of inlining in ClipPropertiesPanel) is deliberate:
 * the panel is a busy file owned by the properties slice, and the keyframe
 * rules — which channel is animated, what time to write at, how a drag
 * coalesces — are this feature's business, not the panel's.
 *
 * WHY THE FIELDS SHOW A DIFFERENT NUMBER THAN THE CLIP
 * ---------------------------------------------------
 * Once a channel is animated, `clip.transform.x` (the static base) is no longer
 * what the compositor draws — `sampleKeyframes` wins (rendering-semantics
 * §3.3). A panel that kept showing the base would be showing a number that
 * affects nothing, and typing into it would appear to do nothing. So an
 * animated field shows the SAMPLE at the playhead and writes back to the
 * keyframe at the playhead (creating one if there is none).
 *
 * PLAYHEAD SUBSCRIPTION (perf, on purpose)
 * ----------------------------------------
 * When the selected clip has keyframes the panel must follow the playhead
 * exactly, so it subscribes to it and re-renders while playing — the displayed
 * values genuinely change every frame. When the clip has NO keyframes, the only
 * playhead-dependent thing is whether the diamond buttons are usable, which is
 * a boolean; the hook subscribes to that boolean instead, so selecting a clip
 * does not turn the Inspector into a 60 Hz re-render during playback. The WRITE
 * path never trusts the rendered value: it reads the playhead from the store at
 * click time.
 */
import { useMemo, type ReactNode } from 'react';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { isLiveEditOpen, updateLiveEdit } from '../inspector/liveEdit';
import { AnimatedBadge, KeyframeToggle } from './KeyframeToggle';
import {
  CHANNEL_META,
  animatedChannels,
  buildKeyframePanelModel,
  keyframeTimeAtPlayhead,
  locateClip,
  type KeyframeChannel,
  type KeyframePanelModel,
} from './keyframeModel';
import {
  applyKeyframeValueToDraft,
  clearChannel,
  setKeyframeValue,
  toggleKeyframe,
} from './keyframeOps';

export interface KeyframeInspector {
  model: KeyframePanelModel;
  /** The diamond buttons may be used (single, unlocked clip, session ready). */
  enabled: boolean;
  /** Node for the field's `adornment` slot, or null for a channel this clip
   *  kind cannot animate. */
  adornment(channel: KeyframeChannel): ReactNode | null;
  /** Sampled value when the channel is animated, otherwise `fallback`. */
  display(channel: KeyframeChannel, fallback: number | null): number | null;
  /**
   * Routes an edit to the keyframe at the playhead. Returns false when the
   * channel is still static — the caller then uses its normal base-value op,
   * so nothing changes for a clip nobody has animated.
   */
  writeChannel(channel: KeyframeChannel, value: number): boolean;
  /** "Animasyonlu: Opaklık (2)" — the human summary line. */
  summary: string | null;
}

export function useKeyframeInspector(sessionReady: boolean): KeyframeInspector {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);

  /** The single selected clip (or null) — playhead independent. */
  const selected = useMemo(() => {
    if (selection.size !== 1) return null;
    const [clipId] = [...selection];
    if (clipId === undefined) return null;
    return locateClip(doc, clipId);
  }, [doc, selection]);

  const hasAnimation = selected !== null && animatedChannels(selected.clip).length > 0;
  const startUs = selected?.clip.timelineStartUs ?? 0;
  const endUs = startUs + (selected?.clip.timelineDurationUs ?? 0);

  // See the header: exact time when it is visible, a coarse boolean otherwise.
  const playheadSignal = useEditorStore((s) =>
    hasAnimation
      ? s.playheadUs
      : selected !== null && s.playheadUs >= startUs && s.playheadUs < endUs
        ? 1
        : 0,
  );
  const playheadUs = hasAnimation ? playheadSignal : useEditorStore.getState().playheadUs;

  const model = useMemo(
    () => buildKeyframePanelModel(doc, selection, playheadUs),
    // playheadSignal is the reactive trigger; playheadUs is read from it (or
    // from the store) above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, selection, playheadUs, playheadSignal],
  );

  const clip = selected?.clip ?? null;
  const enabled = model.clipId !== null && model.editable && model.inRange && sessionReady;

  /** The write time, read from the LIVE store (never from a rendered value). */
  const timeNow = (): number => {
    if (clip === null) return 0;
    return keyframeTimeAtPlayhead(clip, useEditorStore.getState().playheadUs, doc.settings.fps);
  };

  const adornment = (channel: KeyframeChannel): ReactNode | null => {
    const state = model.channels[channel];
    // Hide the diamond only when we KNOW this clip cannot animate the property
    // (an audio clip has no opacity). With no single selection the button stays
    // — DISABLED, with the reason in its tooltip. Silently removing a control
    // teaches the user it does not exist.
    if (model.clipId !== null && !state.available) return null;
    const clipId = model.clipId;
    return (
      <span className="flex shrink-0 items-center gap-1">
        {state.animated && <AnimatedBadge count={state.count} />}
        <KeyframeToggle
          channel={channel}
          state={state}
          enabled={enabled && clipId !== null}
          disabledReason={
            model.clipId === null
              ? 'Keyframe için TEK klip seçili olmalı'
              : !model.editable
                ? 'Track kilitli'
                : !model.inRange
                  ? "Playhead klibin dışında — keyframe klip üzerinde eklenir"
                  : 'Proje yükleniyor'
          }
          onToggle={() => {
            if (clipId !== null) toggleKeyframe(clipId, channel, timeNow());
          }}
          onClear={() => {
            if (clipId !== null) clearChannel(clipId, channel, timeNow());
          }}
        />
      </span>
    );
  };

  const display = (channel: KeyframeChannel, fallback: number | null): number | null => {
    const state = model.channels[channel];
    return state.animated ? state.value : fallback;
  };

  const writeChannel = (channel: KeyframeChannel, value: number): boolean => {
    const clipId = model.clipId;
    if (clipId === null || !model.editable || !sessionReady) return false;
    if (!model.channels[channel].animated) return false;
    const at = timeNow();
    if (isLiveEditOpen()) {
      updateLiveEdit((d) => void applyKeyframeValueToDraft(d, clipId, channel, at, value));
    } else {
      setKeyframeValue(clipId, channel, at, value);
    }
    return true;
  };

  const summary =
    model.animated.length === 0
      ? null
      : model.animated
          .map((c) => `${CHANNEL_META[c].label} (${model.channels[c].count})`)
          .join(', ');

  return {
    model,
    enabled,
    adornment,
    display,
    writeChannel,
    summary,
  };
}
