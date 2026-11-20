/**
 * The registry's second layer.
 *
 * The property everything else rests on is the first test in this file: with
 * no rows, the merged registry IS the committed file. That is what made it
 * safe to ship this two days before a client push, and what makes
 * `DELETE FROM projects` a complete rollback.
 *
 * Every database here is created empty and thrown away. No production data.
 */
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import fileRegistry from '../projects.json';
import {
  mergeRegistry, validateEntry, liveOnly, safeProbeTarget, isPrivateTarget,
  slugFrom, validateRegistry, RESERVED_SLUGS,
} from '../src/shared/registry.js';
import * as store from '../src/worker/registry-store.js';
import * as db from '../src/worker/db.js';

async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}

const row = (over = {}) => ({
  slug: 'mix-brussels',
  origin: 'db',
  entry: JSON.stringify({
    slug: 'mix-brussels', name: 'Mix Brussels', kind: 'client',
    description: 'Ice-bath studio.', status: { probe: 'none' },
  }),
  brand: null, position: 0, archived_at: null, version: 1,
  created_at: '2026-09-22T10:00:00.000Z', updated_at: '2026-09-22T10:00:00.000Z',
  ...over,
});

describe('the merge is the identity when nothing has been added', () => {
  it('returns the committed file, entry for entry', () => {
    const { registry, skipped } = mergeRegistry(fileRegistry, []);
    expect(skipped).toEqual([]);
    expect(registry.map(({ origin, ...rest }) => rest)).toEqual(fileRegistry);
    expect(registry.every((p) => p.origin === 'file')).toBe(true);
  });

  it('and the merged file still passes the validator it was written against', () => {
    const { registry } = mergeRegistry(fileRegistry, []);
    expect(validateRegistry(registry)).toEqual([]);
  });

  it('survives a missing or broken rows argument rather than failing to load', () => {
    expect(mergeRegistry(fileRegistry, null).registry).toHaveLength(fileRegistry.length);
    expect(mergeRegistry(null, null).registry).toEqual([]);
  });
});

describe('a project made in HQ', () => {
  it('is appended, and says where it came from', () => {
    const { registry } = mergeRegistry(fileRegistry, [row()]);
    expect(registry).toHaveLength(fileRegistry.length + 1);
    const made = registry.at(-1);
    expect(made.slug).toBe('mix-brussels');
    expect(made.origin).toBe('db');
  });

  it('orders db-born projects by position, then by when they were made', () => {
    const { registry } = mergeRegistry(fileRegistry, [
      row({ slug: 'c', position: 2, entry: JSON.stringify({ name: 'C', kind: 'client' }) }),
      row({ slug: 'a', position: 0, entry: JSON.stringify({ name: 'A', kind: 'client' }) }),
      row({ slug: 'b', position: 1, entry: JSON.stringify({ name: 'B', kind: 'client' }) }),
    ]);
    expect(registry.slice(-3).map((p) => p.slug)).toEqual(['a', 'b', 'c']);
  });

  it('can never carry a local block, however the row was written', () => {
    const { registry } = mergeRegistry(fileRegistry, [row({
      entry: JSON.stringify({
        name: 'Mix', kind: 'client',
        local: { services: [{ id: 'evil', port: 1, argv: ['rm', '-rf', '/'] }] },
        status: { probe: 'http', url: 'https://x.test', method: 'POST', expect: [200] },
      }),
    })]);
    const made = registry.at(-1);
    expect(made.local).toBeUndefined();
    expect(made.status.method).toBeUndefined();
    expect(made.status.expect).toBeUndefined();
  });
});

describe('an edit to a committed project', () => {
  const target = fileRegistry[0].slug;

  it('changes only the keys it names, and keeps tracking the file for the rest', () => {
    const { registry } = mergeRegistry(fileRegistry, [row({
      slug: target, origin: 'override', entry: JSON.stringify({ note: 'a new note' }),
    })]);
    const merged = registry.find((p) => p.slug === target);
    expect(merged.note).toBe('a new note');
    expect(merged.name).toBe(fileRegistry[0].name);
    expect(merged.description).toBe(fileRegistry[0].description);
    expect(merged.origin).toBe('override');
  });

  it('merges links and status per key rather than replacing the block', () => {
    const withLive = fileRegistry.find((p) => p.links?.live?.url);
    const { registry } = mergeRegistry(fileRegistry, [row({
      slug: withLive.slug, origin: 'override',
      entry: JSON.stringify({ links: { reference: { url: 'https://notes.test', label: 'Notes' } } }),
    })]);
    const merged = registry.find((p) => p.slug === withLive.slug);
    expect(merged.links.live.url).toBe(withLive.links.live.url);
    expect(merged.links.reference.label).toBe('Notes');
  });

  it('cannot take the local block away from a project that has one', () => {
    const withLocal = fileRegistry.find((p) => p.local?.services?.length);
    if (!withLocal) return;
    const { registry } = mergeRegistry(fileRegistry, [row({
      slug: withLocal.slug, origin: 'override', entry: JSON.stringify({ local: null }),
    })]);
    const merged = registry.find((p) => p.slug === withLocal.slug);
    expect(merged.local).toEqual(withLocal.local);
  });
});

