/* HQ assistant panel: a round button bottom right, ⌘K too. Mac only: online and
   on the phone the button is greyed « On the Mac ». The page runs the tools with
   Andy's own session and sends only stripped facts to the local helper, which
   alone holds the key (assistant/helper.mjs). Every write has an Undo; nothing
   sends, approves, passes or deletes. */
import { el } from './dom.js';
import { apiFetch } from './api.js';
import { toast, openModal } from './leads-ui.js';
import { TOOLS, ALLOWED_CALLS, FORBIDDEN, UID, stripFields, todayList, invoiceFacts } from './assistant-tools.js';
import { holdLabel } from './hold-reasons.js';

const HELPER = 'http://127.0.0.1:8789';
const onMac = () => location.hostname === 'localhost' && !matchMedia('(max-width: 760px)').matches;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const tomorrow = () => new Date(Date.parse(`${today()}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const STATE = { replied: 'Replied', talks: 'In talks', new: 'Not contacted yet', sent: 'Waiting for them', passed: 'Passed', won: 'Won' };
const words = (stage) => STATE[stage] ?? (stage ? stage[0].toUpperCase() + stage.slice(1) : '');
const json = (method, path, body) => apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

let leadsCache = null;
const leads = async () => (leadsCache ??= (await apiFetch('/api/leads'))?.leads ?? []);
const lead = async (uid) => (await leads()).find((l) => l.uid === uid);
const allowed = (method, path) => ALLOWED_CALLS.some((c) => c.method === method && c.path.test(path)) && !FORBIDDEN.some((f) => f.test(`${method} ${path}`));

/** Runs one tool: returns { result (what the model sees, stripped), tray[], action?, undo? }. */
export async function runTool(name, input, navigate) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { result: { error: 'unknown tool' }, tray: [] };
  const call = async (body) => {
    const c = tool.calls[0]; const path = c.path(input);
    if (!allowed(c.method, path)) throw new Error('not allowed');
    return c.method === 'GET' ? apiFetch(path) : json(c.method, path, body);
  };
  const leadItem = (l) => ({ title: l.name, sub: [words(l.state?.stage ?? 'new'), l.city].filter(Boolean).join(' · '), act: 'Open', go: `/leads?lead=${encodeURIComponent(l.uid)}` });
  switch (name) {
    case 'find_leads': {
      const words = String(input.query).toLowerCase().split(/\s+/).filter(Boolean);
      const found = (await leads()).filter((l) => words.every((w) => `${l.name} ${l.city} ${l.business}`.toLowerCase().includes(w))).slice(0, 10);
      return { result: found.map((l) => ({ uid: l.uid, name: l.name, city: l.city, business: l.business, stage: l.state?.stage ?? 'new' })), tray: found.map(leadItem) };
    }
    case 'lead_card': {
      const l = await lead(input.uid);
      return { result: { lead: l && { uid: l.uid, name: l.name, city: l.city, stage: l.state?.stage, follow_up: l.state?.follow_up, notes: l.state?.notes }, history: await call() }, tray: l ? [leadItem(l)] : [] };
    }
    case 'list_replies': {
      // Whose turn, as Home and Outreach show it (src/shared/turn.js).
      const r = await call(); const all = [...(r.warm ?? []), ...(r.check ?? []), ...(r.declined ?? [])];
      return { result: { your_turn: r.warm ?? [], check: r.check ?? [], said_no: r.declined ?? [], waiting_for_them: (r.waiting ?? []).length, mailbox: r.freshness?.mailbox?.state ?? 'unknown' },
        tray: all.map((x) => ({ title: x.name, sub: x.can_pass ? 'Said no' : (x.label ?? words(x.stage)), act: 'Open', go: x.uid ? `/leads?lead=${encodeURIComponent(x.uid)}` : '/missions' })) };
    }
    case 'list_invoices': {
      const r = await call(); const list = r.invoices ?? r ?? [];
      return { result: { invoices: invoiceFacts(list, today()) }, tray: (Array.isArray(list) ? list : []).filter((i) => !['paid', 'void'].includes(i.status)).slice(0, 10)
        .map((i) => ({ title: `${i.number ?? 'Draft'}${i.subject ? ` · ${i.subject}` : ''}`, sub: [i.status === 'sent' && i.due_on && i.due_on < today() ? 'Overdue' : (i.status ?? ''), i.due_on ? `due ${i.due_on}` : ''].filter(Boolean).join(' · '), act: 'Open', go: Number.isInteger(i.id) ? `/finance?invoice=${i.id}` : '/finance' })) };
    }
    case 'needs_attention': {
      const r = await call(); const queue = r.queue ?? [];
      return { result: { items: queue.map((i) => ({ number: i.number, title: i.title, kind: i.kind, asks: i.action, due: i.due ?? null })) },
        tray: queue.slice(0, 10).map((i) => ({ title: `${i.number ?? ''} ${i.title}`.trim(), sub: i.action || '', act: 'Open', go: i.href || '/outreach' })) };
    }
    case 'act_on_attention': {
      // A plan only: nothing is written until Andy presses « Do it » (then Undo in the toast).
      const body = { refs: (input.refs ?? []).slice(0, 20), action: input.action, days: input.days || undefined, note: input.note || undefined };
      const { plan = [] } = await call(body);
      const ok = plan.filter((p) => p.ok);
      const tray = plan.map((p) => ({ title: `${p.number ?? ''} ${p.title ?? p.ref}`.trim(), sub: p.ok ? p.change : `Not done: ${p.why}`, act: 'Open', go: '/outreach' }));
      const run = async () => {
        const out = await json('POST', '/api/outreach/attention/apply', body);
        const n = out.done?.length ?? 0;
        toast(n ? `${n} item${n === 1 ? '' : 's'} updated` : (out.skipped?.[0]?.why || 'Nothing changed'),
          n ? { action: { label: 'Undo', onClick: async () => { await json('POST', '/api/outreach/attention/undo', { undo: out.undo }); toast('Undone'); } } } : {});
      };
      return { result: { proposed: plan.map((p) => ({ item: p.number ?? p.ref, title: p.title ?? null, will: p.ok ? p.change : null, cannot: p.ok ? null : p.why })),
        status: ok.length ? 'Waiting for Andy to press Do it. Nothing has changed yet.' : 'Nothing can be done as asked.' },
      tray, action: ok.length ? { label: `Do it (${ok.length})`, run } : null };
    }
    case 'list_missions': { const r = await call(); return { result: r, tray: (r.missions ?? []).filter((m) => ['pending', 'in_progress', 'blocked'].includes(m.status)).slice(0, 8).map((m) => ({ title: m.title, sub: [m.status.replace('_', ' '), m.due ? `due ${String(m.due).slice(0, 10)}` : ''].filter(Boolean).join(' · '), act: 'Open', go: '/missions' })) }; }
    case 'today_list': {
      const get = (method, path) => { if (!allowed(method, path)) throw new Error('not allowed'); return apiFetch(path); };
      const { result, items } = await todayList(get, today());
      return { result, tray: items.slice(0, 10).map((i) => ({ title: i.title, sub: [i.sub, i.due ? `due ${String(i.due).slice(0, 10)}` : ''].filter(Boolean).join(' · '), act: 'Open', go: i.to || '/' })) };
    }
    case 'find_projects': {
      const r = await call(); const list = r.projects ?? r ?? [];
      return { result: r, tray: (Array.isArray(list) ? list : []).slice(0, 10).map((p) => ({ title: p.name, sub: p.state?.label ?? p.kind ?? '', act: 'Open', go: `/p/${p.slug}` })) };
    }
    case 'build_draft_batch': {
      const senders = (await apiFetch('/api/outreach/senders'))?.senders ?? [];
      const sender = input.sender || senders[0]?.email;
      if (!sender) return { result: { error: 'No sender configured in Outreach → Planner' }, tray: [], action: { label: 'Open Planner', go: '/outreach?view=planner' } };
      const r = await call(tool.body({ sender }, { tomorrow: tomorrow() }));
      const b = r.batch;
      if (!b) return { result: r, tray: [] };
      const counts = {};
      for (const sk of b.skipped) for (const reason of sk.reasons) counts[holdLabel(reason)] = (counts[holdLabel(reason)] ?? 0) + 1;
      const held = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([reason, n]) => ({ title: reason, sub: `${n} lead${n === 1 ? '' : 's'}`, act: 'See', go: '/outreach?view=planner' }));
      if (!b.items.length) {
        // An empty draft helps nobody: it is removed at once, and Andy sees why.
        await json('POST', `/api/outreach/batches/${b.id}/cancel`);
        return { result: { day: b.day, drafts: 0, held: b.skipped.length, held_reasons: counts, note: 'no draft kept' }, tray: held,
          action: { label: `See why ${b.skipped.length} are held`, go: '/outreach?view=planner' } };
      }
      return {
        result: { day: b.day, drafts: b.items.length, held: b.skipped.length, held_reasons: counts },
        tray: [{ title: `Draft for ${b.day}`, sub: `${b.items.length} emails · ${b.skipped.length} held`, act: 'Review', go: '/outreach?view=batches' }, ...held],
        action: { label: 'Review in Approvals', go: '/outreach?view=batches' },
        undo: { label: 'Undo: remove this draft', run: () => json('POST', `/api/outreach/batches/${b.id}/cancel`) },
      };
    }
    case 'open_screen': {
      const go = { home: '/', outreach: '/outreach', planner: '/outreach?view=planner', approvals: '/outreach?view=batches', leads: '/leads', onboarding: '/pipeline', finance: '/finance', missions: '/missions', projects: '/projects', reports: '/reports' }[input.screen] ?? '/';
      return { result: { opened: input.screen }, tray: [], action: { label: `Open ${input.screen}`, go } };
    }
    case 'add_todo': {
      const r = await call(tool.body(input, {}));
      const id = r.todo?.id;
      return { result: { added: input.title, due: input.due || null }, tray: [], undo: id && { label: 'Undo', run: () => json('DELETE', `/api/todos/${id}`) } };
    }
    case 'set_follow_up': {
      if (!UID.test(input.uid)) return { result: { error: 'not a lead id' }, tray: [] };
      const before = (await lead(input.uid))?.state?.follow_up ?? null;
      await call(tool.body(input, {}));
      return { result: { follow_up: input.date }, tray: [], undo: { label: 'Undo', run: () => json('PATCH', `/api/leads/${input.uid}/state`, { follow_up: before }) } };
    }
    case 'add_note': {
      if (!UID.test(input.uid)) return { result: { error: 'not a lead id' }, tray: [] };
      const before = (await lead(input.uid))?.state?.notes ?? '';
      await call(tool.body(input, { currentNotes: before, today: today() }));
      return { result: { noted: true }, tray: [], undo: { label: 'Undo', run: () => json('PATCH', `/api/leads/${input.uid}/state`, { notes: before }) } };
    }
    case 'draft_reply': {
      return { result: { placed_in_composer: true }, tray: [], action: { label: 'Open the draft', compose: input.text } };
    }
    default: return { result: { error: 'unknown tool' }, tray: [] };
  }
}

function composer(text) {
  const { modal, close } = openModal({ label: 'Draft reply', className: 'ow-modal' });
  const area = el('textarea', 'text-input'); area.value = text; area.rows = 14;
  const copy = el('button', 'btn primary', 'Copy'); copy.type = 'button';
  copy.addEventListener('click', async () => { await navigator.clipboard?.writeText(area.value); toast('Copied. Send it yourself from Gmail.'); close(); });
  modal.append(el('h2', null, 'Draft reply'), el('p', 'hint', 'Nothing is sent. Copy it into your reply and send it yourself.'), area, copy);
}

export function mountAssistant(navigate, { standalone = false } = {}) {
  const button = el('button', 'as-fab', '✦');
  button.type = 'button';
  button.setAttribute('aria-label', 'Assistant');
  // In the header, before « Mac online »; never a floating button over the page.
  const end = document.querySelector('.topbar-end');
  if (!standalone) { if (end) end.prepend(button); else document.body.append(button); }
  if (!standalone && !onMac()) { button.disabled = true; button.title = 'On the Mac'; return; }
  let token = null; let busy = false;
  const panel = el('section', 'as-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Assistant');
  const answer = el('p', 'as-answer'); const tray = el('div', 'as-tray'); const actions = el('div', 'as-actions'); const meta = el('p', 'as-meta');
  const form = el('form', 'as-form'); const input = el('input', 'text-input'); input.placeholder = 'Ask or tell HQ…'; input.setAttribute('aria-label', 'Ask the assistant');
  const head = el('div', 'as-head');
  const fresh = el('button', 'btn small', 'New question'); fresh.type = 'button';
  const x = el('button', 'as-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close the assistant');
  head.append(el('b', null, 'Assistant'), fresh, x);
  // Dictation (20 Nov): the sound goes to the helper on this Mac (whisper.cpp), never online.
  const mic = el('button', 'as-mic', 'Mic'); mic.type = 'button'; mic.setAttribute('aria-label', 'Dictate'); mic.hidden = true;
  form.append(input, mic); panel.append(head, form, answer, tray, actions, meta); document.body.append(panel);
  let recorder = null; let stopTimer = null;
  const micIdle = () => { mic.textContent = 'Mic'; mic.classList.remove('is-on'); mic.setAttribute('aria-label', 'Dictate'); mic.disabled = false; };
  mic.addEventListener('click', async () => {
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { answer.textContent = 'The microphone is not allowed for HQ. Allow it in System Settings → Privacy → Microphone.'; return; }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    const parts = [];
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) parts.push(e.data); });
    recorder.addEventListener('stop', async () => {
      clearTimeout(stopTimer); stream.getTracks().forEach((t) => t.stop()); recorder = null;
      mic.textContent = '…'; mic.disabled = true;
      try {
        const blob = new Blob(parts, { type: type || 'audio/webm' });
        const res = await fetch(`${HELPER}/transcribe`, { method: 'POST', headers: { 'Content-Type': blob.type, 'x-hq-assistant-token': token }, body: blob, signal: AbortSignal.timeout(90_000) });
        const out = await res.json();
        if (!res.ok) answer.textContent = out.error || 'The dictation could not be read.';
        else if (out.text) { input.value = input.value ? `${input.value} ${out.text}` : out.text; input.focus(); }
        else answer.textContent = 'Nothing was heard. Try again, a little closer to the microphone.';
      } catch { answer.textContent = 'The dictation could not be read. HQ works as usual.'; }
      micIdle();
    });
    recorder.start();
    mic.textContent = 'Stop'; mic.classList.add('is-on'); mic.setAttribute('aria-label', 'Stop dictating');
    stopTimer = setTimeout(() => recorder?.stop(), 30_000);
  });
  fresh.addEventListener('click', () => { answer.textContent = ''; tray.replaceChildren(); actions.replaceChildren(); input.value = ''; input.focus(); });
  const open = async () => {
    panel.hidden = false; input.focus();
    if (!token) {
      try { const session = await (await fetch(`${HELPER}/session`)).json(); token = session.token; mic.hidden = !session.dictation || !navigator.mediaDevices?.getUserMedia; meta.textContent = ''; }
      catch { meta.textContent = 'The assistant is not installed or not running on this Mac.'; }
    }
  };
  const close = () => {
    if (standalone) { window.webkit?.messageHandlers?.hqHideAsk?.postMessage(1); return; }
    panel.hidden = true; button.focus();
  };
  x.addEventListener('click', () => close());
  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); panel.hidden ? open() : close(); }
    if (e.key === 'Escape' && !panel.hidden) close();
  });
  if (standalone) {
    document.body.classList.add('ask-window'); panel.classList.add('as-standalone');
    window.hqAskFocus = () => { input.focus(); input.select(); };
    void open();
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim(); if (!q || busy || !token) return;
    busy = true; panel.dataset.busy = '1'; input.disabled = true; answer.textContent = '…'; tray.replaceChildren(); actions.replaceChildren();
    const messages = [{ role: 'user', content: q }];
    try {
      for (let step = 0; step < 6; step += 1) {
        // Never a spinner that never ends: the helper gives up on the model after ~70 s, the page after 90.
        const res = await fetch(`${HELPER}/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hq-assistant-token': token }, body: JSON.stringify({ messages }), signal: AbortSignal.timeout(90_000) });
        const out = await res.json();
        if (!res.ok) { answer.textContent = out.error || 'The assistant could not answer.'; break; }
        meta.textContent = `${out.used_today}/${out.limit} today · $${out.cost_today.toFixed(3)} · $${Number(out.cost_month ?? 0).toFixed(2)} of $${out.ceiling_month ?? 20} this month`;
        messages.push({ role: 'assistant', content: out.content });
        const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (text) answer.textContent = text;
        const uses = out.content.filter((b) => b.type === 'tool_use');
        if (out.stop_reason !== 'tool_use' || !uses.length) break;
        const results = [];
        for (const u of uses) {
          let r;
          try { r = await runTool(u.name, u.input, navigate); } catch (err) { r = { result: { error: err.message }, tray: [] }; }
          for (const item of r.tray ?? []) {
            const row = el('div', 'as-row');
            const who = el('div', 'as-who'); who.append(el('b', null, item.title), el('small', null, item.sub || ''));
            const go = el('button', 'btn small', item.act || 'Open'); go.type = 'button';
            go.addEventListener('click', () => { navigate(item.go); close(); });
            row.append(who, go); tray.append(row);
          }
          if (r.action) {
            const b = el('button', 'btn primary', r.action.label); b.type = 'button';
            b.addEventListener('click', async () => {
              if (r.action.run) { b.disabled = true; try { await r.action.run(); b.remove(); } catch (err) { b.disabled = false; toast(err.message || 'It did not work'); } return; }
              if (r.action.compose) composer(r.action.compose); else { navigate(r.action.go); close(); }
            });
            actions.replaceChildren(b);
          }
          if (r.undo) {
            const b = el('button', 'btn', r.undo.label); b.type = 'button';
            b.addEventListener('click', async () => { await r.undo.run(); leadsCache = null; toast('Undone'); b.remove(); });
            actions.append(b);
          }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(stripFields(r.result)).slice(0, 6000) });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch { answer.textContent = 'The assistant could not answer just now. HQ works as usual.'; }
    finally {
      // A refusal or an empty reply has no text: say so instead of leaving « … » (20 Nov health check).
      if (answer.textContent === '…') answer.textContent = 'The assistant has no answer to that. Ask it another way, or do it yourself in HQ.';
      busy = false; panel.dataset.busy = '0'; input.disabled = false; input.value = ''; input.focus(); }
  });
}
