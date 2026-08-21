/**
 * E2E'nin ihtiyaç duyduğu Node modülleri için MİNİMAL ambient bildirim.
 *
 * `@types/node` bilinçli olarak eklenmiyor (gerekçe: env.d.ts başlığı — uygulama
 * tsconfig'inde `types` listesi olmadığı için node_modules/@types altındaki her
 * paket `tsc -b` sırasında src'ye de sızar ve DOM/Node çakışmaları yeşil
 * typecheck'i bozar). Buradaki yüzey testlerin GERÇEKTEN kullandığı kadardır:
 * ffmpeg ile test medyası üretmek (child_process), dosya yazıp okumak (fs) ve
 * yol kurmak (path).
 */

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    error?: Error;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: { encoding?: 'utf8'; timeout?: number },
  ): SpawnSyncResult;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function statSync(path: string): { size: number };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
