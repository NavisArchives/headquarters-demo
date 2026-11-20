import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as pdb from '../src/worker/prospects-db.js';
import { handleProspects } from '../src/worker/api/prospects.js';
import { handleLive, liveModel } from '../src/worker/live.js';

/**
 * Prospects and the onboarding questionnaire (migration 0016), on the engine
 * production uses — workerd's SQLite through Miniflare — so the CHECKs and
 * json_patch are the real ones.
 */
async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare(
      `INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
       VALUES ('surgeons-demo', 'Web design', 'Surgeons', 70, 50, '2026-10-14T00:00:00Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
       VALUES ('surgeons-demo/marchal', 'surgeons-demo', 'marchal', 'Web design', 'Dr Hélène Marchal', 'https://example.com',
               'Surgeon', 'BE', 'helene@example.com', 80, 'Hot', '{}', '2026-10-14T00:00:00Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO missions (title, status, lead_uid, created_at, updated_at, done_at)
       VALUES ('Warm lead: Dr Hélène Marchal — reply and book a call', 'done', 'surgeons-demo/marchal',
               '2026-10-10T00:00:00Z', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')`,
    ).run();
    await fn(database);
  } finally {
    await dispose();
  }
}

const MARCHAL = {
  name: 'Dr Hélène Marchal',
  organisation: 'Clinique des Tilleuls',
  email: 'helene@example.com',
  address: '1 Rue des Tilleuls, 1000 Bruxelles',
  stage: 'meeting',
  next_step: 'Meeting at the clinic',
  next_at: '2026-10-16T18:30',
  lead_uid: 'surgeons-demo/marchal',
  gmail_thread: '1a116b914055d29d',
  notes: 'Internal: price anchor at €7k',
  entities: [
    { name: 'Dr Marchal', kind: 'Personal brand' },
    { name: 'Clinique des Tilleuls', kind: 'Clinic' },
    { name: 'Académie Tilleuls', kind: 'Training' },
  ],
};

const call = (database, method, path, body) => {
  const url = new URL(`http://localhost:8790${path}`);
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return handleProspects(new Request(url, init), { DB: database }, url);
};

describe('a prospect', () => {
  it('is made with its businesses, its next step, the lead it came from and that lead’s missions', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, MARCHAL);
      expect(p).toMatchObject({
        name: 'Dr Hélène Marchal', stage: 'meeting', brand: 'realis', next_at: '2026-10-16T18:30',
        lead_name: 'Dr Hélène Marchal', gmail_thread: '1a116b914055d29d',
      });
      expect(p.entities.map((e) => e.id)).toEqual(['dr-marchal', 'clinique-des-tilleuls', 'academie-tilleuls']);
      expect(p.missions).toHaveLength(1);
      expect(p.missions[0].title).toContain('Marchal');
      expect(p.onboarding).toEqual({});
    });
  });

  it('refuses a stage, a brand, a date or a lead that does not exist', async () => {
    await withDatabase(async (database) => {
      await expect(pdb.createProspect(database, { name: 'x', stage: 'maybe' })).rejects.toThrow('stage must be one of');
      await expect(pdb.createProspect(database, { name: 'x', brand: 'acme' })).rejects.toThrow('brand must be');
      await expect(pdb.createProspect(database, { name: 'x', next_at: '2026-02-30' })).rejects.toThrow('next_at');
      await expect(pdb.createProspect(database, { name: 'x', next_at: '2026-10-16T25:00' })).rejects.toThrow('time that does not exist');
      await expect(pdb.createProspect(database, { name: 'x', lead_uid: 'nobody/none' })).rejects.toThrow('no such lead');
      await expect(pdb.createProspect(database, { name: '  ' })).rejects.toThrow('name is required');
      await expect(pdb.createProspect(database, { name: 'x', email: 'not-an-address' })).rejects.toThrow('email');
      expect(await pdb.listProspects(database)).toEqual([]);
    });
  });

  it('keeps a business’s id when businesses are added or renamed, so its answers stay filed', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, MARCHAL);
      const renamed = p.entities.map((e) => (e.id === 'clinique-des-tilleuls' ? { ...e, name: 'Clinique Les Tilleuls' } : e));
      const next = await pdb.updateProspect(database, p.id, { entities: [...renamed, { name: 'Dr Marchal' }] });
      expect(next.entities.map((e) => e.id)).toEqual(['dr-marchal', 'clinique-des-tilleuls', 'academie-tilleuls', 'dr-marchal-4']);
      expect(next.entities[1].name).toBe('Clinique Les Tilleuls');
    });
  });

  it('moves through the stages and lists the soonest next step first', async () => {
    await withDatabase(async (database) => {
      const a = await pdb.createProspect(database, { name: 'Later', next_at: '2026-10-30' });
      const b = await pdb.createProspect(database, { name: 'Sooner', next_at: '2026-10-16T18:30' });
      await pdb.createProspect(database, { name: 'Undated' });
      expect((await pdb.listProspects(database)).map((p) => p.name)).toEqual(['Sooner', 'Later', 'Undated']);
      expect((await pdb.updateProspect(database, a.id, { stage: 'won' })).stage).toBe('won');
      expect(await pdb.updateProspect(database, 999, { stage: 'won' })).toBeNull();
      expect(await pdb.deleteProspect(database, b.id)).toBe(true);
    });
  });
});

