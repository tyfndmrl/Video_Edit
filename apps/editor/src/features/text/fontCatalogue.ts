/**
 * Font catalogue loader — `GET /api/fonts` -> the editor's live font list, and
 * `@font-face` rules that load THE SAME curated TTF the server rasterizes with.
 *
 * Metin-overlay denetimi, bulgu #1 (KRİTİK) and bulgu #3(a):
 * - #1: the editor's font list was a hard-coded guess that shared ONE id with
 *   `fonts/manifest.json` — and not the default one, so "add text -> export"
 *   died with `font-missing`. The list is now SERVED by the backend from that
 *   very file, so the two cannot disagree.
 * - #3(a): the preview measured with whatever the OS had (Segoe UI standing in
 *   for "Inter") while the server measured Roboto. Now the browser downloads
 *   the curated TTF itself, under a private family name, so both sides shape
 *   the SAME file.
 *
 * Failure policy — an editor that cannot reach the API must still be usable:
 *   1. server answer (authoritative) -> also cached in localStorage;
 *   2. last known answer from localStorage;
 *   3. the 4 curated ids compiled in (`CURATED_FALLBACK`).
 * In every branch the ids stay inside `fonts/manifest.json`, so a document
 * authored offline still exports. What degrades offline is the FONT FILE (the
 * preview falls back to a generic family), never the id.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../../app/queryClient';
import { apiFetch } from '../../entities/apiClient';
import {
  CURATED_FALLBACK,
  bumpFontRevision,
  fontCatalogue,
  fontCatalogueRevision,
  fontEntry,
  fontFaceFamily,
  setFontCatalogue,
  subscribeFontCatalogue,
  type FontManifestEntry,
} from './fontManifest';

export const FONTS_ENDPOINT = '/api/fonts';
export const FONT_CATALOGUE_QUERY_KEY = ['fonts', 'catalogue'] as const;
const CACHE_STORAGE_KEY = 'videoedit.fontCatalogue.v1';

/** Wire shape of `GET /api/fonts` (backend: VideoEdit.Api/Endpoints/FontEndpoints.cs). */
export interface FontCatalogueResponse {
  manifestVersion: number;
  /** sha256 pin file version (0 = no `manifest.lock.json` present). */
  lockVersion: number;
  /** True when every served file is sha256-pinned — i.e. reproducible. */
  pinned: boolean;
  fonts: {
    id: string;
    family: string;
    version: string;
    license: string;
    weights: number[];
    styles: string[];
    italic: boolean;
    deprecated: boolean;
    /** style key -> URL the browser can `@font-face` from (same origin). */
    files: Record<string, string>;
  }[];
}

export function toEntries(response: FontCatalogueResponse): FontManifestEntry[] {
  return response.fonts.map((f) =>
    fontEntry({
      id: f.id,
      family: f.family,
      weights: f.weights,
      styles: f.styles,
      deprecated: f.deprecated,
    }),
  );
}

// ---------------------------------------------------------------------------
// localStorage cache (branch 2 of the failure policy)
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari private mode / blocked storage — the compiled-in fallback covers us.
    return null;
  }
}

export function readCachedCatalogue(): FontCatalogueResponse | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FontCatalogueResponse;
    return Array.isArray(parsed?.fonts) && parsed.fonts.length > 0 ? parsed : null;
  } catch {
    // bozuk cache JSON'ı / erişilemeyen storage — cache yok say, derlenmiş 4'lü taşır
    return null;
  }
}

function writeCachedCatalogue(response: FontCatalogueResponse): void {
  try {
    storage()?.setItem(CACHE_STORAGE_KEY, JSON.stringify(response));
  } catch {
    // Quota / private mode: the cache is an optimisation, not a requirement.
  }
}

// ---------------------------------------------------------------------------
// @font-face installation (bulgu #3a — the SAME file, not a lookalike)
// ---------------------------------------------------------------------------

const STYLE_ELEMENT_ID = 've-font-faces';

/** '700i' -> { weight: 700, italic: true }. Unparseable keys are skipped. */
export function parseStyleKey(key: string): { weight: number; italic: boolean } | null {
  const italic = key.endsWith('i');
  const weight = Number.parseInt(italic ? key.slice(0, -1) : key, 10);
  if (!Number.isFinite(weight) || weight < 1 || weight > 1000) return null;
  return { weight, italic };
}

export function buildFontFaceCss(response: FontCatalogueResponse): string {
  const rules: string[] = [];
  for (const font of response.fonts) {
    for (const [styleKey, url] of Object.entries(font.files ?? {})) {
      const parsed = parseStyleKey(styleKey);
      if (!parsed || !url) continue;
      rules.push(
        `@font-face{font-family:"${fontFaceFamily(font.id)}";` +
          `src:url("${url}") format("truetype");` +
          `font-weight:${parsed.weight};` +
          `font-style:${parsed.italic ? 'italic' : 'normal'};` +
          `font-display:swap;}`,
      );
    }
  }
  return rules.join('\n');
}

