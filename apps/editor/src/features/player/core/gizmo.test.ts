/**
 * Gizmo geometry / hit-test / drag math.
 *
 * Expectations are hand-computed from rendering-semantics §2.3–§2.4 (fit ->
 * scale -> rotate around the anchor -> anchor to P) and from the "contain"
 * viewport mapping — never read back from the implementation. One test
 * additionally cross-checks the gizmo quad against the COMPOSITOR matrix
 * (unitQuadToNdcMatrix) so the box the user grabs cannot drift from the
 * pixels the user sees.
 */
import { describe, expect, it } from 'vitest';
import type { Transform } from '@videoedit/timeline-schema';
import { TRANSFORM_SCALE_MIN } from '@videoedit/timeline-schema';
import {
  clampScale,
  computeGizmoGeometry,
  cornerCompPoint,
  gizmoDragPatch,
  hitTestGizmo,
  MIN_SCALE,
  normalizeDeg,
  ROTATE_HANDLE_OFFSET_PX,
  type GizmoDragStart,
} from './gizmo';
import { applyMat3, computePlacement, unitQuadToNdcMatrix } from './transform';
import { fitViewport, type ViewportMapping } from './viewport';
import { IDENTITY_TRANSFORM, mkDoc, mkMediaClip, mkTrack, TEST_SETTINGS } from './testFixtures';
import { applyClipTransformToDraft, maxClipScale } from '../../../state/timelineOps';

const COMP_W = 1920;
const COMP_H = 1080;

/**
 * The scale ceiling is DERIVED from the project, not a constant: the export
 * compiler bounds the rendered layer box, so a 4K project allows roughly half
 * the scale of a 1080p one — under a resolution-independent sanity cap. Tests
 * bind to the op's own function for this composition; hard-coding a number here
 * is exactly the drift the guard at the bottom of this file exists to prevent.
 */
const MAX_SCALE = maxClipScale({ width: COMP_W, height: COMP_H });

/** Viewport exactly half the composition, anchored at client (0,0). */
const HALF: ViewportMapping = fitViewport(COMP_W, COMP_H, {
  left: 0,
  top: 0,
  width: 960,
  height: 540,
});

function tf(patch: Partial<Transform> = {}): Transform {
  return { ...IDENTITY_TRANSFORM, ...patch };
}

function geo(patch: Partial<Transform> = {}, srcW = COMP_W, srcH = COMP_H, mapping = HALF) {
  return computeGizmoGeometry({
    srcW,
    srcH,
    compW: COMP_W,
    compH: COMP_H,
    transform: tf(patch),
    mapping,
  });
}

