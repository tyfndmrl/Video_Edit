/**
 * FONT CATALOGUE CONTRACT — the editor's ids against `fonts/manifest.json`.
 *
 * This test exists because of metin-overlay denetimi, KRİTİK bulgu #1: the editor
 * shipped `inter / roboto / georgia / impact / courier` (default `inter`) while
 * the server manifest held `roboto / open-sans / noto-sans / noto-serif`. The
 * two lists were DISJOINT where it mattered — the default id did not exist on
 * the server — so every "add text -> export" died with `font-missing` even
 * though the fonts were installed.
 *
 * The fix is architectural (the catalogue is served by `GET /api/fonts`), but
 * an offline fallback list still lives in the client. THIS test reads the real
 * `fonts/manifest.json` from disk and proves that fallback can never drift:
 * add an id here that the server cannot resolve and the suite goes red before
 * a user ever gets a failed export.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURATED_FALLBACK, DEFAULT_FONT_ID, fontFaceFamily } from './fontManifest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/editor/src/features/text -> repo root -> fonts/manifest.json */
export const SERVER_FONT_MANIFEST_PATH = resolve(HERE, '../../../../../fonts/manifest.json');

interface ServerManifest {
  manifestVersion: number;
  fonts: Record<
    string,
    { family: string; files: Record<string, string>; deprecated?: boolean }
  >;
}

function loadServerManifest(): ServerManifest {
  // The manifest carries "//" comment keys but is otherwise strict JSON.
  return JSON.parse(readFileSync(SERVER_FONT_MANIFEST_PATH, 'utf8')) as ServerManifest;
}

describe('editor font catalogue vs fonts/manifest.json', () => {
  const server = loadServerManifest();
  const serverIds = Object.keys(server.fonts);

  it('reads a manifest that actually has fonts (a missing file must not pass silently)', () => {
    expect(server.manifestVersion).toBe(1);
    expect(serverIds.length).toBeGreaterThan(0);
  });

  it.each(CURATED_FALLBACK.map((f) => [f.id, f] as const))(
    'offline fallback id "%s" exists in the server manifest',
    (id, entry) => {
      expect(serverIds, `fontId '${id}' is not in fonts/manifest.json`).toContain(id);
      // The family is what SkiaSharp resolves and what the picker shows.
      expect(entry.family).toBe(server.fonts[id]!.family);
    },
  );

  it('every fallback style key is a real file entry on the server', () => {
    for (const entry of CURATED_FALLBACK) {
      const files = server.fonts[entry.id]!.files;
      for (const styleKey of entry.styles) {
        expect(Object.keys(files), `${entry.id}/${styleKey} missing on the server`).toContain(
          styleKey,
        );
      }
    }
  });

  it('every fallback weight has at least one file on the server', () => {
    for (const entry of CURATED_FALLBACK) {
      const available = Object.keys(server.fonts[entry.id]!.files)
        .map((k) => Number.parseInt(k.endsWith('i') ? k.slice(0, -1) : k, 10))
        .filter((w) => Number.isFinite(w));
      for (const weight of entry.weights) {
        expect(available, `${entry.id} has no file for weight ${weight}`).toContain(weight);
      }
    }
  });

  it('DEFAULT_FONT_ID is a real server id — this exact bug broke "add text -> export"', () => {
    expect(serverIds).toContain(DEFAULT_FONT_ID);
    expect(CURATED_FALLBACK.map((f) => f.id)).toContain(DEFAULT_FONT_ID);
    expect(server.fonts[DEFAULT_FONT_ID]!.deprecated ?? false).toBe(false);
  });

  it('uses a PRIVATE @font-face family so a locally installed font cannot win', () => {
    for (const entry of CURATED_FALLBACK) {
      expect(entry.cssStack.startsWith(`"${fontFaceFamily(entry.id)}"`)).toBe(true);
      // The system family name must NOT be a candidate: "Roboto" on the user's
      // machine is a different file than the curated Roboto and would measure
      // differently from the export.
      expect(entry.cssStack).not.toContain(`, ${entry.family},`);
      // ...and the stack must still end in a generic so a failed download
      // degrades to readable text instead of blank.
      expect(/(sans-serif|serif|monospace)$/.test(entry.cssStack)).toBe(true);
    }
  });
});
