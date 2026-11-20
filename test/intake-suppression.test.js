import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { handleIntake } from '../src/worker/intake.js';

// Suppressions go through the intake door, never as an SQL file again
// (Andy, 19 Nov: « find another smoother way »). Validated, idempotent, audited.
const TOKENS = {
  INTAKE_TOKEN_NIRMATA: 'n'.repeat(40), INTAKE_TOKEN_SHORTCUT: 's'.repeat(40),
  INTAKE_TOKEN_EMAIL: 'e'.repeat(40), INTAKE_TOKEN_LEADS: 'l'.repeat(40),
};
async function withEnv(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn({ DB: database, ...TOKENS }, database); } finally { await dispose(); }
}
function call(env, body, token = TOKENS.INTAKE_TOKEN_NIRMATA) {
  const request = new Request('https://hq.example.com/api/intake', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return handleIntake(request, env, new URL(request.url));
}
const body = (extra = {}) => ({ kind: 'suppression', idempotency_key: 'thu-stops-19nov', reason: 'hard bounce', emails: ['A@Example.com ', 'b@example.com'], ...extra });

describe('suppression (intake kind)', () => {
  it('suppresses each address once, lower-cased, with reason and source, and audits the request', () => withEnv(async (env, db) => {
    const res = await call(env, body());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'suppression', suppressed: 2, already: 0 });
    const rows = (await db.prepare('SELECT email, reason, source FROM email_suppression ORDER BY email').all()).results;
    expect(rows).toEqual([
      { email: 'a@example.com', reason: 'hard bounce', source: 'intake:nirmata' },
      { email: 'b@example.com', reason: 'hard bounce', source: 'intake:nirmata' },
    ]);
    const audit = await db.prepare("SELECT source, reason, emails, suppressed FROM suppression_requests WHERE idempotency_key = 'thu-stops-19nov'").first();
    expect(audit).toEqual({ source: 'nirmata', reason: 'hard bounce', emails: 2, suppressed: 2 });
  }));

  it('the same request again files nothing twice', () => withEnv(async (env, db) => {
    await call(env, body());
    const again = await call(env, body());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, kind: 'suppression' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM email_suppression').first()).n).toBe(2);
  }));

  it('a new request with an address already suppressed counts it as already, and keeps the first reason', () => withEnv(async (env, db) => {
    await call(env, body());
    const res = await call(env, body({ idempotency_key: 'declines-20nov', reason: 'declined by reply', emails: ['b@example.com', 'c@example.com'] }));
    expect(await res.json()).toMatchObject({ suppressed: 1, already: 1 });
    expect((await db.prepare("SELECT reason FROM email_suppression WHERE email = 'b@example.com'").first()).reason).toBe('hard bounce');
  }));

  it('MARKETING (LEADS token) may file it; the Shortcut and email tokens may not', () => withEnv(async (env) => {
    expect((await call(env, body(), TOKENS.INTAKE_TOKEN_LEADS)).status).toBe(201);
    expect((await call(env, body({ idempotency_key: 'x' }), TOKENS.INTAKE_TOKEN_SHORTCUT)).status).toBe(400);
    expect((await call(env, body({ idempotency_key: 'y' }), TOKENS.INTAKE_TOKEN_EMAIL)).status).toBe(400);
  }));

  it('refuses a bad request and stores nothing', () => withEnv(async (env, db) => {
    for (const bad of [
      body({ emails: [] }), body({ emails: ['not-an-address'] }), body({ reason: '' }),
      body({ emails: Array.from({ length: 301 }, (_, i) => `x${i}@example.com`) }), body({ idempotency_key: undefined }),
      body({ emails: ['a@example.com', 'A@example.com'] }),
    ]) {
      expect((await call(env, bad)).status).toBe(400);
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM email_suppression').first()).n).toBe(0);
  }));
});
