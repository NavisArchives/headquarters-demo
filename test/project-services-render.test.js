import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDom, html } from './dom-shim.js';

// The screen builds DOM, so a DOM has to exist before it is imported.
installDom();
const { servicesBlock } = await import('../src/public/assets/screens/projects.js');

/* A project with two services, one of which the registry marks manual. */
const project = {
  slug: 'marc-aubin',
  name: 'Marc Aubin',
  links: { local: { url: 'http://localhost:4330', service: 'site' } },
  local: {
    path: '/home/demo/sites/marc-aubin',
    services: [
      { id: 'site', label: 'Site', run: ['npm', 'run', 'dev'], port: 4330 },
    ],
  },
};

const live = (extra) => ({ slug: 'marc-aubin', name: 'site', port: 4330, url: 'http://localhost:4330', manual: false, ...extra });

/** Render the card with a stub `api`, and hand back the pieces a test needs. */
function render(options = {}) {
  const card = servicesBlock(project, { api: async () => ({}), ...options });
  const row = card.find('div').find((n) => n.className === 'service-block');
  const actions = row.find('div').find((n) => n.className === 'svc-actions');
  const word = row.find('span').find((n) => n.className === 'svc-state');
  const message = row.find('p').find((n) => n.className === 'svc-msg');
  const labels = () => actions.children.map((c) => c.textContent);
  return { card, row, actions, word, message, labels };
}

beforeEach(() => { installDom(); });

describe('a service that is not running', () => {
  it('says so, and offers Start and Logs only', () => {
    const { word, labels } = render({ services: [live({ running: false })] });
    expect(word.textContent).toBe('Not running');
    expect(labels()).toEqual(['Start', 'Logs']);
  });

  it('keeps the command as the fallback, under "or run it yourself"', () => {
    const markup = html(render({ services: [live({ running: false })] }).card);
    expect(markup).toContain('or run it yourself');
    expect(markup).toContain('cd &quot;/home/demo/sites/marc-aubin&quot; &amp;&amp; npm run dev');
    expect(markup).not.toContain("aren't wired up yet");
  });
});

describe('a service HQ started', () => {
  it('offers Stop and Open as well, and never Start', () => {
    const { word, labels, actions } = render({ services: [live({ running: true, pid: 4242 })] });
    expect(word.textContent).toBe('Running');
    expect(labels()).toEqual(['Stop', 'Open', 'Logs']);
    const open = actions.find('a')[0];
    expect(open.href).toBe('http://localhost:4330');
    expect(open.target).toBe('_blank');
    expect(open.rel).toMatch(/noopener/);
  });
});

describe('a service someone else started', () => {
  it('says HQ did not start it, and offers no Stop', () => {
    const { word, labels } = render({ services: [live({ running: true })] });
    expect(word.textContent).toBe('Running, not started by HQ');
    expect(labels()).toEqual(['Open', 'Logs']);
  });
});

describe('a manual service', () => {
  it('says who manages it and renders no buttons at all', () => {
    const manual = {
      ...project,
      local: { ...project.local, services: [{ ...project.local.services[0], manual: true }] },
    };
    const card = servicesBlock(manual, { services: [live({ running: true, manual: true })] });
    expect(html(card)).toContain('Managed by launchd — start with ./tools/admin.sh');
    expect(card.find('span').find((n) => n.className === 'svc-state').textContent).toBe('Manual');
    expect(card.find('button').length).toBe(0);
  });
});

describe('without the Mac', () => {
  it('offers Start and says nothing beside it — the reason arrives when it is pressed', () => {
    const { word, actions } = render({ bridge: false });
    expect(word.textContent).toBe('Unknown');
    expect(actions.children.map((c) => c.textContent)).toEqual(['Start']);
    for (const btn of actions.find('button')) expect(Boolean(btn.disabled)).toBe(false);
    expect(html(actions)).not.toMatch(/needs the Mac/);
  });

  it('leaves the copy chip as the way through', () => {
    expect(html(render({ bridge: false }).card)).toContain('npm run dev');
  });
});

describe('pressing Start', () => {
  it('leaves no pressable button while the start is pending, and says it waits', async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const { actions, word, labels } = render({
      services: [live({ running: false })],
      api: () => pending,
    });
    const done = actions.find('button')[0].listeners.click[0]();

    expect(word.textContent).toBe('Starting… (waits for the port)');
    expect(labels()).toEqual(['Starting…']);
    for (const btn of actions.find('button')) expect(btn.disabled).toBe(true);

    settle({ running: true, pid: 99 });
    await done;
    expect(word.textContent).toBe('Running');
    expect(labels()).toEqual(['Stop', 'Open', 'Logs']);
  });

  it('puts the API\'s own 409 in the row it belongs to', async () => {
    const { actions, message, word } = render({
      services: [live({ running: false })],
      api: async () => { throw new Error('already running — not started by HQ'); },
    });
    await actions.find('button')[0].listeners.click[0]();
    expect(message.textContent).toBe('already running — not started by HQ');
    expect(word.textContent).toBe('Not running');
  });

  it('refreshes the status the Local pill reads', async () => {
    let refreshed = 0;
    const { actions } = render({
      services: [live({ running: false })],
      api: async () => ({ running: true, pid: 7 }),
      onRefresh: async () => { refreshed += 1; },
    });
    await actions.find('button')[0].listeners.click[0]();
    expect(refreshed).toBe(1);
  });
});

describe('pressing Stop', () => {
  it('shows a 409 in the row and leaves the row as it found it', async () => {
    const { actions, message, word } = render({
      services: [live({ running: true, pid: 12 })],
      api: async () => { throw new Error('HQ did not start this'); },
    });
    await actions.children.find((c) => c.textContent === 'Stop').listeners.click[0]();
    expect(message.textContent).toBe('HQ did not start this');
    expect(word.textContent).toBe('Running');
  });
});

describe('Logs', () => {
  it('expands the last lines in a mono box, with a refresh, and collapses again', async () => {
    let asked = null;
    const { row, actions } = render({
      services: [live({ running: false })],
      api: async (url) => { asked = url; return { lines: ['one', 'two'] }; },
    });
    const logs = actions.children.find((c) => c.textContent === 'Logs');
    await logs.listeners.click[0]();
    const host = row.find('div').find((n) => n.className === 'svc-logs');
    expect(asked).toBe('/api/services/marc-aubin/site/logs?lines=80');
    expect(host.find('pre')[0].className).toBe('box mono');
    expect(host.find('pre')[0].textContent).toBe('one\ntwo');
    expect(host.find('button')[0].textContent).toBe('Refresh');
    logs.listeners.click[0]();
    expect(host.childElementCount).toBe(0);
  });
});

describe('the markup itself', () => {
  it('is built node by node — nothing is ever set as innerHTML', () => {
    const source = String(servicesBlock);
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    const file = new URL('../src/public/assets/screens/projects.js', import.meta.url);
    expect(readFileSync(file, 'utf8')).not.toMatch(/innerHTML\s*=/);
  });

  it('escapes a hostile label instead of interpolating it', () => {
    const evil = {
      ...project,
      local: { ...project.local, services: [{ id: 'site', label: '<b>x</b>', run: ['npm'], port: 1 }] },
    };
    const markup = html(servicesBlock(evil, { services: [] }));
    expect(markup).not.toContain('<b>x</b>');
    expect(markup).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