describe('a business’s links', () => {
  it('keeps its web addresses and refuses anything that is not one', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, { name: 'x', entities: [{ name: 'Clinic', links: ['https://clinic.example/', 'https://www.instagram.com/clinic/'] }] });
      expect(p.entities[0].links).toEqual(['https://clinic.example/', 'https://www.instagram.com/clinic/']);
      await expect(pdb.createProspect(database, { name: 'x', entities: [{ name: 'C', links: ['javascript:alert(1)'] }] })).rejects.toThrow('http');
    });
  });
});

describe('the onboarding answers', () => {
  it('are merged key by key: a list replaces the old list, null clears one answer', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, MARCHAL);
      await pdb.saveOnboarding(database, p.id, { 'web.state': 'refresh', 'web.languages': ['fr', 'nl'] });
      await pdb.saveOnboarding(database, p.id, { 'video.per_month': '3-4' });
      await pdb.saveOnboarding(database, p.id, { 'web.languages': ['fr'], 'web.state': null });
      const { answers } = await pdb.getOnboarding(database, p.id);
      expect(answers).toEqual({ 'web.languages': ['fr'], 'video.per_month': '3-4' });
    });
  });

  it('refuses keys that are not questions, values that cannot be stored, and an empty save', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, MARCHAL);
      await expect(pdb.saveOnboarding(database, p.id, { 'Web State!': 'x' })).rejects.toThrow('not a question');
      await expect(pdb.saveOnboarding(database, p.id, { notes: { nested: true } })).rejects.toThrow('cannot be saved');
      await expect(pdb.saveOnboarding(database, p.id, { notes: 'x'.repeat(4001) })).rejects.toThrow('too long');
      await expect(pdb.saveOnboarding(database, p.id, { list: [1, 2] })).rejects.toThrow('list of choices');
      await expect(pdb.saveOnboarding(database, p.id, {})).rejects.toThrow('nothing to save');
      expect(await pdb.saveOnboarding(database, 999, { notes: 'x' })).toBeNull();
    });
  });

  it('stop growing past 64 KB', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, MARCHAL);
      const big = {};
      for (let i = 0; i < 17; i += 1) big[`notes.part${i}`] = 'x'.repeat(4000);
      await expect(pdb.saveOnboarding(database, p.id, big)).rejects.toThrow('questionnaire is full');
    });
  });
});

describe('/api/prospects', () => {
  it('makes, reads, changes and deletes a prospect', async () => {
    await withDatabase(async (database) => {
      const made = await call(database, 'POST', '/api/prospects', MARCHAL);
      expect(made.status).toBe(201);
      const { prospect } = await made.json();
      const changed = await (await call(database, 'PATCH', `/api/prospects/${prospect.id}`, { stage: 'onboarding' })).json();
      expect(changed.prospect.stage).toBe('onboarding');
      const list = await (await call(database, 'GET', '/api/prospects')).json();
      expect(list.prospects.map((p) => p.name)).toEqual(['Dr Hélène Marchal']);
      expect((await call(database, 'DELETE', `/api/prospects/${prospect.id}`)).status).toBe(204);
      expect((await call(database, 'GET', `/api/prospects/${prospect.id}`)).status).toBe(404);
    });
  });

  it('gives the questionnaire screen the questionnaire and nothing internal', async () => {
    await withDatabase(async (database) => {
      const { prospect } = await (await call(database, 'POST', '/api/prospects', MARCHAL)).json();
      await call(database, 'PATCH', `/api/prospects/${prospect.id}/onboarding`, { answers: { 'team.size': '6-10' } });
      const res = await call(database, 'GET', `/api/prospects/${prospect.id}/onboarding`);
      const body = await res.json();
      expect(Object.keys(body.onboarding).sort()).toEqual(['answers', 'brand', 'config', 'entities', 'id', 'name', 'organisation', 'template', 'updated_at']);
      const text = JSON.stringify(body);
      for (const secret of ['helene@example.com', 'price anchor', 'meeting', 'surgeons-demo/marchal', '1a116b914055d29d', 'Rue des Tilleuls']) {
        expect(text).not.toContain(secret);
      }
      expect(body.onboarding.answers).toEqual({ 'team.size': '6-10' });
    });
  });

  it('answers a bad request with the field, and leaves other paths alone', async () => {
    await withDatabase(async (database) => {
      const bad = await call(database, 'POST', '/api/prospects', { name: 'x', stage: 'maybe' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ field: 'stage' });
      const badAnswers = await call(database, 'PATCH', '/api/prospects/1/onboarding', { answers: 'nope' });
      expect(badAnswers.status).toBe(400);
      expect((await call(database, 'GET', '/api/prospects/abc')).status).toBe(404);
      expect(await call(database, 'GET', '/api/todos')).toBeNull();
    });
  });
});

