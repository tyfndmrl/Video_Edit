/**
 * silentCatchInventory — sessiz catch envanterinin KALICI muhafızı
 * (feedbackCoverage deseni: elle liste değil, kaynak taraması; yarim-is-2 #6).
 *
 * Sözleşme: bir hatayı SESSİZCE yutan her catch YAZILI GEREKÇE taşımak
 * zorundadır. "Sessiz" tanımı mekanik:
 *   1. Blok catch'ler (`catch {` / `catch (e) {`) — gövde boş, yalnız yorum,
 *      ya da yalnız trivial `return <literal>;` içeriyorsa sessizdir; gövdede
 *      en az bir yorum satırı (gerekçe) OLMALIDIR.
 *   2. Promise catch'leri (`.catch(() => null/undefined/void 0)` ve trivial
 *      gövdeli `.catch(() => { ... })`) — aynı satırda, bir üst satırda ya da
 *      ok gövdesinin içinde yorum OLMALIDIR.
 * Gövdesinde gerçek iş yapan catch'ler (durum yazan, yeniden deneyen, hatayı
 * saran/yükselten, devWarn'la iz düşen) bu muhafızın kapsamı dışındadır —
 * onların görünürlüğü davranışın kendisidir.
 *
 * Tarama iki kökü kapsar: editörün src'si ve @videoedit/timeline-schema'nın
 * src'si (bugün 0 catch; yarın eklenecek ilk sessiz catch de aynı kurala
 * tabidir). Kalıp bozulursa (regex sessizce kör kalırsa) taban sayılar
 * kırmızıya düşer — feedbackCoverage'ın "boş küme = kalıp bozuldu" dersi.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = join(SRC_ROOT, '..', '..', '..', 'packages', 'timeline-schema', 'src');

interface SilentCatch {
  file: string;
  line: number;
  kind: 'block' | 'promise';
  hasJustification: boolean;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

const isCommentLine = (l: string): boolean =>
  l.startsWith('//') || l.startsWith('/*') || l.startsWith('*');

/** `return;` / `return null;` gibi hiçbir iş yapmayan tek satırlar. */
const isTrivialReturn = (l: string): boolean =>
  /^return\s*(null|undefined|false|true|0|''|""|\[\]|\{\})?\s*;$/.test(l);

/**
 * Gövde dilimini SINIFLANDIR: 'silent' (boş / yorum-only / trivial-return),
 * 'handled' (gerçek kod var) — iç blok açan gövdeler de 'handled' sayılır
 * (sessiz-trivial bir catch iç blok içermez).
 */
function classifyBody(body: string): { silent: boolean; hasComment: boolean } {
  if (body.includes('{')) return { silent: false, hasComment: false };
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const commentLines = lines.filter(isCommentLine);
  const codeLines = lines.filter((l) => !isCommentLine(l));
  const silent = codeLines.every(isTrivialReturn); // boş gövde de sessizdir (every([]) === true)
  return { silent, hasComment: commentLines.length > 0 };
}

function scanFile(path: string, repoRel: string): SilentCatch[] {
  const src = readFileSync(path, 'utf8');
  const found: SilentCatch[] = [];

  // 1) Blok catch'ler.
  for (const m of src.matchAll(/\bcatch\s*(\([^)]*\))?\s*\{/g)) {
    const bodyStart = m.index! + m[0].length;
    const close = src.indexOf('}', bodyStart);
    if (close < 0) continue;
    const { silent, hasComment } = classifyBody(src.slice(bodyStart, close));
    if (silent) {
      found.push({ file: repoRel, line: lineOf(src, m.index!), kind: 'block', hasJustification: hasComment });
    }
  }

  // 2) Promise catch'leri: .catch(() => ...)
  for (const m of src.matchAll(/\.catch\(\s*\(\s*\)\s*=>\s*/g)) {
    const after = src.slice(m.index! + m[0].length);
    let silent = false;
    let bodyComment = false;
    if (/^(null|undefined|void 0)\s*\)/.test(after)) {
      silent = true;
    } else if (after.startsWith('{')) {
      const close = after.indexOf('}', 1);
      if (close >= 0) {
        const cls = classifyBody(after.slice(1, close));
        silent = cls.silent;
        bodyComment = cls.hasComment;
      }
    }
    if (!silent) continue;
    const line = lineOf(src, m.index!);
    const srcLines = src.split('\n');
    const sameLine = srcLines[line - 1] ?? '';
    const prevLine = srcLines[line - 2] ?? '';
    const hasJustification =
      bodyComment || sameLine.includes('//') || prevLine.trim().startsWith('//');
    found.push({ file: repoRel, line, kind: 'promise', hasJustification });
  }

  return found;
}

function scanRoot(root: string, label: string): { files: number; catches: SilentCatch[] } {
  const files = listSourceFiles(root);
  const catches = files.flatMap((f) => scanFile(f, `${label}/${relative(root, f).replaceAll('\\', '/')}`));
  return { files: files.length, catches };
}

describe('sessiz catch envanteri (kaynak taraması muhafızı)', () => {
  const editor = scanRoot(SRC_ROOT, 'apps/editor/src');
  const schema = scanRoot(SCHEMA_SRC, 'packages/timeline-schema/src');
  const all = [...editor.catches, ...schema.catches];

  it('tarama gerçek envanteri görüyor (taban sayılar alt sınırdır, eşitlik değil)', () => {
    // Kalıp sessizce kör kalırsa iki taraf birden boşalırdı; tabanlar bunu kırmızıya çevirir.
    expect(editor.files).toBeGreaterThanOrEqual(100);
    expect(schema.files).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeGreaterThanOrEqual(25);
    // Bilinen sabit siteler: sınıfın üç ayrı biçimi (yorumlu blok, trivial-return, promise).
    expect(all.some((c) => c.file.endsWith('entities/apiClient.ts') && c.kind === 'block')).toBe(true);
    expect(all.some((c) => c.file.endsWith('features/text/fontCatalogue.ts'))).toBe(true);
    expect(all.some((c) => c.file.endsWith('entities/auth.ts') && c.kind === 'promise')).toBe(true);
  });

  it('her sessiz catch yazılı gerekçe taşıyor (yorumsuz sessiz catch eklenemez)', () => {
    const violators = all
      .filter((c) => !c.hasJustification)
      .map((c) => `${c.file}:${c.line} (${c.kind})`)
      .sort();
    expect(
      violators,
      'Bu catch\'ler hatayı sessizce yutuyor ama gerekçe yorumu taşımıyor — ' +
        'gövdeye (promise formunda: aynı/üst satıra) tek satır gerekçe yazın; ' +
        'hata gerçekten önemliyse yutmak yerine işleyin ya da lib/devWarn ile iz düşün',
    ).toEqual([]);
  });

  it('timeline-schema bugün catch içermiyor — ilk eklenen de aynı kurala tabi', () => {
    // Bilinçli tespit: 2026-08-31 itibarıyla şema paketinde hiç catch yok.
    // Bu test ekleneni YASAKLAMAZ; yalnız muhafızın şema kökünü gerçekten
    // taradığını sabitler (yukarıdaki dosya tabanı + burada mevcut envanter).
    expect(schema.catches.filter((c) => !c.hasJustification)).toEqual([]);
  });
});
