// The order card on a project page: what this client is charged for here, in
// what rhythm, what has accrued since, and the one button that turns it into
// a draft invoice.
//
// Four rhythms, from the API: `once` (a build, a package), `monthly` (care,
// hosting), `daily` (a shoot day, an editing day) and `hourly` (a session, a
// shift). The card never invents money — every figure comes from the order's
// own entries.
import { el, emptyState } from '../dom.js';
import { dayOf } from '../dates.js';
import { apiFetch } from '../api.js';
import { toast, openModal } from '../leads-ui.js';
import { money, shortMoney, centsFromEuros } from '../finance-lib.js';
import { identity } from '../identity.js';

const KIND_LABEL = { once: 'one-off', monthly: 'per month', daily: 'per day', hourly: 'per hour' };
// The two kinds you log by hand, and the words each one is counted in.
const UNIT = {
  daily: { one: 'day', many: 'days', title: 'Log a day', button: '+ Day worked', step: '0.5', preset: 1 },
  hourly: { one: 'hour', many: 'hours', title: 'Log hours', button: '+ Hours worked', step: '0.25', preset: 1 },
};
const countOf = (kind, n) => `${n} ${n === 1 ? UNIT[kind].one : UNIT[kind].many}`;

/**
 * The order card's styles live in projects.css, which the projects screen
 * loads lazily. Finance shows orders too and must not depend on the owner
 * having visited a project first, so this card loads them as well. It is the
 * same `projects-css` element id, so whichever screen renders first wins and
 * the second is a no-op — and it is written out here rather than imported
 * from the projects screen, which already imports this file.
 */
function ensureOrderStyles() {
  if (document.getElementById('projects-css')) return;
  const link = document.createElement('link');
  link.id = 'projects-css';
  link.rel = 'stylesheet';
  link.href = '/assets/projects.css';
  document.head.appendChild(link);
}
const day = (value) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '');

function rateLine(line) {
  const row = el('div', 'ord-line');
  const text = el('div', 'ord-line__text');
  text.append(el('b', null, line.description));
  const meta = line.kind === 'once' && line.quantity !== 1
    ? `${line.quantity} × ${money(line.unit_cents)}`
    // A monthly line says from when it bills (audit B10).
    : `${KIND_LABEL[line.kind]}${line.kind === 'monthly' && line.starts_on ? ` · from ${line.starts_on}` : ''}`;
  text.append(el('small', null, meta));
  row.append(text);
  row.append(el('span', `ord-rate k-${line.kind}`, money(line.unit_cents)));
  return row;
}

/** A small form in a pop-up, the way everything else in HQ asks a question. */
function ask(title, fields, onSubmit) {
  const { modal, close } = openModal({ className: 'narrow', label: title });
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.append(el('div', 'crumb', 'Order'), el('h2', null, title));
  head.append(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', close);
  nav.append(x);
  head.append(nav);
  modal.append(head);

  const form = el('form', 'ord-form');
  const controls = new Map();
  for (const field of fields) {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'label', field.label));
    let control;
    if (field.type === 'select') {
      control = el('select', 'text-input');
      for (const [value, text] of field.options) {
        const option = el('option', null, text);
        option.value = value;
        control.append(option);
      }
      if (field.value) control.value = field.value;
    } else {
      control = el('input', 'text-input');
      control.type = field.type || 'text';
      if (field.value !== undefined) control.value = field.value;
      if (field.placeholder) control.placeholder = field.placeholder;
      if (field.step) control.step = field.step;
    }
    controls.set(field.name, control);
    wrap.append(control);
    form.append(wrap);
  }
  const actions = el('div', 'sendrow');
  const save = el('button', 'btn primary', 'Save');
  save.type = 'submit';
  actions.append(save);
  form.append(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const values = Object.fromEntries([...controls].map(([key, node]) => [key, node.value]));
      await onSubmit(values);
      close();
    } catch (error) {
      toast(error?.message || 'That could not be saved');
      save.disabled = false;
    }
  });
  modal.append(form);
  const first = controls.values().next().value;
  if (first) first.focus();
}

