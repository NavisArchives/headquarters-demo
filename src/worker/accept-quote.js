/**
 * « Accept quote »: the day a quote comes back signed, its prepayment invoice
 * turns the lead into a client in one action (Andy via NIRMATA, 29 Oct:
 * « be smart, she needs to be added to client already »).
 *
 * Seven steps, each one HQ already had a screen for: the lead is won, the
 * project exists, the client and the invoice point at it, the order exists,
 * the onboarding questionnaire is prepared and the follow-ups are on the list.
 *
 * Every step checks whether it is already done and skips if so. That is what
 * makes it safe on live data without one big transaction: a run that stops
 * half-way is finished by running it again, and running it on a client set
 * up by hand (Dr Morel, 29 Oct) changes nothing. The plan is read first and
 * shown to Andy; nothing is written until he confirms.
 *
 * Never: an onboarding link (Andy makes it, and sends it himself), an email,
 * or an order line. The money stays on the prepayment invoice, where the
 * deposit and the balance already are; a once-line would bill it twice.
 */
import * as db from './db.js';
import * as orders from './orders-db.js';
import { createProspect, listProspects, updateProspect } from './prospects-db.js';
import * as store from './registry-store.js';
import { FREE_MAIL } from './api/gmail.js';
import { slugFrom } from '../shared/registry.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const euros = (cents) => `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** The client's lead: by the address on the client, then by its domain. */
async function findLead(database, email) {
  const uid = await db.findLeadUidByEmail(database, email);
  if (uid) return db.getLead(database, uid);
  const domain = String(email ?? '').split('@')[1];
  const byDomain = domain && !FREE_MAIL.has(domain.toLowerCase()) ? await db.findLeadUidByEmailDomain(database, domain) : null;
  return byDomain ? db.getLead(database, byDomain) : null;
}

/** The follow-ups a signed quote needs, dated from the invoice. */
function followUps(name, invoice, today) {
  const out = [
    { title: `${name}: get the onboarding answers`, due: addDays(today, 5), note: 'Texts, photos and the other items on the questionnaire. Andy sends the link himself.' },
  ];
  if (invoice.due_on) {
    const chase = addDays(invoice.due_on, -7);
    out.push({ title: `${name}: chase deposit ${invoice.number} if unpaid`, due: chase < today ? today : chase, note: `${euros(invoice.requested_cents)} due ${invoice.due_on}.` });
    out.push({ title: `${name}: start the project once ${invoice.number} is paid`, due: invoice.due_on, note: 'Switch the project to active.' });
  }
  return out;
}

/**
 * What Accept quote would do for this invoice, step by step, with `done` on
 * every step that already is. Throws a ValidationError when the invoice is
 * not an issued prepayment, or when its project would clash.
 *
 * @param input  { slug, name, parent } chosen on the sheet; each has a default
 */
export async function planAcceptQuote(database, invoiceId, registry, input = {}, today = db.hqToday()) {
  const invoice = await db.getInvoice(database, invoiceId);
  if (!invoice) return null;
  if (invoice.kind !== 'prepayment') throw new db.ValidationError('Accept quote works from a prepayment invoice (deposit + balance)', 'kind');
  if (!invoice.number || invoice.status === 'void') throw new db.ValidationError('Issue the prepayment invoice first', 'status');
  const client = invoice.client;

  const slug = input.slug ?? invoice.slug ?? client.slug ?? slugFrom(client.name);
  if (!SLUG_RE.test(slug)) throw new db.ValidationError('the project address must be lowercase letters, digits and dashes', 'slug');
  if (invoice.slug && invoice.slug !== slug) throw new db.ValidationError(`this invoice already belongs to the project « ${invoice.slug} »`, 'slug');
  if (client.slug && client.slug !== slug) throw new db.ValidationError(`this client already belongs to the project « ${client.slug} »`, 'slug');

  const project = (registry ?? []).find((p) => p.slug === slug) ?? null;
  const parents = (registry ?? []).filter((p) => p.kind === 'business' && !p.parent).map((p) => ({ slug: p.slug, name: p.name }));
  const parent = project?.parent ?? input.parent ?? (parents.some((p) => p.slug === 'realis-studio') ? 'realis-studio' : null);
  if (parent && !parents.some((p) => p.slug === parent)) throw new db.ValidationError('the brand must be one of HQ\'s businesses', 'parent');
  const lead = await findLead(database, client.email);
  const name = project?.name ?? (typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : client.name);

  const order = (await orders.listOrders(database, { clientId: client.id, slug }))[0] ?? null;
  // The deal this quote closes (audit A6, code-map F3). An open pipeline deal
  // has no client yet, so matching on client_id alone missed it: a second
  // « won » deal was made and the real one stayed open, chased every morning.
  // It is matched by client, then by the lead it came from, then by address.
  const prospects = await listProspects(database);
  const onboarding = prospects.find((p) => p.client_id === client.id) ?? null;
  const address = String(client.email ?? '').trim().toLowerCase();
  const openDeal = onboarding ? null : prospects.find((p) => p.client_id === null && p.stage !== 'lost'
    && ((lead && p.lead_uid === lead.uid) || (address && String(p.email ?? '').trim().toLowerCase() === address))) ?? null;
  const todos = followUps(name, invoice, today);
  const { results: existing } = await database.prepare(
    `SELECT title FROM todos WHERE title IN (${todos.map(() => '?').join(', ')})`,
  ).bind(...todos.map((t) => t.title)).all();
  const have = new Set((existing ?? []).map((t) => t.title));

  const steps = [
    { key: 'lead', label: lead ? `Lead « ${lead.name} » → won` : 'No lead found for this client\'s address', done: !lead || lead.stage === 'won' },
    { key: 'project', label: `Project « ${name} » (${slug})${parent ? ` under ${parents.find((p) => p.slug === parent)?.name}` : ''}, not started`, done: Boolean(project) },
    { key: 'client', label: `Client ${client.name} → project ${slug}`, done: client.slug === slug },
    { key: 'invoice', label: `Invoice ${invoice.number} → project ${slug}`, done: invoice.slug === slug },
    { key: 'order', label: `Order « ${invoice.lines[0]?.description ?? invoice.subject ?? name} », billed on ${invoice.number}`, done: Boolean(order) },
    openDeal
      ? { key: 'onboarding', label: `Deal « ${openDeal.name} » → won, for client ${client.name} (no link, nothing sent)`, done: false }
      : { key: 'onboarding', label: `Onboarding questionnaire for ${lead?.name ?? client.name} (no link, nothing sent)`, done: Boolean(onboarding) },
    ...todos.map((t, i) => ({ key: `todo${i}`, label: `To-do ${t.due}: ${t.title}`, done: have.has(t.title) })),
  ];

  return {
    invoice: { id: invoice.id, number: invoice.number, total_cents: invoice.total_cents, requested_cents: invoice.requested_cents },
    client: { id: client.id, name: client.name },
    lead: lead ? { uid: lead.uid, name: lead.name, stage: lead.stage } : null,
    slug, name, parent, parents, steps,
    // Not exposed on the sheet; the run needs them.
    _ctx: { invoice, client, lead, project, todos, today, openDeal },
  };
}

