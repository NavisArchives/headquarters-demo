/* The HQ assistant's tools: a closed list (NIRMATA-approved plan, 19 Nov 2026).
   Each tool is a thin wrapper over a route HQ already has; the page runs it with
   Andy's session and strips the result before anything goes to the model.
   No tool sends, schedules, approves or exports, passes, suppresses or deletes a
   lead, touches invoices, deploys or runs SQL. Writes: a to-do, a follow-up date,
   a note, a DRAFT batch, a draft reply text (in the composer only). */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
/** A lead id is « dataset/id »; anything else never reaches a path. */
export const UID = /^[a-z0-9-]+\/[a-z0-9._-]+$/;
const leadPath = (uid, rest) => { if (!UID.test(uid)) throw new Error('not a lead id'); return `/api/leads/${uid}/${rest}`; };
const schema = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const TOOLS = [
  {
    name: 'find_leads', write: false, rowsRead: 0,
    description: 'Search the leads already loaded in this HQ page by name, town or sector. Returns at most 10.',
    input: schema({ query: str('Words to look for in the name, town or sector') }),
    calls: [], // the page's own lead list: no database read
  },
  {
    name: 'lead_card', write: false, rowsRead: 40,
    description: 'Everything about one lead: stage, last contact, follow-up date, quote and invoice state, next step.',
    input: schema({ uid: str('The lead id, from find_leads') }),
    calls: [{ method: 'GET', path: (i) => `/api/outreach/timeline?uid=${encodeURIComponent(i.uid)}`, example: '/api/outreach/timeline?uid=a%2Fb' }],
  },
  {
    name: 'list_replies', write: false, rowsRead: 40,
    description: 'The recorded replies that still need Andy, oldest first.',
    input: schema({}),
    calls: [{ method: 'GET', path: () => '/api/outreach/replies', example: '/api/outreach/replies' }],
  },
  {
    name: 'build_draft_batch', write: true, rowsRead: 69000, perDay: 3,
    description: 'Build a DRAFT outreach batch for tomorrow with the planner (no-website first). It never approves or sends.',
    input: schema({ sender: str('The sender address as configured in Outreach → Planner, or an empty string for the first configured sender') }),
    calls: [{ method: 'POST', path: () => '/api/outreach/batches/build', example: '/api/outreach/batches/build' }],
    body: (i, ctx) => ({ sender: i.sender, day: ctx.tomorrow }),
  },
  {
    name: 'open_screen', write: false, rowsRead: 0,
    description: 'Open an HQ screen for Andy: home, outreach, planner, approvals, leads, onboarding, finance, missions, projects, reports.',
    input: schema({ screen: str('Which screen', { enum: ['home', 'outreach', 'planner', 'approvals', 'leads', 'onboarding', 'finance', 'missions', 'projects', 'reports'] }) }),
    calls: [],
  },
  {
    name: 'find_projects', write: false, rowsRead: 10,
    description: 'Projects and their live status.',
    input: schema({}),
    calls: [{ method: 'GET', path: () => '/api/projects', example: '/api/projects' }],
  },
  {
    name: 'list_invoices', write: false, rowsRead: 60,
    description: 'Invoices with their state and amount, from Finance; unpaid ones first.',
    input: schema({}),
    calls: [{ method: 'GET', path: () => '/api/finance/invoices', example: '/api/finance/invoices' }],
  },
  {
    name: 'list_missions', write: false, rowsRead: 40,
    description: 'Open missions with their due dates.',
    input: schema({}),
    calls: [{ method: 'GET', path: () => '/api/missions', example: '/api/missions' }],
  },
  {
    name: 'today_list', write: false, rowsRead: 120,
    description: 'Andy\'s list for today exactly as Home shows it: to-dos, leads whose turn it is, invoices to chase, pipeline next steps, proposals and follow-ups, each with its due date; late ones are marked. Use it for « what do I have to do today ».',
    input: schema({}),
    // Home's own five reads (screens/hq.js loadHome), so the assistant and Home never disagree.
    calls: [
      { method: 'GET', path: () => '/api/todos?open=1', example: '/api/todos?open=1' },
      { method: 'GET', path: () => '/api/missions', example: '/api/missions' },
      { method: 'GET', path: () => '/api/overview', example: '/api/overview' },
      { method: 'GET', path: () => '/api/finance/invoices?status=overdue', example: '/api/finance/invoices?status=overdue' },
      { method: 'GET', path: () => '/api/prospects', example: '/api/prospects' },
    ],
  },
  {
    name: 'needs_attention', write: false, rowsRead: 400,
    description: 'The "Needs your attention" list from Outreach, each item with its short number (N-14), name, kind and what it asks. Use it to find the numbers Andy refers to.',
    input: schema({}),
    calls: [{ method: 'GET', path: () => '/api/outreach/cockpit', example: '/api/outreach/cockpit' }],
  },
  {
    name: 'act_on_attention', write: true, rowsRead: 400,
    description: 'PROPOSE a change to one or several "Needs your attention" items, by number ("14", "N-14") or by name: handled (already answered or dealt with), interested, snooze (days), or note. Nothing changes until Andy presses "Do it" under your answer; he can Undo after. It never sends, deletes, pays, approves or schedules anything.',
    input: schema({
      refs: { type: 'array', items: { type: 'string' }, description: 'The items: numbers or names, as Andy said them' },
      action: str('What to do', { enum: ['handled', 'interested', 'snooze', 'note'] }),
      days: { type: 'integer', description: 'For snooze: 1 to 30 days; otherwise 0' },
      note: str('For note: the text to add; otherwise an empty string'),
    }),
    calls: [{ method: 'POST', path: () => '/api/outreach/attention/plan', example: '/api/outreach/attention/plan' }],
  },
  {
    name: 'add_todo', write: true, rowsRead: 2,
    description: 'Add a to-do for Andy, with an optional due date (YYYY-MM-DD). Andy can undo it.',
    input: schema({ title: str('What to do, in Andy\'s words', { maxLength: 200 }), due: str('Due date YYYY-MM-DD, or empty') }, ['title', 'due']),
    calls: [{ method: 'POST', path: () => '/api/todos', example: '/api/todos' }],
    body: (i) => ({ title: i.title, ...(i.due ? { due: i.due } : {}) }),
  },
  {
    name: 'set_follow_up', write: true, rowsRead: 2,
    description: 'Set the next follow-up date of one lead. It never changes the stage. Andy can undo it.',
    input: schema({ uid: str('The lead id'), date: str('YYYY-MM-DD') }),
    calls: [{ method: 'PATCH', path: (i) => leadPath(i.uid, 'state'), example: '/api/leads/a/b/state' }],
    body: (i) => ({ follow_up: i.date }),
  },
  {
    name: 'add_note', write: true, rowsRead: 2,
    description: 'Add a short note to one lead. Andy can undo it.',
    input: schema({ uid: str('The lead id'), note: str('The note', { maxLength: 500 }) }),
    calls: [{ method: 'PATCH', path: (i) => leadPath(i.uid, 'state'), example: '/api/leads/a/b/state' }],
    // The state route replaces notes, so the page appends to the lead's current notes.
    body: (i, ctx) => ({ notes: [ctx.currentNotes, `${ctx.today}: ${i.note}`].filter(Boolean).join('\n') }),
  },
  {
    name: 'draft_reply', write: false, rowsRead: 0,
    description: 'Put a draft reply in the composer for Andy to read, change and send himself. Nothing is sent or saved as sent.',
    input: schema({ uid: str('The lead id'), text: str('The draft text', { maxLength: 4000 }) }),
    calls: [],
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** The definitions the model sees: strict schemas, nothing else. */
export function toolDefinitions() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input, strict: true }));
}

