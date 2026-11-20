import { describe, it, expect, beforeEach } from 'vitest';
import { installDom, html } from './dom-shim.js';

// The screens build DOM, so a DOM has to exist before they are imported.
installDom();

/** A fetch stub: a map of url-substring -> response body, or an Error to reject. */
function stubFetch(routes) {
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const value = key === undefined ? new Error(`no stub for ${url}`) : routes[key];
    if (value instanceof Error) throw value;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(value),
    };
  };
}

const { loadHome, todoSection } = await import('../src/public/assets/screens/hq.js');
const { homeItems } = await import('../src/public/assets/todos.js');

/** Home's to-do list, drawn from what loadHome() returned. */
const listOf = (home) => html(todoSection(homeItems({
  todos: home.todos, missions: home.missions, overview: home.overview, overdue: home.overdue, failures: home.failures,
})));
const { renderProjectDetail } = await import('../src/public/assets/screens/projects.js');

const OK_HOME = {
  '/api/missions': { missions: [] },
  '/api/overview': { followups: [], activity: [], leads: { total: 3, conversations: 1, won: 0 } },
  '/api/finance/overview': { outstanding_cents: 0, paid_this_year_cents: 0, not_yet_requested_cents: 0 },
  '/api/finance/invoices': { invoices: [] },
  '/api/todos': { todos: [] },
  '/api/prospects': { prospects: [] },
};
const STORE = { status: { checkedAt: '2026-09-21T09:00:00Z' }, merged: [] };

beforeEach(() => { installDom(); });

describe('Headquarters tells the truth about a source it could not reach', () => {
  it('says there is nothing to do only when every source answered', async () => {
    stubFetch(OK_HOME);
    const home = await loadHome(STORE);
    expect(home.failures).toEqual([]);
    expect(listOf(home)).toContain('Nothing to do');
  });

  it('renders a finance failure as the first row of the list, never as an empty list', async () => {
    stubFetch({ '/api/finance/': new Error('D1 is unavailable'), ...OK_HOME });
    const home = await loadHome(STORE);
    expect(home.failures).toEqual([{ source: 'Finance', message: 'D1 is unavailable' }]);

    const out = listOf(home);
    expect(out).toContain('Finance could not be loaded');
    expect(out).toContain('D1 is unavailable');
    expect(out).not.toContain('Nothing to do');
  });

  it('says so when the to-dos themselves could not be read', async () => {
    stubFetch({ ...OK_HOME, '/api/todos': new Error('todos are down') });
    const home = await loadHome(STORE);
    expect(home.failures.map((f) => f.source)).toEqual(['To-dos']);
    expect(listOf(home)).toContain('To-dos could not be loaded');
  });

  it('names each other home source that fails: missions, overview, status', async () => {
    stubFetch({
      '/api/missions': new Error('missions are down'),
      '/api/overview': new Error('overview is down'),
      '/api/finance/overview': OK_HOME['/api/finance/overview'],
      '/api/finance/invoices': OK_HOME['/api/finance/invoices'],
      '/api/todos': OK_HOME['/api/todos'],
      '/api/prospects': OK_HOME['/api/prospects'],
    });
    const home = await loadHome({ status: null, merged: [] });
    const sources = home.failures.map((f) => f.source);
    expect(sources).toEqual(['Missions', 'Leads & follow-ups', 'Project status']);
    expect(home.missions).toEqual([]);
    expect(home.missionsOk).toBe(false);

    const out = listOf(home);
    expect(out).toContain('Missions could not be loaded');
    expect(out).toContain('missions are down');
    expect(out).toContain('Leads &amp; follow-ups could not be loaded');
    expect(out).toContain('overview is down');
    expect(out).toContain('Project status could not be loaded');
  });

  it('separates the two finance fetches when only one of them fails', async () => {
    stubFetch({
      '/api/missions': OK_HOME['/api/missions'],
      '/api/overview': OK_HOME['/api/overview'],
      '/api/finance/overview': OK_HOME['/api/finance/overview'],
      '/api/finance/invoices': new Error('overdue query failed'),
      '/api/todos': OK_HOME['/api/todos'],
      '/api/prospects': OK_HOME['/api/prospects'],
    });
    const home = await loadHome(STORE);
    expect(home.failures.map((f) => f.source)).toEqual(['Overdue invoices']);
    expect(home.financeOverview).not.toBeNull();
  });
});

describe('the project page keeps registry notes apart from the owner’s notes', () => {
  const RECALL = {
    slug: 'recall', name: 'Recall', kind: 'app', description: 'x', stage: 'live',
    notes: [{ date: '2026-08-01', text: 'Session note from the project' }],
    note: 'A registry note',
  };

  it('labels the read-only registry notes and the editable D1 box differently', async () => {
    stubFetch({
      '/meta': { meta: { notes: 'What the owner typed', pinned: 0 } },
      '/api/missions': { missions: [] },
      '/api/finance/projects': new Error('no finance for this project'),
    });
    const out = html(await renderProjectDetail(
      { store: { merged: [RECALL] }, navigate: () => {} }, 'recall',
    ));

    expect(out).toContain('From the project · read-only');
    expect(out).toContain('Session note from the project');

    expect(out).toContain('Your notes');
    // The editable box has its own accessible name (axe, 14 Nov).
    expect(out).toMatch(/<textarea class="text-input"[^>]*aria-label="Your notes"[^>]*>/);
    // The old label is gone, so no two blocks read as the same thing.
    expect(out).not.toContain('Project notes');
  });
});
