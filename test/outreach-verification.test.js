import { describe, expect, it } from 'vitest';
import { summarizeDelivery, parseDeliveryEvents } from '../src/worker/outreach-verification.js';

const batch = (n) => ({ id: 'demo-batch', items: Array.from({ length: n }, (_, i) => ({ uid: `demo/${i}` })) });
const logs = (n) => Array.from({ length: n }, (_, i) => ({ uids: [`demo/${i}`], status: 201, messageId: `message-${i}` }));
const event = (i, kind) => ({ messageId: `message-${i}`, event: kind, date: '2026-11-19T10:00:00Z' });
describe('next-day delivery verification', () => {
  it('uses the strict >3% boundary and unique message outcomes', () => {
    const three = [event(0, 'hard_bounce'), event(1, 'soft_bounce'), event(2, 'soft_bounce')];
    expect(summarizeDelivery(batch(100), logs(100), three).failed).toBe(false);
    const four = summarizeDelivery(batch(100), logs(100), [...three, event(3, 'hardBounce'), event(3, 'hardBounce')]);
    expect(four.failed).toBe(true);
    expect(four.counts.hard_bounce).toBe(2);
    expect(four.counts.soft_bounce).toBe(2);
    expect(four.bounce_rate).toBe(0.04);
  });
  it('fails on any complaint/block or two manually entered spam-tagged subjects', () => {
    for (const kind of ['spam', 'blocked']) expect(summarizeDelivery(batch(1), logs(1), [event(0, kind)]).failed).toBe(true);
    expect(summarizeDelivery(batch(1), logs(1), [], ['First']).failed).toBe(false);
    expect(summarizeDelivery(batch(1), logs(1), [], ['First', 'Second']).failed).toBe(true);
  });
  it('never treats scheduling, failed API calls or unrelated events as delivery proof', () => {
    const summary = summarizeDelivery(batch(3), [...logs(2), { uids: ['demo/2'], status: 500 }], [event(0, 'delivered'), event(99, 'spam')]);
    expect(summary.delivered.map((row) => row.uid)).toEqual(['demo/0']);
    expect(summary.pending).toBe(1);
    expect(summary.api_failed).toBe(1);
    expect(summary.unmatched_events).toBe(1);
    expect(summary.failed).toBe(false);
  });
  it('parses CSV/JSON exports without losing quoted commas and deduplicates a later hard bounce', () => {
    const csv = 'messageId,event,note,date\r\nmessage-0,delivered,"a,b",2026-11-19T10:00:00Z\r\n';
    expect(parseDeliveryEvents(csv)[0]).toMatchObject({ ...event(0, 'delivered'), date: '2026-11-19T10:00:00.000Z' });
    expect(parseDeliveryEvents(JSON.stringify([event(0, 'soft_bounce')]))).toHaveLength(1);
    const summary = summarizeDelivery(batch(1), logs(1), [event(0, 'delivered'), event(0, 'soft_bounce'), event(0, 'hard_bounce')]);
    expect(summary.counts.hard_bounce).toBe(1);
    expect(summary.counts.soft_bounce).toBe(0);
    expect(summary.delivered).toEqual([]);
  });
  it('rejects foreign uids and conflicting message identities', () => {
    expect(() => summarizeDelivery(batch(1), [{ uids: ['other/lead'], status: 201, messageId: 'x' }], [])).toThrow(/batch/);
    expect(() => summarizeDelivery(batch(2), [{ uids: ['demo/0'], status: 201, messageId: 'x' }, { uids: ['demo/1'], status: 201, messageId: 'x' }], [])).toThrow(/identity/);
  });
});
