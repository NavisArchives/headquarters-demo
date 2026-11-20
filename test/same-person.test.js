// The same doctor filed in two lists (NIRMATA, 14 Nov: Becker and Marin, BE and LU).
import { describe, it, expect } from 'vitest';
import { personKey, samePersonMap, isPeopleDataset } from '../src/public/assets/same-person.js';
import { freshDatabase } from './helpers/d1.js';
import { handleIntake } from '../src/worker/intake.js';

describe('personKey', () => {
  it('ignores accents, case, titles, punctuation and word order', () => {
    expect(personKey('Dr. Joé  Becker')).toBe('becker joe');
    expect(personKey('BECKER Joe')).toBe('becker joe');
    expect(personKey('Prof. dr. Ion Marin')).toBe(personKey('Marin, Ion'));
    expect(personKey('Docteur Waśkiewicz Witold')).toBe('waskiewicz witold');
    expect(personKey('')).toBe('');
    expect(personKey(null)).toBe('');
  });
});

describe('samePersonMap', () => {
  const lead = (uid, name) => ({ uid, dataset: uid.split('/')[0], name });
  it('pairs the same name across the BE and LU surgeon lists, both ways', () => {
    const map = samePersonMap([
      lead('plastic-surgeons-belgium/becker-joe-uccle', 'Dr Joe Becker'),
      lead('plastic-surgeons-luxembourg/becker-joe-dippach', 'Dr BECKER Joe'),
      lead('plastic-surgeons-belgium/other', 'Dr Ann Other'),
    ]);
    expect(map.get('plastic-surgeons-belgium/becker-joe-uccle')).toEqual([{ uid: 'plastic-surgeons-luxembourg/becker-joe-dippach', dataset: 'plastic-surgeons-luxembourg' }]);
    expect(map.get('plastic-surgeons-luxembourg/becker-joe-dippach')[0].uid).toBe('plastic-surgeons-belgium/becker-joe-uccle');
    expect(map.has('plastic-surgeons-belgium/other')).toBe(false);
  });
  it('never matches business lists, where a shared name is usually another business', () => {
    const map = samePersonMap([lead('hotels-be-lu-fr/astoria-1', 'Hotel Astoria'), lead('hotels-be-lu-fr/astoria-2', 'Astoria Hotel'),
      lead('architects-france/atelier-l', 'Atelier L'), lead('brussels-brugmann-local/atelier-l', 'Atelier L')]);
    expect(map.size).toBe(0);
    expect(isPeopleDataset('plastic-surgeons-switzerland-fr')).toBe(true);
    expect(isPeopleDataset('hotels-be-lu-fr')).toBe(false);
  });
  it('needs two words: a lone surname is too weak', () => {
    expect(samePersonMap([lead('plastic-surgeons-belgium/a', 'Dr Peeters'), lead('plastic-surgeons-luxembourg/b', 'Peeters')]).size).toBe(0);
  });
});

