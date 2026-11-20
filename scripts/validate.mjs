import { readFileSync } from 'node:fs';
import { validateRegistry, mergeRegistry } from '../src/shared/registry.js';

const registry = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'));
const errors = validateRegistry(registry);

if (errors.length) {
  console.error('projects.json is invalid:');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`projects.json is valid (${registry.length} projects)`);

// The registry now has two layers: this committed file, and the rows the
// owner makes in HQ. Everything rests on one property — with no rows, the
// merge IS the file. If that ever stops being true, a deploy would silently
// change what every project page, probe and invoice sees, so it is checked
// here as well as in the test suite: this is the gate a deploy cannot skip.
const { registry: merged, skipped } = mergeRegistry(registry, []);
const bare = merged.map(({ origin, ...rest }) => rest);
if (skipped.length || JSON.stringify(bare) !== JSON.stringify(registry)) {
  console.error('the registry merge is no longer the identity on an empty overlay:');
  console.error('  with no rows in D1, mergeRegistry(file, []) must return the file exactly.');
  for (const s of skipped) console.error(`  skipped ${s.slug}: ${s.why}`);
  process.exit(1);
}
console.log('registry merge is the identity with an empty overlay');
