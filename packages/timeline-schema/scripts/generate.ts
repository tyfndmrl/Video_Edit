/**
 * Generate generated/timeline.schema.json from the zod schema.
 * The backend consumes this via NJsonSchema to generate C# DTOs, so we target
 * JSON Schema draft-7 (best NJsonSchema compatibility).
 *
 * Note: only the STRUCTURAL schema is exported here. Cross-field invariants
 * (invariants.ts) are code, mirrored by hand in the C# validator, and covered
 * by the shared test vectors.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TimelineDocSchema } from '../src/schema.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(packageRoot, 'generated');
const outFile = join(outDir, 'timeline.schema.json');

const jsonSchema = z.toJSONSchema(TimelineDocSchema, {
  target: 'draft-7',
  reused: 'ref',
});

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(jsonSchema, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outFile}`);
