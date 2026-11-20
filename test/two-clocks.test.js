// A meeting time says whose clock it is on, and shows both (audit C14: M7, P5).
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';
import { freshDatabase } from './helpers/d1.js';
import * as pdb from '../src/worker/prospects-db.js';
import { zoneTimes, instantOf } from '../src/public/assets/dates.js';

installDom();
const { homeItems } = await import('../src/public/assets/todos.js');

describe('a time on two clocks', () => {
  it('converts Brussels and Lima both ways, winter and summer', () => {
    expect(zoneTimes('2026-11-16T18:30', 'Europe/Brussels')).toBe('18:30 Brussels · 12:30 Lima');
    expect(zoneTimes('2026-11-16T11:00', 'America/Lima')).toBe('11:00 Lima · 17:00 Brussels');
    expect(zoneTimes('2026-07-16T18:30', 'Europe/Brussels')).toBe('18:30 Brussels · 11:30 Lima'); // summer time: 7 h
    expect(new Date(instantOf('2026-11-16T18:30', 'Europe/Brussels')).toISOString()).toBe('2026-11-16T17:30:00.000Z');
  });
  it('keeps the bare time for a deal from before zones, and nothing for a day', () => {
    expect(zoneTimes('2026-11-16T18:30', null)).toBe('18:30');
    expect(zoneTimes('2026-11-16', 'Europe/Brussels')).toBe('');
  });
});

describe('Home', () => {
  it('shows a meeting on both clocks', () => {
    const items = homeItems({
      prospects: [{ id: 1, name: 'Dr Marchal', stage: 'meeting', next_step: 'Meeting at the clinic', next_at: '2026-11-16T18:30', next_tz: 'Europe/Brussels' }],
      today: '2026-11-14',
    });
    expect(items[0].sub).toContain('18:30 Brussels · 12:30 Lima');
  });
});

describe('a deal remembers whose clock', () => {
  it('stores a known zone and refuses an unknown one', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      const made = await pdb.createProspect(database, { name: 'Dr X', stage: 'meeting', next_at: '2026-11-16T18:30', next_tz: 'Europe/Brussels' });
      expect(made.next_tz).toBe('Europe/Brussels');
      const moved = await pdb.updateProspect(database, made.id, { next_tz: 'America/Lima' });
      expect(moved.next_tz).toBe('America/Lima');
      await expect(pdb.updateProspect(database, made.id, { next_tz: 'Mars/Olympus' })).rejects.toMatchObject({ field: 'next_tz' });
      expect((await pdb.updateProspect(database, made.id, { next_tz: null })).next_tz).toBeNull();
    } finally { await dispose(); }
  }, 30000);
});
