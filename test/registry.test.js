import { describe, it, expect } from 'vitest';
import { validateRegistry } from '../src/shared/registry.js';

const base = {
  slug: 'realis-studio',
  name: 'Realis Studio',
  kind: 'business',
  description: 'Trilingual portfolio and lead-generation site.',
  stack: 'Astro · Cloudflare Workers assets',
  status: { probe: 'http', worker: 'realis-studio' },
  links: { live: { url: 'https://realis-studio.owner.workers.dev' } },
};

describe('validateRegistry', () => {
  it('accepts a minimal valid entry', () => {
    expect(validateRegistry([base])).toEqual([]);
  });

  it('rejects a non-array registry', () => {
    expect(validateRegistry({})).toEqual(['registry must be an array']);
  });

  it('rejects a slug that is not kebab-case', () => {
    const errors = validateRegistry([{ ...base, slug: 'Realis Studio' }]);
    expect(errors).toContain('projects[0].slug must be kebab-case');
  });

  it('rejects a duplicate slug', () => {
    const errors = validateRegistry([base, { ...base }]);
    expect(errors).toContain('projects[1].slug duplicates "realis-studio"');
  });

  it('rejects an unknown kind', () => {
    const errors = validateRegistry([{ ...base, kind: 'tool' }]);
    expect(errors).toContain('projects[0].kind must be one of business, client, prospect');
  });

  it('rejects an http probe with no live link', () => {
    const errors = validateRegistry([{ ...base, links: {} }]);
    expect(errors).toContain('projects[0] uses probe "http" but has no links.live.url');
  });

  it('rejects a local probe with no local block', () => {
    const errors = validateRegistry([{ ...base, status: { probe: 'local' }, links: {} }]);
    expect(errors).toContain('projects[0] uses probe "local" but has no local block');
  });

  const local = (over = {}) => ({
    ...base,
    status: { probe: 'local' },
    links: {},
    local: {
      path: '/home/demo/sites/marc-aubin',
      services: [{ id: 'site', label: 'Site', run: ['npm', 'run', 'dev'], port: 4321 }],
      ...over,
    },
  });

  it('accepts a project with two services', () => {
    expect(validateRegistry([local({
      services: [
        { id: 'site', label: 'Site', run: ['npm', 'run', 'dev'], port: 4321 },
        { id: 'editor', label: 'Editor', run: ['npm', 'run', 'edit'], port: 4100 },
      ],
    })])).toEqual([]);
  });

  it('rejects a relative local path', () => {
    const errors = validateRegistry([local({ path: 'Movies/AXELDELANGE' })]);
    expect(errors).toContain('projects[0].local.path must be absolute');
  });

  it('rejects a local block with no services', () => {
    const errors = validateRegistry([local({ services: [] })]);
    expect(errors).toContain('projects[0].local.services must be a non-empty array');
  });

  it('rejects a run command given as a shell string', () => {
    const errors = validateRegistry([local({
      services: [{ id: 'site', label: 'Site', run: 'npm run dev', port: 4321 }],
    })]);
    expect(errors).toContain('projects[0].local.services[0].run must be a non-empty argv array');
  });

  it('rejects a service id that is not kebab-case', () => {
    const errors = validateRegistry([local({
      services: [{ id: 'Site Two', label: 'Site', run: ['npm', 'run', 'dev'], port: 4321 }],
    })]);
    expect(errors).toContain('projects[0].local.services[0].id must be kebab-case');
  });

  it('accepts a service carrying environment variables', () => {
    expect(validateRegistry([local({
      services: [{ id: 'site', label: 'Site', run: ['python3', 'server.py'], port: 3017, env: { PORT: '3017' } }],
    })])).toEqual([]);
  });

  it('rejects a non-string environment value', () => {
    const errors = validateRegistry([local({
      services: [{ id: 'site', label: 'Site', run: ['python3', 'server.py'], port: 3017, env: { PORT: 3017 } }],
    })]);
    expect(errors).toContain('projects[0].local.services[0].env values must all be strings');
  });

  it('rejects two services sharing an id', () => {
    const errors = validateRegistry([local({
      services: [
        { id: 'site', label: 'A', run: ['a'], port: 1 },
        { id: 'site', label: 'B', run: ['b'], port: 2 },
      ],
    })]);
    expect(errors).toContain('projects[0].local.services[1].id duplicates "site"');
  });

  it('rejects a live link that is not an absolute https URL', () => {
    const errors = validateRegistry([{ ...base, links: { live: { url: '/somewhere' } } }]);
    expect(errors).toContain('projects[0].links.live.url must be an absolute https URL');
  });
});
