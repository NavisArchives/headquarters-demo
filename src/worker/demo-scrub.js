// The demo shows no real identity (audit F19, 14 Nov). Demo screenshots are
// meant to be public, but Andy's name, brands, domains and Gmail live in many
// places on purpose: the outreach letters, the brands' signatures, the SQL
// triggers that write mission links, the login page, the Gmail link. Instead
// of a demo branch in each, the demo Worker rewrites every text response it
// serves (HTML, JS, JSON) to the demo identity from wrangler.demo.jsonc.
//
// Only when DEMO is on. Production never sets DEMO, and then nothing here runs.
// Keys the code compares (brand 'realis', 'archive', a quoted 'andyssarchives') are left alone:
// only names, addresses and domains are rewritten.
import { identityFrom } from '../shared/identity.js';

const TEXT = /^(text\/html|text\/plain|text\/css|application\/json|text\/javascript|application\/javascript)/i;
const JSON_TYPE = /^application\/json/i;
// A JSON string that is exactly one of these is a key the code compares: kept.
const KEYS = new Set(['andyssarchives', 'realis', 'archive', 'realis-studio']);

/** The rewrites, most specific first, built from the demo's own identity. */
export function demoRewrites(env = {}) {
  const who = identityFrom(env);
  const site = who.domain.replace(/^hq\./, '');
  const owner = who.owner;
  const ownerId = owner.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ugc = who.brandUgc;
  const ugcId = ugc.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return [
    [/owner@gmail\.com/gi, `${ownerId}@example.com`],
    [/leads-dashboard\.owner\.workers\.dev/gi, 'example.com'],
    [/owner/gi, ownerId],
    [/huizenga/gi, ownerId],
    [/hq\.example\.com/gi, who.domain],
    [/(onboarding|live)\.example\.com/gi, `$1.${site}`],
    [/realisstudio\.com/gi, site],
    [/andyssarchives\.com/gi, `${ugcId}.example`],
    [/@fieldnote.studio/gi, `@${ugcId}`],
    [/docteuraubin\.be/gi, 'a-clinic.example'],
    [/victoralexislemaire\.com/gi, 'a-studio.example'],
    // a Belgian mobile, written the way the profile writes it (no number is kept in this file)
    [/\+32[ .]?4\d{2}(?:[ .]?\d{2}){3}/g, '+32 400 00 00 00'],
    [/Realis Studio/g, who.brandWeb],
    [/REALIS STUDIO/g, who.brandWeb.toUpperCase()],
    [/\bREALIS\b/g, who.brandWeb.split(' ')[0].toUpperCase()],
    [/\bRealis\b/g, who.brandWeb.split(' ')[0]],
    // 'andyssarchives' on its own in quotes is a key (registry, packages,
    // orders): kept, or the demo would send back a brand the Worker refuses.
    [/(['"]?)\bandyssarchives\b(['"]?)/gi, (m, a, b) => (a && a === b ? m : `${a}${ugc}${b}`)],
    [/Andy Nirmata/g, owner],
    [/\bAndy\b/g, owner],
    [/\bANDY\b/g, owner.toUpperCase()],
    [/\b(Axel )?[Dd]e Lange\b/g, 'a client'],
    [/\bDr Morel\b|\bMorel\b/g, 'a client'],
    [/\bNord Architects\b/g, 'an architecture client'],
    [/\bVictor\b|\bAlexis\b/g, 'a client'],
  ];
}

/** A string with the real identity rewritten to the demo's. */
export function scrubText(text, rewrites) {
  let out = String(text);
  for (const [pattern, to] of rewrites) out = out.replace(pattern, to);
  return out;
}

/** JSON: every string value rewritten on its own (so « \\nAndy » in the raw
 *  text is still a word), keys and exact brand keys kept. */
export function scrubJson(text, rewrites) {
  let data;
  try { data = JSON.parse(text); } catch { return scrubText(text, rewrites); }
  const walk = (v) => {
    if (typeof v === 'string') return KEYS.has(v) ? v : scrubText(v, rewrites);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return JSON.stringify(walk(data));
}

/** The response as the demo serves it: text bodies rewritten, everything else as is. */
export async function scrubForDemo(response, env) {
  if (env?.DEMO !== 'on' || !response || !response.body) return response;
  const type = response.headers.get('Content-Type') || '';
  if (!TEXT.test(type)) return response;
  const raw = await response.text();
  const body = JSON_TYPE.test(type) ? scrubJson(raw, demoRewrites(env)) : scrubText(raw, demoRewrites(env));
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
