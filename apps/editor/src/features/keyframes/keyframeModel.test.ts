import { describe, it, expect } from 'vitest';
import type { Clip, MediaClip, TimelineDoc, Track } from '@videoedit/timeline-schema';
import {
  CHANNEL_META,
  KEYFRAME_CHANNELS,
  animatedChannels,
  buildKeyframePanelModel,
  channelBaseValue,
  channelBounds,
  channelIsAvailable,
  channelValueAt,
  clampChannelValue,
  easingLabel,
  keyframeAt,
  keyframeSampleBudget,
  keyframeTimeAtPlayhead,
} from './keyframeModel';

const SETTINGS = { width: 1920, height: 1080 };

function mediaClip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'video',
    assetId: '22222222-2222-4222-8222-222222222222',
    timelineStartUs: 1_000_000,
    timelineDurationUs: 4_000_000,
    sourceInUs: 0,
    sourceOutUs: 4_000_000,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0.25, y: -0.1, scale: 1.5, rotationDeg: 30, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 0.8,
    ...over,
  };
}

function docWith(clip: Clip, locked = false): TimelineDoc {
  const track: Track = {
    id: '33333333-3333-4333-8333-333333333333',
    type: 'video',
    muted: false,
    hidden: false,
    locked,
    clips: [clip],
  };
  return {
    schemaVersion: 1,
    projectId: '44444444-4444-4444-8444-444444444444',
    settings: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      backgroundColor: '#000000',
    },
    tracks: [track],
    markers: [],
  };
}

describe('channel vocabulary', () => {
  it('covers exactly the schema KeyframeTracks keys', () => {
    expect([...KEYFRAME_CHANNELS].sort()).toEqual(
      ['opacity', 'rotationDeg', 'scale', 'volume', 'x', 'y'].sort(),
    );
    for (const channel of KEYFRAME_CHANNELS) {
      expect(CHANNEL_META[channel].label.length).toBeGreaterThan(0);
    }
  });

  it('offers volume only where the clip still owns audio', () => {
    expect(channelIsAvailable(mediaClip(), 'volume')).toBe(true);
    expect(channelIsAvailable(mediaClip({ audio: null }), 'volume')).toBe(false);
    expect(channelIsAvailable(mediaClip({ kind: 'image', audio: null }), 'volume')).toBe(false);
  });

  it('hides the visual channels on an audio clip (nothing draws them)', () => {
    const audioClip = mediaClip({ kind: 'audio' });
    expect(channelIsAvailable(audioClip, 'x')).toBe(false);
    expect(channelIsAvailable(audioClip, 'opacity')).toBe(false);
    expect(channelIsAvailable(audioClip, 'volume')).toBe(true);
  });

  it('reads the base value from the right place per channel', () => {
    const clip = mediaClip();
    expect(channelBaseValue(clip, 'x')).toBe(0.25);
    expect(channelBaseValue(clip, 'scale')).toBe(1.5);
    expect(channelBaseValue(clip, 'rotationDeg')).toBe(30);
    expect(channelBaseValue(clip, 'opacity')).toBe(0.8);
    expect(channelBaseValue(clip, 'volume')).toBe(1);
    expect(channelBaseValue(mediaClip({ audio: null }), 'volume')).toBeNull();
  });
});

describe('bounds and clamping', () => {
  it('derives the scale ceiling from the PROJECT, not a constant', () => {
    const hd = channelBounds('scale', { width: 1920, height: 1080 });
    const uhd = channelBounds('scale', { width: 3840, height: 2160 });
    expect(hd.max).toBeGreaterThan(uhd.max);
  });

  it('clamps and rounds like the base-value ops', () => {
    expect(clampChannelValue('opacity', 1.9, SETTINGS)).toBe(1);
    expect(clampChannelValue('opacity', -3, SETTINGS)).toBe(0);
    expect(clampChannelValue('volume', 5, SETTINGS)).toBe(2);
    expect(clampChannelValue('rotationDeg', 400, SETTINGS)).toBe(360);
    expect(clampChannelValue('x', 0.123456789, SETTINGS)).toBe(0.1235);
    expect(clampChannelValue('x', Number.NaN, SETTINGS)).toBeNull();
    expect(clampChannelValue('x', Number.POSITIVE_INFINITY, SETTINGS)).toBeNull();
  });
});