/* ---- packages: what you sell, priced once -----------------------------
   A package is a named set of order lines. It is not made in a form: it is
   made from an order you already built properly, which is how a price list
   actually comes about. Applying one turns a new client's order from six
   fields of typing into one choice, and it is what stops the same work
   costing different money from one client to the next. */

export async function loadPackages() {
  return apiFetch('/api/finance/packages').then((b) => b?.packages ?? []).catch(() => []);
}

export async function savePackages(list) {
  return apiFetch('/api/finance/packages', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages: list }),
  });
}

/** What a package charges, in one line of prose, for a picker. */
export function packageSummary(pack) {
  return (pack.lines ?? [])
    .map((line) => `${line.description} ${money(line.unit_cents)}${line.kind === 'once' ? '' : ` ${KIND_LABEL[line.kind]}`}`)
    .join(' · ');
}

/**
 * The card. `slug` is the project; `clients` is the list the picker offers
 * when there is no order yet. Re-renders itself in place after every change,
 * so the figures on screen are always the ones in the database.
 */
export async function orderCard(slug, { navigate, clients = [], orderId = null, onChange, compactEmpty = false } = {}) {
  ensureOrderStyles();
  const card = el('section', 'card ord-card');

  async function load() {
    if (orderId) {
      const one = await apiFetch(`/api/finance/orders/${orderId}`);
      return one?.order ?? null;
    }
    const body = await apiFetch(`/api/finance/orders?slug=${encodeURIComponent(slug)}`);
    const list = body?.orders ?? [];
    if (!list.length) return null;
    const full = await apiFetch(`/api/finance/orders/${list[0].id}`);
    return full?.order ?? null;
  }

  async function refresh() {
    const order = await load().catch(() => null);
    paint(order);
    onChange?.();
  }

  function paint(order) {
    card.replaceChildren();
    // The project page: no order is one small button, no card (the page places it).
    const small = compactEmpty && !order;
    card.className = small ? 'ord-start' : 'card ord-card';
    if (order) card.closest?.('.money-card')?.after(card);
    // Declared here, not in the block below: the order's client is added to it
    // further down (audit A1: « eyebrow is not defined » after Make it a project).
    let eyebrow = null;
    if (!small) {
      eyebrow = el('p', 'eyebrow');
      eyebrow.append(document.createTextNode('Order'));
      card.append(eyebrow);
    }

    if (!order) {
      if (!small) {
        card.append(emptyState(
          'No order yet',
          'An order says what this client is charged for on this project: a one-off build, a monthly fee, a day rate — or all three.',
        ));
      }
      if (clients.length) {
        const add = el('button', small ? 'btn small' : 'btn primary small', 'Start an order');
        add.type = 'button';
        add.addEventListener('click', () => ask('Start an order', [
          { name: 'client_id', label: 'Client', type: 'select', options: clients.map((c) => [String(c.id), c.name]) },
          { name: 'title', label: 'What is it for', placeholder: 'Website and care' },
          { name: 'started_on', label: 'Starts on', type: 'date', value: dayOf() },
        ], async (values) => {
          await apiFetch('/api/finance/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...values, client_id: Number(values.client_id), slug }),
          });
          toast('Order started');
          await refresh();
        }));
        card.append(add);
      } else {
        card.append(el('p', 'hint', 'Add a client in Finance first — an order belongs to one.'));
      }
      return;
    }

    eyebrow?.append(el('span', 'n', `${order.client_name}${order.status === 'ended' ? ' · ended' : ''}`));

    const t = order.totals ?? {};
    const figures = el('div', 'ord-figs');
    const fig = (value, label, cls = '') => {
      const f = el('div', `ord-fig ${cls}`.trim());
      f.append(el('b', null, value), el('span', null, label));
      return f;
    };
    if (t.monthly_cents) figures.append(fig(shortMoney(t.monthly_cents), 'per month'));
    if (t.day_rate_cents) figures.append(fig(shortMoney(t.day_rate_cents), 'per day'));
    if (t.hour_rate_cents) figures.append(fig(shortMoney(t.hour_rate_cents), 'per hour'));
    if (t.days_logged) figures.append(fig(String(t.days_logged), t.days_logged === 1 ? 'day logged' : 'days logged'));
    if (t.hours_logged) figures.append(fig(String(t.hours_logged), t.hours_logged === 1 ? 'hour logged' : 'hours logged'));
    // A quoted project is billed on its prepayment invoice, not by lines here:
    // the order shows those figures rather than a misleading €0 (NIRMATA F2, 29 Oct).
    const prepaid = order.prepayments ?? [];
    if (prepaid.length) {
      figures.append(
        fig(shortMoney(t.prepaid_total_cents ?? 0), 'agreed'),
        fig(shortMoney(t.prepaid_asked_cents ?? 0), 'invoiced'),
        fig(shortMoney(t.prepaid_paid_cents ?? 0), 'paid', (t.prepaid_paid_cents ?? 0) < (t.prepaid_asked_cents ?? 0) ? 'is-due' : ''),
      );
    }
    if (!prepaid.length || t.uninvoiced_cents) {
      figures.append(fig(shortMoney(t.uninvoiced_cents ?? 0), 'not yet invoiced', t.uninvoiced_cents ? 'is-due' : ''));
    }
    card.append(figures);

    const lines = el('div', 'ord-lines');
    for (const line of order.lines) {
      const row = rateLine(line);
      const remove = el('button', 'ord-x', '✕');
      remove.type = 'button';
      remove.title = `Remove ${line.description}`;
      remove.setAttribute('aria-label', `Remove ${line.description}`);
      remove.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/finance/orders/${order.id}/lines/${line.id}`, { method: 'DELETE' });
          toast('Line removed');
          await refresh();
        } catch (error) { toast(error?.message || 'That line could not be removed'); }
      });
      row.append(remove);
      lines.append(row);
    }
    for (const p of prepaid) {
      const row = el('p', 'hint');
      const link = el('a', 'money-link', p.number);
      link.href = `/finance/${p.id}`;
      link.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || !navigate) return;
        event.preventDefault();
        navigate(link.getAttribute('href'));
      });
      row.append("Billed on prepayment ", link, ` — ${shortMoney(p.asked_cents)} of ${shortMoney(p.total_cents)} invoiced, ${shortMoney(p.paid_cents)} paid.`);
      lines.append(row);
    }
    if (!order.lines.length && !prepaid.length) lines.append(el('p', 'hint', 'Nothing is charged yet. Add what was agreed.'));
    card.append(lines);

    const actions = el('div', 'ord-actions');
    const addLine = el('button', 'btn small', '+ Charge');
    addLine.type = 'button';
    addLine.title = 'Add something this client is charged for';
    addLine.addEventListener('click', () => ask('Add a charge', [
      { name: 'kind', label: 'How often', type: 'select', options: [['once', 'One-off'], ['monthly', 'Every month'], ['daily', 'Per day worked'], ['hourly', 'Per hour worked']] },
      { name: 'description', label: 'What it is', placeholder: 'Shoot day' },
      { name: 'amount', label: 'Amount (€)', type: 'number', step: '0.01', placeholder: '450' },
      { name: 'quantity', label: 'How many (one-off only)', type: 'number', step: '0.5', value: '1' },
      // A care plan starts at go-live, not when the order was opened (audit B10).
      { name: 'starts_on', label: 'Monthly from (go-live)', type: 'date', value: dayOf() },
    ], async (values) => {
      await apiFetch(`/api/finance/orders/${order.id}/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: values.kind,
          description: values.description,
          unit_cents: centsFromEuros(values.amount, 'amount'),
          quantity: Number(values.quantity) || 1,
          ...(values.kind === 'monthly' && values.starts_on ? { starts_on: values.starts_on } : {}),
        }),
      });
      toast('Charge added');
      await refresh();
    }));
    actions.append(addLine);

    // Editing and ending an order have been routed since the day orders
    // shipped; nothing in the browser ever called them. A monthly line
    // therefore accrued forever, because `ended_on` could only be set when
    // the order was created and the form never asked for it.
    // Apply a package, or make one from what is already here.
    const fromPackage = el('button', 'btn small', '+ Package');
    fromPackage.type = 'button';
    fromPackage.title = 'Add everything in one of your packages at once';
    fromPackage.addEventListener('click', async () => {
      const packs = await loadPackages();
      if (!packs.length) {
        toast('No packages yet — build an order, then press "Save as package"');
        return;
      }
      ask('Add a package', [
        { name: 'which', label: 'Package', type: 'select', options: packs.map((pack, i) => [String(i), `${pack.name} · ${packageSummary(pack)}`]) },
      ], async (values) => {
        const pack = packs[Number(values.which)] ?? packs[0];
        for (const line of pack.lines) {
          // Sequential on purpose: each line takes the next position, and
          // the order they were priced in is the order they should read in.
          // eslint-disable-next-line no-await-in-loop
          await apiFetch(`/api/finance/orders/${order.id}/lines`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(line),
          });
        }
        toast(`${pack.name} added — ${pack.lines.length} charge${pack.lines.length === 1 ? '' : 's'}`);
        await refresh();
      });
    });
    actions.append(fromPackage);

    if (order.lines.length) {
      const asPackage = el('button', 'btn small', 'Save as package');
      asPackage.type = 'button';
      asPackage.title = 'Keep these charges and their prices, to reuse on the next client';
      asPackage.addEventListener('click', () => ask('Save as a package', [
        { name: 'name', label: 'Call it', placeholder: 'Website and care' },
        { name: 'brand', label: 'Which business', type: 'select', options: [
          ['', 'Either'], ['realis', identity().brandWeb], ['andyssarchives', identity().brandUgc],
        ] },
      ], async (values) => {
        const name = String(values.name || '').trim();
        if (!name) throw new Error('Give the package a name');
        const packs = await loadPackages();
        const lines = order.lines.map((line) => ({
          kind: line.kind, description: line.description,
          unit_cents: line.unit_cents, quantity: line.quantity,
        }));
        const next = packs.filter((pack) => pack.name !== name)
          .concat([{ name, brand: values.brand || null, lines }]);
        await savePackages(next);
        toast(`Saved "${name}" — it is on every order now`);
      }));
      actions.append(asPackage);
    }

    const edit = el('button', 'btn small', 'Edit');
    edit.type = 'button';
    edit.title = 'Change what this order is, when it started, or what it says';
    edit.addEventListener('click', () => ask('Edit order', [
      { name: 'title', label: 'What this order is', value: order.title || '' },
      { name: 'started_on', label: 'Starts on', type: 'date', value: order.started_on || '' },
      { name: 'notes', label: 'Note', value: order.notes || '' },
    ], async (values) => {
      await apiFetch(`/api/finance/orders/${order.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      toast('Order updated');
      await refresh();
    }));
    actions.append(edit);

    if (order.status !== 'ended') {
      const end = el('button', 'btn small', 'End order');
      end.type = 'button';
      end.title = 'Stop the monthly charges from the date you give';
      end.addEventListener('click', () => ask('End this order', [
        { name: 'ended_on', label: 'Last day it runs', type: 'date', value: dayOf() },
      ], async (values) => {
        await apiFetch(`/api/finance/orders/${order.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ended', ended_on: values.ended_on }),
        });
        // Ending an order stops money accruing, so it says so plainly rather
        // than closing in silence.
        toast(`Ended on ${values.ended_on} — no month after that is charged`);
        await refresh();
      }));
      actions.append(end);
    } else {
      const reopen = el('button', 'btn small', 'Reopen');
      reopen.type = 'button';
      reopen.title = 'Start charging again from the month you reopen it';
      reopen.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/finance/orders/${order.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'active', ended_on: '' }),
          });
          toast('Order reopened');
          await refresh();
        } catch (error) { toast(error?.message || 'That could not be reopened'); }
      });
      actions.append(reopen);
    }

    for (const kind of ['daily', 'hourly']) {
      const logged = order.lines.filter((l) => l.kind === kind);
      if (!logged.length) continue;
      const unit = UNIT[kind];
      const log = el('button', 'btn small', unit.button);
      log.type = 'button';
      log.title = `Log ${unit.many} against the ${unit.one} rate`;
      log.addEventListener('click', () => ask(unit.title, [
        { name: 'line_id', label: 'Rate', type: 'select', options: logged.map((l) => [String(l.id), `${l.description} · ${money(l.unit_cents)}`]) },
        { name: 'happened_on', label: 'Date', type: 'date', value: dayOf() },
        { name: 'quantity', label: `How many ${unit.many}`, type: 'number', step: unit.step, value: String(unit.preset) },
        { name: 'description', label: 'Note (optional)', placeholder: '' },
      ], async (values) => {
        const quantity = Number(values.quantity) || 1;
        await apiFetch(`/api/finance/orders/${order.id}/${kind === 'hourly' ? 'hours' : 'days'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...values, line_id: Number(values.line_id), quantity }),
        });
        toast(`${countOf(kind, quantity)} logged`);
        await refresh();
      }));
      actions.append(log);
    }

    if (t.uninvoiced_count) {
      const invoice = el('button', 'btn primary small', `Invoice ${shortMoney(t.uninvoiced_cents)}`);
      invoice.type = 'button';
      invoice.title = 'Put everything not yet invoiced on a new draft';
      invoice.addEventListener('click', async () => {
        invoice.disabled = true;
        try {
          const made = await apiFetch(`/api/finance/orders/${order.id}/invoice`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
          });
          toast('Draft invoice created');
          if (made?.invoice?.id) navigate?.(`/finance/${made.invoice.id}`);
          else await refresh();
        } catch (error) {
          toast(error?.message || 'That could not be invoiced');
          invoice.disabled = false;
        }
      });
      actions.append(invoice);
    }
    card.append(actions);

    const pending = order.entries.filter((e) => !e.invoice_id);
    if (pending.length) {
      const list = el('div', 'ord-entries');
      list.append(el('p', 'ord-entries__head', 'Waiting to be invoiced'));
      for (const entry of pending.slice(0, 8)) {
        const row = el('div', 'ord-entry');
        row.append(el('span', 'ord-entry__what', entry.period ? `${entry.description} · ${entry.period}` : entry.description));
        const when = UNIT[entry.kind] && entry.quantity !== 1
          ? `${day(entry.happened_on)} · ${countOf(entry.kind, entry.quantity)}`
          : day(entry.happened_on);
        row.append(el('span', 'ord-entry__when', when));
        row.append(el('span', 'ord-entry__sum', money(Math.round(entry.unit_cents * entry.quantity))));
        list.append(row);
      }
      if (pending.length > 8) list.append(el('p', 'hint', `and ${pending.length - 8} more`));
      card.append(list);
    }
  }

  paint(await load().catch(() => null));
  return card;
}

/** The same card, in a pop-up — for an order that has no project page yet. */
export async function openOrderPopup(orderId, { navigate, onChange } = {}) {
  const { modal, close } = openModal({ className: 'narrow', label: 'Order' });
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.append(el('div', 'crumb', 'Finance'), el('h2', null, 'Order'));
  head.append(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '\u2715');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => { close(); onChange?.(); });
  nav.append(x);
  head.append(nav);
  modal.append(head);
  modal.append(await orderCard(null, { navigate, orderId }));
}

/** Belgium, the Netherlands, France and Luxembourg by name; anything else
 *  keeps the invoice default, which the client screen can correct. */
const COUNTRY_CODE = {
  belgium: 'BE', belgië: 'BE', belgique: 'BE',
  netherlands: 'NL', nederland: 'NL',
  france: 'FR', luxembourg: 'LU', germany: 'DE', deutschland: 'DE',
};

function initialsFrom(name) {
  const words = String(name || '').split(/[^A-Za-zÀ-ÿ0-9]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return letters || 'CL';
}

/**
 * A lead that said yes becomes work: the client is created from what the lead
 * already told us, and an order is opened for it. Nothing is invented — every
 * field comes from the lead's own row, and the lead is marked accepted so the
 * pipeline and the money agree with each other.
 */
/** The open order a lead already became, found by the « Lead: <uid> » line
 *  every lead order carries in its notes. */
export function orderForLead(orders, uid) {
  const mark = `Lead: ${uid}`;
  return (orders ?? []).find((o) => o.status !== 'ended'
    && String(o.notes ?? '').split('\n').some((line) => line.trim() === mark)) ?? null;
}

export async function leadToProject(lead, { navigate, onChange } = {}) {
  const [clients, orders] = await Promise.all([
    apiFetch('/api/finance/clients').then((b) => b?.clients ?? []).catch(() => []),
    apiFetch('/api/finance/orders').then((b) => b?.orders ?? []).catch(() => []),
  ]);
  // Pressed a second time (audit A1): open the order it already made, never a second one.
  const made = orderForLead(orders, lead.uid);
  if (made) {
    toast(`${lead.name} is a project already — opening its order`);
    await openOrderPopup(made.id, { navigate });
    return;
  }
  const existing = clients.find((c) => (lead.email && c.email && c.email.toLowerCase() === lead.email.toLowerCase())
    || c.name.trim().toLowerCase() === String(lead.name || '').trim().toLowerCase());

  ask('Turn this lead into a project', [
    { name: 'client', label: 'Client', type: 'select', options: [
      ...(existing ? [[String(existing.id), `${existing.name} (already a client)`]] : []),
      ['new', existing ? `Create another client called ${lead.name}` : `Create the client ${lead.name}`],
      ...clients.filter((c) => c.id !== existing?.id).map((c) => [String(c.id), c.name]),
    ] },
    { name: 'title', label: 'What the project is', value: lead.name || '' },
    { name: 'started_on', label: 'Starts on', type: 'date', value: dayOf() },
  ], async (values) => {
    let clientId = Number(values.client);
    if (values.client === 'new') {
      const made = await apiFetch('/api/finance/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: lead.name,
          initials: initialsFrom(lead.name),
          email: lead.email || null,
          address: [lead.city, lead.area].filter(Boolean).join(', ') || null,
          country: COUNTRY_CODE[String(lead.country || '').toLowerCase()] || 'BE',
        }),
      });
      clientId = made?.client?.id;
    }
    const notes = [
      lead.website ? `Site: ${lead.website}` : null,
      lead.languages?.length ? `Languages: ${lead.languages.join(' / ')}` : null,
      lead.category ? `From the ${lead.category} list` : null,
      `Lead: ${lead.uid}`,
    ].filter(Boolean).join('\n');
    const order = await apiFetch('/api/finance/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, title: values.title, started_on: values.started_on, notes }),
    });
    // The pipeline and the money agree: a lead that became work is accepted.
    if (lead.stage !== 'won') {
      await apiFetch(`/api/leads/${lead.uid}/state`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'won' }),
      }).catch(() => {});
    }
    toast(`${lead.name} is a project now — add what they are charged for`);
    onChange?.();
    await openOrderPopup(order?.order?.id, { navigate });
  });
}

/** A mission that turned out to be a piece of paid work. */
export async function missionToProject(mission, { navigate, onChange } = {}) {
  const clients = await apiFetch('/api/finance/clients').then((b) => b?.clients ?? []).catch(() => []);
  if (!clients.length) { toast('Add a client in Finance first — an order belongs to one'); return; }
  ask('Turn this mission into a project', [
    { name: 'client_id', label: 'Client', type: 'select', options: clients.map((c) => [String(c.id), c.name]) },
    { name: 'title', label: 'What the project is', value: mission.title || '' },
    { name: 'started_on', label: 'Starts on', type: 'date', value: dayOf() },
  ], async (values) => {
    const order = await apiFetch('/api/finance/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: Number(values.client_id),
        slug: mission.slug || null,
        title: values.title,
        started_on: values.started_on,
        notes: [mission.detail, `Mission #${mission.id}`].filter(Boolean).join('\n\n'),
      }),
    });
    toast('Project opened from the mission');
    onChange?.();
    await openOrderPopup(order?.order?.id, { navigate });
  });
}

