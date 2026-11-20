// The deposit is paid: the project starts (audit B9, F5; 14 Nov).
//
// Accept quote leaves a client project « not started », with two to-dos on
// Home: « <name>: chase deposit <number> if unpaid » and « <name>: start the
// project once <number> is paid ». Recording the payment changed neither, so
// Home kept saying « chase » about a client who had paid, and the project
// never became active. Now, the moment a prepayment is settled:
//   - its project, if still not started, becomes active;
//   - those two to-dos are ticked off.
// Nothing else is touched. Called after recordPayment; never on a void or an
// archive invoice.
import { updateProject } from './registry-store.js';
import { nowIso } from './db.js';

/** The two to-do titles Accept quote writes for this invoice (accept-quote.js). */
export function depositTodoTitles(number) {
  return [`chase deposit ${number} if unpaid`, `start the project once ${number} is paid`];
}

export async function onPrepaymentSettled(db, invoice, { registry = [], file = [], actor = 'deposit paid' } = {}) {
  const out = { started: false, cleared: 0 };
  if (!invoice || invoice.kind !== 'prepayment' || invoice.status === 'void' || invoice.archive) return out;
  if (!(Number(invoice.due_cents) <= 0 && Number(invoice.paid_cents) > 0)) return out;

  const [chase, start] = depositTodoTitles(invoice.number);
  const ticked = await db.prepare(
    `UPDATE todos SET done_at = ?, updated_at = ?
     WHERE done_at IS NULL AND (title LIKE '%: ' || ? OR title LIKE '%: ' || ?)`,
  ).bind(nowIso(), nowIso(), chase, start).run();
  out.cleared = Number(ticked?.meta?.changes ?? 0);

  const project = invoice.slug ? registry.find((p) => p.slug === invoice.slug) : null;
  if (project && project.stage === 'not_started') {
    await updateProject(db, invoice.slug, { stage: 'active' }, { file, existing: registry, actor });
    out.started = true;
  }
  return out;
}