describe('the send list flags the same person (read only)', () => {
  it('names the twin and the one already written to, and counts them', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      const run = (sql, ...args) => database.prepare(sql).bind(...args).run();
      await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-belgium', 'Plastic surgeons', 'BE', 70, 50, 'x'), ('plastic-surgeons-luxembourg', 'Plastic surgeons', 'LU', 70, 50, 'x')");
      const add = (uid, name, country, email) => run(
        `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
         VALUES (?, ?, ?, 'Plastic surgeons', ?, '', 'x', ?, ?, 80, 'Hot', '{}', '["FR"]', 'x')`,
        uid, uid.split('/')[0], uid.split('/')[1], name, country, email);
      await add('plastic-surgeons-belgium/marin-ion-arlon', 'Dr Ion Marin', 'Belgium', 'arlon@x.be');
      await add('plastic-surgeons-luxembourg/marin-ion-bertrange', 'Dr MARIN Ion', 'Luxembourg', 'bertrange@x.lu');
      await add('plastic-surgeons-belgium/solo-ann', 'Dr Ann Solo', 'Belgium', 'solo@x.be');
      await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-luxembourg/marin-ion-bertrange', 'sent', 'batch 1', '2026-10-08T08:00:00Z')");
      const env = { DB: database, INTAKE_TOKEN_LEADS: 'l'.repeat(40) };
      const q = '?dataset=plastic-surgeons-belgium';
      const res = await handleIntake(new Request(`https://hq.example/api/intake/send-list${q}`, { headers: { Authorization: `Bearer ${'l'.repeat(40)}` } }), env, new URL(`https://hq.example/api/intake/send-list${q}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      const marin = body.leads.find((l) => l.uid.endsWith('marin-ion-arlon'));
      expect(marin.same_person).toEqual(['plastic-surgeons-luxembourg/marin-ion-bertrange']);
      expect(marin.same_person_written_via).toBe('plastic-surgeons-luxembourg/marin-ion-bertrange');
      expect(body.leads.find((l) => l.uid.endsWith('solo-ann')).same_person).toEqual([]);
      expect(body.counts.same_person).toBe(1);
      expect(body.counts.same_person_already_written).toBe(1);
    } finally { await dispose(); }
  });
});

describe('the send list flags a lead whose address changed since it was written to (0032)', () => {
  it('names the first address, flags the change, and counts it', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      const run = (sql, ...args) => database.prepare(sql).bind(...args).run();
      await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-belgium', 'Plastic surgeons', 'BE', 70, 50, 'x')");
      const add = (id, email) => run(
        `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
         VALUES (?, 'plastic-surgeons-belgium', ?, 'Plastic surgeons', ?, '', 'x', 'Belgium', ?, 80, 'Hot', '{}', '["NL"]', 'x')`,
        `plastic-surgeons-belgium/${id}`, id, `Dr ${id} Test`, email);
      await add('moved', 'clinic@uz.example');
      await add('same', 'same@x.example');
      await add('none', 'none@x.example');
      await run("INSERT INTO lead_events (uid, kind, detail, at, sent_to, subject) VALUES ('plastic-surgeons-belgium/moved', 'sent', 'batch a', '2026-09-30T15:00:00Z', 'home@mail.example', 'À l’attention du Dr moved')");
      await run("INSERT INTO lead_events (uid, kind, detail, at, sent_to) VALUES ('plastic-surgeons-belgium/moved', 'sent', 'batch b', '2026-10-07T15:00:00Z', 'clinic@uz.example')");
      await run("INSERT INTO lead_events (uid, kind, detail, at, sent_to) VALUES ('plastic-surgeons-belgium/same', 'sent', 'batch a', '2026-09-30T15:00:00Z', 'same@x.example')");
      await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-belgium/none', 'sent', 'batch a', '2026-09-30T15:00:00Z')");
      const q = '?dataset=plastic-surgeons-belgium';
      const res = await handleIntake(new Request(`https://hq.example/api/intake/send-list${q}`, { headers: { Authorization: `Bearer ${'l'.repeat(40)}` } }), { DB: database, INTAKE_TOKEN_LEADS: 'l'.repeat(40) }, new URL(`https://hq.example/api/intake/send-list${q}`));
      const body = await res.json();
      const by = Object.fromEntries(body.leads.map((l) => [l.uid.split('/')[1], l]));
      expect(by.moved).toMatchObject({ first_sent_to: 'home@mail.example', address_changed_since_send: true });
      expect(by.same).toMatchObject({ first_sent_to: 'same@x.example', address_changed_since_send: false });
      expect(by.none).toMatchObject({ first_sent_to: null, address_changed_since_send: false });
      // The first letter's real subject (0035), for a follow-up to repeat; null when never logged.
      expect(by.moved.first_subject).toBe('À l’attention du Dr moved');
      expect(by.none.first_subject).toBeNull();
      expect(body.counts.address_changed_since_send).toBe(1);
    } finally { await dispose(); }
  });
});

describe('migration 0032 fills sent_to from the logs that named the address', () => {
  it('reads « to <address> » from the text, lowercased, and leaves the others empty', async () => {
    const { readFileSync } = await import('node:fs');
    const { database, dispose } = await freshDatabase();
    try {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('d', 'x', 'D', 70, 50, 'x')").run();
      await database.prepare("INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at) VALUES ('d/a', 'd', 'a', 'x', 'A', '', 'x', 'BE', 'a@x.example', 80, 'Hot', '{}', 'x')").run();
      const ev = (detail) => database.prepare("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('d/a', 'sent', ?, '2026-11-01T00:00:00Z')").bind(detail).run();
      await ev('batch b1 · template v3 · to A@Clinic.example · message m1');
      await ev('batch b2 · template v3 · to last@x.example');
      await ev('batch b3 · template v3 · message m3');
      const update = readFileSync(new URL('../migrations/0032_lead_events_sent_to.sql', import.meta.url), 'utf8').split('ALTER TABLE lead_events ADD COLUMN sent_to TEXT;')[1];
      await database.prepare(update.replace(/^--.*$/gm, '').trim()).run();
      const rows = (await database.prepare("SELECT sent_to FROM lead_events WHERE uid = 'd/a' ORDER BY id").all()).results.map((r) => r.sent_to);
      expect(rows).toEqual(['a@clinic.example', 'last@x.example', null]);
    } finally { await dispose(); }
  });
});
