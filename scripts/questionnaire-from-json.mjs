// Turn a client question file (as the client sessions write it: essentials and
// optional groups, types short / long / single / multi, options as plain text,
// « other », the dictation hint, the thank-you) into the setup HQ stores for a
// prospect (form_config), checked by the same rules HQ applies.
//   node scripts/questionnaire-from-json.mjs <questions.json> > setup.json
// Writes nothing anywhere: it prints the checked setup, or why it is refused.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanConfig } from '../src/public/assets/onboarding-form.js';

const TYPES = { short: 'text', text: 'text', long: 'long', single: 'choice', choice: 'choice', multi: 'chips', chips: 'chips', approve: 'approve' };
const slug = (text) => String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** The setup for one client file. Keys: custom.<the file's key without its prefix>, at most 12 characters. */
export function setupFrom(file) {
  const groups = [['c-essentiel', file.essentialsTitle ?? 'L’essentiel', file.essentials ?? [], false], ['c-en-plus', file.optionalTitle ?? 'En plus', file.optional ?? [], true]];
  const used = new Set();
  const custom = [];
  for (const [section, , questions, optional] of groups) {
    for (const q of questions) {
      const type = TYPES[q.type];
      if (!type) throw new Error(`${q.key}: unknown type ${q.type}`);
      let key = `custom.${String(q.key).replace(/^[a-z]+\./, '').replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
      for (let n = 2; used.has(key); n += 1) key = `${key.slice(0, 18)}${n}`;
      used.add(key);
      const out = { key, section, type, label: q.label };
      if (q.options) {
        const ids = new Set();
        out.options = q.options.map((o) => {
          const label = typeof o === 'string' ? o : o.label;
          let id = (typeof o === 'object' && o.id) || slug(label) || 'option';
          for (let n = 2; ids.has(id); n += 1) id = `${slug(label).slice(0, 36)}-${n}`;
          ids.add(id);
          return { id, label };
        });
      }
      if (q.other) out.other = true;
      if (q.max) out.max = q.max;
      if (q.hint) out.hint = q.hint;
      if (q.content) out.content = q.content;
      if (optional || q.optional) out.optional = true;
      custom.push(out);
    }
  }
  const sections = groups.filter(([, , qs]) => qs.length).map(([id]) => id);
  return cleanConfig({
    sections,
    customSections: groups.filter(([, , qs]) => qs.length).map(([id, title]) => ({ id, title })),
    off: [], media: [], custom,
    clientAnswers: true,
    tu: file.address === 'tu',
    // « Victor-Alexis Lemaire (Alexis) »: the name in brackets is the one he goes by.
    ...(/\(([^)]{1,40})\)/.exec(file.client ?? '')?.[1] ? { firstName: /\(([^)]{1,40})\)/.exec(file.client)[1].trim() } : {}),
    ...(file.welcome ? { welcome: file.welcome } : {}),
    ...(file.thanks ? { thanks: file.thanks } : {}),
    ...(file.optional_intro ? { optionalIntro: file.optional_intro } : {}),
    ...(file.accent ? { accent: file.accent } : {}),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) { console.error('usage: node scripts/questionnaire-from-json.mjs <questions.json>'); process.exit(2); }
  try {
    console.log(JSON.stringify(setupFrom(JSON.parse(readFileSync(resolve(path), 'utf8'))), null, 2));
  } catch (error) {
    console.error(`NOT VALID: ${error.message}`);
    process.exit(1);
  }
}