/** The only calls the assistant may make, by method and path. */
export const ALLOWED_CALLS = [
  { method: 'GET', path: /^\/api\/outreach\/(timeline\?uid=[^&]+|replies)$/ },
  { method: 'POST', path: /^\/api\/outreach\/batches\/build$/ },
  { method: 'GET', path: /^\/api\/outreach\/cockpit$/ },
  // Plan is read-only; apply and undo run only from Andy's own « Do it » / « Undo » click.
  { method: 'POST', path: /^\/api\/outreach\/attention\/(plan|apply|undo)$/ },
  { method: 'GET', path: /^\/api\/(projects|missions|finance\/invoices|overview|prospects)$/ },
  { method: 'GET', path: /^\/api\/(todos\?open=1|finance\/invoices\?status=overdue)$/ },
  { method: 'POST', path: /^\/api\/todos$/ },
  { method: 'PATCH', path: /^\/api\/leads\/[a-z0-9-]+\/[a-z0-9._-]+\/state$/ },
];

/** Never, whatever a tool says. */
export const FORBIDDEN = [
  /\/(approve|send|export|cancel|verify|log-delivered)\b/,
  /^(POST|PUT|PATCH|DELETE) \/api\/(intake|finance|outreach\/senders|outreach\/agreements|gmail|settings|services)/,
  /^DELETE /,
];

