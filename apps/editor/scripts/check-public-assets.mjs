/**
 * public/ sızıntı bekçisi — üretim bundle'ına test/ölçüm medyası girmesin.
 *
 * Neden var: Vite `public/` altındaki HER dosyayı olduğu gibi `dist/`e kopyalar.
 * Bu depoda bir E2E/ölçüm fixture'ı (122 MB'lık `e2e-test-video.mp4`) uzun süre
 * `apps/editor/public/` altında durdu; gitignore'lu olduğu için commit'lere
 * girmedi ama `pnpm --filter @videoedit/editor build` çalıştıran HERKESİN
 * `dist/` çıktısına kopyalandı — yani üretim artefaktına sızdı. Dosyayı bir
 * kez taşımak yeterli değil: aynı kaza tekrar edebilir. Bu bekçi build'i
 * ÖNCEDEN, net bir gerekçeyle durdurur.
 *
 * Kural:
 *  - `public/` altında medya uzantılı dosya OLAMAZ (test/ölçüm medyasının yeri
 *    `apps/editor/e2e/fixtures/media/` — Playwright dosya YOLUNDAN okur).
 *  - `public/` altındaki hiçbir dosya MAX_BYTES'ı aşamaz (favicon/ikon/font
 *    ölçeğinden büyük her şey aslında bir `src/` içe aktarımı olmalı; öyle
 *    olunca hash'lenir, sürümlenir ve ölü ise bundle'a hiç girmez).
 *
 * Çıkış kodu 0 = temiz, 1 = sızıntı (build durur).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(EDITOR_ROOT, 'public');

/** Tek bir dosya için üst sınır (1 MiB) — ikon/manifest ölçeği. */
const MAX_BYTES = 1024 * 1024;

const MEDIA_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.mp3',
  '.m4a',
  '.wav',
  '.flac',
  '.ogg',
];

/** public/ altındaki tüm dosyalar (özyinelemeli). */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return []; // public/ yoksa sorun yok
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const problems = [];
for (const path of walk(PUBLIC_DIR)) {
  const rel = relative(EDITOR_ROOT, path).replace(/\\/g, '/');
  const lower = path.toLowerCase();
  const size = statSync(path).size;
  if (MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    problems.push(`${rel} — medya dosyası (${(size / 1048576).toFixed(1)} MB)`);
  } else if (size > MAX_BYTES) {
    problems.push(`${rel} — ${(size / 1048576).toFixed(1)} MB (üst sınır 1 MB)`);
  }
}

if (problems.length > 0) {
  console.error(
    '\nHATA: apps/editor/public/ altında üretim bundle\'ına SIZACAK dosya(lar) var.\n' +
      'Vite public/ içeriğini olduğu gibi dist/ altına kopyalar.\n\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\nÇözüm: test/ölçüm medyasını apps/editor/e2e/fixtures/media/ altına taşıyın\n' +
      '(Playwright dosyayı YOLDAN okur, sunucudan değil); uygulamanın gerçekten\n' +
      'ihtiyaç duyduğu büyük varlıklar ise src/ içinden import edilmelidir.\n',
  );
  process.exit(1);
}
