import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LEAD_COLUMNS, STATE_STAGES } from '../src/worker/db.js';

const sql = readFileSync(new URL('../migrations/0002_leads.sql', import.meta.url), 'utf8');

describe('0002_leads.sql', () => {
  it('declares every column the importer writes', () => {
    for (const col of LEAD_COLUMNS) {
      expect(sql, `leads.${col} missing from migration`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('constrains stage to the old app\'s vocabulary, exactly', () => {
    for (const s of STATE_STAGES) expect(sql).toContain(`'${s}'`);
    expect(STATE_STAGES).toEqual(['new', 'looked', 'shortlist', 'sent', 'replied', 'talks', 'won', 'passed']);
  });

  it('keeps facts and state in separate tables', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS leads \(/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS lead_state \(/);
    // state must reference facts, never the other way round
    expect(sql).toMatch(/lead_state[\s\S]*REFERENCES leads\(uid\)/);
  });
});