describe('computeGizmoGeometry', () => {
  it('identity transform, source = comp: the box IS the whole viewport', () => {
    // fitScale = min(1920/1920, 1080/1080) = 1 ; s = 1 ; anchor a = (960, 540)
    // P = (1920/2 + 0*1920, 1080/2 + 0*1080) = (960, 540)
    // source (0,0) -> u,v = (-960,-540) -> screen comp (0,0) -> viewport (0,0)
    const g = geo();
    expect(g.corners.nw).toEqual({ x: 0, y: 0 });
    expect(g.corners.ne).toEqual({ x: 960, y: 0 });
    expect(g.corners.se).toEqual({ x: 960, y: 540 });
    expect(g.corners.sw).toEqual({ x: 0, y: 540 });
    expect(g.anchor).toEqual({ x: 480, y: 270 });
    expect(g.topMid).toEqual({ x: 480, y: 0 });
    // Handle sits ROTATE_HANDLE_OFFSET_PX above the top edge, in SCREEN px
    // (independent of the viewport scale — it is a UI affordance, not content).
    expect(g.rotateHandle).toEqual({ x: 480, y: -ROTATE_HANDLE_OFFSET_PX });
  });

  it('normalized x/y move the box by fractions of the COMPOSITION (§2.3 P)', () => {
    // x = 0.25 -> P.x = 960 + 0.25*1920 = 1440 comp px -> 720 screen px
    // y = -0.5 -> P.y = 540 - 0.5*1080 = 0 comp px -> 0 screen px
    const g = geo({ x: 0.25, y: -0.5 });
    expect(g.anchor).toEqual({ x: 720, y: 0 });
    expect(g.corners.nw).toEqual({ x: 240, y: -270 });
    expect(g.corners.se).toEqual({ x: 1200, y: 270 });
  });

  it('scale multiplies the fit size around the anchor (x/y unchanged)', () => {
    // s = fitScale * scale = 1 * 0.5 -> drawn 960x540 comp px, centred on P
    const g = geo({ scale: 0.5 });
    expect(g.anchor).toEqual({ x: 480, y: 270 });
    expect(g.corners.nw).toEqual({ x: 240, y: 135 });
    expect(g.corners.se).toEqual({ x: 720, y: 405 });
  });

  it('rotation is CLOCKWISE in screen coords and turns around the anchor', () => {
    // Square 1080x1080 source in a 1920x1080 comp: fitScale = 1, drawn
    // 1080x1080 centred on P = (960, 540); half-extent 540 comp px.
    // 90 deg CW sends the TOP edge to the RIGHT edge:
    //   nw (0,0)       -> comp (1500,    0) -> screen (750,   0)
    //   ne (1080,0)    -> comp (1500, 1080) -> screen (750, 540)
    //   se (1080,1080) -> comp ( 420, 1080) -> screen (210, 540)
    //   sw (0,1080)    -> comp ( 420,    0) -> screen (210,   0)
    const g = geo({ rotationDeg: 90 }, 1080, 1080);
    expect(g.corners.nw.x).toBeCloseTo(750, 6);
    expect(g.corners.nw.y).toBeCloseTo(0, 6);
    expect(g.corners.ne.x).toBeCloseTo(750, 6);
    expect(g.corners.ne.y).toBeCloseTo(540, 6);
    expect(g.corners.se.x).toBeCloseTo(210, 6);
    expect(g.corners.se.y).toBeCloseTo(540, 6);
    expect(g.corners.sw.x).toBeCloseTo(210, 6);
    expect(g.corners.sw.y).toBeCloseTo(0, 6);
  });

  it('the rotate handle follows the box (180 deg -> handle below)', () => {
    const g = geo({ rotationDeg: 180 });
    expect(g.topMid.x).toBeCloseTo(480, 6);
    expect(g.topMid.y).toBeCloseTo(540, 6);
    expect(g.rotateHandle.y).toBeCloseTo(540 + ROTATE_HANDLE_OFFSET_PX, 6);
  });

  it('non-square source letterboxes inside the comp (fit=contain)', () => {
    // 1080x1920 portrait into 1920x1080: fitScale = min(1.777.., 0.5625)
    // = 0.5625 -> drawn 607.5 x 1080 comp px, centred -> screen /2
    const g = geo({}, 1080, 1920);
    expect(g.corners.nw.x).toBeCloseTo((1920 - 607.5) / 2 / 2, 6);
    expect(g.corners.nw.y).toBeCloseTo(0, 6);
    expect(g.corners.se.x).toBeCloseTo((1920 + 607.5) / 2 / 2, 6);
    expect(g.corners.se.y).toBeCloseTo(540, 6);
  });

  it('a letterboxed VIEWPORT offsets every handle by the bar size', () => {
    // Viewport 960x1080 -> scale 0.5, 270 px bars top/bottom.
    const mapping = fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 960, height: 1080 });
    const g = geo({}, COMP_W, COMP_H, mapping);
    expect(g.corners.nw).toEqual({ x: 0, y: 270 });
    expect(g.corners.se).toEqual({ x: 960, y: 810 });
    expect(g.anchor).toEqual({ x: 480, y: 540 });
  });

  it('the gizmo quad equals the COMPOSITOR quad (same §2 matrix, no drift)', () => {
    const transform = tf({ x: 0.13, y: -0.07, scale: 1.4, rotationDeg: 23, anchorX: 0.2, anchorY: 0.8 });
    const srcW = 1280;
    const srcH = 720;
    const g = computeGizmoGeometry({
      srcW,
      srcH,
      compW: COMP_W,
      compH: COMP_H,
      transform,
      mapping: HALF,
    });
    const m = unitQuadToNdcMatrix(
      computePlacement({ srcW, srcH, compW: COMP_W, compH: COMP_H, transform }),
      srcW,
      srcH,
      COMP_W,
      COMP_H,
    );
    // Unit-quad corner -> NDC -> composition px -> screen px (viewport scale .5)
    const cases = [
      { uv: [0, 0], corner: g.corners.nw },
      { uv: [1, 0], corner: g.corners.ne },
      { uv: [1, 1], corner: g.corners.se },
      { uv: [0, 1], corner: g.corners.sw },
    ] as const;
    for (const { uv, corner } of cases) {
      const ndc = applyMat3(m, uv[0], uv[1]);
      const compX = ((ndc.x + 1) * COMP_W) / 2;
      const compY = ((1 - ndc.y) * COMP_H) / 2;
      expect(corner.x).toBeCloseTo(compX * HALF.scale, 3);
      expect(corner.y).toBeCloseTo(compY * HALF.scale, 3);
    }
  });
});

