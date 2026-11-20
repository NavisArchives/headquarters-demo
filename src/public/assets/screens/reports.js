// Reports (audit E18; F4, F9, F10; 14 Nov): what the outreach brings in, what
// the pipeline is worth, and the money by month, invoiced and received apart,
// one currency at a time. Read-only; every figure comes from /api/reports/*.
import { el, hero, emptyState } from '../dom.js';
import { apiFetch } from '../api.js';

const BY = [['dataset', 'By list'], ['batch', 'By batch'], ['template', 'By template']];
const STAGE_LABEL = { lead: 'Meeting to plan', meeting: 'Meeting planned', onboarding: 'Proposal in creation', proposal: 'Proposal sent', contract: 'Contract' };

const money = (cents, currency = 'EUR') => new Intl.NumberFormat('en-IE', { style: 'currency', currency, maximumFractionDigits: 0 }).format((Number(cents) || 0) / 100);
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');

/** A cell is a string, or [value, share] shown as « value  share ». A row flagged total: true is the sum line. */
function table(head, rows, extra = '') {
  const wrap = el('div', `tablewrap rep-table${extra ? ` ${extra}` : ''}`);
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of head) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  t.appendChild(thead);
  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr', r.total ? 'is-total' : null);
    for (const c of r) {
      const td = el('td', null, String(Array.isArray(c) ? c[0] : c));
      if (Array.isArray(c)) td.appendChild(el('span', 'pct', c[1]));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  t.appendChild(body);
  wrap.appendChild(t);
  return wrap;
}

/** The outreach funnel: leads, not emails; each step as a count and a share of « sent ». */
export function funnelCard(data, by, onBy) {
  const card = el('section', 'card');
  card.appendChild(el('p', 'eyebrow', 'Outreach funnel · leads emailed, and how far they went'));
  const tabs = el('div', 'tabs rep-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [v, label] of BY) {
    const b = el('button', 'tab', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v === by));
    b.addEventListener('click', () => onBy(v));
    tabs.appendChild(b);
  }
  card.appendChild(tabs);
  if (!data) { card.appendChild(emptyState('Report unavailable', 'HQ could not load this report. Reload to try again.')); return card; }
  const groups = data.groups ?? [];
  if (!groups.length) {
    card.appendChild(emptyState('Nothing sent yet', 'Once a send is logged (the send log, « Mark as sent » or the Gmail back-fill), it counts here.'));
    return card;
  }
  card.appendChild(table(['', 'Sent', 'Opened', 'Replied', 'In talks', 'Won'], groups.map((g) => [
    g.key, g.sent, [g.opened, pct(g.opened, g.sent)], [g.replied, pct(g.replied, g.sent)],
    [g.talks, pct(g.talks, g.sent)], [g.won, pct(g.won, g.sent)],
  ]), 'rep-funnel'));
  if (data.opens && !data.opens.complete) {
    card.appendChild(el('p', 'hint', `Opens read for the first ${data.opens.read} of ${data.opens.of} leads.`));
  }
  return card;
}

/** Open deals by stage, and what they are worth where a value is set. */
export function pipelineCard(data) {
  const card = el('section', 'card');
  card.appendChild(el('p', 'eyebrow', 'Pipeline value · open deals'));
  if (!data) { card.appendChild(emptyState('Report unavailable', 'HQ could not load pipeline values. Reload to try again.')); return card; }
  const open = data.open ?? [];
  if (!open.length) {
    card.appendChild(emptyState('No open deal', 'Deals on the Pipeline board count here.'));
    return card;
  }
  const order = Object.keys(STAGE_LABEL);
  const rows = [...open].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage)).map((r) => [
    STAGE_LABEL[r.stage] ?? r.stage, r.deals, money(r.value_cents), `${r.valued} of ${r.deals}`,
  ]);
  const t = data.open_total;
  rows.push(Object.assign(['All open', t.deals, money(t.value_cents), `${t.valued} of ${t.deals}`], { total: true }));
  card.appendChild(table(['Stage', 'Deals', 'Value', 'With a value'], rows));
  const won = data.won ?? { deals: 0, value_cents: 0, valued: 0 };
  card.appendChild(el('p', 'hint', `Won: ${won.deals} deal${won.deals === 1 ? '' : 's'}, ${money(won.value_cents)} where a value is set (${won.valued} of ${won.deals}). A deal's value is set on its page.`));
  return card;
}

/** Invoiced and received per month, one currency per row, never added together. */
export function moneyCard(data) {
  const card = el('section', 'card');
  card.appendChild(el('p', 'eyebrow', `Money by month · ${data?.year ?? ''} · invoiced (issue date) and received (payment date)`));
  if (!data) { card.appendChild(emptyState('Report unavailable', 'HQ could not load money totals. Reload to try again.')); return card; }
  const months = data.months ?? [];
  if (!months.length) {
    card.appendChild(emptyState('Nothing this year', 'Issued invoices and recorded payments count here.'));
    return card;
  }
  const label = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const rows = months.map((m) => [label(m.month), m.currency, money(m.invoiced_cents, m.currency), money(m.received_cents, m.currency)]);
  for (const [currency, t] of Object.entries(data.totals ?? {})) rows.push(Object.assign([`${data.year} total`, currency, money(t.invoiced_cents, currency), money(t.received_cents, currency)], { total: true }));
  card.appendChild(table(['Month', 'Currency', 'Invoiced', 'Received'], rows));
  return card;
}

export async function renderReports() {
  // On a phone (P6 block 4): one card at a time behind Funnel · Pipeline · Money,
  // the page still, the card's body the one region that scrolls.
  const root = el('div', 'reports phone-frame');
  root.appendChild(hero('The', 'numbers', 'Outreach, pipeline and money · read from HQ, nothing estimated'));
  let by = 'dataset';
  const funnelSlot = el('div');
  const [funnel, pipeline, money] = await Promise.all([
    apiFetch(`/api/reports/funnel?by=${by}`).catch(() => null),
    apiFetch('/api/reports/pipeline').catch(() => null),
    apiFetch('/api/reports/money').catch(() => null),
  ]);
  const drawFunnel = (data) => funnelSlot.replaceChildren(funnelCard(data, by, async (next) => {
    by = next;
    drawFunnel(await apiFetch(`/api/reports/funnel?by=${by}`).catch(() => null));
  }));
  drawFunnel(funnel);
  const grid = el('div', 'grid g-2');
  const pipe = pipelineCard(pipeline);
  const cash = moneyCard(money);
  funnelSlot.dataset.pane = 'funnel';
  pipe.dataset.pane = 'pipeline';
  cash.dataset.pane = 'money';
  grid.append(pipe, cash);
  const body = el('div', 'rep-body scroll-region');
  body.append(funnelSlot, grid);

  const seg = el('div', 'tabs rep-seg');
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', 'Reports');
  const tabs = {};
  const show = (key) => {
    root.dataset.seg = key;
    for (const [k, t] of Object.entries(tabs)) t.setAttribute('aria-selected', String(k === key));
    body.scrollTop = 0;
  };
  for (const [key, label] of [['funnel', 'Funnel'], ['pipeline', 'Pipeline'], ['money', 'Money']]) {
    const t = el('button', 'tab', label);
    t.type = 'button';
    t.setAttribute('role', 'tab');
    t.dataset.seg = key;
    t.addEventListener('click', () => show(key));
    tabs[key] = t;
    seg.appendChild(t);
  }
  show('funnel');
  root.append(seg, body);
  return root;
}
