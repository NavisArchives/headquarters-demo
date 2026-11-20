import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDom, html } from './dom-shim.js';
import { merge } from '../src/public/assets/lib.js';

// The screens build DOM, so a DOM has to exist before they are imported.
installDom();
const { renderProjectsList, projectsTab } = await import('../src/public/assets/screens/projects.js');
const { platformRow, platformsPane, hostOf } = await import('../src/public/assets/screens/platforms.js');

const registry = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'));
const store = { projects: registry, merged: merge(registry, {}) };

describe('Projects → Platforms', () => {
  it('Projects has two tabs: Projects open by default, Platforms on ?tab=platforms', () => {
    expect(projectsTab('')).toBe('projects');
    expect(projectsTab('?tab=platforms')).toBe('platforms');
    expect(projectsTab('?tab=nope')).toBe('projects');
    const root = renderProjectsList({ store, navigate: () => {} });
    const tabs = [...root.querySelectorAll('[role="tab"]')].map((t) => [t.textContent, t.getAttribute('aria-selected')]);
    expect(tabs).toEqual([['Projects', 'true'], ['Platforms', 'false']]);
    expect(root.dataset.seg).toBe('projects');
    expect(root.querySelector('.pf-pane')).toBeTruthy();
    expect(root.querySelector('.pj-pane')).toBeTruthy();
    expect(html(root)).toContain('class="grid g-cards"');
  });

  it('a row shows name, link, status, the facts it has, and when it changed', () => {
    const row = platformRow({
      id: 1, name: 'RemoExperts', url: 'https://portal.rex.zone/', status: 'test_to_do', next_step: 'Trial Test',
      pay: '', note: '', updated_at: '2026-11-20T00:00:00Z',
    }, { now: Date.parse('2026-11-20T02:00:00Z') });
    expect(html(row)).toContain('RemoExperts');
    const link = row.querySelector('.pf-link');
    expect(link.href).toBe('https://portal.rex.zone/');
    expect(link.target).toBe('_blank');
    expect(link.textContent).toContain('portal.rex.zone');
    expect(row.querySelector('select').value).toBe('test_to_do');
    expect(row.querySelectorAll('option')).toHaveLength(6);
    expect(row.querySelector('select').getAttribute('aria-label')).toBe('Status of RemoExperts');
    expect([...row.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Next']);
    expect(row.querySelector('.pf-when').textContent).toMatch(/Changed /);
  });

  it('a row without link or facts still renders', () => {
    const row = platformRow({ id: 2, name: 'Mindrift', url: '', status: 'to_sign_up', next_step: '', pay: '', note: '', updated_at: '2026-11-20T00:00:00Z' });
    expect(row.querySelector('.pf-link')).toBeNull();
    expect(row.querySelector('dl')).toBeNull();
  });

  it('the pane has its add button, and hosts read cleanly', () => {
    const pane = platformsPane();
    expect(pane.querySelector('.btn').textContent).toBe('+ Add platform');
    expect(hostOf('https://www.mercor.com/')).toBe('mercor.com');
    expect(hostOf('')).toBe('');
  });
});
