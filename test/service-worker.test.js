// HQ's service worker (design approved 14 Nov): what it touches, the
// per-release manifest, and /sw.js with its kill switch.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFor } from '../src/public/assets/sw-route.js';
import { buildManifest } from '../scripts/sw-manifest.mjs';
import { handleServiceWorker, buildServiceWorker, KILL_SCRIPT } from '../src/worker/sw.js';

const O = 'https://hq.example.com';
const req = (path, { method = 'GET', mode = 'cors', origin = O } = {}) => ({ url: `${origin}${path}`, method, mode });

describe('what the worker touches', () => {
  it('answers pages, assets and Home\'s reads, and nothing else', () => {
    const table = [
      [req('/', { mode: 'navigate' }), 'shell'],
      [req('/missions', { mode: 'navigate' }), 'shell'],
      [req('/finance/12', { mode: 'navigate' }), 'shell'],
      [req('/p/arbor', { mode: 'navigate' }), 'shell'],
      [req('/assets/app.js'), 'asset'],
      [req('/assets/fonts/fonts.css'), 'asset'],
      [req('/api/overview'), 'data'],
      [req('/api/missions'), 'data'],
      [req('/api/todos'), 'data'],
      // left alone: sign-in and out, writes, client pages, the pixel, the calendar, intake, Leads, screenshots, other sites
      [req('/login', { mode: 'navigate' }), 'pass'],
      [req('/logout', { mode: 'navigate' }), 'pass'],
      [req('/api/todos', { method: 'POST' }), 'pass'],
      [req('/api/missions/3', { method: 'PATCH' }), 'pass'],
      [req('/live/abc', { mode: 'navigate' }), 'pass'],
      [req('/px/abc.gif'), 'pass'],
      [req('/cal/abc.ics'), 'pass'],
      [req('/api/intake'), 'pass'],
      [req('/api/leads'), 'pass'],
      [req('/assets/shots/arbor.jpg'), 'pass'],
      [req('/assets/app.js', { origin: 'https://example.com' }), 'pass'],
    ];
    for (const [r, want] of table) expect([r.method, r.url, r.mode, routeFor(r, O)]).toEqual([r.method, r.url, r.mode, want]);
  });
});

describe('the manifest: one release, one cache', () => {
  it('lists the shell\'s files with their hashes, leaves screenshots and licences out, and changes version with one byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-sw-'));
    try {
      mkdirSync(join(dir, 'assets', 'shots'), { recursive: true });
      mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
      writeFileSync(join(dir, 'assets', 'fonts', 'OFL.txt'), 'licence');
      writeFileSync(join(dir, 'assets', 'shots', 'a.jpg'), 'x');
      writeFileSync(join(dir, 'asset-manifest.json'), '{}');
      const first = buildManifest(dir);
      expect(first.files.map((f) => f.path)).toEqual(['/assets/app.js', '/index.html']);
      expect(first.version).toMatch(/^[0-9a-f]{16}$/);
      expect(buildManifest(dir).version).toBe(first.version);
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(2)');
      expect(buildManifest(dir).version).not.toBe(first.version);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('/sw.js', () => {
  const env = (files, extra = {}) => ({
    ...extra,
    ASSETS: { fetch: async (r) => { const p = new URL(r.url).pathname; return p in files ? new Response(files[p]) : new Response('no', { status: 404 }); } },
  });
  const ask = (e) => handleServiceWorker(new Request(`${O}/sw.js`), e, new URL(`${O}/sw.js`));
  const files = {
    '/asset-manifest.json': JSON.stringify({ version: 'abcdef0123456789', files: [{ path: '/index.html', sha256: 'x' }, { path: '/assets/app.js', sha256: 'y' }] }),
    '/assets/sw-route.js': 'export function routeFor() { return "pass"; }',
    '/assets/sw-core.js': '/* core */ self.addEventListener("fetch", () => {});',
  };

  it('is this release\'s worker: its version, its files, the routing table without exports', async () => {
    const res = await ask(env(files));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/javascript/);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('X-HQ-Release')).toBe('abcdef0123456789');
    const body = await res.text();
    expect(body).toContain('const VERSION = "abcdef0123456789";');
    expect(body).toContain('"/assets/app.js"');
    expect(body).toContain('function routeFor()');
    expect(body).not.toMatch(/^export /m);
    expect(body).not.toContain('sha256');
  });

  it('is 404 where no release wrote a manifest (dev, the demo, tests): nothing registers', async () => {
    const { '/asset-manifest.json': _, ...rest } = files;
    expect((await ask(env(rest))).status).toBe(404);
  });

  it('is the kill switch when SW_OFF is "1": it empties every HQ cache and unregisters', async () => {
    const res = await ask(env(files, { SW_OFF: '1' }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(KILL_SCRIPT);
    expect(body).toContain("key.startsWith('hq-')");
    expect(body).toContain('registration.unregister()');
    expect(res.headers.get('X-HQ-Release')).toBeNull();
  });

  it('composes the real routing table and core into one script that parses', () => {
    const route = readFileSync(new URL('../src/public/assets/sw-route.js', import.meta.url), 'utf8');
    const core = readFileSync(new URL('../src/public/assets/sw-core.js', import.meta.url), 'utf8');
    const body = buildServiceWorker({ version: '0123456789abcdef', files: [{ path: '/index.html' }] }, route, core);
    expect(() => new Function(body)).not.toThrow();
  });

  it('builds a script that parses', () => {
    const body = buildServiceWorker({ version: '0123456789abcdef', files: [{ path: '/index.html' }] }, 'export const A = 1;\nexport function routeFor() { return A; }', 'const B = 2;');
    expect(() => new Function(body)).not.toThrow();
    expect(() => new Function(KILL_SCRIPT)).not.toThrow();
  });
});
