import { describe, it, expect } from 'vitest';
import registry from '../projects.json' with { type: 'json' };
import {
  merge, summarise, relativeTime, isRunnable, macOnline,
} from '../src/public/assets/lib.js';

const realisStudio = registry.find((p) => p.slug === 'realis-studio');
const andyssarchives = registry.find((p) => p.slug === 'andyssarchives');
const axelAubin = registry.find((p) => p.slug === 'marc-aubin');

describe('merge', () => {
  it('attaches the matching state by slug', () => {
    const [merged] = merge(
      [{ slug: 'realis-studio' }],
      { 'realis-studio': { kind: 'up', label: 'Live' } },
    );
    expect(merged.state).toEqual({ kind: 'up', label: 'Live' });
  });

  it('defaults to unknown when the status payload has no entry for the slug', () => {
    const [merged] = merge([{ slug: 'archivio' }], { 'realis-studio': { kind: 'up', label: 'Live' } });
    expect(merged.state).toEqual({ kind: 'unknown', label: 'Unknown' });
  });

  it('defaults every project when the status payload is missing entirely', () => {
    const merged = merge([{ slug: 'a' }, { slug: 'b' }], undefined);
    expect(merged.every((p) => p.state.kind === 'unknown')).toBe(true);
  });

  it('defaults every project when the status payload is null', () => {
    const merged = merge([{ slug: 'a' }], null);
    expect(merged[0].state).toEqual({ kind: 'unknown', label: 'Unknown' });
  });

  it('preserves the original project fields alongside state', () => {
    const [merged] = merge([{ slug: 'a', name: 'A' }], {});
    expect(merged.name).toBe('A');
  });

  it('returns an empty array for an empty or missing project list', () => {
    expect(merge([], {})).toEqual([]);
    expect(merge(undefined, {})).toEqual([]);
  });
});

describe('summarise', () => {
  it('counts live, running, pending and attention separately', () => {
    const merged = [
      { state: { kind: 'up' } },
      { state: { kind: 'up' } },
      { state: { kind: 'running' } },
      { state: { kind: 'starting' } },
      { state: { kind: 'stopping' } },
      { state: { kind: 'failed' } },
      { state: { kind: 'down' } },
      { state: { kind: 'none' } },
      { state: { kind: 'unknown' } },
    ];
    expect(summarise(merged)).toEqual({ live: 2, running: 1, pending: 2, attention: 2 });
  });

  it('returns all zeroes for an empty list', () => {
    expect(summarise([])).toEqual({ live: 0, running: 0, pending: 0, attention: 0 });
  });

  it('treats a missing state as contributing nothing', () => {
    expect(summarise([{}])).toEqual({ live: 0, running: 0, pending: 0, attention: 0 });
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('reports never for a missing timestamp', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime(undefined, now)).toBe('never');
  });

  it('reports never for an unparseable timestamp', () => {
    expect(relativeTime('not a date', now)).toBe('never');
  });

  it('reports just now for anything under a minute', () => {
    expect(relativeTime('2026-09-20T11:59:59.000Z', now)).toBe('just now');
    expect(relativeTime(now.toISOString(), now)).toBe('just now');
  });

  it('reports minutes for under an hour', () => {
    expect(relativeTime('2026-09-20T11:57:00.000Z', now)).toBe('3 minutes ago');
    expect(relativeTime('2026-09-20T11:59:00.000Z', now)).toBe('1 minute ago');
  });

  it('reports hours for under a day', () => {
    expect(relativeTime('2026-09-20T11:00:00.000Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-09-20T09:00:00.000Z', now)).toBe('3 hours ago');
  });

  it('reports days beyond a day', () => {
    expect(relativeTime('2026-09-18T12:00:00.000Z', now)).toBe('2 days ago');
    expect(relativeTime('2026-09-19T12:00:00.000Z', now)).toBe('1 day ago');
  });
});

describe('isRunnable', () => {
  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('is true for a local project in a state HQ would act on', () => {
    expect(isRunnable({ ...axelAubin, state: { kind: 'stopped' } })).toBe(true);
    expect(isRunnable({ ...axelAubin, state: { kind: 'running' } })).toBe(true);
    expect(isRunnable({ ...axelAubin, state: { kind: 'starting' } })).toBe(true);
    expect(isRunnable({ ...axelAubin, state: { kind: 'failed' } })).toBe(true);
  });

  it('is false for a local project in a state HQ would not act on', () => {
    expect(isRunnable({ ...axelAubin, state: { kind: 'unknown' } })).toBe(false);
    expect(isRunnable({ ...axelAubin, state: { kind: 'none' } })).toBe(false);
  });

  it('is false with no state at all', () => {
    expect(isRunnable(axelAubin)).toBe(false);
  });

  it('is never true for a project without a local block', () => {
    for (const base of [realisStudio, andyssarchives]) {
      const withoutLocal = { ...base, local: undefined };
      for (const kind of ['running', 'stopped', 'failed', 'starting']) {
        expect(isRunnable({ ...withoutLocal, state: { kind } })).toBe(false);
      }
    }
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('knows Realis Studio and andyssarchives as services HQ can start (projects.json, 16 Oct)', () => {
    expect(realisStudio.local.services.map((s) => s.port)).toEqual([4322, 4324]);
    expect(andyssarchives.local.services.map((s) => s.port)).toEqual([4173, 4180, 4187]);
  });

  it('is false when local.services is present but empty', () => {
    expect(isRunnable({ local: { services: [] }, state: { kind: 'running' } })).toBe(false);
  });

  it('is false for a project with no local field and no state', () => {
    expect(isRunnable({})).toBe(false);
    expect(isRunnable(undefined)).toBe(false);
  });
});

describe('macOnline', () => {
  it('is online when there are no local-probe projects', () => {
    expect(macOnline([{ status: { probe: 'http' }, state: { kind: 'up' } }])).toBe(true);
    expect(macOnline([])).toBe(true);
  });

  it('is offline only when every local-probe project reports Mac offline', () => {
    const allOffline = [
      { status: { probe: 'local' }, state: { label: 'Mac offline' } },
      { status: { probe: 'local' }, state: { label: 'Mac offline' } },
    ];
    expect(macOnline(allOffline)).toBe(false);
  });

  it('is online when at least one local-probe project is reachable', () => {
    const mixed = [
      { status: { probe: 'local' }, state: { label: 'Mac offline' } },
      { status: { probe: 'local' }, state: { kind: 'running', label: 'Running' } },
    ];
    expect(macOnline(mixed)).toBe(true);
  });
});