describe('sampling', () => {
  it('falls back to the base value when the channel is empty', () => {
    expect(channelValueAt(mediaClip(), 'opacity', 500_000)).toBe(0.8);
  });

  it('interpolates through the schema reference implementation', () => {
    const clip = mediaClip({
      keyframes: {
        opacity: [
          { timeUs: 0, value: 0, easing: { type: 'linear' } },
          { timeUs: 2_000_000, value: 1, easing: { type: 'linear' } },
        ],
      },
    });
    expect(channelValueAt(clip, 'opacity', 0)).toBe(0);
    expect(channelValueAt(clip, 'opacity', 1_000_000)).toBeCloseTo(0.5, 6);
    expect(channelValueAt(clip, 'opacity', 2_000_000)).toBe(1);
    // Past the last keyframe the value HOLDS (§3.3), it does not extrapolate.
    expect(channelValueAt(clip, 'opacity', 3_500_000)).toBe(1);
  });

  it('clamps the sampling time into the clip (sampleKeyframes needs an integer in range)', () => {
    const clip = mediaClip({
      keyframes: { opacity: [{ timeUs: 0, value: 0.4, easing: { type: 'linear' } }] },
    });
    expect(channelValueAt(clip, 'opacity', -999)).toBe(0.4);
    expect(channelValueAt(clip, 'opacity', 99_000_000)).toBe(0.4);
  });
});

describe('keyframeTimeAtPlayhead', () => {
  const fps = { num: 30, den: 1 };
  const clip = mediaClip(); // [1s, 5s)

  it('converts absolute -> clip relative and snaps to the frame grid', () => {
    // 1.5 s absolute -> 0.5 s into the clip -> frame 15 at 30 fps -> 500000 us.
    expect(keyframeTimeAtPlayhead(clip, 1_500_000, fps)).toBe(500_000);
    // A time between frames snaps to the nearest boundary (33333 us grid).
    expect(keyframeTimeAtPlayhead(clip, 1_010_000, fps)).toBe(0);
    expect(keyframeTimeAtPlayhead(clip, 1_020_000, fps)).toBe(33_333);
  });

  it('clamps outside the clip instead of producing an illegal time', () => {
    expect(keyframeTimeAtPlayhead(clip, 0, fps)).toBe(0);
    expect(keyframeTimeAtPlayhead(clip, 99_000_000, fps)).toBe(clip.timelineDurationUs);
  });
});

