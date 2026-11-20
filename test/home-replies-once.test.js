import { describe, expect, it } from 'vitest';
import { installDom } from './dom-shim.js';

installDom();
const { homeItems, withoutShownReplies } = await import('../src/public/assets/todos.js');

// A reply is shown once on Home: as its card in « Replies first », not again as
// the « they replied, your turn » to-do row, so the To do count adds it once.
describe('Home lists each recorded reply once', () => {
  const missions = [
    { id: 1, lead_uid: 'demo/aurore', title: 'Clinique Aurore — they replied, your turn to answer', status: 'pending', turn: 'yours' },
    { id: 2, lead_uid: 'demo/other', title: 'Other lead — they replied, your turn to answer', status: 'pending', turn: 'yours' },
  ];
  const items = homeItems({ missions, today: '2026-11-19' });

  it('drops the to-do row of a lead whose reply card is shown', () => {
    const left = withoutShownReplies(items, ['demo/aurore']);
    expect(left.map((i) => i.title)).toEqual(['Other lead — they replied, your turn to answer']);
  });

  it('keeps every row when no reply card is shown', () => {
    expect(withoutShownReplies(items, [])).toHaveLength(2);
  });

  it('never drops a to-do, an invoice or an alert', () => {
    const mixed = homeItems({ missions, today: '2026-11-19', todos: [{ id: 9, title: 'Renew the car insurance', due: '2026-11-17' }],
      failures: [{ source: 'Leads', message: 'down' }] });
    const left = withoutShownReplies(mixed, ['demo/aurore', 'demo/other']);
    expect(left.map((i) => i.kind).sort()).toEqual(['alert', 'todo']);
  });
});