/**
 * Start an order from nothing — no lead, no mission, no project page.
 *
 * This is what makes Finance self-sufficient: a client who arrives by phone,
 * by a friend or by an offer over a coffee can be put into HQ in one pop-up,
 * a new client created on the spot if there is not one yet, and the charges
 * added immediately afterwards on the order that opens.
 */
export async function newOrder({ navigate, onChange } = {}) {
  const [clients, projects] = await Promise.all([
    apiFetch('/api/finance/clients').then((b) => b?.clients ?? []).catch(() => []),
    apiFetch('/api/projects').then((b) => b?.projects ?? []).catch(() => []),
  ]);

  ask('New order', [
    { name: 'client', label: 'Client', type: 'select', options: [
      ...clients.map((c) => [String(c.id), c.name]),
      ['new', clients.length ? 'A new client…' : 'A new client'],
    ] },
    { name: 'client_name', label: 'New client\u2019s name (only if new)', placeholder: 'Mix Brussels' },
    { name: 'title', label: 'What this order is', placeholder: 'Ice bath treatments' },
    { name: 'started_on', label: 'Starts on', type: 'date', value: dayOf() },
    { name: 'slug', label: 'Project (optional)', type: 'select', options: [
      ['', 'No project'],
      ...projects.map((project) => [project.slug, project.name]),
    ] },
    { name: 'notes', label: 'Note (optional)', placeholder: 'What was agreed' },
  ], async (values) => {
    let clientId = Number(values.client);
    if (values.client === 'new') {
      const name = String(values.client_name || '').trim();
      if (!name) throw new Error('Give the new client a name');
      const made = await apiFetch('/api/finance/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, initials: initialsFrom(name), country: 'BE' }),
      });
      clientId = made?.client?.id;
    }
    if (!clientId) throw new Error('Pick a client, or create one');

    const order = await apiFetch('/api/finance/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        slug: values.slug || null,
        title: String(values.title || '').trim() || 'Untitled order',
        started_on: values.started_on,
        notes: values.notes || '',
      }),
    });
    toast('Order started — add what they are charged for');
    onChange?.();
    await openOrderPopup(order?.order?.id, { navigate });
  });
}

