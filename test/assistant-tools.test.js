import { describe, it, expect } from 'vitest';
import { TOOLS, TOOL_NAMES, toolDefinitions, stripFields, ALLOWED_CALLS, FORBIDDEN } from '../src/public/assets/assistant-tools.js';

// The assistant's tool list is closed (NIRMATA-approved plan, 19 Nov): it can read,
// add a to-do / follow-up date / note, build a DRAFT batch and draft reply text.
// It can never send, schedule, approve, export, pass, suppress, delete, touch
// invoices, deploy or run SQL.
describe('assistant tool list', () => {
  it('is exactly the approved list', () => {
    expect(TOOL_NAMES).toEqual(['find_leads', 'lead_card', 'list_replies', 'build_draft_batch', 'open_screen',
      'find_projects', 'list_invoices', 'list_missions', 'today_list', 'needs_attention', 'act_on_attention', 'add_todo', 'set_follow_up', 'add_note', 'draft_reply']);
  });

  it('every HQ call a tool may make is on the allow-list, and none is forbidden', () => {
    for (const tool of TOOLS) {
      for (const call of tool.calls) {
        expect(ALLOWED_CALLS.some((ok) => ok.method === call.method && ok.path.test(call.example)), `${tool.name} ${call.method} ${call.example}`).toBe(true);
        expect(FORBIDDEN.some((bad) => bad.test(`${call.method} ${call.example}`)), `${tool.name} ${call.method} ${call.example}`).toBe(false);
      }
    }
  });

  it('forbids the dangerous routes outright', () => {
    for (const bad of ['POST /api/outreach/batches/x/approve', 'POST /api/outreach/batches/x/send', 'GET /api/outreach/batches/x/export',
      'POST /api/outreach/batches/x/cancel', 'POST /api/intake', 'POST /api/finance/invoices', 'DELETE /api/todos/1', 'PUT /api/outreach/senders']) {
      expect(FORBIDDEN.some((re) => re.test(bad)), bad).toBe(true);
    }
  });

  it('a follow-up date can never pass a lead: its body carries follow_up only', () => {
    const tool = TOOLS.find((t) => t.name === 'set_follow_up');
    expect(tool.body({ uid: 'x/y', date: '2026-12-01', stage: 'passed' })).toEqual({ follow_up: '2026-12-01' });
    expect(tool.calls[0].path({ uid: 'web-demo/maison-verhoeven' })).toBe('/api/leads/web-demo/maison-verhoeven/state');
    expect(() => tool.calls[0].path({ uid: '../../finance/invoices' })).toThrow();
  });

  it('tool definitions are strict JSON schemas (no extra properties)', () => {
    for (const def of toolDefinitions()) {
      expect(def.input_schema.additionalProperties).toBe(false);
      expect(def.strict).toBe(true);
    }
  });

  it('strips addresses, phones and message bodies before anything leaves the Mac', () => {
    const lead = { uid: 'a/b', name: 'Bakkerij X', city: 'Gent', stage: 'new', email: 'info@x.be', phone: '+32 9', contact: 'info@x.be',
      body: 'Dear…', text: 'Dear…', sent_to: 'info@x.be', notes: 'call', payload: { email: 'info@x.be' } };
    const out = stripFields(lead);
    expect(out).toEqual({ uid: 'a/b', name: 'Bakkerij X', city: 'Gent', stage: 'new', notes: 'call' });
    expect(JSON.stringify(stripFields({ list: [lead] }))).not.toMatch(/@|\+32|Dear/);
    expect(stripFields({ note: 'Call 04 93 88 34 52 or 0329380849 or +32 2 000 00 00' }).note).not.toMatch(/\d{2} \d{2}|\d{6}/);
    expect(stripFields({ at: '2026-11-19T09:00:00Z', amount: '€2,400.00', day: '2026-12-01' })).toEqual({ at: '2026-11-19T09:00:00Z', amount: '€2,400.00', day: '2026-12-01' });
  });
});

describe('today_list: Home\'s own list (20 Nov: « what do I have to do today » gave two answers)', () => {
  it('reads only Home\'s five routes, all allowed, and marks what is late', async () => {
    const { todayList } = await import('../src/public/assets/assistant-tools.js');
    const asked = [];
    const get = async (method, path) => {
      asked.push(`${method} ${path}`);
      expect(ALLOWED_CALLS.some((c) => c.method === method && c.path.test(path)), path).toBe(true);
      if (path.startsWith('/api/todos')) return { todos: [{ id: 1, title: 'Call Alexis', due: '2026-11-18' }] };
      if (path === '/api/missions') return { missions: [{ id: 2, lead_uid: 'a/b', title: 'Answer Aurore', status: 'pending', turn: 'yours' }] };
      if (path.startsWith('/api/finance/invoices')) return { invoices: [{ id: 3, number: '2026.LS.02', due_on: '2026-10-20' }] };
      if (path === '/api/prospects') return { prospects: [] };
      return { followups_due: 0 };
    };
    const { result } = await todayList(get, '2026-11-20');
    expect(asked).toEqual(['GET /api/todos?open=1', 'GET /api/missions', 'GET /api/overview', 'GET /api/finance/invoices?status=overdue', 'GET /api/prospects']);
    expect(result.total).toBe(3);
    expect(result.late).toBe(2);
    expect(result.items.map((i) => i.title)).toEqual(['Chase 2026.LS.02', 'Call Alexis', 'Answer Aurore']);
  });
  it('names a read that failed instead of hiding it', async () => {
    const { todayList } = await import('../src/public/assets/assistant-tools.js');
    const get = async (method, path) => { if (path === '/api/missions') throw new Error('down'); return {}; };
    const { result } = await todayList(get, '2026-11-20');
    expect(result.items[0]).toMatchObject({ kind: 'alert', title: 'Missions could not be loaded' });
  });
});

describe('invoiceFacts: the model never sees raw cents (20 Nov: « 240 000 € » for €2,400)', () => {
  it('writes euros out, drops paid ones, puts overdue first', async () => {
    const { invoiceFacts } = await import('../src/public/assets/assistant-tools.js');
    const out = invoiceFacts([
      { number: '2026.CA.01', status: 'issued', computed_status: 'sent', overdue: 'true', due_on: '2026-11-19', total_cents: '181500', balance_cents: '181500' },
      { number: '2026.X.09', status: 'issued', computed_status: 'paid', total_cents: '50000', balance_cents: '0' },
      { number: null, status: 'draft', total_cents: '387200' },
      { number: '2026.LS.02', status: 'issued', computed_status: 'sent', due_on: '2026-10-20', total_cents: '240000', balance_cents: '240000' },
    ], '2026-11-20');
    expect(out.map((i) => [i.number, i.overdue, i.total])).toEqual([
      ['2026.CA.01', true, '€1,815.00'], ['2026.LS.02', true, '€2,400.00'], [null, false, '€3,872.00']]);
    expect(out[2].status).toBe('draft, not issued');
    expect(JSON.stringify(out)).not.toMatch(/_cents|181500|240000/);
  });
});
