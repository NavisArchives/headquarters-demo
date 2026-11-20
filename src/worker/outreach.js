import { ValidationError, hqToday, nowIso, cleanDay } from './db.js';
import { compose } from '../shared/outreach.js';
import { eligibility } from './outreach-policy.js';
import { responseDeadline } from './business-hours.js';
import { sha256Hex } from './lead-batches.js';
import { conversationTurns } from './conversations.js';
import { STOP_HOLD_PREFIX } from './outreach-verification.js';
import { needsAndy } from '../shared/turn.js';
import { numberItems } from './attention-numbers.js';

const CHECK_REASONS = { reply_not_linked: 'reply not linked to a lead', unreadable_time: 'a mail time is unreadable',
  same_time_both_ways: 'sent and received at the same time', no_mail_times: 'no mail on record either way',
  no_reply_time: 'marked as replied, but no reply is on record', same_day_order_unknown: 'sent and replied the same day; the order is not on record' };

const LIMIT = 280;
const emailOf = (x) => String(x || '').trim().toLowerCase();
function required(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ValidationError(`${field} is required (maximum ${max} characters)`, field);
  return value.trim();
}

// Bounded queries and the existing uid/kind and normalized email indexes.
export async function candidates(db, day = hqToday(), now = new Date()) {
  const { results } = await db.prepare(`SELECT l.*, COALESCE(s.stage,'new') AS stage, s.follow_up, s.last_sent_at, s.last_reply_at,
    (SELECT COUNT(*) FROM lead_events e WHERE e.uid=l.uid AND e.kind='sent') AS sends,
    EXISTS(SELECT 1 FROM email_suppression es WHERE es.email=lower(trim(l.email))) AS suppressed,
    (SELECT e.sent_to FROM lead_events e WHERE e.uid=l.uid AND e.kind='sent' AND e.sent_to IS NOT NULL ORDER BY e.at,e.id LIMIT 1) AS first_sent_to,
    (SELECT other.uid FROM leads other WHERE lower(trim(other.email))=lower(trim(l.email)) AND other.uid<>l.uid
      AND EXISTS(SELECT 1 FROM lead_events e WHERE e.uid=other.uid AND e.kind='sent') LIMIT 1) AS inbox_written_via
    FROM leads l LEFT JOIN lead_state s ON s.uid=l.uid
    WHERE l.dataset<>'travel-volunteer-stays' AND l.business<>'Agencies'
    AND COALESCE(s.stage,'new') NOT IN ('passed','won','talks','replied')
    ORDER BY CASE WHEN s.follow_up<=? THEN 0 ELSE 1 END, s.follow_up, l.score DESC,l.uid LIMIT 500`).bind(day).all();
  const used = new Set();
  return (results || []).map((row) => {
    const email = emailOf(row.email);
    const policy = eligibility({ ...row, today: day, address_changed_since_send: !!row.first_sent_to && email !== row.first_sent_to }, now);
    if (used.has(email)) { policy.eligible = false; policy.reasons.push('shared_inbox_in_plan'); }
    if (policy.eligible) used.add(email);
    return { uid: row.uid, name: row.name, dataset: row.dataset, score: row.score, email, country: row.country,
      stage: row.stage, last_sent_at: row.last_sent_at, follow_up: row.follow_up, ...policy };
  });
}

