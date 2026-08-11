/**
 * Font catalogue — the curated set the editor may write into
 * `TextClip.text.fontId`.
 *
 * WHY THIS FILE WAS REWRITTEN (M4 dalga-2 denetimi, KRİTİK bulgu #1): the
 * editor used to ship its own hard-coded list — `inter / roboto / georgia /
 * impact / courier`, default `inter` — while `fonts/manifest.json` (the ONLY
 * thing the server can resolve) contains `roboto / open-sans / noto-sans /
 * noto-serif`. The two sets overlapped in exactly ONE id, and the DEFAULT was
 * not in it: every new text clip was born with `fontId: 'inter'` and every
 * export containing it died with `font-missing`. "Add text -> export", the main
 * path of the whole text feature, was broken.
 *
 * The rule now:
 * - the catalogue is SERVED, not guessed — `GET /api/fonts` projects
 *   `fonts/manifest.json` (fontCatalogue.ts fetches it at app start);
 * - {@link CURATED_FALLBACK} below is the offline fallback and every id in it
 *   MUST exist in `fonts/manifest.json`. `fontManifest.contract.test.ts` READS
 *   THAT FILE and fails if it does not — the two lists cannot drift apart
 *   silently again;
 * - {@link DEFAULT_FONT_ID} is `roboto`, which exists on both sides.
 *
 * THE SAME TTF ON BOTH SIDES (rendering-semantics §7): the browser loads the
 * curated file itself through `@font-face` (fontCatalogue.ts installs the
 * rules, served by the API from `fonts/`), under a PRIVATE family name
 * (`ve-<fontId>`). The private name matters: `font-family: Roboto` would let a
 * locally installed Roboto win and the preview would measure a different font
 * than SkiaSharp does.
 */

/** CSS family prefix for the curated files. Private on purpose (see header). */
export const FONT_FACE_FAMILY_PREFIX = 've-';

/** The `@font-face` family name for a fontId — never a system family name. */
export function fontFaceFamily(fontId: string): string {
  return `${FONT_FACE_FAMILY_PREFIX}${fontId}`;
}

export interface FontManifestEntry {
  /** Value stored in the document (`TextClip.text.fontId`). Version-pinned id. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Manifest family name — what SkiaSharp resolves, and the label's source. */
  family: string;
  /**
   * CSS font stack for the browser side. Starts with the PRIVATE `@font-face`
   * family (the curated TTF) and always ends in a generic family so a failed
   * font download degrades instead of blanking the preview.
   */
  cssStack: string;
  /** Weights the manifest promises for this id. */
  weights: readonly number[];
  /** Manifest style keys ('400', '700i', ...) — what `@font-face` rules to build. */
  styles: readonly string[];
  /** Retired ids stay selectable for OLD documents but are hidden from the picker. */
  deprecated: boolean;
}

/** Generic tail per family kind, so a failed download still shows readable text. */
function genericTail(family: string): string {
  return /serif/i.test(family) && !/sans/i.test(family)
    ? '"Times New Roman", serif'
    : 'system-ui, sans-serif';
}

/**
 * Builds an entry from the SERVER's manifest projection. `label` falls back to
 * the family name: `fonts/manifest.json` carries no UI label, and inventing one
 * client-side is what produced the drift in the first place.
 */
export function fontEntry(input: {
  id: string;
  family: string;
  weights?: readonly number[];
  styles?: readonly string[];
  deprecated?: boolean;
  label?: string;
}): FontManifestEntry {
  const family = input.family || input.id;
  const weights = input.weights?.length ? [...input.weights].sort((a, b) => a - b) : [400, 700];
  return {
    id: input.id,
    label: input.label ?? family,
    family,
    cssStack: `"${fontFaceFamily(input.id)}", ${genericTail(family)}`,
    weights,
    styles: input.styles?.length ? [...input.styles] : ['400', '700'],
    deprecated: input.deprecated ?? false,
  };
}