/**
 * Installs the rules and waits for the files. The revision bump is what makes
 * already-drawn text rasters redraw with the real font (overlayRaster keys
 * include it) — without it the first frame would keep the fallback metrics.
 */
async function installFontFaces(response: FontCatalogueResponse): Promise<void> {
  if (typeof document === 'undefined') return;
  const css = buildFontFaceCss(response);
  if (css.length === 0) return;

  let element = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement('style');
    element.id = STYLE_ELEMENT_ID;
    document.head.appendChild(element);
  }
  if (element.textContent !== css) {
    element.textContent = css;
  }

  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  const wanted: string[] = [];
  for (const font of response.fonts) {
    for (const styleKey of Object.keys(font.files ?? {})) {
      const parsed = parseStyleKey(styleKey);
      if (!parsed) continue;
      wanted.push(
        `${parsed.italic ? 'italic ' : ''}${parsed.weight} 16px "${fontFaceFamily(font.id)}"`,
      );
    }
  }
  // A font that fails to download must not reject the whole batch: the preview
  // degrades to the generic tail for THAT id and the rest still load.
  await Promise.allSettled(wanted.map((spec) => fonts.load(spec)));
  bumpFontRevision();
}

/** True once the curated file for this id+style is really usable by canvas. */
export function isFontFileLoaded(fontId: string, weight = 400, italic = false): boolean {
  const fonts = (globalThis as { document?: Document & { fonts?: FontFaceSet } }).document?.fonts;
  if (!fonts) return false;
  try {
    return fonts.check(`${italic ? 'italic ' : ''}${weight} 16px "${fontFaceFamily(fontId)}"`);
  } catch {
    // check() parse hatası (egzotik font dizgesi) — "yüklü değil" ile aynı sonuç
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Applies a response: catalogue + cache + `@font-face`. Exported for tests. */
export function applyCatalogue(response: FontCatalogueResponse, cache = true): FontManifestEntry[] {
  const entries = toEntries(response);
  if (entries.length === 0) return [];
  setFontCatalogue(entries);
  if (cache) writeCachedCatalogue(response);
  void installFontFaces(response);
  return entries;
}

async function fetchCatalogue(): Promise<FontCatalogueResponse> {
  return apiFetch<FontCatalogueResponse>(FONTS_ENDPOINT);
}

let bootstrapped = false;

/**
 * Fills the catalogue at app start. Idempotent, safe to call from anywhere
 * (React or not) — it goes through the shared react-query client, so a mounted
 * `useFontCatalogue()` gets the same in-flight request, not a second one.
 */
export async function loadFontCatalogue(): Promise<readonly FontManifestEntry[]> {
  // Cached answer FIRST: the picker and any new text clip get real ids on the
  // very first frame, before the network answers.
  const cached = readCachedCatalogue();
  if (cached) applyCatalogue(cached, false);

  try {
    const response = await queryClient.fetchQuery({
      queryKey: FONT_CATALOGUE_QUERY_KEY,
      queryFn: fetchCatalogue,
      staleTime: Number.POSITIVE_INFINITY,
      retry: 1,
    });
    applyCatalogue(response);
  } catch {
    // Offline / API down: keep whatever we have (cache or the compiled-in 4).
    // Deliberately silent — this is not an error the user can act on, and the
    // ids we keep are still exportable.
  }
  return fontCatalogue();
}

/** Kicks the load exactly once per page load. */
export function bootstrapFontCatalogue(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  void loadFontCatalogue();
}

/** TEST ONLY: re-arms `bootstrapFontCatalogue`. */
export function resetFontCatalogueBootstrapForTests(): void {
  bootstrapped = false;
}

/**
 * React binding: the served catalogue plus a re-render whenever it (or the
 * loaded-font revision) changes. Components read `entries`; everything else can
 * call `fontCatalogue()` directly.
 */
export function useFontCatalogue(): {
  entries: readonly FontManifestEntry[];
  revision: number;
  isLoading: boolean;
  failed: boolean;
} {
  const query = useQuery({
    queryKey: FONT_CATALOGUE_QUERY_KEY,
    queryFn: fetchCatalogue,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const [, force] = useState(0);
  useEffect(() => subscribeFontCatalogue(() => force((n) => n + 1)), []);
  useEffect(() => {
    if (query.data) applyCatalogue(query.data);
  }, [query.data]);

  const entries = fontCatalogue();
  return {
    entries: entries.length > 0 ? entries : CURATED_FALLBACK,
    revision: fontCatalogueRevision(),
    isLoading: query.isLoading,
    failed: query.isError,
  };
}
