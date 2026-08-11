/**
 * Font manifest — the curated font catalogue the editor may write into
 * `TextClip.text.fontId`.
 *
 * Why a manifest and not a free-form family (rendering-semantics §7): the
 * SAME font file has to reach the browser (`@font-face`) and SkiaSharp on the
 * server, and the id is version-pinned so a font update can never re-layout an
 * existing project. The schema therefore carries `fontId`, never a CSS family.
 *
 * TODO (M4 dalga 2 / backend): there is no `GET /api/fonts` manifest endpoint
 * yet and no R2-hosted TTF set, so this list is a STATIC placeholder built from
 * families that ship with the host OS (plus a generic fallback each). The
 * contract shape is already the manifest's: `{ id, family, weights, version }`,
 * so wiring the endpoint later means replacing the array, not the call sites.
 * Until then the preview raster measures with the local font and the server
 * raster will measure with its own — the parity note in the inspector says so
 * out loud (features/inspector/ClipPropertiesPanel.tsx, "Önizleme" note).
 */

export interface FontManifestEntry {
  /** Value stored in the document (`TextClip.text.fontId`). Version-pinned id. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Manifest family name — what SkiaSharp will resolve. */
  family: string;
  /**
   * CSS font stack for the browser side (preview raster + future `@font-face`).
   * Always ends in a generic family so a missing file degrades, never blanks.
   */
  cssStack: string;
  /** Weights the manifest promises for this id. */
  weights: readonly number[];
}

export const FONT_MANIFEST: readonly FontManifestEntry[] = [
  {
    id: 'inter',
    label: 'Inter (Sans)',
    family: 'Inter',
    cssStack: 'Inter, "Segoe UI", system-ui, sans-serif',
    weights: [400, 700],
  },
  {
    id: 'roboto',
    label: 'Roboto (Sans)',
    family: 'Roboto',
    cssStack: 'Roboto, "Segoe UI", system-ui, sans-serif',
    weights: [400, 700],
  },
  {
    id: 'georgia',
    label: 'Georgia (Serif)',
    family: 'Georgia',
    cssStack: 'Georgia, "Times New Roman", serif',
    weights: [400, 700],
  },
  {
    id: 'impact',
    label: 'Impact (Başlık)',
    family: 'Impact',
    cssStack: 'Impact, "Arial Black", system-ui, sans-serif',
    weights: [400],
  },
  {
    id: 'courier',
    label: 'Courier (Mono)',
    family: '"Courier New"',
    cssStack: '"Courier New", ui-monospace, monospace',
    weights: [400, 700],
  },
];

/** Default for a freshly added text clip. */
export const DEFAULT_FONT_ID = 'inter';

export function fontById(fontId: string): FontManifestEntry | undefined {
  return FONT_MANIFEST.find((f) => f.id === fontId);
}

/**
 * CSS stack for a fontId. An unknown id (an older document, a manifest entry
 * that was retired) falls back to the default entry rather than rendering
 * nothing — the document keeps its id, only the PREVIEW degrades.
 */
export function cssStackFor(fontId: string): string {
  return (fontById(fontId) ?? fontById(DEFAULT_FONT_ID))?.cssStack ?? 'system-ui, sans-serif';
}

/** Weight options offered for a fontId (falls back to the common pair). */
export function weightsFor(fontId: string): readonly number[] {
  const entry = fontById(fontId);
  return entry && entry.weights.length > 0 ? entry.weights : [400, 700];
}
