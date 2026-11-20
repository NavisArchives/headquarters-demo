import { describe, expect, it } from 'vitest';
import { planDraftRows } from '../src/worker/outreach-draft-plan.js';

const day = '2026-11-18';
const lead = (uid, extra = {}) => ({
  uid, name: uid, dataset: 'demo', business: 'UGC', email: `${uid}@example.com`,
  country: 'BE', languages: '["EN"]', stage: 'new', website: '', score: 70,
  ...extra,
});
const follow = (uid, sends = 1, extra = {}) => lead(uid, {
  stage: 'sent', sends, follow_up: day, last_sent_at: '2026-10-01T12:00:00Z',
  first_subject: 'The actual original subject', ...extra,
});
const composeLead = async (row, options) => ({ subject: options.subject || 'Approved subject', body: `Approved copy for ${row.uid}\n\nExactly as written.\n` });
const plan = (rows, extra = {}) => planDraftRows(rows, { day, limit: 280, composeLead, ...extra });

describe('server draft planning', () => {
  it('orders second touches, closers, no-website first touches, then other first touches', async () => {
    const result = await plan([
      lead('site', { website: 'https://example.com' }), lead('no-site'),
      follow('closer', 2), follow('second'),
    ], { composeLead: async (row, options) => ({ ...(await composeLead(row, options)), template: options.mode === 'closer' ? 'closer-3rd' : options.mode }) });
    expect(result.items.map((row) => row.uid)).toEqual(['second', 'closer', 'no-site', 'site']);
    expect(result.items.map((row) => row.step)).toEqual([2, 3, 1, 1]);
  });

  it('uses existing no-site facts and holds a changed recipient', async () => {
    const result = await plan([
      lead('site', { website: 'https://example.com', score: 99 }),
      lead('no-site', { website: 'https://directory.example.com', category: 'No site' }),
      follow('changed', 1, { first_sent_to: 'previous@example.com' }),
    ]);
    expect(result.items.map((row) => row.uid)).toEqual(['no-site', 'site']);
    expect(result.skipped[0].reasons).toContain('recipient_changed');
  });

  it('respects the sender limit and the absolute ceiling', async () => {
    expect((await plan([lead('a'), lead('b')], { limit: 1 })).items).toHaveLength(1);
    expect((await plan(Array.from({ length: 290 }, (_, i) => lead(`demo-${i}`)), { limit: 999 })).items).toHaveLength(280);
    expect((await plan([lead('a')], { limit: 0 })).items).toHaveLength(0);
  });

  it('holds suppressed, closed, replied, talks, already batched and duplicate inboxes', async () => {
    const rows = [lead('suppressed', { suppressed: 1 }), ...['passed', 'won', 'replied', 'talks'].map((stage) => lead(stage, { stage })),
      lead('batched', { open_batch_id: 'another' }), lead('a'), lead('b', { email: 'a@example.com' })];
    const result = await plan(rows);
    expect(result.items.map((row) => row.uid)).toEqual(['a']);
    expect(result.skipped).toHaveLength(7);
    expect(result.skipped.find((row) => row.uid === 'batched').reasons).toContain('already_in_open_batch');
  });

  it('keeps original subjects and approved bodies byte for byte', async () => {
    const result = await plan([follow('second')]);
    expect(result.items[0].subject).toBe('The actual original subject');
    expect(result.items[0].body).toBe('Approved copy for second\n\nExactly as written.\n');
  });

  it('holds missing or reply-prefixed original subjects instead of inventing one', async () => {
    const result = await plan([follow('missing', 1, { first_subject: null }), follow('prefixed', 1, { first_subject: 'Re: old' })]);
    expect(result.items).toEqual([]);
    expect(result.skipped.map((row) => row.reasons[0])).toEqual(['missing_original_subject', 'reply_prefixed_subject']);
  });

  it('holds missing approved copy and never substitutes second-touch copy for a closer', async () => {
    const result = await plan([lead('empty'), follow('closer', 2)], {
      composeLead: async (row) => row.uid === 'empty' ? { noDraft: 'No approved template' } : { subject: 'Subject', body: 'Second touch copy' },
    });
    expect(result.items).toEqual([]);
    expect(result.skipped.find((row) => row.uid === 'closer').reasons).toContain('missing_approved_closer');
    // A lead with no sector letter is held by code, not by compose's sentence.
    expect(result.skipped.find((row) => row.uid === 'empty').reasons).toEqual(['no_sector_letter']);
  });
});
