import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal JSONC strip: removes // line comments and /* */ block comments
// without a dependency. Good enough for our own config file, not a general
// JSONC parser (it doesn't need to be — it only ever reads wrangler.jsonc).
function stripJsonComments(source) {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === '\\') {
        // preserve the escaped character verbatim
        result += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result;
}

const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const config = JSON.parse(stripJsonComments(readFileSync(configPath, 'utf8')));

describe('wrangler.jsonc config guards', () => {
  it('keeps workers_dev disabled so the dashboard has no unauthenticated second URL', () => {
    expect(
      config.workers_dev,
      'workers_dev must be false: with workers.dev enabled the dashboard is served unauthenticated at a second URL'
    ).toBe(false);
  });

  it('keeps run_worker_first enabled so the Worker verifies Access before assets are served', () => {
    expect(
      config.assets?.run_worker_first,
      'assets.run_worker_first must be true: otherwise the asset server answers / and /assets/* before the Worker runs, bypassing Access verification entirely'
    ).toBe(true);
  });

  it('keeps the assets binding named ASSETS so the Worker code that gates access to it still applies', () => {
    expect(
      config.assets?.binding,
      "assets.binding must be 'ASSETS': the Worker's fetch handler calls env.ASSETS.fetch(...) after verifying Access; a renamed binding would break that reference (or silently start referring to something else) and remove the gate"
    ).toBe('ASSETS');
  });

  it('guards the STATUS binding that the login rate limiter depends on', () => {
    const statusBinding = config.kv_namespaces?.find(ns => ns.binding === 'STATUS');
    expect(
      statusBinding?.binding,
      'kv_namespaces must include an entry with binding "STATUS": the login rate limiter in src/worker/auth.js stores per-IP failure counts in this namespace; without this binding, the rate limiter fails open and has no protection against password guessing'
    ).toBe('STATUS');
  });
});
