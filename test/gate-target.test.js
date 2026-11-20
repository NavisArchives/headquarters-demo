import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDemoServer, assertDemoConfigIsLocal } from '../scripts/gate-target.mjs';

/** The deploy gates click through every screen; they may only touch the demo. */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const answer = (body, ok = true) => { globalThis.fetch = async () => ({ ok, json: async () => body }); };

describe('the gates refuse anything but the demo HQ', () => {
  it('passes a server that says it is the demo', async () => {
    answer({ demo: true });
    await expect(assertDemoServer('http://localhost:8790', 'x')).resolves.toBeUndefined();
  });

  it('refuses the live-bound HQ, which says demo: false', async () => {
    answer({ demo: false });
    await expect(assertDemoServer('http://localhost:8787', 'x')).rejects.toThrow(/not the demo HQ/);
  });

  it('refuses an HQ too old to answer, and one that cannot be reached', async () => {
    answer({ error: 'not found' }, false);
    await expect(assertDemoServer('http://localhost:8787', 'x')).rejects.toThrow(/not the demo HQ/);
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await expect(assertDemoServer('http://localhost:8787', 'x')).rejects.toThrow(/not the demo HQ/);
  });

  it('refuses a demo config that binds a remote database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    writeFileSync(join(dir, 'wrangler.demo.jsonc'), '{ "d1_databases": [{ "binding": "DB", "remote": true }] }');
    expect(() => assertDemoConfigIsLocal(dir)).toThrow(/remote database/);
  });

  it('passes the committed demo config, which keeps its database local', () => {
    expect(() => assertDemoConfigIsLocal(join(import.meta.dirname, '..'))).not.toThrow();
  });
});
