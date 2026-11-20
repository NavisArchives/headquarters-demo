// The prospect page keeps typed notes across a redraw, and reads its three
// sources together (audit 14).
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';
import { freshDatabase } from './helpers/d1.js';
import * as pdb from '../src/worker/prospects-db.js';

installDom();
// The page marks the top menu; the shim's document has no menu to mark.
globalThis.document.querySelectorAll ??= () => [];
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.document.addEventListener ??= () => {};
globalThis.document.removeEventListener ??= () => {};
const { renderProspect } = await import('../src/public/assets/screens/pipeline.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

async function aProspect() {
  const { database, dispose } = await freshDatabase();
  try {
    const made = await pdb.createProspect(database, { name: 'Studio Test', organisation: 'Test bv', stage: 'meeting', notes: 'saved note' });
    return await pdb.getProspect(database, made.id);
  } finally { await dispose(); }
}

function stub(prospect, { failNotes = false } = {}) {
  const calls = [];
  let current = prospect;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method, at: calls.length });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).startsWith(`/api/prospects/${prospect.id}`) && method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (failNotes && body.notes !== undefined) return reply({ error: 'nope' }, 500);
      current = { ...current, ...body };
      return reply({ prospect: current });
    }
    if (String(url) === `/api/prospects/${prospect.id}`) return reply({ prospect: current });
    if (String(url).includes('/api/finance/clients')) return reply({ clients: [] });
    if (String(url).includes('/api/onboarding-templates')) return reply({ templates: [] });
    return reply({});
  };
  return calls;
}

const notesBox = (root) => root.querySelector('textarea.pl-notes');
const type = (area, text) => { area.value = text; for (const fn of area.listeners.input ?? []) fn({ target: area }); };
const buttonsWith = (root, label) => root.querySelectorAll('button').filter((b) => b.textContent.trim() === label);

describe('the prospect page', () => {
  it('asks for the prospect, the clients and the templates together', async () => {
    const p = await aProspect();
    const calls = stub(p);
    await renderProspect({}, p.id);
    const first = calls.slice(0, 3).map((c) => c.url.split('?')[0]).sort();
    expect(first).toEqual(['/api/finance/clients', '/api/onboarding-templates', `/api/prospects/${p.id}`].sort());
  }, 30000);

  it('keeps unsaved notes when another save redraws the page', async () => {
    const p = await aProspect();
    stub(p);
    const root = await renderProspect({}, p.id);
    type(notesBox(root), 'typed, not saved');
    // Any other save repaints the page from the server.
    // Save the next step: any save repaints the page from the server.
    const saveNext = buttonsWith(root, 'Save')[0];
    expect(saveNext).toBeTruthy();
    for (const fn of saveNext.listeners.click) fn({ target: saveNext });
    for (let i = 0; i < 20; i += 1) await tick(); // eslint-disable-line no-await-in-loop
    expect(root.querySelectorAll('textarea').length).toBeGreaterThan(0);
    expect(notesBox(root).value).toBe('typed, not saved');
  }, 30000);

  it('keeps the draft when the save fails, through a later redraw', async () => {
    const p = await aProspect();
    stub(p, { failNotes: true });
    const root = await renderProspect({}, p.id);
    type(notesBox(root), 'kept on failure');
    for (const fn of buttonsWith(root, 'Save notes')[0].listeners.click) fn({});
    for (let i = 0; i < 20; i += 1) await tick(); // eslint-disable-line no-await-in-loop
    // A later save repaints: the notes that failed to save are still there.
    for (const fn of buttonsWith(root, 'Save')[0].listeners.click) fn({});
    for (let i = 0; i < 20; i += 1) await tick(); // eslint-disable-line no-await-in-loop
    expect(notesBox(root).value).toBe('kept on failure');
  }, 30000);

  it('after a good save, the box shows what the server holds', async () => {
    const p = await aProspect();
    stub(p);
    const root = await renderProspect({}, p.id);
    type(notesBox(root), 'saved now');
    for (const fn of buttonsWith(root, 'Save notes')[0].listeners.click) fn({});
    for (let i = 0; i < 20; i += 1) await tick(); // eslint-disable-line no-await-in-loop
    expect(notesBox(root).value).toBe('saved now');
  }, 30000);
});
