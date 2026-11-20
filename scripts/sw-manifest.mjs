// The service worker's manifest: every file the app shell needs, with its
// sha256, and a version that is the hash of those hashes. Written per release
// (scripts/release.mjs, in the release worktree) and never committed: one
// release, one cache, so a page never mixes two releases' modules.
//   node scripts/sw-manifest.mjs            writes src/public/asset-manifest.json
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = /\.(js|css|woff2|png|svg|ico|webmanifest|html)$/;
// Client-site screenshots stay off the phone's offline store; licence texts are not needed.
const SKIP = [/^\/assets\/shots\//];

export function buildManifest(publicDir) {
  const walk = (dir) => readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const files = walk(publicDir)
    .map((full) => ({ full, path: `/${relative(publicDir, full).split('\\').join('/')}` }))
    .filter(({ path }) => KEEP.test(path) && !SKIP.some((re) => re.test(path)) && path !== '/asset-manifest.json')
    .map(({ full, path }) => ({ path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') }));
  const version = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex').slice(0, 16);
  return { version, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = buildManifest(join(root, 'src', 'public'));
  writeFileSync(join(root, 'src', 'public', 'asset-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`sw-manifest: ${manifest.files.length} files, version ${manifest.version}`);
}