describe('a row that cannot be used is reported, never fatal', () => {
  it('skips unreadable JSON and still returns every other project', () => {
    const { registry, skipped } = mergeRegistry(fileRegistry, [row({ entry: '{not json' })]);
    expect(registry).toHaveLength(fileRegistry.length);
    expect(skipped[0].slug).toBe('mix-brussels');
  });

  it('skips an edit whose project has left the repository', () => {
    const { skipped } = mergeRegistry(fileRegistry, [row({ slug: 'gone-from-the-repo', origin: 'override' })]);
    expect(skipped.some((s) => s.slug === 'gone-from-the-repo')).toBe(true);
  });

  it('refuses to let a made project shadow a committed one', () => {
    const { registry, skipped } = mergeRegistry(fileRegistry, [row({ slug: fileRegistry[0].slug })]);
    expect(registry).toHaveLength(fileRegistry.length);
    expect(skipped.some((s) => s.slug === fileRegistry[0].slug)).toBe(true);
  });
});

describe('archiving', () => {
  it('marks the project and takes it off the live list, keeping it in the registry', () => {
    const { registry } = mergeRegistry(fileRegistry, [row({ archived_at: '2026-09-22T10:00:00.000Z' })]);
    const made = registry.at(-1);
    expect(made.archived).toBe(true);
    expect(liveOnly(registry).some((p) => p.slug === 'mix-brussels')).toBe(false);
    expect(registry.some((p) => p.slug === 'mix-brussels')).toBe(true);
  });
});

