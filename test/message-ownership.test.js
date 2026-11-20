import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { logMessage } from '../src/worker/message-log.js';
import { handleIntake } from '../src/worker/intake.js';

async function withLeads(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare(`
      INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
      VALUES ('demo', 'UGC', 'Demo', 70, 50, '2026-11-18')
    `).run();
    await database.prepare(`
      INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
        languages, email, score, tier, payload, imported_at)
      VALUES ('demo/a', 'demo', 'a', 'UGC', 'Demo A', '', 'Brand', 'BE', '["EN"]', 'a@example.com', 80, 'Hot', '{}', '2026-11-18'),
             ('demo/b', 'demo', 'b', 'UGC', 'Demo B', '', 'Brand', 'BE', '["EN"]', 'b@example.com', 80, 'Hot', '{}', '2026-11-18')
    `).run();
    await fn(database);
  } finally {
    await dispose();
  }
}

// Let the other transaction win immediately after the losing caller's stale read.
function interleavedDb(database, winner, input) {
  let interleaved = false;
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      if (/SELECT id, uid FROM lead_events WHERE message_key/.test(sql)) {
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async first() {
                if (!interleaved) {
                  interleaved = true;
                  await logMessage(database, winner, input);
                  return null;
                }
                return bound.first();
              },
            };
          },
        };
      }
      return statement;
    },
    batch: (statements) => database.batch(statements),
  };
}

const input = {
  key: 'demo:one-message', at: '2026-11-18T15:00:00.000Z',
  template: 'closer-3rd', detail: 'Demo closer', to: 'a@example.com',
};

describe('transactional message ownership', () => {
  it('does not change the losing lead when the same new key is claimed by another owner', () => withLeads(async (database) => {
    await database.prepare(`
      INSERT INTO lead_state (uid, stage, notes, follow_up, updated_at)
      VALUES ('demo/b', 'looked', 'Keep this note', '2026-12-01', '2026-11-01T12:00:00Z')
    `).run();
    const before = await database.prepare("SELECT * FROM lead_state WHERE uid = 'demo/b'").first();
    const eventsBefore = (await database.prepare("SELECT * FROM lead_events WHERE uid = 'demo/b'").all()).results;
    let failure;
    try {
      await logMessage(interleavedDb(database, 'demo/a', input), 'demo/b', input);
    } catch (error) {
      failure = error;
    }
    expect(await database.prepare("SELECT * FROM lead_state WHERE uid = 'demo/b'").first()).toEqual(before);
    expect((await database.prepare("SELECT * FROM lead_events WHERE uid = 'demo/b'").all()).results).toEqual(eventsBefore);
    expect(failure).toMatchObject({ status: 422, message: expect.stringContaining('belongs to another lead') });
    const rows = (await database.prepare('SELECT uid FROM lead_events WHERE message_key = ?').bind(input.key).all()).results;
    expect(rows).toEqual([{ uid: 'demo/a' }]);
  }));

  it('returns HTTP 422 when intake files a message owned by another lead', () => withLeads(async (database) => {
    const sender = 'demo@example.com';
    await logMessage(database, 'demo/a', { ...input, key: `gmail:${sender}:demo-message` });
    const token = 'fictional-demo-token-'.repeat(3);
    const request = new Request('https://hq.test/api/intake', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'outreach_sent', lead_uid: 'demo/b', batch: 'demo-batch',
        sender, message_id: 'demo-message', to: 'b@example.com',
      }),
    });
    const response = await handleIntake(request, { DB: database, INTAKE_TOKEN_LEADS: token }, new URL(request.url));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('belongs to another lead');
    expect(await database.prepare("SELECT uid FROM lead_state WHERE uid = 'demo/b'").first()).toBeNull();
  }));

  it('keeps a same-owner closer retry harmless during the same interleaving', () => withLeads(async (database) => {
    const result = await logMessage(interleavedDb(database, 'demo/a', input), 'demo/a', input);
    expect(result.duplicate).toBe(true);
    const state = await database.prepare("SELECT stage, follow_up, notes FROM lead_state WHERE uid = 'demo/a'").first();
    expect(state.stage).toBe('passed');
    expect(state.follow_up).toBeNull();
    expect(state.notes.split('\n')).toHaveLength(1);
    expect((await database.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE uid = 'demo/a' AND kind = 'stage' AND detail = 'passed'").first()).n).toBe(1);
    expect((await database.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE uid = 'demo/a' AND kind = 'sent'").first()).n).toBe(1);
  }));
});
