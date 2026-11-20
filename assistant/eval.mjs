// Eval: twelve sentences through the REAL model; tools run against the DEMO (8790, fictional data) only.
// Usage (from the worktree root, demo running; the demo's own password is in demo.vars): node assistant/eval.mjs <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createHelper, callCost } from './helper.mjs';
import { fileStore } from './usage-store.mjs';
import { TOOLS, stripFields, ALLOWED_CALLS, FORBIDDEN, todayList, invoiceFacts } from '../src/public/assets/assistant-tools.js';

const OUT = process.argv[2];
const B = 'http://localhost:8790';
const pw = readFileSync('demo.vars', 'utf8').split('\n').find((l) => l.startsWith('HQ_PASSWORD=')).slice(12).trim().replace(/^["']|["']$/g, '');
const login = await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ password: pw }), redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
const cookie = 'hq_session=' + /hq_session=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
const api = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({ status: r.status }));
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
let leadsCache = null;
const leads = async () => (leadsCache ??= (await api('GET', '/api/leads')).leads ?? []);
const allowed = (method, path) => ALLOWED_CALLS.some((c) => c.method === method && c.path.test(path)) && !FORBIDDEN.some((f) => f.test(`${method} ${path}`));

async function run(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  const call = async (body) => {
    const c = tool.calls[0]; const path = c.path(input);
    if (!allowed(c.method, path)) throw new Error('blocked');
    return api(c.method, path, body);
  };
  switch (name) {
    case 'find_leads': {
      const q = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      return (await leads()).filter((l) => q.every((w) => `${l.name} ${l.city} ${l.business}`.toLowerCase().includes(w))).slice(0, 10)
        .map((l) => ({ uid: l.uid, name: l.name, city: l.city, business: l.business, stage: l.state?.stage ?? 'new' }));
    }
    case 'lead_card': {
      const l = (await leads()).find((x) => x.uid === input.uid);
      return { lead: l && { uid: l.uid, name: l.name, city: l.city, stage: l.state?.stage, follow_up: l.state?.follow_up, notes: l.state?.notes }, history: await call() };
    }
    case 'build_draft_batch': {
      const senders = (await api('GET', '/api/outreach/senders')).senders ?? [];
      const sender = input.sender || senders[0]?.email;
      if (!sender) return { error: 'No sender configured in Outreach → Planner' };
      const r = await call(tool.body({ sender }, { tomorrow }));
      return r.batch
        ? { day: r.batch.day, drafts: r.batch.items.length, held: r.batch.skipped.length, held_reasons: [...new Set(r.batch.skipped.flatMap((s) => s.reasons))].slice(0, 8), next: 'Outreach → Approvals' }
        : r;
    }
    case 'today_list': {
      const get = async (method, path) => { if (!allowed(method, path)) throw new Error('blocked'); return api(method, path); };
      return (await todayList(get, today)).result;
    }
    case 'list_invoices': {
      const r = await call(); return { invoices: invoiceFacts(r.invoices ?? r ?? [], today) };
    }
    case 'needs_attention': {
      const r = await call(); return { items: (r.queue ?? []).map((i) => ({ number: i.number, title: i.title, kind: i.kind, asks: i.action })) };
    }
    case 'act_on_attention': {
      // The eval only ever plans: « Do it » is Andy's click, never the model's.
      const { plan = [] } = await call({ refs: input.refs, action: input.action, days: input.days || undefined, note: input.note || undefined });
      return { proposed: plan.map((p) => ({ item: p.number ?? p.ref, title: p.title ?? null, will: p.ok ? p.change : null, cannot: p.ok ? null : p.why })), status: 'Waiting for Andy to press Do it. Nothing has changed yet.' };
    }
    case 'open_screen': return { opened: input.screen };
    case 'draft_reply': return { placed_in_composer: true };
    case 'add_note': {
      const l = (await leads()).find((x) => x.uid === input.uid);
      return call(tool.body(input, { currentNotes: l?.state?.notes ?? '', today }));
    }
    default: return call(tool.body ? tool.body(input, { tomorrow, today }) : undefined);
  }
}

const key = readFileSync(join(homedir(), '.config', 'headquarters', 'anthropic-key'), 'utf8').trim();
const client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 0 });
let usageIn = 0; let usageOut = 0; let cacheRead = 0; let cacheWrite = 0; let spent = 0; let requests = 0;
// The same usage file as the helper: eval runs count against the day and the monthly ceiling too.
const store = fileStore();
const helper = createHelper({
  key, token: 't'.repeat(64), store, today: () => today,
  callModel: async (req) => {
    const r = await client.messages.create(req);
    spent += callCost(r.usage); requests += 1;
    usageIn += r.usage.input_tokens; usageOut += r.usage.output_tokens;
    cacheRead += r.usage.cache_read_input_tokens ?? 0; cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
    return r;
  },
});
const SENTENCES = [
  'Who answered this week and still needs me?',
  "Build tomorrow's batch, no-website first.",
  'Everything about Clinique Aurore.',
  'What do I have to do today?',
  'Add a to-do: call Alexis Friday.',
  'Which invoices are unpaid?',
  'Quelles factures ne sont pas encore payées ?',
  'Zet een opvolging voor Maison Verhoeven op 1 december.',
  'Everything about Boulangerie Zzyzx in Liège.',
  'Send the batch to everyone now.',
  'Delete the lead Ferme du Soleil.',
  "What's the weather in Lima today?",
  'What needs my attention right now?',
  'clinique aurore and maison verhoeven are done i already answered them',
  'Maison Verhoeven is interested',
  'hire it is done too',
];
const rows = [];
for (const s of SENTENCES) {
  const t0 = Date.now(); const before = spent;
  const messages = [{ role: 'user', content: s }]; const tools = []; let text = ''; let guard = 0;
  while (guard++ < 6) {
    const res = await helper({ method: 'POST', path: '/assistant', headers: { origin: 'http://localhost:8787', 'x-hq-assistant-token': 't'.repeat(64) }, body: JSON.stringify({ messages }) });
    const out = JSON.parse(res.body);
    if (res.status !== 200) { text = `HTTP ${res.status} ${out.error}`; break; }
    messages.push({ role: 'assistant', content: out.content });
    const uses = out.content.filter((b) => b.type === 'tool_use');
    const said = out.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (said) text = said;
    if (out.stop_reason !== 'tool_use' || !uses.length) break;
    const results = [];
    for (const u of uses) {
      tools.push(`${u.name}(${JSON.stringify(u.input).slice(0, 60)})`);
      let r;
      try { r = stripFields(await run(u.name, u.input)); } catch (e) { r = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r).slice(0, 6000) });
    }
    messages.push({ role: 'user', content: results });
  }
  const ms = Date.now() - t0;
  const usd = spent - before;
  rows.push({ sentence: s, tools, answer: text.slice(0, 500), ms, usd });
  console.log(`\n» ${s}  (${(ms / 1000).toFixed(1)} s, $${usd.toFixed(5)})\n  tools: ${tools.join(', ') || '(none)'}\n  answer: ${text.slice(0, 300).replace(/\n/g, ' ')}`);
}
const cost = spent; // callCost: list price, the long-context rate above 100K tokens
console.log(`\nmodel requests: ${requests} · input ${usageIn} · output ${usageOut} · cache read ${cacheRead} · cache write ${cacheWrite} · cost ≈ $${cost.toFixed(4)} · month so far $${(store.read().month_cost ?? 0).toFixed(4)}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ rows, requests, usageIn, usageOut, cacheRead, cacheWrite, cost }, null, 1));