describe('hitTestGizmo', () => {
  it('picks the rotate handle, the corners and the body in that order', () => {
    const g = geo();
    expect(hitTestGizmo(g, { x: 480, y: -ROTATE_HANDLE_OFFSET_PX })).toBe('rotate');
    expect(hitTestGizmo(g, { x: 0, y: 0 })).toBe('nw');
    expect(hitTestGizmo(g, { x: 960, y: 0 })).toBe('ne');
    expect(hitTestGizmo(g, { x: 960, y: 540 })).toBe('se');
    expect(hitTestGizmo(g, { x: 0, y: 540 })).toBe('sw');
    expect(hitTestGizmo(g, { x: 480, y: 270 })).toBe('move');
  });

  it('grabs a corner from slightly outside it (radius), but not from far away', () => {
    const g = geo();
    expect(hitTestGizmo(g, { x: -6, y: -6 })).toBe('nw'); // hypot 8.49 <= 11
    expect(hitTestGizmo(g, { x: -30, y: -30 })).toBeNull();
  });

  it('returns null outside the box (click falls through to play/pause)', () => {
    const g = geo({ scale: 0.5 }); // box = screen (240,135)..(720,405)
    expect(hitTestGizmo(g, { x: 100, y: 100 })).toBeNull();
    expect(hitTestGizmo(g, { x: 900, y: 500 })).toBeNull();
    expect(hitTestGizmo(g, { x: 480, y: 270 })).toBe('move');
  });

  it('body test follows the ROTATED quad, not its bounding box', () => {
    // 45 deg diamond, scale 0.5: half-diagonal = sqrt(480^2+270^2)/2 in screen
    // px around the centre (480,270). The bounding-box corner (250,140) is
    // OUTSIDE the diamond; a naive AABB test would wrongly report 'move'.
    const g = geo({ scale: 0.5, rotationDeg: 45 });
    expect(hitTestGizmo(g, { x: 480, y: 270 })).toBe('move');
    expect(hitTestGizmo(g, { x: 250, y: 140 })).toBeNull();
  });

  it('a hidden-size (degenerate) box never claims a hit', () => {
    const g = geo({ scale: 0 });
    expect(hitTestGizmo(g, { x: 4800, y: 2700 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drag math (composition-space pointers)
// ---------------------------------------------------------------------------

function dragStart(handle: GizmoDragStart['handle'], transform: Transform, pointer: { x: number; y: number }): GizmoDragStart {
  const placement = computePlacement({
    srcW: COMP_W,
    srcH: COMP_H,
    compW: COMP_W,
    compH: COMP_H,
    transform,
  });
  return {
    handle,
    pointer,
    transform,
    placement,
    compW: COMP_W,
    compH: COMP_H,
    maxScale: MAX_SCALE,
  };
}

describe('gizmoDragPatch — move', () => {
  it('converts a composition delta into normalized x/y (fractions of W/H)', () => {
    const start = dragStart('move', tf(), { x: 100, y: 100 });
    // +192 comp px of 1920 = 0.1 ; +108 of 1080 = 0.1
    expect(gizmoDragPatch(start, { x: 292, y: 208 })).toEqual({ x: 0.1, y: 0.1 });
  });

  it('is absolute from the gesture start (no drift when replayed)', () => {
    const start = dragStart('move', tf({ x: 0.25, y: -0.25 }), { x: 0, y: 0 });
    const a = gizmoDragPatch(start, { x: 960, y: 540 });
    gizmoDragPatch(start, { x: 10, y: 10 }); // intermediate move
    expect(gizmoDragPatch(start, { x: 960, y: 540 })).toEqual(a);
    expect(a).toEqual({ x: 0.75, y: 0.25 });
  });

  it('Shift locks to the dominant axis', () => {
    const start = dragStart('move', tf(), { x: 0, y: 0 });
    expect(gizmoDragPatch(start, { x: 192, y: 50 }, { shift: true })).toEqual({ x: 0.1, y: 0 });
    expect(gizmoDragPatch(start, { x: 50, y: 108 }, { shift: true })).toEqual({ x: 0, y: 0.1 });
  });

  it('never writes scale or rotation', () => {
    const start = dragStart('move', tf({ scale: 2, rotationDeg: 30 }), { x: 0, y: 0 });
    expect(Object.keys(gizmoDragPatch(start, { x: 5, y: 5 })).sort()).toEqual(['x', 'y']);
  });
});

describe('gizmoDragPatch — corner scale', () => {
  function cornerStart(
    transform: Transform,
    corner: 'se' | 'nw' = 'se',
    pointer?: { x: number; y: number },
  ) {
    const start = dragStart(corner, transform, pointer ?? { x: 0, y: 0 });
    const c = cornerCompPoint(start.placement, COMP_W, COMP_H, corner);
    return { ...start, corner: c, pointer: pointer ?? c };
  }

  it('doubling the pivot->corner distance doubles the scale', () => {
    // anchor centre -> pivot (960,540); se corner (1920,1080); v0 = (960,540)
    const start = cornerStart(tf());
    expect(gizmoDragPatch(start, { x: 2880, y: 1620 })).toEqual({ scale: 2 });
  });

  it('perpendicular pointer wobble does not change the scale (projection)', () => {
    const start = cornerStart(tf());
    // v0 = (960,540); perpendicular = (-540,960); corner + perpendicular
    expect(gizmoDragPatch(start, { x: 1920 - 540, y: 1080 + 960 })).toEqual({ scale: 1 });
  });

  it('scales relative to the START scale, not from 1', () => {
    const start = cornerStart(tf({ scale: 3 }));
    // se corner at scale 3: pivot + 3*(960,540) = (3840, 2160); halve it
    expect(gizmoDragPatch(start, { x: 960 + 1440, y: 540 + 810 })).toEqual({ scale: 1.5 });
  });

  it('collapsing onto / through the pivot clamps to MIN_SCALE (never negative)', () => {
    const start = cornerStart(tf());
    expect(gizmoDragPatch(start, { x: 960, y: 540 })).toEqual({ scale: MIN_SCALE });
    expect(gizmoDragPatch(start, { x: -9600, y: -5400 })).toEqual({ scale: MIN_SCALE });
  });

  it('runaway drags clamp to the project ceiling', () => {
    const start = cornerStart(tf());
    expect(gizmoDragPatch(start, { x: 1e7, y: 1e7 })).toEqual({ scale: MAX_SCALE });
  });

  it('the ceiling follows the PROJECT: a 4K composition allows less scale', () => {
    // The bound comes from the rendered layer box, so a bigger composition
    // means a smaller multiplier. A gizmo carrying its own constant would
    // happily propose 4.2 on a 4K project and be silently clamped at export.
    const uhdMax = maxClipScale({ width: 3840, height: 2160 });
    expect(uhdMax).toBeLessThan(MAX_SCALE);
    const start = { ...cornerStart(tf()), maxScale: uhdMax };
    expect(gizmoDragPatch(start, { x: 1e7, y: 1e7 })).toEqual({ scale: uhdMax });
  });

  it('works from the opposite corner too (pivot is the anchor, not a corner)', () => {
    const start = cornerStart(tf(), 'nw');
    // nw corner (0,0); v0 = (-960,-540); double the distance
    expect(gizmoDragPatch(start, { x: -960, y: -540 })).toEqual({ scale: 2 });
  });

  it('anchor exactly on the grabbed corner: no change instead of a divide-by-zero', () => {
    const start = cornerStart(tf({ anchorX: 0, anchorY: 0 }), 'nw');
    expect(gizmoDragPatch(start, { x: 500, y: 500 })).toEqual({});
  });

  it('never writes x/y (the anchor is the fixed point of scaling, §2.3)', () => {
    const start = cornerStart(tf({ x: 0.3, y: 0.2 }));
    expect(Object.keys(gizmoDragPatch(start, { x: 2000, y: 1500 }))).toEqual(['scale']);
  });
});

describe('gizmoDragPatch — rotate', () => {
  it('follows the pointer angle around the anchor (clockwise positive)', () => {
    // pivot (960,540); start pointer straight up (-90 deg); pointer to the
    // right (0 deg) -> +90 deg clockwise.
    const start = dragStart('rotate', tf(), { x: 960, y: 40 });
    expect(gizmoDragPatch(start, { x: 1460, y: 540 })).toEqual({ rotationDeg: 90 });
  });

  it('adds to the existing rotation', () => {
    const start = dragStart('rotate', tf({ rotationDeg: 45 }), { x: 960, y: 40 });
    expect(gizmoDragPatch(start, { x: 1460, y: 540 })).toEqual({ rotationDeg: 135 });
  });

  it('counter-clockwise drags produce negative degrees', () => {
    const start = dragStart('rotate', tf(), { x: 960, y: 40 });
    expect(gizmoDragPatch(start, { x: 460, y: 540 })).toEqual({ rotationDeg: -90 });
  });

  it('Shift snaps to 15 deg steps', () => {
    const start = dragStart('rotate', tf(), { x: 960, y: 40 });
    // ~100 deg drag -> 105 ; ~7 deg drag -> 0
    const p100 = { x: 960 + 500 * Math.cos((10 * Math.PI) / 180), y: 540 + 500 * Math.sin((10 * Math.PI) / 180) };
    expect(gizmoDragPatch(start, p100, { shift: true })).toEqual({ rotationDeg: 105 });
    const p7 = { x: 960 + 500 * Math.cos((-83 * Math.PI) / 180), y: 540 + 500 * Math.sin((-83 * Math.PI) / 180) };
    expect(gizmoDragPatch(start, p7, { shift: true })).toEqual({ rotationDeg: 0 });
  });

  it('rotates around the ANCHOR, not the box centre', () => {
    // anchor top-left of the source -> P = comp centre, box hangs to the +x/+y.
    const start = dragStart('rotate', tf({ anchorX: 0, anchorY: 0 }), { x: 1960, y: 540 });
    expect(start.placement.px).toBe(960);
    expect(start.placement.py).toBe(540);
    expect(gizmoDragPatch(start, { x: 960, y: 1540 })).toEqual({ rotationDeg: 90 });
  });

  it('never writes x/y/scale', () => {
    const start = dragStart('rotate', tf({ scale: 2 }), { x: 960, y: 40 });
    expect(Object.keys(gizmoDragPatch(start, { x: 1460, y: 540 }))).toEqual(['rotationDeg']);
  });
});

describe('helpers', () => {
  it('normalizeDeg wraps into (-180, 180]', () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(180)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(540)).toBe(180);
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(45)).toBe(45);
  });

  it('clampScale keeps the schema contract (scale > 0) with a usable floor', () => {
    expect(clampScale(-3, MAX_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN, MAX_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(1e9, MAX_SCALE)).toBe(MAX_SCALE);
    expect(clampScale(1.25, MAX_SCALE)).toBe(1.25);
    // A degenerate ceiling must never widen the band.
    expect(clampScale(5, Number.NaN)).toBe(MIN_SCALE);
    expect(clampScale(5, 0)).toBe(MIN_SCALE);
    // The floor is the SHARED one, not a private copy.
    expect(MIN_SCALE).toBe(TRANSFORM_SCALE_MIN);
    expect(MIN_SCALE).toBeGreaterThan(0);
  });

  it('non-finite pointers are ignored (no patch)', () => {
    const start = dragStart('move', tf(), { x: 0, y: 0 });
    expect(gizmoDragPatch(start, { x: Number.NaN, y: 0 })).toEqual({});
  });

  /**
   * Drift guard, bound to the DERIVED bound rather than to a mirrored constant.
   *
   * The op (state/timelineOps.applyClipTransformToDraft) is the authority for
   * both the gizmo drag and the inspector number fields. Asserting
   * `MAX_SCALE === SCALE_MAX` only ever compared two copies of a number; what
   * actually matters is that a value the GIZMO proposes reaches the document
   * UNCHANGED. So this feeds the gizmo's own extremes through the real op and
   * demands byte-identical storage — it fails if either side changes its band,
   * its rounding, or its derivation.
   */
  function storedScale(proposed: number, settings = TEST_SETTINGS): number {
    const doc = mkDoc([
      mkTrack('t', [mkMediaClip({ id: 'c', startUs: 0, durationUs: 1_000_000 })]),
    ]);
    doc.settings = { ...settings };
    applyClipTransformToDraft(doc, ['c'], { scale: proposed });
    return doc.tracks[0]!.clips[0]!.transform.scale;
  }

  /**
   * Every project shape the ceiling behaves differently in:
   * - 1080p / 4K: the LAYER-BOX bound dominates (8192 / longest side)
   * - 640x480:    the box bound is loose (12.8), so the resolution-independent
   *               sanity cap dominates instead. A gizmo that derived its own
   *               ceiling from the layer box alone would propose 12.8 here and
   *               be silently clamped to 10 by the op — the box would stop
   *               following the pointer with no explanation.
   */
  const PROJECT_SHAPES = [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 640, height: 480 },
    { width: 1080, height: 1920 }, // vertical
  ] as const;

  it('drift guard: every scale the gizmo proposes survives the transform OP', () => {
    for (const settings of PROJECT_SHAPES) {
      const start = {
        ...dragStart('se', tf(), { x: 1920, y: 1080 }),
        corner: { x: 1920, y: 1080 },
        maxScale: maxClipScale(settings),
      };
      const proposals = [
        gizmoDragPatch(start, { x: 1e7, y: 1e7 }).scale, // runaway -> ceiling
        gizmoDragPatch(start, { x: 960, y: 540 }).scale, // collapse -> floor
        gizmoDragPatch(start, { x: 2880, y: 1620 }).scale, // ordinary drag
        gizmoDragPatch(start, { x: 1234, y: 789 }).scale, // awkward decimals
      ];
      for (const proposed of proposals) {
        expect(proposed, 'the drag must produce a scale at all').toBeTypeOf('number');
        expect(
          storedScale(proposed!, { ...TEST_SETTINGS, ...settings }),
          `At ${settings.width}x${settings.height} the gizmo proposed ${proposed} but the op ` +
            'stored something else — the box would stop following the pointer without saying why.',
        ).toBe(proposed);
      }
    }
  });

  it('drift guard: position and rotation extremes survive the transform OP too', () => {
    const doc = mkDoc([
      mkTrack('t', [mkMediaClip({ id: 'c', startUs: 0, durationUs: 1_000_000 })]),
    ]);
    // A full turn (normalizeDeg's extreme) and a one-composition-wide move.
    const move = gizmoDragPatch(dragStart('move', tf(), { x: 0, y: 0 }), { x: 1920, y: 1080 });
    const rotate = gizmoDragPatch(dragStart('rotate', tf(), { x: 960, y: 40 }), {
      x: 960,
      y: 1040,
    });
    applyClipTransformToDraft(doc, ['c'], { ...move, ...rotate });
    const stored = doc.tracks[0]!.clips[0]!.transform;
    expect(stored.x).toBe(move.x);
    expect(stored.y).toBe(move.y);
    expect(stored.rotationDeg).toBe(rotate.rotationDeg);
  });
});
