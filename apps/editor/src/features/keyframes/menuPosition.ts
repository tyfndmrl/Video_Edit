/**
 * Keeping a `position: fixed` popover inside the window.
 *
 * Both keyframe menus (the strip's right-click easing menu and the Inspector's
 * per-channel easing picker) anchor to a point that comes from the click or
 * from a control's own rect. Near the right or bottom edge that anchor puts
 * part of the menu — sometimes ALL of it — outside the viewport, where it is
 * still "visible" to a DOM query but cannot be clicked by a real pointer at all.
 * That is not a cosmetic issue: the Inspector lives on the right edge, so its
 * picker hit exactly this and the menu items were unreachable.
 *
 * The clamp runs AFTER layout (the real menu box is the only honest width) and
 * is idempotent, so re-applying it to an already clamped point changes nothing
 * and the caller's state settles in one extra pass.
 */

export interface MenuPoint {
  x: number;
  y: number;
}

/** Window inset kept free on every side, px. */
export const MENU_VIEWPORT_MARGIN = 8;

/**
 * `point` clamped so a `width` x `height` box fits inside `viewport`.
 * When the box is larger than the viewport the top-left margin wins — a menu
 * pinned to the visible corner beats one centred off-screen.
 */
export function clampMenuPoint(
  point: MenuPoint,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuPoint {
  const maxX = viewport.width - size.width - margin;
  const maxY = viewport.height - size.height - margin;
  return {
    x: Math.max(margin, Math.min(point.x, maxX)),
    y: Math.max(margin, Math.min(point.y, maxY)),
  };
}