/** Runs every step of the plan that is not done yet, in order. */
export async function acceptQuote(database, invoiceId, registry, input = {}, { actor = '', today } = {}) {
  const plan = await planAcceptQuote(database, invoiceId, registry, input, today);
  if (!plan) return null;
  const { invoice, client, lead, todos } = plan._ctx;
  const day = plan._ctx.today;
  const left = new Set(plan.steps.filter((s) => !s.done).map((s) => s.key));
  const share = invoice.total_cents ? Math.round((invoice.requested_cents / invoice.total_cents) * 100) : 0;

  if (left.has('lead')) {
    await db.patchLeadState(database, lead.uid, {
      stage: 'won',
      follow_up: null,
      notes: `${lead.notes ? `${lead.notes}\n` : ''}${day}: quote accepted, deposit ${invoice.number} (${euros(invoice.requested_cents)}) issued. Client ${client.name} (#${client.id}), project « ${plan.slug} ».`,
    });
  }
  if (left.has('project')) {
    await store.createProject(database, {
      slug: plan.slug,
      name: plan.name,
      kind: 'client',
      description: `${invoice.lines[0]?.description ?? invoice.subject ?? 'Client project'} — ${euros(invoice.total_cents)}, quote accepted ${day}.`.slice(0, 300),
      stage: 'not_started',
      ...(plan.parent ? { parent: plan.parent } : {}),
      status: { probe: 'none' },
      note: `Quote accepted ${day}: ${euros(invoice.total_cents)}, deposit ${invoice.number}. Starts once the deposit is paid.`,
    }, registry, { actor });
  }
  if (left.has('client')) await db.updateClient(database, client.id, { slug: plan.slug });
  if (left.has('invoice')) await db.linkInvoiceProject(database, invoice.id, plan.slug);
  if (left.has('order')) {
    await orders.createOrder(database, {
      client_id: client.id,
      slug: plan.slug,
      title: invoice.lines[0]?.description ?? invoice.subject ?? plan.name,
      started_on: day,
      notes: [
        `${euros(invoice.total_cents)} agreed, billed on prepayment ${invoice.number}: deposit ${share} % (${euros(invoice.requested_cents)}) now, the balance with « Part 2 » at go-live.`,
        'No lines here for that money (a one-off line would bill it twice). Add monthly lines (care, maintenance) on the day they start.',
      ].join('\n'),
    });
  }
  if (left.has('onboarding') && plan._ctx.openDeal) {
    // The deal already in the pipeline is the one that was won: no second one.
    await updateProspect(database, plan._ctx.openDeal.id, {
      client_id: client.id,
      stage: 'won',
      next_step: 'Send the onboarding link (Andy, when he decides)',
    });
  } else if (left.has('onboarding')) {
    await createProspect(database, {
      name: lead?.name ?? client.name,
      organisation: client.name,
      email: client.email ?? null,
      brand: plan.parent === 'andyssarchives' ? 'archive' : 'realis',
      stage: 'won',
      client_id: client.id,
      ...(lead ? { lead_uid: lead.uid } : {}),
      next_step: 'Send the onboarding link (Andy, when he decides)',
    });
  }
  for (const [i, todo] of todos.entries()) {
    if (left.has(`todo${i}`)) await db.createTodo(database, { ...todo, ...(lead ? { lead_uid: lead.uid } : {}) });
  }
  return { done: [...left], slug: plan.slug, name: plan.name, parent: plan.parent };
}

/** The plan as the sheet sees it. */
export function publicPlan(plan) {
  if (!plan) return plan;
  const { _ctx, ...rest } = plan;
  return rest;
}
