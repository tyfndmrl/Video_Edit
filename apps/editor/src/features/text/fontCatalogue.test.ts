/**
 * Font catalogue loader — the client half of M4 dalga-2 KRİTİK bulgu #1(b) and
 * #3(a).
 *
 * What matters here and is therefore tested:
 * - a server answer REPLACES the compiled-in list (the whole point: the editor
 *   stops guessing);
 * - a failure keeps a usable list — cached first, compiled-in second — and the
 *   ids in every branch are exportable;
 * - the `@font-face` CSS points at the API's own font files, under the PRIVATE
 *   family name, so the preview shapes the same TTF the export does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCatalogue,
  buildFontFaceCss,
  parseStyleKey,
  readCachedCatalogue,
  toEntries,
  type FontCatalogueResponse,
} from './fontCatalogue';
import {
  CURATED_FALLBACK,
  DEFAULT_FONT_ID,
  cssStackFor,
  fontById,
  fontCatalogue,
  fontCatalogueRevision,
  resetFontCatalogueForTests,
  selectableFonts,
  weightsFor,
} from './fontManifest';

const RESPONSE: FontCatalogueResponse = {
  manifestVersion: 1,
  lockVersion: 1,
  pinned: true,
  fonts: [
    {
      id: 'roboto',
      family: 'Roboto',
      version: 'classic-hinted',
      license: 'Apache-2.0',
      weights: [400, 700],
      styles: ['400', '400i', '700', '700i'],
      italic: true,
      deprecated: false,
      files: {
        '400': '/api/fonts/roboto/400.ttf',
        '400i': '/api/fonts/roboto/400i.ttf',
        '700': '/api/fonts/roboto/700.ttf',
        '700i': '/api/fonts/roboto/700i.ttf',
      },
    },
    {
      id: 'retired-one',
      family: 'Retired Sans',
      version: 'v0',
      license: 'OFL-1.1',
      weights: [400],
      styles: ['400'],
      italic: false,
      deprecated: true,
      files: { '400': '/api/fonts/retired-one/400.ttf' },
    },
  ],
};

/** Minimal in-memory localStorage (vitest runs in the node environment). */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } satisfies Storage);
  return map;
}

beforeEach(() => {
  resetFontCatalogueForTests();
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetFontCatalogueForTests();
});

describe('toEntries', () => {
  it('keeps the server ids, families, weights and styles verbatim', () => {
    const entries = toEntries(RESPONSE);
    expect(entries.map((e) => e.id)).toEqual(['roboto', 'retired-one']);
    expect(entries[0]!.family).toBe('Roboto');
    expect(entries[0]!.weights).toEqual([400, 700]);
    expect(entries[0]!.styles).toEqual(['400', '400i', '700', '700i']);
    expect(entries[1]!.deprecated).toBe(true);
  });

  it('labels an unknown font with its family (no client-side invention)', () => {
    expect(toEntries(RESPONSE)[1]!.label).toBe('Retired Sans');
  });
});

describe('applyCatalogue', () => {
  it('replaces the compiled-in list and bumps the raster revision', () => {
    const before = fontCatalogueRevision();
    applyCatalogue(RESPONSE);

    expect(fontCatalogue().map((f) => f.id)).toEqual(['roboto', 'retired-one']);
    expect(fontCatalogueRevision()).toBeGreaterThan(before);
    expect(weightsFor('roboto')).toEqual([400, 700]);
  });

  it('hides deprecated ids from the picker but keeps them resolvable', () => {
    applyCatalogue(RESPONSE);
    expect(selectableFonts().map((f) => f.id)).toEqual(['roboto']);
    // An OLD document that still says 'retired-one' must keep rendering.
    expect(fontById('retired-one')).toBeDefined();
  });

  it('caches the answer so the next start has real ids on the first frame', () => {
    applyCatalogue(RESPONSE);
    expect(readCachedCatalogue()?.fonts.map((f) => f.id)).toEqual(['roboto', 'retired-one']);
  });

  it('ignores an empty catalogue rather than leaving the editor with no fonts', () => {
    applyCatalogue({ ...RESPONSE, fonts: [] });
    expect(fontCatalogue()).toEqual(CURATED_FALLBACK);
  });
});

describe('offline behaviour', () => {
  it('falls back to the compiled-in curated list, whose ids the server has', () => {
    // Nothing applied: this is the "API unreachable, nothing cached" branch.
    expect(fontCatalogue()).toEqual(CURATED_FALLBACK);
    expect(fontCatalogue().map((f) => f.id)).toContain(DEFAULT_FONT_ID);
  });

  it('uses the cached answer when there is one', () => {
    applyCatalogue(RESPONSE);
    resetFontCatalogueForTests();
    expect(fontCatalogue()).toEqual(CURATED_FALLBACK); // reset really reset

    const cached = readCachedCatalogue();
    expect(cached).not.toBeNull();
    applyCatalogue(cached!, false);
    expect(fontCatalogue().map((f) => f.id)).toEqual(['roboto', 'retired-one']);
  });

  it('survives storage that throws (private mode / blocked cookies)', () => {
    vi.stubGlobal('localStorage', {
      get length() {
        throw new Error('blocked');
      },
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {},
      clear() {},
      key: () => null,
    } as unknown as Storage);

    expect(() => applyCatalogue(RESPONSE)).not.toThrow();
    expect(readCachedCatalogue()).toBeNull();
    expect(fontCatalogue().map((f) => f.id)).toContain('roboto');
  });
});

describe('parseStyleKey', () => {
  it('reads the manifest style key format', () => {
    expect(parseStyleKey('400')).toEqual({ weight: 400, italic: false });
    expect(parseStyleKey('700i')).toEqual({ weight: 700, italic: true });
    expect(parseStyleKey('')).toBeNull();
    expect(parseStyleKey('bold')).toBeNull();
    expect(parseStyleKey('0')).toBeNull();
    expect(parseStyleKey('1001')).toBeNull();
  });
});

describe('buildFontFaceCss', () => {
  const css = buildFontFaceCss(RESPONSE);

  it('points at the API font files — the SAME TTF SkiaSharp rasterizes', () => {
    expect(css).toContain('src:url("/api/fonts/roboto/400.ttf") format("truetype")');
    expect(css).toContain('src:url("/api/fonts/roboto/700i.ttf") format("truetype")');
  });

  it('uses a PRIVATE family name so a locally installed Roboto cannot win', () => {
    expect(css).toContain('font-family:"ve-roboto"');
    expect(css).not.toContain('font-family:"Roboto"');
    expect(cssStackFor('roboto')).toContain('"ve-roboto"');
  });

  it('emits one rule per style with the right weight and slant', () => {
    expect(css.match(/@font-face/g)).toHaveLength(5); // 4 roboto + 1 retired
    expect(css).toContain('font-weight:700;font-style:italic');
    expect(css).toContain('font-weight:400;font-style:normal');
  });
});
