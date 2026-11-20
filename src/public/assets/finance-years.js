// Money by year and by client: the figures the Finance screen's archive view
// shows. Pure — it takes the invoices the API returns and adds them up — so
// the screen and the tests use exactly the same arithmetic.
//
//   invoiced  what was asked for (a prepayment counts what it asked now; its
//             part 2 is its own invoice), drafts and void invoices excluded
//   paid      the payments, from the invoice's own paid_cents
//   unpaid    still owed on a LIVE invoice
//   unproven  not covered by a payment on an ARCHIVE invoice: the money may
//             well have arrived, but no bank record of it was found

export const BANK_NAMES = Object.freeze({
  kbc: 'KBC', wise: 'Wise', bog: 'Second Bank', KBC: 'KBC', Wise: 'Wise',
});

/** "kbc,wise" -> ['KBC', 'Wise']: which account(s) the money arrived in. */
export function paidIntoNames(paidInto) {
  if (!paidInto) return [];
  return [...new Set(String(paidInto).split(',').map((s) => s.trim()).filter(Boolean)
    .map((id) => BANK_NAMES[id] ?? id))];
}

export function invoiceYear(invoice) {
  const y = Number(invoice?.year);
  if (Number.isInteger(y) && y > 0) return y;
  return invoice?.issued_on ? Number(String(invoice.issued_on).slice(0, 4)) : null;
}

const counts = (invoice) => invoice && invoice.number && invoice.status !== 'void';
const isArchive = (invoice) => invoice?.series === 'archive';

function figures(invoice) {
  const asked = Number(invoice.requested_cents ?? invoice.request_cents ?? invoice.total_cents ?? 0);
  const paid = Math.min(Number(invoice.paid_cents ?? 0), asked);
  const open = Math.max(asked - paid, 0);
  return {
    invoiced_cents: asked,
    paid_cents: paid,
    unpaid_cents: isArchive(invoice) ? 0 : open,
    unproven_cents: isArchive(invoice) ? open : 0,
  };
}

const empty = () => ({
  count: 0, archive_count: 0, invoiced_cents: 0, paid_cents: 0, unpaid_cents: 0, unproven_cents: 0,
});
function add(into, invoice) {
  const f = figures(invoice);
  into.count += 1;
  if (isArchive(invoice)) into.archive_count += 1;
  into.invoiced_cents += f.invoiced_cents;
  into.paid_cents += f.paid_cents;
  into.unpaid_cents += f.unpaid_cents;
  into.unproven_cents += f.unproven_cents;
  return into;
}

/**
 * `{ total, years[], clients[], invoices[] }` for one view.
 *   years    every year that has an invoice (newest first), each with its
 *            totals — always over ALL clients' invoices when no client is
 *            chosen, or that client's when one is
 *   clients  per client, inside the chosen year (or all years), biggest first
 *   invoices the invoices of the view (year and client applied), newest first
 *   total    the totals of `invoices`
 * `clientName(id)` names a client; `expenses` (optional) add an
 * `expenses_cents` per year.
 */
export function moneyByYear(invoices = [], { year = null, clientId = null, clientName = () => '', expenses = [] } = {}) {
  const live = invoices.filter(counts);
  const forClient = clientId == null ? live : live.filter((i) => i.client_id === clientId);

  const years = new Map();
  for (const invoice of forClient) {
    const y = invoiceYear(invoice);
    if (!years.has(y)) years.set(y, { year: y, ...empty(), expenses_cents: 0 });
    add(years.get(y), invoice);
  }
  if (clientId == null) {
    for (const e of expenses) {
      const y = Number(e.year ?? String(e.spent_on).slice(0, 4));
      if (!years.has(y)) years.set(y, { year: y, ...empty(), expenses_cents: 0 });
      years.get(y).expenses_cents += Number(e.amount_cents ?? 0);
    }
  }

  const inYear = (i) => year == null || invoiceYear(i) === year;
  const clients = new Map();
  for (const invoice of live.filter(inYear)) {
    const id = invoice.client_id;
    if (!clients.has(id)) clients.set(id, { client_id: id, name: clientName(id) || invoice.client_name || `Client ${id}`, ...empty(), banks: new Set() });
    const c = add(clients.get(id), invoice);
    for (const bank of paidIntoNames(invoice.paid_into)) c.banks.add(bank);
  }

  const view = forClient.filter(inYear).sort((a, b) => {
    const ya = invoiceYear(a) ?? 0;
    const yb = invoiceYear(b) ?? 0;
    if (ya !== yb) return yb - ya;
    const da = a.issued_on ?? a.due_on ?? '';
    const db = b.issued_on ?? b.due_on ?? '';
    if (da !== db) return db < da ? -1 : 1;
    return (b.id ?? 0) - (a.id ?? 0);
  });

  return {
    total: view.reduce(add, empty()),
    years: [...years.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
    clients: [...clients.values()]
      .map((c) => ({ ...c, banks: [...c.banks] }))
      .sort((a, b) => b.invoiced_cents - a.invoiced_cents || a.name.localeCompare(b.name)),
    invoices: view,
  };
}
