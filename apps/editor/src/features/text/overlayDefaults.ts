/**
 * Defaults for a freshly added overlay clip.
 *
 * Separate from the ops on purpose (same split as features/library/addToTimeline
 * vs state/timelineOps): `state/` owns the document mutation and the invariants,
 * this module owns the product decisions — how big is "default text", what
 * colour is a new shape, how long is a new overlay clip.
 */
import { roundHalfUp, type ProjectSettings, type ShapeClip, type TextClip } from '@videoedit/timeline-schema';
import { DEFAULT_FONT_ID } from './fontManifest';

/** A new text/shape/sticker clip is 5 s long (prompt: "varsayılan süreli"). */
export const OVERLAY_DEFAULT_DURATION_US = 5_000_000;

/** What a new text clip says until the user types. */
export const DEFAULT_TEXT_CONTENT = 'Metin';

/**
 * Default cap height as a fraction of the composition height. 8 % of 1080 is
 * ~86 px — big enough to read on a phone, small enough to leave room for a
 * second line.
 */
export const DEFAULT_TEXT_SIZE_RATIO = 0.08;

export function defaultTextStyle(
  settings: Pick<ProjectSettings, 'height'>,
  content: string = DEFAULT_TEXT_CONTENT,
): TextClip['text'] {
  return {
    content,
    fontId: DEFAULT_FONT_ID,
    fontSizePx: Math.max(8, roundHalfUp(settings.height * DEFAULT_TEXT_SIZE_RATIO)),
    fontWeight: 700,
    italic: false,
    fill: '#ffffff',
    // A dark outline is what makes white text readable over ANY footage; the
    // default therefore carries one instead of leaving the first text invisible
    // on a bright shot.
    stroke: { color: '#000000', widthPx: Math.max(1, roundHalfUp(settings.height * 0.004)) },
    align: 'center',
    lineHeight: 1.2,
  };
}

/**
 * A new shape's transform scale. The natural box of a shape is the WHOLE frame
 * (overlayGeometry.shapeBoxPx, mirroring the export's ShapeGeometry.cs), so
 * scale = 1 would cover the picture completely; half a frame is what a user
 * dropping a "rectangle" expects to see.
 */
export const DEFAULT_SHAPE_SCALE = 0.5;

export function defaultShapeStyle(type: ShapeClip['shape']['type'] = 'rect'): ShapeClip['shape'] {
  return {
    type,
    fill: '#5a8cff',
    // Radius is in PROJECT px on a frame-sized box: 16 px would be invisible.
    radiusPx: type === 'rect' ? 32 : 0,
  };
}
