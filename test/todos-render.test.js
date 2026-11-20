import { describe, it, expect } from 'vitest';
import { installDom, html } from './dom-shim.js';

installDom();

const { dueBadge, homeItems, localDay } = await import('../src/public/assets/todos.js');
const { todoSection } = await import('../src/public/assets/screens/hq.js');

const TODAY = '2026-10-15';

describe('a date on a row', () => {
  it('reads late, today, tomorrow, soon or quiet', () => {
    expect(dueBadge('2026-10-12', TODAY)).toEqual({ text: '3d late', cls: 'late' });
    expect(dueBadge('2026-10-15', TODAY)).toEqual({ text: 'Today', cls: 'today' });
    expect(dueBadge('2026-10-16', TODAY)).toEqual({ text: 'Tomorrow', cls: 'soon' });
    expect(dueBadge('2026-10-18', TODAY)).toEqual({ text: '18 Oct', cls: 'soon' });
    expect(dueBadge('2026-10-28', TODAY)).toEqual({ text: '28 Oct', cls: '' });
    expect(dueBadge(null, TODAY)).toEqual({ text: '', cls: '' });
    expect(dueBadge('2026-10-20T09:00:00Z', TODAY).text).toBe('20 Oct');
  });

  it('counts today on the Mac’s own clock, not in UTC', () => {
    expect(localDay(new Date(2026, 9, 15, 23, 30))).toBe('2026-10-15');
  });
});

describe('Home’s list', () => {
  const todos = [
    { id: 1, title: 'Passport', due: '2026-10-28', mission_title: 'Move to Lima' },
    { id: 2, title: 'Book the flight Lima → Tarapoto', due: null },
    { id: 3, title: 'Travel clinic', due: '2026-10-20', note: 'Yellow fever\nand altitude' },
    { id: 4, title: 'Ticked', due: '2026-10-10', done_at: '2026-10-14T10:00:00Z' },
  ];
  const missions = [
    { id: 10, title: 'Stride Studio — they replied, your turn to answer', status: 'pending', due: '2026-10-15', lead_uid: 'ugc/knees' },
    { id: 11, title: 'Morel — waiting for their answer (you wrote 14 Oct)', status: 'pending', due: '2026-10-18', lead_uid: 'clinics/morel' },
    { id: 12, title: 'Proposal', status: 'proposed' },
    { id: 13, title: 'A finished lead', status: 'done', due: '2026-10-01', lead_uid: 'ugc/old' },
  ];

  it('puts everything by date, the undated last, and leaves out what is not Andy’s turn yet', () => {
    const items = homeItems({
      todos, missions, today: TODAY,
      overview: { followups_due: 122, followups: [] },
      overdue: [{ id: 104, number: '6.R.A.L.01', subject: 'Website', due_on: '2026-10-01', due_cents: 85000 }],
    });
    expect(items.map((i) => i.title)).toEqual([
      'Chase 6.R.A.L.01 · Website',
      'Stride Studio — they replied, your turn to answer',
      '1 proposal from replies',
      'Follow up 122 leads',
      'Travel clinic',
      'Passport',
      'Book the flight Lima → Tarapoto',
    ]);
    expect(items.find((i) => i.title === 'Travel clinic').sub).toBe('Yellow fever');
    expect(items.find((i) => i.title === 'Passport').sub).toBe('Move to Lima');
    expect(items.find((i) => i.kind === 'lead').to).toBe('/leads?lead=ugc%2Fknees');
    expect(items.find((i) => i.title.startsWith('Follow up')).to).toBe('/leads?tile=due');
  });

  it('shows a prospect’s next step from a week out, with its time, and not a closed deal’s', () => {
    const prospects = [
      { id: 3, name: 'Dr Hélène Marchal', organisation: 'Clinique des Tilleuls', stage: 'meeting', next_step: 'Meeting', next_at: '2026-10-16T18:30' },
      { id: 4, name: 'Far away', stage: 'lead', next_step: 'Call', next_at: '2026-11-30' },
      { id: 5, name: 'Signed', stage: 'won', next_step: 'Kick-off', next_at: '2026-10-16' },
    ];
    const items = homeItems({ prospects, today: TODAY });
    expect(items.map((i) => i.title)).toEqual(['Meeting · Dr Hélène Marchal']);
    expect(items[0]).toMatchObject({ sub: 'Pipeline · Clinique des Tilleuls · 18:30', due: '2026-10-16', to: '/pipeline/3' });
  });

  it('shows a lead whose follow-up day has come', () => {
    const items = homeItems({ missions, today: '2026-10-18' });
    expect(items.map((i) => i.id)).toContain(11);
  });

  it('puts a source that could not be read, and a site that is down, above everything', () => {
    const items = homeItems({
      todos, today: TODAY,
      failures: [{ source: 'Finance', message: 'D1 is unavailable' }],
      down: [{ name: 'Realis Studio', slug: 'realis', state: { kind: 'down', label: 'Down' } }],
    });
    expect(items.slice(0, 2).map((i) => i.kind)).toEqual(['alert', 'alert']);
    expect(items[1].to).toBe('/p/realis');
  });

  it('draws a tick box for what can be ticked here, a dot for the rest, and the date', () => {
    const markup = html(todoSection(homeItems({ todos, missions, today: TODAY }), { today: TODAY }));
    expect(markup).toContain('aria-label="Done: Passport"');
    expect(markup).toContain('aria-label="Done: Stride Studio — they replied, your turn to answer"');
    expect(markup).toContain('td-dot');
    expect(markup).toContain('>Today<');
    expect(markup).not.toContain('Ticked');
  });

  it('says there is nothing to do when there is nothing', () => {
    expect(html(todoSection([]))).toContain('Nothing to do');
  });
});
