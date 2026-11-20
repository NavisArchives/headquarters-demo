import * as db from '../db.js';
import * as orders from '../orders-db.js';
import { onPrepaymentSettled } from '../deposit-paid.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
async function body(request) {
  let value;
  try { value = await request.json(); } catch { throw new db.ValidationError('Expected JSON', 'body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new db.ValidationError('Expected an object', 'body');
  return value;
}
const result = (key, value, status = 200) => (value ? json({ [key]: value }, status) : json({ error: 'Not found or action unavailable' }, 404));

/** An id is a positive decimal integer, nothing else. `\d+` also matched `0`
 *  and `007`, which are not ids any row ever has: they reached the database
 *  as a lookup that could only miss, or (for `0`) as an id `assertId` refuses,
 *  which is a 400 where the honest answer is 404. */
const ID = '([1-9]\\d*)';
const CLIENT_PATH = new RegExp(`^/api/finance/clients/${ID}$`);
// DELETE /api/finance/invoices/<id>/payments/<paymentId>: a payment taken back (audit B8).
const PAYMENT_PATH = new RegExp(`^/api/finance/invoices/${ID}/payments/${ID}$`);
const INVOICE_PATH = new RegExp(`^/api/finance/invoices/${ID}(?:/(lines|issue|unissue|sent|paid|void|part|payments|bank|issuer|snooze))?$`);
// One issuer profile (Andy, 14 Nov: Belgium or Abroad IE), edited from Your invoice details.
const PROFILE_PATH = /^\/api\/finance\/issuer\/profiles\/([a-z0-9_-]{1,20})$/;
const PROJECT_PATH = /^\/api\/finance\/projects\/([^/]+)$/;
// `days` and `hours` are the same action under two honest names: the line's
// kind decides which unit is written, so the path only has to read true.
const ORDER_PATH = new RegExp(`^/api/finance/orders/${ID}(?:/(lines|days|hours|work|entries|invoice)(?:/${ID})?)?$`);

/** An invoice belongs to a project by `slug` — the registry's slug, the same
 *  one the project page uses. The registry is the app's own deploy-time
 *  artifact, not data, so it is handed in from index.js rather than imported
 *  here: the name is attached to each invoice on the way out, never stored,
 *  and a slug that is not in the registry is refused on the way in.
 *
 *  `projects` omitted (a direct call, a test) means no registry is available:
 *  nothing is decorated and no slug is refused. */
function projectHelpers(projects) {
  const names = new Map((projects ?? []).map((p) => [p.slug, p.name]));
  return {
    known: (slug) => (projects ? names.has(slug) : true),
    decorate(invoice) {
      if (!invoice || typeof invoice !== 'object') return invoice;
      return { ...invoice, project_name: invoice.slug ? (names.get(invoice.slug) ?? null) : null };
    },
    /** Refuses a slug no project has, before it is written to a row that the
     *  project page would then never find. */
    check(input) {
      if (!projects || !input || typeof input !== 'object') return input;
      if (typeof input.slug === 'string' && input.slug && !names.has(input.slug)) {
        throw new db.ValidationError('slug must be a project in the registry', 'slug');
      }
      return input;
    },
  };
}

export async function handleFinance(request, env, url, projects, { file = [] } = {}) {
  const path = url.pathname;
  if (!path.startsWith('/api/finance/')) return null;
  const method = request.method;
  const client = path.match(CLIENT_PATH);
  const item = path.match(INVOICE_PATH);
  const paymentItem = path.match(PAYMENT_PATH);
  const project = path.match(PROJECT_PATH);
  const order = path.match(ORDER_PATH);
  const profileItem = path.match(PROFILE_PATH);
  // `projects` may be a function that reads the registry (index.js): the
  // screens' read-only routes that never use it skip that D1 query, and the
  // two list reads run it alongside their own query instead of before it.
  const loadProjects = () => (typeof projects === 'function' ? projects() : projects);
  const noRegistry = method === 'GET' && (path === '/api/finance/overview' || path === '/api/finance/expenses'
    || path === '/api/finance/issuer' || path === '/api/finance/clients' || path === '/api/finance/packages')
    || !!profileItem;
  const parallelRead = method === 'GET' && (path === '/api/finance/invoices' || !!project);
  let helpers = noRegistry || parallelRead ? projectHelpers(null) : projectHelpers(await loadProjects());
  const { check } = helpers;
  const known = (slug) => helpers.known(slug);
  const decorate = (x) => helpers.decorate(x);
  const invoiceResult = (value, status) => result('invoice', value && decorate(value), status);
  // A path this router knows, asked with a method it does not support, is 405;
  // anything else under /api/finance/ is 404. They are different answers and
  // the screen tells them apart.
  const knownPath = path === '/api/finance/overview' || path === '/api/finance/issuer'
    || path === '/api/finance/clients' || path === '/api/finance/invoices'
    || path === '/api/finance/orders' || path === '/api/finance/packages'
    || path === '/api/finance/expenses'
    || !!client || !!item || !!project || !!order || !!paymentItem || !!profileItem;

  try {
    if (path === '/api/finance/overview' && method === 'GET') return json(await db.financeOverview(env.DB));
    if (path === '/api/finance/expenses' && method === 'GET') {
      const year = url.searchParams.get('year');
      return json({ expenses: await db.listExpenses(env.DB, year ? { year: Number(year) } : {}) });
    }

    /* ---- orders: what a client is charged for on one project ---- */
    if (path === '/api/finance/orders') {
      if (method === 'GET') {
        const list = await orders.listOrders(env.DB, {
          clientId: url.searchParams.has('client_id') ? Number(url.searchParams.get('client_id')) : null,
          slug: url.searchParams.get('slug'),
        });
        return json({ orders: list.map((o) => decorate(o)) });
      }
      if (method === 'POST') {
        const input = check(await body(request));
        return result('order', decorate(await orders.createOrder(env.DB, input)), 201);
      }
    }
    if (order) {
      const id = Number(order[1]);
      const sub = order[2];
      const childId = order[3] ? Number(order[3]) : null;
      if (!sub) {
        if (method === 'GET') {
          const found = await orders.getOrder(env.DB, id);
          return result('order', found && decorate(found));
        }
        if (method === 'PATCH') {
          const patch = check(await body(request));
          const updated = await orders.updateOrder(env.DB, id, patch);
          return result('order', updated && decorate(updated));
        }
        if (method === 'DELETE') {
          const gone = await orders.deleteOrder(env.DB, id);
          return gone ? new Response(null, { status: 204 }) : json({ error: 'Not found or action unavailable' }, 404);
        }
      }
      if (sub === 'lines') {
        if (method === 'POST') return result('line', await orders.addOrderLine(env.DB, id, await body(request)), 201);
        if (method === 'DELETE' && childId) {
          const gone = await orders.removeOrderLine(env.DB, id, childId);
          return gone ? new Response(null, { status: 204 }) : json({ error: 'Not found or action unavailable' }, 404);
        }
      }
      if ((sub === 'days' || sub === 'hours' || sub === 'work') && method === 'POST') {
        return result('entry', await orders.logOrderWork(env.DB, id, await body(request)), 201);
      }
      if (sub === 'entries' && method === 'DELETE' && childId) {
        const gone = await orders.removeOrderEntry(env.DB, id, childId);
        return gone ? new Response(null, { status: 204 }) : json({ error: 'Not found or action unavailable' }, 404);
      }
      if (sub === 'invoice' && method === 'POST') {
        const made = await orders.invoiceOrder(env.DB, id, await body(request).catch(() => ({})));
        return made ? json({ invoice: decorate(made.invoice), entries: made.entries }, 201) : json({ error: 'Not found or action unavailable' }, 404);
      }
    }
    if (path === '/api/finance/issuer') {
      if (method === 'GET') {
        const [issuer, bankAccounts, profiles] = await Promise.all([db.getIssuer(env.DB), db.getBankAccounts(env.DB), db.getIssuerProfiles(env.DB)]);
        return json({ issuer, bank_accounts: bankAccounts, issuer_profiles: profiles });
      }
      if (method === 'PUT') {
        const issuer = await body(request);
        for (const field of ['name', 'address', 'vat_number', 'email', 'iban']) {
          if (typeof issuer[field] !== 'string' || !issuer[field].trim()) throw new db.ValidationError(`${field} is required`, field);
        }
        await db.setSetting(env.DB, 'issuer', issuer);
        return json({ issuer });
      }
    }
    if (profileItem && method === 'PUT') {
      return json({ profile: await db.setIssuerProfile(env.DB, profileItem[1], await body(request)) });
    }
    // What you sell, priced once. A package is a named set of order lines —
    // "Website build", "Care", "Shoot day" — so a new client is picked rather
    // than typed, and the same work costs the same thing twice running.
    if (path === '/api/finance/packages') {
      if (method === 'GET') return json({ packages: (await db.getSetting(env.DB, 'packages')) ?? [] });
      if (method === 'PUT') {
        const sent = await body(request);
        const list = Array.isArray(sent) ? sent : sent.packages;
        if (!Array.isArray(list)) throw new db.ValidationError('send a list of packages', 'packages');
        if (list.length > 40) throw new db.ValidationError('that is more packages than HQ will hold', 'packages');
        const clean = list.map((pack, index) => {
          const name = typeof pack?.name === 'string' ? pack.name.trim() : '';
          if (!name) throw new db.ValidationError(`package ${index + 1} needs a name`, 'name');
          const lines = Array.isArray(pack.lines) ? pack.lines : [];
          if (!lines.length) throw new db.ValidationError(`"${name}" has nothing in it`, 'lines');
          return {
            name,
            brand: pack.brand === 'realis' || pack.brand === 'andyssarchives' ? pack.brand : null,
            lines: lines.map((line) => {
              const kind = ['once', 'monthly', 'daily', 'hourly'].includes(line?.kind) ? line.kind : null;
              if (!kind) throw new db.ValidationError(`"${name}" has a charge with no rhythm`, 'kind');
              const description = typeof line.description === 'string' ? line.description.trim() : '';
              if (!description) throw new db.ValidationError(`"${name}" has a charge with no name`, 'description');
              const unitCents = Number(line.unit_cents);
              if (!Number.isInteger(unitCents) || unitCents < 0) throw new db.ValidationError(`"${description}" has no price`, 'unit_cents');
              const quantity = Number(line.quantity);
              return { kind, description, unit_cents: unitCents, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 };
            }),
          };
        });
        await db.setSetting(env.DB, 'packages', clean);
        return json({ packages: clean });
      }
    }
    if (path === '/api/finance/clients') {
      if (method === 'GET') return json({ clients: await db.listClients(env.DB) });
      if (method === 'POST') return result('client', await db.createClient(env.DB, check(await body(request))), 201);
    }
    if (client && method === 'PATCH') return result('client', await db.updateClient(env.DB, Number(client[1]), check(await body(request))));
    if (project && method === 'GET') {
      // The path carries a percent-encoded slug; the registry holds the real
      // one. A malformed encoding is not a project either.
      let slug;
      try { slug = decodeURIComponent(project[1]); } catch { return json({ error: 'No such project' }, 404); }
      // An unknown slug is not a project, so there is nothing to answer with
      // — the same 404 /api/projects/<slug>/meta gives.
      const [list, money] = await Promise.all([loadProjects(), db.financeProject(env.DB, slug)]);
      helpers = projectHelpers(list);
      if (!known(slug)) return json({ error: 'No such project' }, 404);
      return json({ ...money, invoices: money.invoices.map(decorate) });
    }
    if (path === '/api/finance/invoices') {
      if (method === 'GET') {
        const [list, invoices] = await Promise.all([loadProjects(), db.listInvoices(env.DB, Object.fromEntries(url.searchParams))]);
        helpers = projectHelpers(list);
        return json({ invoices: invoices.map(decorate) });
      }
      if (method === 'POST') return invoiceResult(await db.createInvoice(env.DB, check(await body(request))), 201);
    }
    if (paymentItem) {
      if (method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
      const out = await db.removePayment(env.DB, Number(paymentItem[1]), Number(paymentItem[2]));
      if (!out) return json({ error: 'No such payment on this invoice' }, 404);
      return json({ removed: out.removed, invoice: decorate(out.invoice) });
    }
    if (item) {
      const id = Number(item[1]);
      const action = item[2];
      if (!action && method === 'GET') return invoiceResult(await db.getInvoice(env.DB, id));
      if (!action && method === 'PATCH') return invoiceResult(await db.updateInvoice(env.DB, id, check(await body(request))));
      // A whole draft in one request — header and lines together, in one D1
      // batch (review finding H2). PATCH + PUT /lines still work on their own;
      // this is the call the editor makes, so a refused line can no longer
      // leave the header already saved.
      if (!action && method === 'PUT') {
        const { lines, ...patch } = check(await body(request));
        return invoiceResult(await db.saveInvoice(env.DB, id, patch, lines));
      }
      if (!action && method === 'DELETE') return result('deleted', await db.deleteDraft(env.DB, id));
      if (action === 'lines' && method === 'PUT') return invoiceResult(await db.setInvoiceLines(env.DB, id, (await body(request)).lines));
      // Which account it asks to be paid into: a draft, or issued but not yet sent.
      if (action === 'bank' && method === 'PUT') {
        return invoiceResult(await db.setInvoiceBankAccount(env.DB, id, (await body(request)).bank_account));
      }
      // Which issuer it is made out from (Belgium / Abroad IE): a draft, or issued but not yet sent.
      if (action === 'issuer' && method === 'PUT') {
        return invoiceResult(await db.setInvoiceIssuerProfile(env.DB, id, (await body(request)).issuer_profile));
      }
      if (action === 'payments' && method === 'GET') return result('payments', await db.listPayments(env.DB, id));
      if (action === 'payments' && method === 'POST') {
        const payment = await db.recordPayment(env.DB, id, await body(request));
        if (!payment) return result('payment', null);
        const invoice = await db.getInvoice(env.DB, id);
        // A settled deposit starts its project and clears its « chase » to-dos (audit B9).
        let started = { started: false, cleared: 0 };
        if (invoice?.kind === 'prepayment') {
          started = await onPrepaymentSettled(env.DB, invoice, { registry: (await loadProjects()) ?? [], file });
        }
        return json({ payment, invoice: decorate(invoice), deposit: started }, 201);
      }
      if (method === 'POST' && action) {
        const input = await body(request);
        if (action === 'issue') {
          const invoice = await db.getInvoice(env.DB, id);
          if (!invoice) return result('invoice', null);
          if (!invoice.lines.length) throw new db.ValidationError('Add invoice lines before issuing', 'lines');
          return invoiceResult(await db.issueInvoice(env.DB, id));
        }
        if (action === 'sent') return invoiceResult(await db.markSent(env.DB, id));
        // Chased: off Home's list for a few days (audit B7). { days: 3 | 7 | 0 }.
        if (action === 'snooze') return invoiceResult(await db.snoozeInvoiceChase(env.DB, id, input.days));
        if (action === 'paid') return invoiceResult(await db.markPaid(env.DB, id));
        if (action === 'void') return invoiceResult(await db.voidInvoice(env.DB, id, input.reason));
        if (action === 'part') return invoiceResult(await db.createPartInvoice(env.DB, id), 201);
        if (action === 'unissue') return invoiceResult(await db.unissueInvoice(env.DB, id));
      }
    }
    return json({ error: knownPath ? 'Method or route not available' : 'Not found' }, knownPath ? 405 : 404);
  } catch (error) {
    if (error instanceof db.ValidationError) return json({ error: error.message, field: error.field }, 400);
    // The D1 error text can name columns, constraints and values; it goes to
    // the log, never into a response body.
    if (isReadLimit(error)) return readLimitResponse();
    console.error('finance api:', error);
    return json({ error: 'Finance could not be saved or loaded' }, 500);
  }
}
