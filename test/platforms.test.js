import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshDatabase } from './helpers/d1.js';
import { handlePlatforms } from '../src/worker/api/platforms.js';
import { cleanUrl } from '../src/worker/platforms-db.js';

/** Projects → Platforms (migration 0040), on workerd's SQLite through Miniflare. */
async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}
const call = async (database, method, path, body) => {
  const url = new URL(`http://localhost:8790${path}`);
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const res = await handlePlatforms(new Request(url, init), { DB: database }, url);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

describe('a platform', () => {
  it('is added, listed, edited, re-statused and removed through the API', async () => {
    await withDatabase(async (database) => {
      const made = await call(database, 'POST', '/api/platforms', { name: ' micro1 ', url: 'micro1.ai', status: 'test_to_do', next_step: 'AI interview', pay: '' });
      expect(made.status).toBe(201);
      expect(made.body.platform).toMatchObject({ name: 'micro1', url: 'https://micro1.ai/', status: 'test_to_do', next_step: 'AI interview', pay: '', note: '' });
      const id = made.body.platform.id;

      const moved = await call(database, 'PATCH', `/api/platforms/${id}`, { status: 'waiting' });
      expect(moved.body.platform.status).toBe('waiting');
      expect(moved.body.platform.updated_at >= made.body.platform.updated_at).toBe(true);

      const edited = await call(database, 'PATCH', `/api/platforms/${id}`, { pay: '$30/h', note: 'French role' });
      expect(edited.body.platform).toMatchObject({ pay: '$30/h', note: 'French role', status: 'waiting' });

      const listed = await call(database, 'GET', '/api/platforms');
      expect(listed.body.platforms.map((p) => p.name)).toEqual(['micro1']);

      expect((await call(database, 'DELETE', `/api/platforms/${id}`)).status).toBe(204);
      expect((await call(database, 'GET', '/api/platforms')).body.platforms).toEqual([]);
      expect((await call(database, 'DELETE', `/api/platforms/${id}`)).status).toBe(404);
      expect((await call(database, 'PATCH', `/api/platforms/${id}`, { status: 'active' })).status).toBe(404);
    });
  });

  it('lists the ones that need Andy first', async () => {
    await withDatabase(async (database) => {
      for (const [name, status] of [['A', 'closed'], ['B', 'active'], ['C', 'to_sign_up'], ['D', 'waiting'], ['E', 'test_to_do'], ['F', 'signed_up']]) {
        await call(database, 'POST', '/api/platforms', { name, status });
      }
      const { body } = await call(database, 'GET', '/api/platforms');
      expect(body.platforms.map((p) => p.status)).toEqual(['test_to_do', 'to_sign_up', 'signed_up', 'waiting', 'active', 'closed']);
    });
  });

  it('refuses anything that is not name, link, status, next step, pay or note: no login, password, code or ID', async () => {
    await withDatabase(async (database) => {
      for (const extra of [{ email: 'x' }, { password: 'x' }, { code: '1' }, { api_key: 'k' }, { id_number: '1' }]) {
        expect((await call(database, 'POST', '/api/platforms', { name: 'X', ...extra })).status).toBe(400);
      }
      const ok = await call(database, 'POST', '/api/platforms', { name: 'X' });
      expect((await call(database, 'PATCH', `/api/platforms/${ok.body.platform.id}`, { login: 'y' })).status).toBe(400);
      expect((await call(database, 'POST', '/api/platforms', { name: '  ' })).status).toBe(400);
      expect((await call(database, 'POST', '/api/platforms', { name: 'Y', status: 'paused' })).status).toBe(400);
      expect((await call(database, 'POST', '/api/platforms', { name: 'Y', url: 'javascript:alert(1)' })).status).toBe(400);
      expect((await call(database, 'GET', '/api/platforms')).body.platforms).toHaveLength(1);
    });
  });

  it('keeps no column for a secret, and never touches the projects tables', () => {
    const sql = readFileSync(new URL('../migrations/0040_platforms.sql', import.meta.url), 'utf8');
    const body = sql.slice(sql.indexOf('CREATE TABLE')).toLowerCase();
    for (const word of ['email', 'password', 'token', 'secret', 'api_key', 'id_number', 'login']) {
      expect(body).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
    expect(body).not.toMatch(/\bprojects\b/);
    for (const file of ['../src/worker/platforms-db.js', '../src/worker/api/platforms.js', '../src/public/assets/screens/platforms.js']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/FROM projects|\/api\/projects|\/api\/finance|\/api\/orders/);
    }
  });

  it('accepts a bare host as a link and rejects non-web addresses', () => {
    expect(cleanUrl('app.outlier.ai')).toBe('https://app.outlier.ai/');
    expect(cleanUrl('')).toBe('');
    expect(() => cleanUrl('ftp://x.com')).toThrow();
    expect(() => cleanUrl('localhost')).toThrow();
  });
});