/** Every order, for the Finance screen: one row each, newest first. */
export async function ordersSection(navigate) {
  ensureOrderStyles();
  const card = el('section', 'card');
  const eyebrow = el('p', 'eyebrow');
  eyebrow.append(document.createTextNode('Orders'));
  card.append(eyebrow);

  const body = el('div', 'ord-list');
  card.append(body);

  // The same actions row the order card uses, so the button sits where every
  // other action in this design sits: under what it acts on.
  const actions = el('div', 'ord-actions');
  const start = el('button', 'btn small', '+ New order');
  start.type = 'button';
  start.title = 'Start an order for any client, with or without a project';
  actions.append(start);
  card.append(actions);

  async function paint() {
    body.replaceChildren();
    const list = await apiFetch('/api/finance/orders').then((b) => b?.orders ?? []).catch(() => []);
    eyebrow.querySelectorAll('.n').forEach((n) => n.remove());
    eyebrow.append(el('span', 'n', `${list.length}`));
    if (!list.length) {
      body.append(el('p', 'ord-empty', 'An order says what a client is charged for — a build, a monthly fee, a day rate, an hourly rate. Start one here, or from a project page, a lead or a mission.'));
      return;
    }
    for (const order of list) {
      const row = el('button', 'ord-row');
      row.type = 'button';
      const text = el('span', 'ord-row__text');
      text.append(el('b', null, order.title || 'Untitled order'));
      text.append(el('small', null, [order.client_name, order.project_name || order.slug, order.status === 'ended' ? 'ended' : null].filter(Boolean).join(' · ')));
      row.append(text);
      row.append(el('span', 'ord-row__when', order.started_on));
      row.addEventListener('click', () => openOrderPopup(order.id, { navigate, onChange: paint }));
      body.append(row);
    }
  }
  start.addEventListener('click', () => newOrder({ navigate, onChange: paint }));

  await paint();
  return card;
}