/**
 * OFFLINE FALLBACK — used only until `GET /api/fonts` answers (and when it
 * cannot). Every id here MUST exist in `fonts/manifest.json`; the contract test
 * reads that file and proves it.
 */
export const CURATED_FALLBACK: readonly FontManifestEntry[] = [
  fontEntry({
    id: 'roboto',
    family: 'Roboto',
    label: 'Roboto (Sans)',
    weights: [400, 700],
    styles: ['400', '400i', '700', '700i'],
  }),
  fontEntry({
    id: 'open-sans',
    family: 'Open Sans',
    label: 'Open Sans (Sans)',
    weights: [400, 700],
    styles: ['400', '400i', '700', '700i'],
  }),
  fontEntry({
    id: 'noto-sans',
    family: 'Noto Sans',
    label: 'Noto Sans (Sans)',
    weights: [400, 700],
    styles: ['400', '400i', '700', '700i'],
  }),
  fontEntry({
    id: 'noto-serif',
    family: 'Noto Serif',
    label: 'Noto Serif (Serif)',
    weights: [400, 700],
    styles: ['400', '400i', '700', '700i'],
  }),
];

/**
 * Default for a freshly added text clip. MUST be a curated id — this is the
 * exact value that made every "add text -> export" fail when it was `inter`.
 */
export const DEFAULT_FONT_ID = 'roboto';

// ---------------------------------------------------------------------------
// Live catalogue (filled by fontCatalogue.ts from GET /api/fonts)
// ---------------------------------------------------------------------------

let catalogue: readonly FontManifestEntry[] = CURATED_FALLBACK;
/**
 * Bumped on every catalogue change AND when a curated file finishes loading in
 * the browser. Raster caches fold it into their key so a text drawn with the
 * fallback font is re-drawn once the real TTF arrives.
 */
let revision = 0;
const listeners = new Set<() => void>();

/** The catalogue the app is using right now (never empty). */
export function fontCatalogue(): readonly FontManifestEntry[] {
  return catalogue;
}

/** Entries offered in the picker: deprecated ids stay loadable but hidden. */
export function selectableFonts(): readonly FontManifestEntry[] {
  const visible = catalogue.filter((f) => !f.deprecated);
  return visible.length > 0 ? visible : catalogue;
}

export function fontCatalogueRevision(): number {
  return revision;
}

/** Replaces the catalogue (server answer / cached answer). Empty input ignored. */
export function setFontCatalogue(entries: readonly FontManifestEntry[]): void {
  if (entries.length === 0) return;
  catalogue = entries;
  bumpFontRevision();
}

/** Signals "the pixels a font produces changed" without changing the catalogue. */
export function bumpFontRevision(): void {
  revision += 1;
  for (const fn of listeners) fn();
}

/** Subscribe to catalogue/revision changes (used by `useFontCatalogue`). */
export function subscribeFontCatalogue(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** TEST ONLY: restores the offline fallback so tests do not leak into each other. */
export function resetFontCatalogueForTests(): void {
  catalogue = CURATED_FALLBACK;
  revision = 0;
  listeners.clear();
}

export function fontById(fontId: string): FontManifestEntry | undefined {
  return catalogue.find((f) => f.id === fontId);
}

/**
 * CSS stack for a fontId. An unknown id (an older document, a retired manifest
 * entry) falls back to the default entry rather than rendering nothing — the
 * document KEEPS its id, only the PREVIEW degrades. (The export does not
 * degrade: an unknown id is refused with 422 before the render starts.)
 */
export function cssStackFor(fontId: string): string {
  return (
    (fontById(fontId) ?? fontById(DEFAULT_FONT_ID) ?? catalogue[0])?.cssStack ??
    'system-ui, sans-serif'
  );
}

/** Weight options offered for a fontId (falls back to the common pair). */
export function weightsFor(fontId: string): readonly number[] {
  const entry = fontById(fontId);
  return entry && entry.weights.length > 0 ? entry.weights : [400, 700];
}
