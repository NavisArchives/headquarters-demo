import { conversationTurns } from './conversations.js';

const threadHref = (id) => (id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}` : null);

/** Recorded conversations, grouped by whose turn it is (one read model with
 *  the Outreach queue). This does not connect to or classify a mailbox. */
export async function replyInbox(db, now = new Date()) {
  const { rows, truncated } = await conversationTurns(db, now);
  const shaped = rows.map((row) => ({ ...row, reply_at: row.last_in, thread_href: threadHref(row.thread_id),
    can_pass: row.turn === 'closed' && row.reason === 'said_no' }));
  // Newest first within each group on Home.
  const newest = (list) => list.sort((a, b) => String(b.reply_at || '').localeCompare(String(a.reply_at || '')));
  return {
    warm: newest(shaped.filter((row) => row.turn === 'yours')),
    check: newest(shaped.filter((row) => row.turn === 'incomplete')),
    declined: newest(shaped.filter((row) => row.can_pass)),
    waiting: newest(shaped.filter((row) => row.turn === 'theirs' || row.turn === 'follow_up_due')),
    truncated,
    mail_sync: 'Mailbox sync is not live in HQ. These are recorded replies, updated through external intake or the Mac bridge.',
  };
}