const HIDDEN_KEYS = new Set(['email', 'phone', 'contact', 'sent_to', 'recipient', 'body', 'text', 'payload', 'snippet', 'html', 'from_email', 'to', 'iban', 'token']);
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;
// Phone numbers (+32 2 000 00 00, 0032…, 04 93 88 34 52, 0329380849); never dates (2026-11-19) or amounts.
const PHONE = /(?<![\d-])(?:(?:\+|00)\d[\d\s().-]{7,}\d|0\d(?:[\s.]?\d{2}){4})(?![\d-])/g;

/** What may leave the Mac: no addresses, phones or message bodies, at any depth. */
export function stripFields(value) {
  if (Array.isArray(value)) return value.map(stripFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN_KEYS.has(k)) continue;
      out[k] = stripFields(v);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(EMAIL, '[address hidden]').replace(PHONE, '[number hidden]');
  return value;
}

/** « What do I have to do today »: Home's own list (todos.js homeItems) from Home's five
 *  reads, each through `get` (which enforces the allow-list). Returns what the model sees
 *  and the rows for the tray. A read that fails is named, as Home names it. */
export async function todayList(get, today) {
  const { homeItems } = await import('./todos.js');
  const tool = TOOLS.find((t) => t.name === 'today_list');
  const [todos, missions, overview, overdue, prospects] = await Promise.allSettled(tool.calls.map((c) => get(c.method, c.path())));
  const value = (r, pick) => (r.status === 'fulfilled' ? pick(r.value) : []);
  const failures = [['To-dos', todos], ['Missions', missions], ['Leads & follow-ups', overview], ['Overdue invoices', overdue], ['Pipeline', prospects]]
    .filter(([, r]) => r.status === 'rejected').map(([source]) => ({ source, message: 'could not be loaded' }));
  const items = homeItems({
    todos: value(todos, (v) => v?.todos ?? []), missions: value(missions, (v) => v?.missions ?? []),
    overview: overview.status === 'fulfilled' ? overview.value ?? {} : {},
    overdue: value(overdue, (v) => v?.invoices ?? []), prospects: value(prospects, (v) => v?.prospects ?? []),
    failures, today,
  });
  const due = (i) => (i.due ? String(i.due).slice(0, 10) : null);
  const result = {
    today,
    items: items.slice(0, 25).map((i) => ({ title: i.title, kind: i.kind, due: due(i), late: !!due(i) && due(i) < today })),
    total: items.length, late: items.filter((i) => due(i) && due(i) < today).length,
  };
  return { result, items };
}

/** Invoices as the model may read them: euros already written out, never raw cents
 *  (20 Nov eval: « 240 000 € » for €2,400 from total_cents), unpaid first, open ones only. */
export function invoiceFacts(list, today) {
  const eur = (cents) => (cents == null || cents === '' ? null : `€${(Number(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const open = (Array.isArray(list) ? list : []).filter((i) => !['paid', 'void', 'cancelled'].includes(i.computed_status ?? i.status));
  return open.map((i) => {
    const status = i.status === 'draft' ? 'draft, not issued' : (i.computed_status ?? i.status);
    const late = i.status !== 'draft' && (String(i.overdue) === 'true' || (!!i.due_on && i.due_on < today));
    return { number: i.number ?? null, subject: i.subject ?? null, status, overdue: late, due_on: i.due_on ?? null,
      total: eur(i.total_cents), still_to_pay: eur(i.balance_cents ?? i.total_cents) };
  }).sort((a, b) => Number(b.overdue) - Number(a.overdue));
}