describe('buildKeyframePanelModel', () => {
  const animated = mediaClip({
    keyframes: {
      opacity: [
        { timeUs: 0, value: 0, easing: { type: 'linear' } },
        { timeUs: 1_000_000, value: 1, easing: { type: 'linear' } },
      ],
    },
  });

  it('is empty without a single selection (no invented multi-clip semantics)', () => {
    const doc = docWith(animated);
    expect(buildKeyframePanelModel(doc, new Set(), 1_000_000).clipId).toBeNull();
    expect(
      buildKeyframePanelModel(doc, new Set([animated.id, 'other']), 1_000_000).clipId,
    ).toBeNull();
  });

  it('reports the animated channels, the sample and the keyframe at the playhead', () => {
    const doc = docWith(animated);
    // Absolute 1.5 s -> 0.5 s into the clip -> halfway on a linear ramp.
    const model = buildKeyframePanelModel(doc, new Set([animated.id]), 1_500_000);
    expect(model.clipId).toBe(animated.id);
    expect(model.clipTimeUs).toBe(500_000);
    expect(model.inRange).toBe(true);
    expect(model.animated).toEqual(['opacity']);
    expect(model.channels.opacity.count).toBe(2);
    expect(model.channels.opacity.value).toBeCloseTo(0.5, 6);
    expect(model.channels.opacity.atTime).toBeNull();
    // A static channel still reports its base value.
    expect(model.channels.scale.animated).toBe(false);
    expect(model.channels.scale.value).toBe(1.5);
  });

  it('finds the keyframe sitting exactly at the playhead', () => {
    const doc = docWith(animated);
    const model = buildKeyframePanelModel(doc, new Set([animated.id]), 2_000_000);
    expect(model.channels.opacity.atTime?.timeUs).toBe(1_000_000);
    expect(keyframeAt(animated, 'opacity', 1_000_000)?.value).toBe(1);
  });

  it('marks the playhead out of range instead of silently writing at a clip edge', () => {
    const doc = docWith(animated);
    expect(buildKeyframePanelModel(doc, new Set([animated.id]), 100_000).inRange).toBe(false);
    expect(buildKeyframePanelModel(doc, new Set([animated.id]), 9_000_000).inRange).toBe(false);
  });

  it('goes read-only on a locked track', () => {
    const doc = docWith(animated, true);
    expect(buildKeyframePanelModel(doc, new Set([animated.id]), 1_500_000).editable).toBe(false);
  });

  it('lists animated channels in panel order', () => {
    const clip = mediaClip({
      keyframes: {
        opacity: [{ timeUs: 0, value: 1, easing: { type: 'linear' } }],
        x: [{ timeUs: 0, value: 0, easing: { type: 'linear' } }],
      },
    });
    expect(animatedChannels(clip)).toEqual(['x', 'opacity']);
  });
});

describe('easingLabel', () => {
  it('names the presets and calls anything else a custom curve', () => {
    expect(easingLabel({ type: 'linear' })).toBe('Doğrusal');
    expect(easingLabel({ type: 'easeInOut' })).toBe('Yavaş başla ve bitir');
    expect(easingLabel({ type: 'cubicBezier', x1: 0.1, y1: 0, x2: 0.9, y2: 1 })).toBe(
      'Özel eğri',
    );
  });
});

describe('keyframeSampleBudget (Inspector uyarisinin esigi)', () => {
  const curved = (fromUs: number, toUs: number) => [
    { timeUs: fromUs, value: 0, easing: { type: 'easeIn' } as const },
    { timeUs: toUs, value: 1, easing: { type: 'linear' } as const },
  ];

  it('bos dokuman: 0 harcama, uyari yok', () => {
    const status = keyframeSampleBudget(docWith(mediaClip()));
    expect(status.upperBound).toBe(0);
    expect(status.max).toBe(60_000);
    expect(status.warn).toBe(false);
  });

  it('esik ALTI egri animasyon uyari uretmez', () => {
    // 4 s klip @30fps = 120 kare; tek egrili kanal = 120 ornek << 48000.
    const doc = docWith(mediaClip({ keyframes: { x: curved(0, 4_000_000) } }));
    const status = keyframeSampleBudget(doc);
    expect(status.upperBound).toBe(120);
    expect(status.warn).toBe(false);
  });

  it('esige ulasan dokuman uyari uretir (0.8 * 60000 = 48000)', () => {
    // 30fps'te 48000 kare = 1600 s'lik klip; tek egrili kanal esigi tam doldurur.
    const longClip = mediaClip({
      timelineStartUs: 0,
      timelineDurationUs: 1_600_000_000,
      sourceOutUs: 1_600_000_000,
      keyframes: { x: curved(0, 1_600_000_000) },
    });
    const status = keyframeSampleBudget(docWith(longClip));
    expect(status.upperBound).toBe(48_000);
    expect(status.ratio).toBeCloseTo(0.8, 10);
    expect(status.warn).toBe(true);
  });

  it('esigin BIR kare altinda uyari henuz yoktur (sinir keskin)', () => {
    const clip = mediaClip({
      timelineStartUs: 0,
      timelineDurationUs: 1_599_966_667, // 47999 kare
      sourceOutUs: 1_599_966_667,
      keyframes: { x: curved(0, 1_599_966_667) },
    });
    const status = keyframeSampleBudget(docWith(clip));
    expect(status.upperBound).toBe(47_999);
    expect(status.warn).toBe(false);
  });
});
