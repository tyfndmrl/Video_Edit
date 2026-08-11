import { describe, it, expect } from 'vitest';
import type { Clip, MediaClip, TimelineDoc, Track } from '@videoedit/timeline-schema';
import {
  TRACK_H,
  TRANSITION_BADGE_BOTTOM_GAP,
  TRANSITION_BADGE_H,
  trackTop,
} from '../timeline/geometry';
import {
  KEYFRAME_HIT_SLOP_PX,
  KEYFRAME_ROW_H,
  KEYFRAME_STRIP_MAX_ROWS,
  buildStripLayout,
  hitTestStrip,
  stripHitRect,
  xToClipTimeUs,
} from './stripGeometry';

const US = 1_000_000;
const CLIP_ID = '01890000-0000-7000-8000-000000000201';
/** 0.0001 px/us = 100 px per second — the editor's default-ish zoom. */
const PX_PER_US = 0.0001;
const NAME_BAR_BOTTOM = 2 + 15;

function clipWith(keyframes: MediaClip['keyframes']): MediaClip {
  return {
    id: CLIP_ID,
    kind: 'video',
    assetId: '01890000-0000-7000-8000-00000000000a',
    timelineStartUs: 2 * US,
    timelineDurationUs: 4 * US,
    sourceInUs: 0,
    sourceOutUs: 4 * US,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes,
    effects: [],
    opacity: 1,
  };
}

function docWith(clip: Clip, locked = false): TimelineDoc {
  const track: Track = {
    id: '01890000-0000-7000-8000-000000000101',
    type: 'video',
    muted: false,
    hidden: false,
    locked,
    clips: [clip],
  };
  return {
    schemaVersion: 1,
    projectId: '01890000-0000-7000-8000-000000000001',
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

const input = (doc: TimelineDoc, selection: string[]) => ({
  doc,
  selection: new Set(selection),
  scrollUs: 0,
  pxPerUs: PX_PER_US,
  widthPx: 1200,
});

const twoKeyframes = {
  opacity: [
    { timeUs: 0, value: 0, easing: { type: 'linear' as const } },
    { timeUs: 2 * US, value: 1, easing: { type: 'linear' as const } },
  ],
};

describe('buildStripLayout', () => {
  it('is null unless exactly one ANIMATED clip is selected', () => {
    const bare = docWith(clipWith({}));
    expect(buildStripLayout(input(bare, [CLIP_ID]))).toBeNull();

    const animated = docWith(clipWith(twoKeyframes));
    expect(buildStripLayout(input(animated, []))).toBeNull();
    expect(buildStripLayout(input(animated, [CLIP_ID, 'other']))).toBeNull();
    expect(buildStripLayout(input(animated, [CLIP_ID]))).not.toBeNull();
  });

  it('places the band between the name bar and the transition badge', () => {
    const layout = buildStripLayout(input(docWith(clipWith(twoKeyframes)), [CLIP_ID]))!;
    const badgeTop = trackTop(0) + TRACK_H - TRANSITION_BADGE_H - TRANSITION_BADGE_BOTTOM_GAP;
    expect(layout.bottomY).toBeLessThan(badgeTop);
    expect(layout.topY).toBeGreaterThanOrEqual(trackTop(0) + NAME_BAR_BOTTOM);
    expect(layout.bottomY - layout.topY).toBe(KEYFRAME_ROW_H);
  });

  it('maps keyframe times through the timeline transform', () => {
    const layout = buildStripLayout(input(docWith(clipWith(twoKeyframes)), [CLIP_ID]))!;
    const [row] = layout.rows;
    expect(row.channel).toBe('opacity');
    // Clip starts at 2 s; keyframe 0 is at the clip's left edge.
    expect(row.diamonds[0].x).toBeCloseTo(2 * US * PX_PER_US, 6);
    expect(row.diamonds[1].x).toBeCloseTo(4 * US * PX_PER_US, 6);
  });

  it('caps the rows and reports what it folded away', () => {
    const clip = clipWith({
      x: [{ timeUs: 0, value: 0, easing: { type: 'linear' } }],
      y: [{ timeUs: 0, value: 0, easing: { type: 'linear' } }],
      scale: [{ timeUs: 0, value: 1, easing: { type: 'linear' } }],
      opacity: [{ timeUs: 0, value: 1, easing: { type: 'linear' } }],
    });
    const layout = buildStripLayout(input(docWith(clip), [CLIP_ID]))!;
    expect(layout.rows).toHaveLength(KEYFRAME_STRIP_MAX_ROWS);
    expect(layout.rows.map((r) => r.channel)).toEqual(['x', 'y']);
    expect(layout.hiddenChannels).toEqual(['scale', 'opacity']);
  });

  it('vanishes when the clip is too narrow to hold a grabbable diamond', () => {
    const doc = docWith(clipWith(twoKeyframes));
    expect(buildStripLayout({ ...input(doc, [CLIP_ID]), pxPerUs: 0.000001 })).toBeNull();
  });

  it('vanishes when the clip is scrolled off screen', () => {
    const doc = docWith(clipWith(twoKeyframes));
    expect(buildStripLayout({ ...input(doc, [CLIP_ID]), scrollUs: 60 * US })).toBeNull();
  });

  it('stays visible but read-only on a locked track', () => {
    const layout = buildStripLayout(input(docWith(clipWith(twoKeyframes), true), [CLIP_ID]))!;
    expect(layout.editable).toBe(false);
  });
});

describe('hitTestStrip', () => {
  const layout = buildStripLayout(input(docWith(clipWith(twoKeyframes)), [CLIP_ID]))!;
  const rowCentre = layout.rows[0].y + KEYFRAME_ROW_H / 2;

  it('grabs the diamond under the pointer', () => {
    const hit = hitTestStrip(layout, layout.rows[0].diamonds[1].x, rowCentre);
    expect(hit?.timeUs).toBe(2 * US);
    expect(hit?.channel).toBe('opacity');
  });

  it('returns null off the diamonds, so the press reaches the timeline', () => {
    const mid = (layout.rows[0].diamonds[0].x + layout.rows[0].diamonds[1].x) / 2;
    expect(hitTestStrip(layout, mid, rowCentre)).toBeNull();
    // Outside the row band vertically.
    expect(hitTestStrip(layout, layout.rows[0].diamonds[0].x, layout.rows[0].y - 3)).toBeNull();
  });

  it('honours the slop window and picks the NEAREST diamond', () => {
    const x = layout.rows[0].diamonds[0].x;
    expect(hitTestStrip(layout, x + KEYFRAME_HIT_SLOP_PX - 1, rowCentre)?.timeUs).toBe(0);
    expect(hitTestStrip(layout, x + KEYFRAME_HIT_SLOP_PX + 2, rowCentre)).toBeNull();
  });
});

describe('stripHitRect / xToClipTimeUs', () => {
  const layout = buildStripLayout(input(docWith(clipWith(twoKeyframes)), [CLIP_ID]))!;

  it('covers the band only (the rest of the lane keeps its own gestures)', () => {
    const rect = stripHitRect(layout);
    expect(rect.y).toBe(layout.topY);
    expect(rect.height).toBe(layout.bottomY - layout.topY);
    expect(rect.height).toBeLessThan(TRACK_H / 2);
  });

  it('inverts the time transform back to CLIP-relative microseconds', () => {
    const x = layout.rows[0].diamonds[1].x;
    expect(xToClipTimeUs(layout, x, 0, PX_PER_US)).toBe(2 * US);
    expect(xToClipTimeUs(layout, layout.rows[0].diamonds[0].x, 0, PX_PER_US)).toBe(0);
  });
});