const live = (database, path, method = 'GET') => {
  const url = new URL(`https://hq.example.com${path}`);
  return handleLive(new Request(url, { method }), { DB: database }, url);
};

describe('the light questionnaire and the live mirror (migration 0017)', () => {
  it('takes the light template and refuses one that does not exist', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, { ...MARCHAL, template: 'light' });
      expect(made.template).toBe('light');
      expect((await pdb.createProspect(database, { name: 'Dr X' })).template).toBe('light');
      await expect(pdb.updateProspect(database, made.id, { template: 'short' })).rejects.toThrow(/template/);
      expect((await pdb.getOnboarding(database, made.id)).template).toBe('light');
    });
  });

  it('gives one public link per prospect, the same one twice, for 7 days, and stops it on revoke', async () => {
    await withDatabase(async (database) => {
      const { prospect } = await (await call(database, 'POST', '/api/prospects', { ...MARCHAL, template: 'light' })).json();
      const first = await (await call(database, 'POST', `/api/prospects/${prospect.id}/live`)).json();
      expect(first.live.url).toMatch(/^https:\/\/onboarding\.example\.com\/marchal-[a-z2-7]{6}$/);
      const again = await (await call(database, 'POST', `/api/prospects/${prospect.id}/live`)).json();
      expect(again.live.url).toBe(first.live.url);
      const days = (Date.parse(first.live.expires_at) - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThanOrEqual(7);

      const path = `/live${new URL(first.live.url).pathname}`;
      const page = await live(database, path);
      expect(page.status).toBe(200);
      expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
      const html = await page.text();
      expect(html).toContain('Dr Hélène Marchal');
      expect(html).toContain('Quels sont vos besoins\u00a0?');
      expect(html).not.toMatch(/€|Budget|à chiffrer/);

      await call(database, 'PATCH', `/api/prospects/${prospect.id}/onboarding`, { answers: { 'light.langs': ['fr', 'nl', 'en'], 'light.start.date': 'Janvier' } });
      const model = await (await live(database, `${path}.json`)).json();
      expect(model.html).toContain('<span class="opt on">Néerlandais</span>');
      expect(model.html).toContain('Janvier');
      expect(model.updated_at).toBeTruthy();

      // Nothing internal, ever: notes, contact details, stage, lead, thread.
      const everything = html + JSON.stringify(model);
      for (const secret of ['helene@example.com', 'price anchor', 'Meeting at the clinic', 'surgeons-demo/marchal', '1a116b914055d29d', 'Rue des Tilleuls']) {
        expect(everything).not.toContain(secret);
      }

      expect((await call(database, 'DELETE', `/api/prospects/${prospect.id}/live`)).status).toBe(204);
      expect((await live(database, path)).status).toBe(404);
      expect((await live(database, `${path}.json`)).status).toBe(404);
      const fresh = await (await call(database, 'POST', `/api/prospects/${prospect.id}/live`)).json();
      expect(fresh.live.url).not.toBe(first.live.url);
    });
  });

  it('answers 404 for an expired link, a wrong token, a malformed path or a write', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      const old = await pdb.ensureLiveLink(database, made.id, Date.now() - 8 * 86400000);
      expect((await live(database, `/live/${old.token}`)).status).toBe(404);
      const now = await pdb.ensureLiveLink(database, made.id);
      expect(now.token).not.toBe(old.token);
      expect((await live(database, `/live/${now.token}`)).status).toBe(200);
      expect((await live(database, `/live/${'0'.repeat(64)}`)).status).toBe(404);
      expect((await live(database, '/live/abc')).status).toBe(404);
      expect((await live(database, `/live/${now.token}`, 'POST')).status).toBe(404);
      expect(await live(database, '/pipeline')).toBeNull();
    });
  });

  it('escapes what a client or Andy typed', () => {
    const model = liveModel({ name: '<script>x</script>', brand: 'realis', template: 'light', entities: [], answers: { 'light.timing': '"><img src=x>' } });
    expect(model.brand).toBe('REALIS STUDIO');
    return import('../src/worker/live.js').then(({ livePage }) => {
      const html = livePage(model, 'n');
      expect(html).not.toContain('<script>x');
      expect(html).not.toContain('<img src=x>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

const post = (database, path, body, ip = '203.0.113.7') => {
  const url = new URL(`https://hq.example.com${path}`);
  return handleLive(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip } }), { DB: database }, url);
};

describe('F31: tailored questionnaires, templates, the client typing, short links (migration 0018)', () => {
  it('tailors one prospect: sections, hidden questions, own questions, videos; refuses junk', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, { name: 'Dr Y' });
      expect(made.config.sections[0]).toBe('format');
      const config = { ...made.config, off: ['light.langs'], custom: [{ key: 'custom.a1', section: 'pages', label: 'Une page sur la recherche ?' }],
        media: [{ url: 'https://cdn.example.com/reel.mp4', poster: 'https://cdn.example.com/reel.jpg', title: 'Interview' }] };
      const saved = await pdb.updateProspect(database, made.id, { form_config: config });
      expect(saved.config.custom[0].label).toBe('Une page sur la recherche ?');
      const form = await pdb.getOnboarding(database, made.id);
      expect(form.config.off).toEqual(['light.langs']);
      await expect(pdb.updateProspect(database, made.id, { form_config: { sections: ['nope'] } })).rejects.toThrow(/unknown section/);
      await expect(pdb.updateProspect(database, made.id, { form_config: { ...config, media: [{ url: 'javascript:alert(1)' }] } })).rejects.toThrow(/https/);
      // Back to the built-in setup.
      expect((await pdb.updateProspect(database, made.id, { form_config: null })).config.sections).toContain('domain');
    });
  });

  it('lists the two built-in templates and saves Andy’s under a name, replacing the same name', async () => {
    await withDatabase(async (database) => {
      const list = await (await call(database, 'GET', '/api/onboarding-templates')).json();
      expect(list.templates.map((x) => x.name)).toEqual(['Base (site)', 'Complet (Dr Renard)']);
      const config = { sections: ['format', 'domain'], off: [], custom: [], media: [] };
      expect((await call(database, 'POST', '/api/onboarding-templates', { name: 'Court', config })).status).toBe(201);
      await call(database, 'POST', '/api/onboarding-templates', { name: 'Court', config: { ...config, sections: ['format'] } });
      const again = await (await call(database, 'GET', '/api/onboarding-templates')).json();
      expect(again.templates.filter((x) => x.name === 'Court').map((x) => x.config.sections)).toEqual([['format']]);
      expect((await call(database, 'POST', '/api/onboarding-templates', { name: 'Base (site)', config })).status).toBe(400);
    });
  });

  it('lets the client type an open answer, and nothing else', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, { ...MARCHAL, template: 'light' });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      expect(token).toMatch(/^marchal-[a-z2-7]{6}$/);
      await pdb.saveOnboarding(database, made.id, { 'light.domain': 'yes' });
      const ok = await post(database, `/live/${token}/answer`, { key: 'light.domain.name', value: 'drmarchal.be' });
      expect(ok.status).toBe(200);
      expect((await pdb.getOnboarding(database, made.id)).answers['light.domain.name']).toBe('drmarchal.be');
      // A choice stays Andy's; a hidden question is not open; too long is refused.
      expect((await post(database, `/live/${token}/answer`, { key: 'light.langs', value: 'fr' })).status).toBe(400);
      expect((await post(database, `/live/${token}/answer`, { key: 'light.practice.name', value: 'X' })).status).toBe(400);
      expect((await post(database, `/live/${token}/answer`, { key: 'light.domain.name', value: 'x'.repeat(301) })).status).toBe(400);
      expect((await post(database, `/live/${token}/answer`, { key: 'light.domain.name', value: { a: 1 } })).status).toBe(400);
      // At most 60 a minute (a phone questionnaire saves on every tap).
      // One fixed clock, so the 61 writes never straddle a minute's turn on a slow machine.
      const at = Date.now();
      let refused = null;
      for (let i = 0; i < 61 && !refused; i += 1) {
        try { await pdb.clientWrite(database, token, 'light.start.date', `mars ${i}`, at); } catch (error) { refused = { i, error }; }
      }
      expect(refused?.error).toBeInstanceOf(pdb.TooManyWrites);
      // The 61st write in a minute at the latest (one written earlier in this test may share the minute).
      expect(refused.i).toBeGreaterThanOrEqual(59);
      expect(refused.i).toBeLessThanOrEqual(60);
      // A revoked link writes nothing.
      await pdb.revokeLiveLink(database, made.id);
      expect((await post(database, `/live/${token}/answer`, { key: 'light.start.date', value: 'avril' })).status).toBe(404);
    });
  }, 30000);

  it('keeps the first 64-character links working until they expire', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      const old = 'a'.repeat(64);
      await database.prepare('UPDATE prospects SET live_token = ?, live_expires_at = ? WHERE id = ?')
        .bind(old, new Date(Date.now() + 86400000).toISOString(), made.id).run();
      expect((await live(database, `/live/${old}`)).status).toBe(200);
      // Copying again gives the same one while it works.
      expect((await pdb.ensureLiveLink(database, made.id)).token).toBe(old);
    });
  });

  it('stops answering an address after 20 wrong links in a minute', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const get = (path) => {
        const url = new URL(`https://hq.example.com${path}`);
        return handleLive(new Request(url, { headers: { 'CF-Connecting-IP': '198.51.100.9' } }), { DB: database }, url);
      };
      for (let i = 0; i < 20; i += 1) expect((await get(`/live/marchal-aaaa${String.fromCharCode(97 + (i % 26))}${i % 2 ? 'b' : 'c'}`)).status).toBe(404);
      expect((await get(`/live/${token}`)).status).toBe(429);
      // Another address is not affected.
      expect((await live(database, `/live/${token}`)).status).toBe(200);
    });
  }, 30000); // 22 requests, each a read and a synced write: the test's own work, like the 61 writes above.
});