describe('where a checked address may point', () => {
  it('allows an ordinary public https site', () => {
    expect(safeProbeTarget('https://mixbrussels.be')).toBeNull();
  });

  for (const [url, why] of [
    ['http://example.com', 'plain http'],
    ['https://localhost', 'this machine'],
    ['https://hq.localhost', 'this machine by suffix'],
    ['https://printer.local', 'the local network'],
    ['https://127.0.0.1', 'loopback'],
    ['https://10.1.2.3', 'a private range'],
    ['https://172.16.0.9', 'another private range'],
    ['https://192.168.1.1', 'a home network'],
    ['https://169.254.169.254', 'cloud metadata'],
    ['https://[::1]/', 'IPv6 loopback'],
    ['https://example.com/api/publish', 'an API path'],
    ['not a url', 'nonsense'],
    ['', 'nothing at all'],
  ]) {
    it(`refuses ${why}`, () => {
      expect(safeProbeTarget(url)).toBeTruthy();
    });
  }

  it('knows a redirect landing inside a private network when it sees one', () => {
    expect(isPrivateTarget('https://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isPrivateTarget('http://localhost:8787/api/finance/clients')).toBe(true);
    expect(isPrivateTarget('https://realisstudio.com/')).toBe(false);
  });
});

describe('one validator, not two', () => {
  it('reports a candidate’s own problems without the array index', () => {
    const errors = validateEntry({ slug: 'x', name: '', kind: 'nope' }, fileRegistry);
    expect(errors.some((e) => e.startsWith('name'))).toBe(true);
    expect(errors.some((e) => e.startsWith('kind'))).toBe(true);
    expect(errors.every((e) => !e.startsWith('projects['))).toBe(true);
  });

  it('accepts a complete, ordinary entry', () => {
    expect(validateEntry({
      slug: 'mix-brussels', name: 'Mix Brussels', kind: 'client',
      description: 'Ice-bath studio.', status: { probe: 'none' },
    }, fileRegistry)).toEqual([]);
  });

  it('knows the two brands and refuses a third', () => {
    const ok = { slug: 'a-client', name: 'A', kind: 'client', description: 'd', status: { probe: 'none' } };
    expect(validateEntry({ ...ok, brand: 'realis' }, fileRegistry)).toEqual([]);
    expect(validateEntry({ ...ok, brand: 'someone-else' }, fileRegistry)).toContainEqual(
      expect.stringContaining('brand must be one of'),
    );
  });
});

describe('a name becomes an address', () => {
  it('strips accents and punctuation', () => {
    expect(slugFrom('Mix Brussels')).toBe('mix-brussels');
    expect(slugFrom('Dr Élodie Lefèvre — Chirurgie')).toBe('dr-elodie-lefevre-chirurgie');
    expect(slugFrom('   ')).toBe('');
  });
});

describe('writing a project', () => {
  it('creates one, records a version, and logs what happened', async () => {
    await withDatabase(async (database) => {
      const made = await store.createProject(database, {
        name: 'Mix Brussels', kind: 'client', description: 'Ice-bath studio.', brand: 'andyssarchives',
      }, fileRegistry, { actor: 'test' });
      expect(made.slug).toBe('mix-brussels');

      const { registry } = mergeRegistry(fileRegistry, await store.readRows(database));
      expect(registry.some((p) => p.slug === 'mix-brussels')).toBe(true);

      expect(await store.listVersions(database, 'mix-brussels')).toHaveLength(1);
      expect((await store.listEvents(database, 'mix-brussels'))[0].action).toBe('create');
    });
  });

  it('refuses a slug HQ uses for its own pages', async () => {
    await withDatabase(async (database) => {
      for (const slug of ['admin', 'api', 'leads']) {
        // eslint-disable-next-line no-await-in-loop -- one message per slug
        await expect(store.createProject(database, {
          slug, name: 'X', kind: 'client', description: 'd',
        }, fileRegistry)).rejects.toThrow(/HQ uses for its own pages/);
      }
      expect(RESERVED_SLUGS).toContain('admin');
    });
  });

  it('refuses a second project with a slug that already exists', async () => {
    await withDatabase(async (database) => {
      await expect(store.createProject(database, {
        slug: fileRegistry[0].slug, name: 'X', kind: 'client', description: 'd',
      }, fileRegistry)).rejects.toThrow(/already a project/);
    });
  });

  it('refuses a checked address that points inside the network', async () => {
    await withDatabase(async (database) => {
      await expect(store.createProject(database, {
        name: 'Router', kind: 'business', description: 'd',
        status: { probe: 'http', url: 'https://192.168.1.1' },
      }, fileRegistry)).rejects.toThrow(/private network/);
    });
  });

  it('refuses a local block and says why', async () => {
    await withDatabase(async (database) => {
      await expect(store.createProject(database, {
        name: 'X', kind: 'client', description: 'd',
        local: { services: [{ id: 'x', port: 1 }] },
      }, fileRegistry)).rejects.toThrow(/runs commands on the Mac/);
    });
  });

  it('hands back every validation problem at once, not just the first', async () => {
    await withDatabase(async (database) => {
      await expect(store.createProject(database, { slug: 'a-thing', name: 'X' }, fileRegistry))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringContaining('kind')]) });
    });
  });
});

