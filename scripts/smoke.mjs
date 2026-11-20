import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_BASE } from './gate-target.mjs';
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_TEST_URL.
const origin = process.env.HQ_TEST_URL || DEMO_BASE;
const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const password = process.env.HQ_TEST_PASSWORD || vars.match(/^HQ_PASSWORD=(.*)$/m)?.[1];
const login = await fetch(`${origin}/login`, { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });
assert.equal(login.status, 302, 'login succeeds');
const cookie = login.headers.get('set-cookie').split(';')[0];
async function api(path, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin }, body: body ? JSON.stringify(body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
assert.equal((await fetch(`${origin}/api/missions`)).status, 401, 'unauthenticated API protected');
const { projects } = await api('/api/projects'); assert.ok(projects.length);
const overview = await api('/api/overview'); assert.ok(overview.leads.total >= 214);
const { leads } = await api('/api/leads?business=UGC'); assert.equal(leads.length, 150);
const uid = leads[0].uid;
const { lead } = await api(`/api/leads/${uid}`);
await api(`/api/leads/${uid}/state`, 'PATCH', { notes: lead.notes });
assert.ok((await api(`/api/leads/${uid}/compose?lang=EN`)).body);
const { mission } = await api('/api/missions', 'POST', { title: 'HQ automated smoke test' });
await api(`/api/missions/${mission.id}`, 'PATCH', { status: 'done' });
await api(`/api/missions/${mission.id}`, 'DELETE');
const { meta } = await api(`/api/projects/${projects[0].slug}/meta`);
await api(`/api/projects/${projects[0].slug}/meta`, 'PUT', meta);
await api('/api/finance/overview'); await api('/api/finance/clients'); await api('/api/finance/invoices');
assert.ok((await api('/api/finance/issuer')).issuer.name);
assert.equal((await fetch(`${origin}/api/missions`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://elsewhere.invalid' }, body: '{}' })).status, 403);
console.log(`PASS: authenticated HQ, ${projects.length} projects, ${overview.leads.total} leads, outreach, mission lifecycle, project notes, finance, cross-origin protection.`);