const { default: worker } = await import('../src/worker/index.js');

describe('onboarding.example.com: a Realis client’s page on Realis Studio’s own domain', () => {
  const at = (database, href, init = {}) => worker.fetch(new Request(href, init), { DB: database, ASSETS: { fetch: () => new Response('asset') } }, {});

  it('serves the live page, its updates and the client’s answers, and nothing else', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, { ...MARCHAL, template: 'light' });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const page = await at(database, `https://onboarding.example.com/${token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<title>REALIS STUDIO · Questionnaire de démarrage</title>');
      expect(html).not.toMatch(/andyssarchives|Headquarters|\bHQ\b/i);
      expect((await at(database, `https://onboarding.example.com/live/${token}`)).status).toBe(200);
      expect((await at(database, `https://onboarding.example.com/${token}.json`)).status).toBe(200);
      await pdb.saveOnboarding(database, made.id, { 'light.domain': 'yes' });
      const wrote = await at(database, `https://onboarding.example.com/${token}/answer`, {
        method: 'POST', body: JSON.stringify({ key: 'light.domain.name', value: 'drmarchal.be' }), headers: { 'Content-Type': 'application/json' },
      });
      expect(wrote.status).toBe(200);
      // Never HQ on this host: not the app, not the login, not the API, not the pixel.
      for (const path of ['/', '/login', '/pipeline', '/api/prospects', '/px/abc.gif', '/cal/abc.ics', '/favicon.ico', '/assets/app.js']) {
        const res = await at(database, `https://onboarding.example.com${path}`);
        expect(res.status, path).toBe(404);
        expect(await res.text()).not.toMatch(/andyssarchives|Headquarters|Sign in/i);
      }
      // The retired live. host answers nothing, never HQ.
      expect((await at(database, `https://live.example.com/${token}`)).status).toBe(404);
      expect((await at(database, 'https://live.example.com/login')).status).toBe(404);
      // The same token still works on the HQ host until it expires (Fontaine's first link).
      expect((await at(database, `https://hq.example.com/live/${token}`)).status).toBe(200);
      // A revoked link: a plain French page, no brand.
      await pdb.revokeLiveLink(database, made.id);
      const gone = await at(database, `https://onboarding.example.com/${token}`);
      expect(gone.status).toBe(404);
      expect(await gone.text()).toContain('Ce lien n’existe pas ou n’est plus actif.');
    });
  });

  it('gives an andyssarchives prospect the HQ host, a Realis one Realis Studio’s', async () => {
    const { liveUrl } = await import('../src/worker/live.js');
    expect(liveUrl('realis', 'fontaine-k7q2mx')).toBe('https://onboarding.example.com/fontaine-k7q2mx');
    expect(liveUrl('archive', 'lumen-k7q2mx')).toBe('https://hq.example.com/live/lumen-k7q2mx');
    expect(liveUrl('realis', 'x-aaaaaa', { demoOrigin: 'http://localhost:8790' })).toBe('http://localhost:8790/live/x-aaaaaa');
  });
});