export async function todayQueue(db, zone = 'America/Lima', now = new Date()) {
  const day = hqToday(now);
  const [warm, follow, deals, approvals, blockers, unpaid] = await Promise.all([
    conversationTurns(db, now),
    db.prepare(`SELECT s.uid,l.name,s.follow_up,(SELECT COUNT(*) FROM lead_events e WHERE e.uid=s.uid AND e.kind='sent') AS sends
      FROM lead_state s JOIN leads l ON l.uid=s.uid WHERE s.follow_up<=? AND s.stage NOT IN ('passed','won','replied','talks')
      AND l.dataset<>'travel-volunteer-stays' AND l.business<>'Agencies'
      AND NOT EXISTS(SELECT 1 FROM email_suppression es WHERE es.email=lower(trim(l.email)))
      ORDER BY s.follow_up LIMIT 80`).bind(day).all(),
    db.prepare("SELECT id,name,next_step,next_at FROM prospects WHERE client_id IS NULL AND stage NOT IN ('won','lost') AND (next_at IS NULL OR substr(next_at,1,10)<=?) ORDER BY next_at LIMIT 50").bind(day).all(),
    db.prepare("SELECT id,day FROM outreach_batches WHERE status='draft' ORDER BY day,created_at LIMIT 30").all(),
    db.prepare('SELECT email,reason FROM outreach_senders WHERE paused=1').all(),
    db.prepare("SELECT id,number,subject,due_on FROM invoices WHERE status='sent' AND due_on<? LIMIT 50").bind(day).all(),
  ]);
  const items = [
    // Whose turn: the same read model as Home's replies (src/worker/conversations.js).
    ...warm.rows.filter((r) => needsAndy(r.turn)).map((r) => ({
      key: r.review_id ? `reply:${r.review_id}` : `turn:${r.uid}`, uid: r.uid || null, review_id: r.review_id || null, kind: r.turn === 'yours' ? 'warm_reply' : 'check_conversation',
      title: r.name, detail: r.turn === 'yours' ? r.summary : `${r.label} · ${CHECK_REASONS[r.reason] || r.reason}`,
      due: r.turn === 'yours' && r.last_in ? responseDeadline(r.last_in, zone) : null, priority: 0,
      href: r.uid ? `/leads?lead=${encodeURIComponent(r.uid)}` : '/missions', action: r.turn === 'yours' ? 'Answer this reply' : 'Check this conversation' })),
    ...(deals.results || []).map((r) => ({ key: `deal:${r.id}`, deal_id: r.id, kind: 'sales', title: r.name, detail: r.next_step || 'Set the next action', due: r.next_at, priority: 1, href: `/pipeline/${r.id}`, action: 'Open opportunity' })),
    ...(follow.results || []).map((r) => ({ key: `follow:${r.uid}`, uid: r.uid, kind: 'follow_up', title: r.name, detail: r.sends === 1 ? 'Second email is due' : r.sends === 2 ? 'Closer is due · check sector rules' : 'Review incomplete or finished sequence', due: r.follow_up, priority: 2, href: `/leads?lead=${encodeURIComponent(r.uid)}`, action: 'Review follow-up' })),
    ...(approvals.results || []).map((r) => ({ key: `batch:${r.id}`, kind: 'approval', title: 'Batch waiting for your approval', detail: r.day, priority: 3, href: '/outreach?view=batches', action: 'Review exact emails' })),
    ...(unpaid.results || []).map((r) => ({ key: `invoice:${r.id}`, kind: 'payment', title: r.number || r.subject, detail: 'Invoice overdue · review payments before chasing', due: r.due_on, priority: 4, href: `/finance/${r.id}`, action: 'Review invoice' })),
    ...(blockers.results || []).map((r) => ({ key: `sender:${r.email}`, kind: 'blocker', title: r.email, detail: r.reason, priority: 5, href: '/outreach?view=planner', action: 'Review sender' })),
  ];
  // A short number that never shifts (N-14), so Andy can say « 14 is done » (migration 0041).
  return numberItems(db, items, now.toISOString());
}

