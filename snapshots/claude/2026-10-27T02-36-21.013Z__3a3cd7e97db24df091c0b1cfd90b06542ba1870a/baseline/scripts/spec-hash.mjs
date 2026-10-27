// Stamp the build with the sync file it came from. Run after editing SPEC.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '../public/engine/sha256.js';
const h = sha256(readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/spec.js', import.meta.url),
  "// Prompt versioning: every game's genesis entry is stamped with the hash of the sync file\n// this build came from (SPEC.md). Regenerate with: node scripts/spec-hash.mjs\nexport const SPEC_HASH = '" + h + "';\n");
console.log('SPEC_HASH', h);