/* ---- the phone questionnaire (22 Oct) ---- */

const PHONE = {
  sections: ['c-parcours', 'c-projets'],
  customSections: [{ id: 'c-parcours', title: 'Ton parcours' }, { id: 'c-projets', title: 'Tes projets' }],
  off: [], media: [], clientAnswers: true, tu: true,
  custom: [
    { key: 'custom.p1', section: 'c-parcours', type: 'text', label: 'Année de fondation ?' },
    { key: 'custom.p2', section: 'c-parcours', type: 'chips', label: 'Tes missions ?', max: 2, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] },
    { key: 'custom.p3', section: 'c-projets', type: 'choice', label: 'Ton client type ?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    { key: 'custom.p4', section: 'c-projets', type: 'long', label: 'Des prix ?', optional: true },
  ],
};

describe('the phone questionnaire: question types, the client answering on his own, received times', () => {
  it('takes own sections and typed own questions, and refuses broken ones', async () => {
    const { cleanConfig, resolveSections } = await import('../src/public/assets/onboarding-form.js');
    const clean = cleanConfig(PHONE);
    expect(clean).toMatchObject({ clientAnswers: true, tu: true, customSections: PHONE.customSections });
    expect(resolveSections(clean).map((s) => [s.id, s.fields.map((f) => f.type)])).toEqual([['c-parcours', ['text', 'chips']], ['c-projets', ['choice', 'long']]]);
    expect(() => cleanConfig({ ...PHONE, custom: [{ ...PHONE.custom[1], max: 9 }] })).toThrow(/max/);
    expect(() => cleanConfig({ ...PHONE, custom: [{ ...PHONE.custom[2], options: [{ id: 'x', label: 'X' }] }] })).toThrow(/2 to 12/);
    expect(() => cleanConfig({ ...PHONE, custom: [{ ...PHONE.custom[0], section: 'c-nope' }] })).toThrow(/section/);
    expect(() => cleanConfig({ ...PHONE, custom: [PHONE.custom[0], PHONE.custom[0]] })).toThrow(/share the key/);
    // An own question without a type is long text, as before.
    expect(cleanConfig({ ...PHONE, custom: [{ key: 'custom.z', section: 'c-projets', label: 'Libre' }] }).custom[0].type).toBe('long');
  });

  it('lets the client answer choices only when his setup says he answers on his own, within the max', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      await pdb.updateProspect(database, made.id, { form_config: PHONE });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const ok = (key, value) => post(database, `/live/${token}/answer`, { key, value });
      expect((await ok('custom.p2', ['a', 'b'])).status).toBe(200);
      expect((await ok('custom.p2', ['a', 'b', 'c'])).status).toBe(400); // over the max
      expect((await ok('custom.p2', ['zz'])).status).toBe(400); // not an option
      expect((await ok('custom.p3', 'y')).status).toBe(200);
      expect((await ok('custom.p3', ['y'])).status).toBe(400); // one choice is a string
      expect((await ok('custom.p1', '2011')).status).toBe(200);
      const form = await pdb.getProspect(database, made.id);
      expect(form.onboarding).toMatchObject({ 'custom.p2': ['a', 'b'], 'custom.p3': 'y', 'custom.p1': '2011' });
      // When it came in, and from whom.
      expect(form.onboarding_meta['custom.p3']).toMatchObject({ by: 'client' });
      expect(Date.parse(form.onboarding_meta['custom.p3'].at)).toBeGreaterThan(Date.now() - 60000);
      // Andy's own answers are marked as his; a cleared answer clears its time.
      await pdb.saveOnboarding(database, made.id, { 'custom.p4': 'Prix X' });
      await ok('custom.p1', null);
      const after = await pdb.getProspect(database, made.id);
      expect(after.onboarding_meta['custom.p4'].by).toBe('andy');
      expect(after.onboarding_meta['custom.p1']).toBeUndefined();
      // Without « the client answers on his phone », choices stay Andy's.
      await pdb.updateProspect(database, made.id, { form_config: { ...PHONE, clientAnswers: false } });
      expect((await ok('custom.p3', 'x')).status).toBe(400);
    });
  });

  it('serves one question per screen, essentials first, with nothing internal', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      await pdb.updateProspect(database, made.id, { form_config: PHONE });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const res = await live(database, `/live/${token}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="flow-data"');
      const data = JSON.parse(/<script type="application\/json" id="flow-data">([\s\S]*?)<\/script>/.exec(html)[1]);
      expect(data.questions.map((q) => q.key)).toEqual(['custom.p1', 'custom.p2', 'custom.p3', 'custom.p4']);
      expect(data.questions.at(-1).optional).toBe(true);
      expect(data.tu).toBe(true);
      for (const secret of ['helene@example.com', 'price anchor', 'Meeting at the clinic', 'surgeons-demo/marchal', '1a116b914055d29d', '€']) {
        expect(html).not.toContain(secret);
      }
    });
  });

  it('cannot be broken out of by what someone typed', async () => {
    const { flowModel, flowPage } = await import('../src/worker/flow.js');
    const model = flowModel({ name: '</script><script>alert(1)</script>', brand: 'realis', config: PHONE, answers: { 'custom.p1': '</script><img src=x>' } });
    const html = flowPage(model, 'n');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('approval mode and the client accent (24 Oct)', () => {
  const APPROVAL = {
    sections: ['c-textes'], customSections: [{ id: 'c-textes', title: 'Textes' }], off: [], media: [],
    clientAnswers: true, accent: '#A7DBBB',
    custom: [{ key: 'custom.t1', section: 'c-textes', type: 'approve', label: 'Le titre', content: 'Restaurer, transformer, transmettre.' }],
  };

  it('needs the content to approve, and a real colour', async () => {
    const { cleanConfig } = await import('../src/public/assets/onboarding-form.js');
    expect(cleanConfig(APPROVAL)).toMatchObject({ accent: '#A7DBBB', custom: [{ type: 'approve', content: 'Restaurer, transformer, transmettre.' }] });
    expect(() => cleanConfig({ ...APPROVAL, custom: [{ ...APPROVAL.custom[0], content: '' }] })).toThrow(/content/);
    expect(() => cleanConfig({ ...APPROVAL, accent: 'red; background:url(x)' })).toThrow(/accent/);
  });

  it('lets the client approve or ask for a change with a note, and shows Andy which', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      await pdb.updateProspect(database, made.id, { form_config: APPROVAL });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const ok = (key, value) => post(database, `/live/${token}/answer`, { key, value });
      expect((await ok('custom.t1', 'maybe')).status).toBe(400);
      expect((await ok('custom.t1', 'changed')).status).toBe(200);
      expect((await ok('custom.t1.note', 'Plutôt « rénover »')).status).toBe(200);
      expect((await ok('custom.zz.note', 'x')).status).toBe(400); // a note only belongs to an approval
      const p = await pdb.getProspect(database, made.id);
      const { summarise, resolveSections } = await import('../src/public/assets/onboarding-form.js');
      const lines = summarise(p.onboarding, [], 'fr', resolveSections(p.config)).flatMap((g) => g.lines);
      expect(lines[0].value).toBe('À modifier : Plutôt « rénover »');
      expect(p.onboarding_meta['custom.t1.note'].by).toBe('client');
      const page = await (await live(database, `/live/${token}`)).text();
      expect(page).toContain(':root { --accent: #A7DBBB; }');
      expect(page).toContain('Restaurer, transformer, transmettre.');
    });
  });
});

describe('« Autre », the client’s own closing lines, and the question-file converter (24 Oct)', () => {
  const WITH_OTHER = {
    sections: ['c-a'], customSections: [{ id: 'c-a', title: 'A' }], off: [], media: [], clientAnswers: true,
    thanks: 'Merci Alexis !', optionalIntro: 'Encore quelques-unes.',
    custom: [{ key: 'custom.o1', section: 'c-a', type: 'chips', label: 'Matériaux ?', max: 2, other: true, options: [{ id: 'chaux', label: 'Chaux' }, { id: 'chanvre', label: 'Chanvre' }] }],
  };

  it('adds « Autre » and lets the client type what, and reads it back for Andy', async () => {
    await withDatabase(async (database) => {
      const made = await pdb.createProspect(database, MARCHAL);
      await pdb.updateProspect(database, made.id, { form_config: WITH_OTHER });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      const ok = (key, value) => post(database, `/live/${token}/answer`, { key, value });
      expect((await ok('custom.o1', ['chaux', 'autre'])).status).toBe(200);
      expect((await ok('custom.o1.other', 'Terre crue')).status).toBe(200);
      const p = await pdb.getProspect(database, made.id);
      const { summarise, resolveSections } = await import('../src/public/assets/onboarding-form.js');
      expect(summarise(p.onboarding, [], 'fr', resolveSections(p.config))[0].lines[0].value).toBe('Chaux, Autre : Terre crue');
      const html = await (await live(database, `/live/${token}`)).text();
      expect(html).toContain('"thanks":"Merci Alexis !"');
      expect(html).toContain('"optionalIntro":"Encore quelques-unes."');
    });
  });

  it('turns a client question file into a checked setup', async () => {
    const { setupFrom } = await import('../scripts/questionnaire-from-json.mjs');
    const setup = setupFrom({
      address: 'tu', thanks: 'Merci !', optional_intro: 'Encore ?',
      essentials: [{ key: 'rav.founded', type: 'short', label: 'Année ?' }, { key: 'rav.expert', type: 'multi', max: 2, other: true, label: 'Expert ?', options: ['Expertises judiciaires', 'Conseil PEB'] }],
      optional: [{ key: 'rav.email', type: 'single', label: 'E-mail ?', options: ['a@x.be', 'b@x.be'] }],
    });
    expect(setup).toMatchObject({ clientAnswers: true, tu: true, thanks: 'Merci !', optionalIntro: 'Encore ?', sections: ['c-essentiel', 'c-en-plus'] });
    expect(setup.custom.map((q) => [q.key, q.type, Boolean(q.optional)])).toEqual([['custom.founded', 'text', false], ['custom.expert', 'chips', false], ['custom.email', 'choice', true]]);
    expect(setup.custom[1].options.map((o) => o.id)).toEqual(['expertises-judiciaires', 'conseil-peb']);
    expect(() => setupFrom({ essentials: [{ key: 'x.y', type: 'slider', label: 'Q' }] })).toThrow(/unknown type/);
  });
});

describe('a client’s onboarding (migration 0021)', () => {
  it('moves an onboarding to a client: off the pipeline, onto the project, the link and answers unchanged', async () => {
    await withDatabase(async (database) => {
      await database.prepare(`INSERT INTO clients (id, name, slug, country, created_at) VALUES (7, 'Nord Architects SRL', 'victor-lemaire', 'BE', '2026-10-22T00:00:00Z')`).run();
      const made = await pdb.createProspect(database, { name: 'Victor-Alexis Lemaire', stage: 'won' });
      const { token } = await pdb.ensureLiveLink(database, made.id);
      await pdb.saveOnboarding(database, made.id, { 'light.domain': 'yes' }, { by: 'client' });
      const deals = async () => (await (await call(database, 'GET', '/api/prospects?for=pipeline')).json()).prospects.map((p) => p.id);
      expect(await deals()).toContain(made.id);

      await expect(pdb.updateProspect(database, made.id, { client_id: 999 })).rejects.toThrow(/no such client/);
      const moved = await pdb.updateProspect(database, made.id, { client_id: 7 });
      expect(moved).toMatchObject({ client_id: 7, client_name: 'Nord Architects SRL', client_slug: 'victor-lemaire' });
      expect(await deals()).not.toContain(made.id);
      const onProject = (await (await call(database, 'GET', '/api/prospects?slug=victor-lemaire')).json()).prospects;
      expect(onProject.map((p) => p.id)).toEqual([made.id]);
      // « N answered · N approved » on the project page (notes and « Autre » texts are not answers of their own).
      expect(onProject[0]).toMatchObject({ onboarding_answers: 1, onboarding_approved: 0 });
      // The link already sent still opens, and the answers are still there.
      expect((await live(database, `/live/${token}`)).status).toBe(200);
      expect((await pdb.getProspect(database, made.id)).onboarding).toEqual({ 'light.domain': 'yes' });
      // Unlinking puts it back in the pipeline.
      await pdb.updateProspect(database, made.id, { client_id: null });
      expect(await deals()).toContain(made.id);
    });
  });
});

describe('a deal moves its lead, one way (A3)', () => {
  const stageOf = async (database) => (await database.prepare("SELECT COALESCE(s.stage, 'new') AS stage FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid WHERE l.uid = 'surgeons-demo/marchal'").first()).stage;

  it('a meeting puts the lead in talks; won wins it and closes its warm mission', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, { name: 'Dr Marchal', stage: 'lead', lead_uid: 'surgeons-demo/marchal' });
      expect(await stageOf(database)).toBe('new');
      await pdb.updateProspect(database, p.id, { stage: 'meeting' });
      expect(await stageOf(database)).toBe('talks');
      const open = await database.prepare("SELECT COUNT(*) AS n FROM missions WHERE lead_uid = 'surgeons-demo/marchal' AND status <> 'done'").first();
      expect(open.n).toBe(1);
      await pdb.updateProspect(database, p.id, { stage: 'won' });
      expect(await stageOf(database)).toBe('won');
      const still = await database.prepare("SELECT COUNT(*) AS n FROM missions WHERE lead_uid = 'surgeons-demo/marchal' AND status <> 'done'").first();
      expect(still.n).toBe(0);
    });
  });

  it('lost passes the lead, but a won lead is never passed, and nothing moves back', async () => {
    await withDatabase(async (database) => {
      const p = await pdb.createProspect(database, { name: 'Dr Marchal', stage: 'proposal', lead_uid: 'surgeons-demo/marchal' });
      expect(await stageOf(database)).toBe('talks');
      await pdb.updateProspect(database, p.id, { stage: 'lead' });
      expect(await stageOf(database)).toBe('talks');
      await pdb.updateProspect(database, p.id, { stage: 'lost' });
      expect(await stageOf(database)).toBe('passed');

      // They came back and signed: a won deal wins even a passed lead, and it stays won.
      const q = await pdb.createProspect(database, { name: 'Again', stage: 'won', lead_uid: 'surgeons-demo/marchal' });
      expect(await stageOf(database)).toBe('won');
      await pdb.updateProspect(database, p.id, { stage: 'lost' });
      await pdb.updateProspect(database, q.id, { stage: 'meeting' });
      expect(await stageOf(database)).toBe('won');
    });
  });

  it('a deal with no lead changes no lead', async () => {
    await withDatabase(async (database) => {
      await pdb.createProspect(database, { name: 'Walk-in', stage: 'won' });
      expect(await stageOf(database)).toBe('new');
    });
  });
});
