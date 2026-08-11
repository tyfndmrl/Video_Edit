/**
 * Screen <-> composition coordinate mapping for the preview canvas. Pure (no
 * DOM), so the whole gizmo/pointer path is unit-testable.
 *
 * WHY THIS IS THE ONLY PLACE THAT DOES IT (rendering-semantics §2.1): all
 * transform math lives in project output space (W x H); the preview merely
 * shows that space scaled down. Every pointer coordinate therefore crosses
 * exactly one boundary — here — before it touches §2 math. If a second copy of
 * this conversion appeared anywhere, the gizmo and the compositor could drift.
 *
 * The mapping is a "contain" fit (same rule as CSS object-fit: contain): a
 * single uniform scale plus a centering offset, i.e. letterbox bars top/bottom
 * (element wider than the composition) or pillarbox bars left/right. The
 * canvas element normally already carries the project aspect ratio so the bars
 * are 0 px, but the math must not ASSUME that — a rounded layout, a min-width
 * rule or a future letterboxed viewer would silently offset every drag.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * A DOMRect-shaped box describing where the canvas sits.
 *
 * COORDINATE SPACE IS THE CALLER'S CHOICE, but it must be used consistently:
 * whatever space this rect is expressed in is the same "screen space" that
 * compToScreen() emits and screenToComp() expects. PlayerPanel/TransformGizmo
 * use CONTAINER-LOCAL px (the canvas box measured relative to the stage
 * element), because the gizmo is an SVG overlay whose own coordinate system is
 * container-local — feeding a page-coordinate pointer into a container-local
 * mapping would offset every drag by the panel's position on screen.
 */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Uniform scale + screen-space origin of the composition rectangle.
 *   screen = origin + comp * scale
 * ("screen" = whatever space the ViewportRect was given in — see above.)
 */
export interface ViewportMapping {
  /** Screen px per composition px (uniform — aspect is preserved). */
  scale: number;
  /** Screen x of composition point (0,0). */
  offsetX: number;
  /** Screen y of composition point (0,0). */
  offsetY: number;
}

/**
 * "contain" fit of a compW x compH composition into a client rect.
 * Degenerate inputs (zero-size rect or composition) yield scale 0; callers
 * treat scale <= 0 as "no usable viewport" and skip interaction.
 */
export function fitViewport(compW: number, compH: number, rect: ViewportRect): ViewportMapping {
  if (compW <= 0 || compH <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { scale: 0, offsetX: rect.left, offsetY: rect.top };
  }
  const scale = Math.min(rect.width / compW, rect.height / compH);
  return {
    scale,
    offsetX: rect.left + (rect.width - compW * scale) / 2,
    offsetY: rect.top + (rect.height - compH * scale) / 2,
  };
}

/** Composition px -> client px. */
export function compToScreen(m: ViewportMapping, p: Point): Point {
  return { x: m.offsetX + p.x * m.scale, y: m.offsetY + p.y * m.scale };
}

/** Client px -> composition px (exact inverse of compToScreen). */
export function screenToComp(m: ViewportMapping, p: Point): Point {
  if (m.scale === 0) return { x: Number.NaN, y: Number.NaN };
  return { x: (p.x - m.offsetX) / m.scale, y: (p.y - m.offsetY) / m.scale };
}

/** Screen distance (px) -> composition distance (px). */
export function screenLenToComp(m: ViewportMapping, lengthPx: number): number {
  return m.scale === 0 ? Number.NaN : lengthPx / m.scale;
}