export async function cockpit(db, zone = 'America/Lima', now = new Date()) {
  const day = hqToday(now);
  const monday = new Date(`${day}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  const week=monday.toISOString().slice(0,10);
  const cutoff=[`${day.slice(0,7)}-01`,week].sort()[0];
  const readFrom=new Date(Date.parse(`${cutoff}T00:00:00Z`)-86400000).toISOString();
  const [events, replies, signed, paid, coverage, delivery] = await Promise.all([
    db.prepare('SELECT hour_utc AS at,n FROM outreach_stat_hours WHERE hour_utc>=?').bind(readFrom).all(),
    db.prepare(`SELECT intent,COUNT(*) AS n FROM reply_reviews GROUP BY intent`).all(),
    db.prepare('SELECT currency,SUM(amount_cents) AS cents,COUNT(*) AS agreements FROM signed_agreements GROUP BY currency').all(),
    db.prepare("SELECT i.currency,SUM(p.amount_cents) AS cents FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'void' GROUP BY i.currency").all(),
    db.prepare('SELECT sent_events,identified,exact_content FROM outreach_stat_totals WHERE id=1').first(),
    db.prepare("SELECT kind,COUNT(*) AS n FROM outreach_delivery_events GROUP BY kind").all(),
  ]);
  const totals = { today: 0, week: 0, month: 0, all: coverage.sent_events };
  // Old records have only dates or UTC timestamps; report known events, never invented sends.
  for (const e of events.results || []) {
    if(!Number.isFinite(Date.parse(e.at))) continue;
    const date = hqToday(new Date(e.at));
    if (date === day) totals.today += e.n;
    if (date >= week && date <= day) totals.week += e.n;
    if (date<=day && date.slice(0,7) === day.slice(0,7)) totals.month += e.n;
  }
  return { day, sent: totals, coverage, replies: replies.results || [], signed: signed.results || [], paid: paid.results || [],
    delivery_events: delivery.results || [], daily_ceiling: LIMIT, sending_enabled: false, mail_sync: 'External intake or the Mac bridge; live mailbox connection must be configured',
    calendar: `${zone} · Monday–Friday, 09:00–17:00 · holidays not configured`, queue: await todayQueue(db, zone, now) };
}

export async function timeline(db, uid) {
  const { results } = await db.prepare(`SELECT id,kind,detail,at,batch,template,sent_to,sender,subject,body,thread_id,provenance,message_key
    FROM lead_events WHERE uid=? ORDER BY at DESC,id DESC LIMIT 100`).bind(uid).all();
  const replies=(await db.prepare('SELECT id,subject,from_email,body_excerpt,received_at,reviewed_at,thread_id,intent FROM reply_reviews WHERE uid=? ORDER BY received_at DESC LIMIT 50').bind(uid).all()).results || [];
  return [...(results || []),...replies.map(r=>({id:`reply:${r.id}`,kind:'reply',detail:r.intent,subject:r.subject,body:r.body_excerpt,sender:r.from_email,thread_id:r.thread_id,at:r.received_at || r.reviewed_at,provenance:'stored_excerpt'}))].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,100);
}

export async function saveSender(db, input) {
  const email = emailOf(required(input.email,'email',254));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('email must be an address','email');
  const limit = Number(input.daily_limit);
  if (!Number.isInteger(limit) || limit<0 || limit>LIMIT) throw new ValidationError('daily_limit must be between 0 and 280','daily_limit');
  if (typeof input.paused !== 'boolean') throw new ValidationError('paused must be true or false','paused');
  const current = await db.prepare('SELECT paused,reason FROM outreach_senders WHERE email=?').bind(email).first();
  let reason = String(input.reason || '').slice(0,300);
  // A stop-rule hold is lifted only by an explicit review: Andy says what he checked.
  // The stop and its evidence stay on the batch's verification record.
  const stopHold = current?.paused && String(current.reason || '').includes(STOP_HOLD_PREFIX);
  if (stopHold && input.paused) reason = current.reason; // editing the limit keeps the hold's words
  if (stopHold && !input.paused) {
    const note = typeof input.review_note === 'string' ? input.review_note.trim() : '';
    if (note.length < 10) throw new ValidationError('This sender was paused by a failed stop rule. Say what you reviewed before resuming (at least 10 characters).','review_note');
    reason = `Resumed ${nowIso().slice(0,10)} after stop-rule review: ${note}`.slice(0,300);
  }
  await db.prepare(`INSERT INTO outreach_senders(email,daily_limit,paused,reason,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET daily_limit=excluded.daily_limit,paused=excluded.paused,reason=excluded.reason,updated_at=excluded.updated_at`)
    .bind(email,limit,input.paused?1:0,reason,nowIso()).run();
}

export async function batchDetail(db,id) {
  const batch = await db.prepare('SELECT * FROM outreach_batches WHERE id=?').bind(id).first();
  if (!batch) return null;
  return { ...batch, items: (await db.prepare('SELECT i.*, l.name FROM outreach_batch_items i LEFT JOIN leads l ON l.uid = i.uid WHERE i.batch_id = ? ORDER BY i.uid').bind(id).all()).results || [] };
}

async function validateItems(db, items, now = new Date()) {
  if (!Array.isArray(items) || !items.length || items.length>LIMIT) throw new ValidationError('A batch needs 1–280 emails','items');
  const seen = new Set();
  const clean = [];
  const {results: facts} = await db.prepare(`SELECT l.*,COALESCE(s.stage,'new') AS stage,s.follow_up,s.last_sent_at,s.last_reply_at,
      (SELECT COUNT(*) FROM lead_events e WHERE e.uid=l.uid AND e.kind='sent') AS sends,
      EXISTS(SELECT 1 FROM email_suppression es WHERE es.email=lower(trim(l.email))) AS suppressed,
      (SELECT sent_to FROM lead_events e WHERE e.uid=l.uid AND e.kind='sent' AND sent_to IS NOT NULL ORDER BY at,id LIMIT 1) AS first_sent_to,
      (SELECT other.uid FROM leads other WHERE other.uid<>l.uid AND lower(trim(other.email))=lower(trim(l.email))
        AND EXISTS(SELECT 1 FROM lead_events e WHERE e.uid=other.uid AND e.kind='sent') LIMIT 1) AS inbox_written_via
      FROM leads l LEFT JOIN lead_state s ON s.uid=l.uid WHERE l.uid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(items.map(x=>required(x.uid,'uid')))).all();
  const byUid=new Map(facts.map(x=>[x.uid,x]));

  for (const item of items) {
    const uid = required(item.uid,'uid');
    const subject = required(item.subject,'subject',500);
    const body = required(item.body,'body',20000);
    const row = byUid.get(uid);
    if (!row) throw new ValidationError('Unknown lead','uid');
    const policy = eligibility({ ...row, subject, hook: item.hook, today:hqToday(now), address_changed_since_send:!!row.first_sent_to && row.first_sent_to!==emailOf(row.email) },now);
    if (!policy.eligible) throw new ValidationError(`${row.name}: ${policy.reasons.join('; ')}`,'items');
    if (/^plastic-surgeons(-|$)/.test(row.dataset) || row.business==='Plastic surgeons') {
      let payload={};try{payload=JSON.parse(row.payload || '{}');}catch{}
      const canonical=compose({...payload,...row,languages:[item.lang]},{lang:item.lang,mode:'email'});
      if(subject!==canonical.subject)throw new ValidationError('Keep the approved medical subject','subject');
    }
    if (seen.has(policy.email)) throw new ValidationError('One email per inbox','items');
    seen.add(policy.email);
    if (item.recipient && emailOf(item.recipient)!==policy.email) throw new ValidationError('Recipient changed; create a fresh batch','recipient');
    if (!['EN','NL','FR'].includes(item.lang) || item.lang!==policy.lang) throw new ValidationError('Language must match the lead','lang');
    // Manual text must preserve opt-out and medical subject rules; no automatic copy substitution.
    if (!/no thanks|non merci|nee.{0,2}bedankt|unsubscribe|désinscri|uitschrij/i.test(body)) throw new ValidationError('Include the approved opt-out wording','body');
    clean.push({ uid, recipient:policy.email, step:policy.step,subject,body,lang:item.lang,hook:item.hook || '' });
  }
  return clean.sort((a,b)=>a.uid.localeCompare(b.uid));
}

export async function createBatch(db,input,now=new Date()) {
  cleanDay(input.day,'day');
  if (input.day!==hqToday(now)) throw new ValidationError('Plan today; future batches must be revalidated on their send day','day');
  const sender=emailOf(input.sender);
  if (!await db.prepare('SELECT email FROM outreach_senders WHERE email=?').bind(sender).first()) throw new ValidationError('Configure the sender first','sender');
  const items=await validateItems(db,input.items,now);
  const id=crypto.randomUUID();
  const hash=await sha256Hex(JSON.stringify({day:input.day,sender,items:items.map(({hook,...rest})=>rest)}));
  await db.batch([
    db.prepare('INSERT INTO outreach_batches(id,day,sender,content_hash,created_at) VALUES(?,?,?,?,?)').bind(id,input.day,sender,hash,now.toISOString()),
    ...items.map((x)=>db.prepare('INSERT INTO outreach_batch_items(batch_id,uid,recipient,step,subject,body,lang,hook) VALUES(?,?,?,?,?,?,?,?)').bind(id,x.uid,x.recipient,x.step,x.subject,x.body,x.lang,x.hook)),
  ]);
  return batchDetail(db,id);
}

export async function approveBatch(db,id,hash,actor,now=new Date()) {
  const batch=await batchDetail(db,id);
  if (!batch) throw new ValidationError('Unknown batch','id');
  if (batch.status!=='draft' || batch.content_hash!==hash) throw new ValidationError('Batch changed or already reviewed; reload','content_hash');
  if (batch.day!==hqToday(now)) throw new ValidationError('This batch is stale; create a new plan for today','day');
  const items=await validateItems(db,batch.items,now);
  const expected=await sha256Hex(JSON.stringify({day:batch.day,sender:batch.sender,items:items.map(({hook,...rest})=>rest)}));
  if(expected!==hash)throw new ValidationError('Batch contents changed; create a fresh batch','content_hash');
  const since=new Date(now.getTime()-86400000).toISOString();
  // Atomic reservation gate: the first statement changes nothing if either limit is exhausted.
  // Recipient PK collisions roll the whole D1 batch back.
  const result=await db.batch([
    db.prepare(`UPDATE outreach_batches SET status='approved',approved_at=?,approved_by=? WHERE id=? AND status='draft' AND content_hash=?
      AND EXISTS(SELECT 1 FROM outreach_senders WHERE email=outreach_batches.sender AND paused=0
        AND daily_limit>=(SELECT COUNT(*) FROM outreach_reservations WHERE day=outreach_batches.day AND sender=outreach_batches.sender)+?
        +(SELECT COUNT(*) FROM lead_events WHERE kind='sent' AND at>=? AND (sender=outreach_batches.sender OR sender IS NULL)))
      AND (SELECT COUNT(*) FROM outreach_reservations WHERE day=outreach_batches.day)+?
        +(SELECT COUNT(*) FROM lead_events WHERE kind='sent' AND at>=?)<=280
      AND NOT EXISTS(SELECT 1 FROM outreach_batch_items i JOIN leads l ON l.uid=i.uid LEFT JOIN lead_state s ON s.uid=l.uid
        WHERE i.batch_id=outreach_batches.id AND (lower(trim(l.email))<>i.recipient OR s.last_reply_at IS NOT NULL OR s.stage IN ('passed','won','talks','replied')
          OR EXISTS(SELECT 1 FROM email_suppression es WHERE es.email=i.recipient)
          OR (SELECT COUNT(*) FROM lead_events e WHERE e.uid=i.uid AND e.kind='sent')<>i.step-1
          OR (i.step>1 AND (s.follow_up IS NULL OR s.follow_up>outreach_batches.day))
          OR EXISTS(SELECT 1 FROM leads other WHERE other.uid<>i.uid AND lower(trim(other.email))=i.recipient
            AND EXISTS(SELECT 1 FROM lead_events e WHERE e.uid=other.uid AND e.kind='sent'))))`).bind(now.toISOString(),actor,id,hash,items.length,since,items.length,since),
    db.prepare(`INSERT INTO outreach_reservations(day,recipient,batch_id,sender)
      SELECT b.day,i.recipient,b.id,b.sender FROM outreach_batches b JOIN outreach_batch_items i ON i.batch_id=b.id
      WHERE b.id=? AND b.status='approved' AND b.approved_at=? `).bind(id,now.toISOString()),
  ]);
  if (!result[0].meta.changes) throw new ValidationError('Approval blocked: paused sender, changed lead or daily capacity exhausted','approval');
  // A shared inbox reservation must never yield a partial approved batch.
  const reserved=await db.prepare('SELECT COUNT(*) AS n FROM outreach_reservations WHERE batch_id=?').bind(id).first();
  if (reserved.n!==items.length) { await cancelBatch(db,id); throw new ValidationError('An inbox is already reserved today; create a fresh batch','items'); }
  return batchDetail(db,id);
}

export async function cancelBatch(db,id) {
  await db.batch([
    db.prepare("UPDATE outreach_batches SET status='cancelled',cancelled_at=? WHERE id=? AND status IN ('draft','approved')").bind(nowIso(),id),
    db.prepare("DELETE FROM outreach_reservations WHERE batch_id=? AND EXISTS(SELECT 1 FROM outreach_batches WHERE id=? AND status='cancelled')").bind(id,id),
  ]);
}

export async function recordAgreement(db,id,input) {
  cleanDay(input.signed_on,'signed_on');
  if (!Number.isInteger(input.amount_cents) || input.amount_cents<0 || input.amount_cents>100000000) throw new ValidationError('Use a valid amount in cents','amount_cents');
  if (!/^[A-Z]{3}$/.test(input.currency || '')) throw new ValidationError('Use a three-letter currency','currency');
  const evidence=required(input.evidence,'evidence',1000);
  if (!await db.prepare("SELECT id FROM prospects WHERE id=? AND stage='won'").bind(id).first()) throw new ValidationError('Mark the opportunity won before recording signed revenue','stage');
  await db.prepare(`INSERT INTO signed_agreements(prospect_id,signed_on,amount_cents,currency,evidence,recorded_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(prospect_id) DO UPDATE SET signed_on=excluded.signed_on,amount_cents=excluded.amount_cents,currency=excluded.currency,evidence=excluded.evidence,recorded_at=excluded.recorded_at`)
    .bind(id,input.signed_on,input.amount_cents,input.currency,evidence,nowIso()).run();
}