describe('editing and retiring', () => {
  it('stores only what changed on a committed project', async () => {
    await withDatabase(async (database) => {
      const target = fileRegistry[0].slug;
      const { registry } = mergeRegistry(fileRegistry, []);
      await store.updateProject(database, target, { note: 'changed here' }, {
        file: fileRegistry, existing: registry, actor: 'test',
      });
      const saved = await store.getRow(database, target);
      expect(saved.origin).toBe('override');
      expect(JSON.parse(saved.entry)).toEqual({ note: 'changed here' });

      const merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry
        .find((p) => p.slug === target);
      expect(merged.note).toBe('changed here');
      expect(merged.name).toBe(fileRegistry[0].name);
    });
  });

  it('refuses to change a slug, because the money points at it', async () => {
    await withDatabase(async (database) => {
      const target = fileRegistry[0].slug;
      const { registry } = mergeRegistry(fileRegistry, []);
      await expect(store.updateProject(database, target, { slug: 'something-else' }, {
        file: fileRegistry, existing: registry,
      })).rejects.toThrow(/slug cannot change/);
    });
  });

  it('puts a committed project back exactly as the repository has it', async () => {
    await withDatabase(async (database) => {
      const target = fileRegistry[0].slug;
      const { registry } = mergeRegistry(fileRegistry, []);
      await store.updateProject(database, target, { note: 'temporary' }, { file: fileRegistry, existing: registry });
      await store.revertProject(database, target, { file: fileRegistry });
      const back = mergeRegistry(fileRegistry, await store.readRows(database)).registry
        .find((p) => p.slug === target);
      expect(back.note).toBe(fileRegistry[0].note);
    });
  });

  it('archives and unarchives without touching the entry', async () => {
    await withDatabase(async (database) => {
      await store.createProject(database, { name: 'Mix Brussels', kind: 'client', description: 'd' }, fileRegistry);
      let merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      await store.setArchived(database, 'mix-brussels', true, { existing: merged });
      merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      expect(merged.find((p) => p.slug === 'mix-brussels').archived).toBe(true);

      await store.setArchived(database, 'mix-brussels', false, { existing: merged });
      merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      expect(merged.find((p) => p.slug === 'mix-brussels').archived).toBeUndefined();
      expect(merged.find((p) => p.slug === 'mix-brussels').name).toBe('Mix Brussels');
    });
  });

  it('lets a slug typed by mistake be thrown away while nothing refers to it', async () => {
    await withDatabase(async (database) => {
      await store.createProject(database, { slug: 'mixx-brussels', name: 'Mixx', kind: 'client', description: 'd' }, fileRegistry);
      expect(await store.discardProject(database, 'mixx-brussels', { file: fileRegistry })).toBe(true);
      expect(await store.getRow(database, 'mixx-brussels')).toBeFalsy();
    });
  });

  it('refuses to throw away a project the money points at, and says what points at it', async () => {
    await withDatabase(async (database) => {
      await store.createProject(database, { name: 'Mix Brussels', kind: 'client', description: 'd' }, fileRegistry);
      await db.createClient(database, { name: 'Mix Brussels', initials: 'MB', slug: 'mix-brussels' });
      await expect(store.discardProject(database, 'mix-brussels', { file: fileRegistry }))
        .rejects.toMatchObject({ counts: expect.objectContaining({ clients: 1 }) });
    });
  });

  it('refuses to throw away a committed project at all', async () => {
    await withDatabase(async (database) => {
      await expect(store.discardProject(database, fileRegistry[0].slug, { file: fileRegistry }))
        .rejects.toThrow(/archive it instead/);
    });
  });

  it('restores an old version by writing a new one, so history is never rewritten', async () => {
    await withDatabase(async (database) => {
      await store.createProject(database, { name: 'Mix Brussels', kind: 'client', description: 'first' }, fileRegistry);
      let merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      await store.updateProject(database, 'mix-brussels', { description: 'second' }, { file: fileRegistry, existing: merged });

      await store.restoreVersion(database, 'mix-brussels', 1, { actor: 'test' });
      merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      expect(merged.find((p) => p.slug === 'mix-brussels').description).toBe('first');

      const versions = await store.listVersions(database, 'mix-brussels');
      expect(versions).toHaveLength(3);
      expect(versions[0].note).toBe('restored from v1');
    });
  });

  it('refuses a save that raced another window', async () => {
    await withDatabase(async (database) => {
      await store.createProject(database, { name: 'Mix Brussels', kind: 'client', description: 'd' }, fileRegistry);
      const merged = mergeRegistry(fileRegistry, await store.readRows(database)).registry;
      await expect(store.updateProject(database, 'mix-brussels', { description: 'e' }, {
        file: fileRegistry, existing: merged, expectUpdatedAt: '1999-01-01T00:00:00.000Z',
      })).rejects.toThrow(/changed somewhere else/);
    });
  });
});

describe('when the database cannot be read', () => {
  it('serves the committed file and says it is degraded rather than failing', async () => {
    const broken = { prepare() { throw new Error('D1 is away'); } };
    expect(await store.readRows(broken)).toBeNull();
    const out = await store.effectiveRegistry({ DB: broken }, fileRegistry);
    expect(out.degraded).toBe(true);
    expect(out.registry).toHaveLength(fileRegistry.length);
  });

  it('tolerates no database binding at all, which is how the worker tests run', async () => {
    const out = await store.effectiveRegistry({}, fileRegistry);
    expect(out.degraded).toBe(true);
    expect(out.registry.map(({ origin, ...rest }) => rest)).toEqual(fileRegistry);
  });
});
