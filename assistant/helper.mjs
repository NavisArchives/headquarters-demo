// HQ assistant — the local helper (Mac only).
// It alone reads Andy's key (~/.config/headquarters/anthropic-key) and talks to the
// Claude API. The HQ page runs the tools with Andy's session and sends only stripped
// facts here. The key is never in the Worker, a secret, wrangler config, .dev.vars,
// the repo or D1 (Andy's rule of 19 Nov, CLAUDE.md §6 exception).
//
//   node assistant/helper.mjs        (started by the HQ Dock app; dies with it)
//
// Listens on 127.0.0.1 only. Answers only http://localhost:8787 (Origin), with the
// per-launch token from GET /session. Body capped, 200 requests a day, the key never
// returned or logged.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileStore, memoryStore } from './usage-store.mjs';
import { transcribeAudio, canTranscribe, TRANSCRIBE_LIMITS } from './transcribe.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { toolDefinitions, TOOL_NAMES } from '../src/public/assets/assistant-tools.js';

export const HELPER_LIMITS = Object.freeze({ body: 65_536, perDay: 200, messages: 40, maxTokens: 2048 });
export const MODEL = 'claude-haiku-5-5'; // lowest-cost current model (claude-api reference, 19 Nov 2026)
const ORIGIN = 'http://localhost:8787';
const CONFIG = join(homedir(), '.config', 'headquarters');

export const SYSTEM = [
  'You are the assistant inside Headquarters (HQ), Andy\'s agency app. Help him start things fast.',
  'Use only the tools. Answer from tool results only; if nothing matches, say so. Never invent leads, numbers or dates.',
  'Reply in the same language as Andy\'s latest message (English, French or Dutch), whatever language the data is in. Short answers, no praise, no filler.',
  'Your answer is ONE sentence of at most 25 words, numbers first, plain text, no markdown, no lists: the tray below it already shows every item and detail.',
  'Never add caveats about HQ itself (mailbox sync, missing dates, what the data lacks) unless Andy asks.',
  'When a tool returns the data, answer with it directly. Use open_screen only when Andy asks to see a screen.',
  'If Andy asks to send, schedule, approve, export, delete, pass or pay anything, refuse in one plain sentence and call no tool.',
  'Talk to Andy directly as "you", never as "Andy" or "he". Refusals follow the language rule too: an English message gets an English refusal.',
  'Dates: use the date given with Andy\'s first message; a day without a year means the next such date.',
  'Andy often tells rather than asks, and often by dictation without punctuation: "14 is done", "BrightDesk answered", "3, 7 and 9 are done", "4 is interested", "snooze 12 a week", "note on 5: called back". Use act_on_attention with his numbers or names as he said them; it only proposes, and he confirms with the Do it button. Say in one sentence what will change.',
  'Dictation mishears names. If a name matches nothing, call needs_attention and name the closest items as a question; never pick one yourself.',
  'build_draft_batch builds a DRAFT only; tell Andy to review and approve it himself in Outreach → Approvals.',
  'draft_reply only puts text in the composer; Andy sends it himself.',
].join('\n');

const json = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type, x-hq-assistant-token', 'access-control-allow-methods': 'GET, POST' };
const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** The request handler, with everything it depends on passed in (tests use fakes). */
/** Today's date goes with Andy's first message (after the cached system prompt and tools). */
const WORDS = {
  English: 'the a an and to of for my me i you what which who is are do have add delete send pay pass everything about show build tomorrow today',
  French: 'le la les des du une un et est pas que qui quel quelle quelles quels pour sur avec mes mon ma je vous ajoute supprime envoie paie factures demain',
  Dutch: 'het een van voor op zet en niet wat welke wie mijn ik je jij is zijn verwijder stuur betaal facturen morgen vandaag opvolging',
};
/** The language of Andy's own words, by common-word count; null when unclear. Lead names
 *  (« Ferme du Soleil ») are short, so his verbs and articles outweigh them (20 Nov eval). */
export function languageOf(text) {
  const words = String(text).toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿœ']+/).filter(Boolean);
  const score = Object.entries(WORDS).map(([lang, list]) => {
    const set = new Set(list.split(' '));
    return [lang, words.filter((w) => set.has(w)).length];
  }).sort((a, b) => b[1] - a[1]);
  return score[0][1] > score[1][1] ? score[0][0] : null;
}
const latestText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (t) return t;
  }
  return '';
};

export function withToday(messages, day) {
  const tomorrow = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const lang = languageOf(latestText(messages));
  const note = { type: 'text', text: `(Today is ${day}, Lima time; tomorrow is ${tomorrow}.${lang ? ` Andy's latest message is in ${lang}: answer in ${lang}.` : ''})` };
  const [first, ...rest] = messages;
  const content = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
  return [{ ...first, content: [note, ...content] }, ...rest];
}

/* ---------------------------------------------------------------- money
   Andy, 20 Nov: the key must never pass $100 a month. The hard stop is his own
   « Monthly spend limit » in the Claude Console; this is HQ's share under it. */
/** HQ's monthly ceiling in US dollars. A constant: nothing on the page or from the model can raise it. */
export const MONTHLY_CEILING_USD = 20;
/** claude-haiku-5-5 list prices, $ per million tokens; the higher pair when one prompt passes 100K tokens. */
export const PRICE = Object.freeze({ input: 0.10, output: 0.50, longInput: 0.50, longOutput: 2.50, longFrom: 100_000, cacheRead: 0.1, cacheWrite: 1.25 });
/** What one call cost, from the usage the API returned. */
export function callCost(u = {}) {
  const inTok = u.input_tokens || 0; const read = u.cache_read_input_tokens || 0; const write = u.cache_creation_input_tokens || 0;
  const long = inTok + read + write > PRICE.longFrom;
  const rateIn = long ? PRICE.longInput : PRICE.input; const rateOut = long ? PRICE.longOutput : PRICE.output;
  return (inTok * rateIn + read * rateIn * PRICE.cacheRead + write * rateIn * PRICE.cacheWrite + (u.output_tokens || 0) * rateOut) / 1e6;
}
/** The largest prompt one call can carry: the body cap (a token is at least one byte), the fixed
 *  instructions and tool list (bytes, an upper bound on their tokens), and the dated note. */
export const MAX_PROMPT_TOKENS = HELPER_LIMITS.body + Buffer.byteLength(SYSTEM) + Buffer.byteLength(JSON.stringify(toolDefinitions())) + 1_000;
/** The most one call can cost: every prompt token billed as a cache write, every answer token at the full rate. */
export const WORST_CALL_USD = callCost({ cache_creation_input_tokens: MAX_PROMPT_TOKENS, output_tokens: HELPER_LIMITS.maxTokens });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const nextMonthName = (m) => MONTHS[Number(m.slice(5, 7)) % 12];
/** The month the Console counts in (UTC calendar month). */
export const utcMonth = () => new Date().toISOString().slice(0, 7);

const BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
/** A message the helper will pass on: user/assistant, text or tool blocks only, tool results as text. */
export function plainMessage(m) {
  if (!m || !['user', 'assistant'].includes(m.role)) return false;
  if (typeof m.content === 'string') return true;
  return Array.isArray(m.content) && m.content.every((b) => b && BLOCKS.has(b.type)
    && (b.type !== 'tool_result' || typeof b.content === 'string' || b.content === undefined));
}

/** The two answers that mean Andy's own limits were reached: never retried, one plain line. */
export function spendLimitMessage(error) {
  const body = error?.error?.error ?? error?.error ?? {};
  const message = String(body.message ?? error?.message ?? '');
  if (error?.status === 400 && /You have reached your specified API usage limits/i.test(message)) {
    return 'Your Anthropic monthly spend limit (set in the Claude Console) is reached. The assistant is off until it resets; HQ works as usual.';
  }
  if (error?.status === 429 && body.details?.error_code === 'enforced_spend_limit_reached') {
    return 'Your Anthropic account has reached its spend limit. The assistant is off until it resets; HQ works as usual.';
  }
  return null;
}

/** A request that provably never left this Mac: refused or unresolved before any byte was sent. */
export function neverSent(error) {
  const code = error?.cause?.code ?? error?.cause?.cause?.code ?? error?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}
const COUNTER_OFF = 'The assistant\'s spending counter cannot be read or saved on this Mac, so the assistant is off to protect your key. HQ works as usual.';

export function createHelper({ key, token, callModel, usage, store = null, transcribe = null, today, saveUsage = () => {}, month = utcMonth, log = () => {}, origin = ORIGIN }) {
  const counter = store ?? memoryStore(usage ?? { day: '', count: 0 }, saveUsage);
  const allowOrigin = { ...cors, 'access-control-allow-origin': origin };
  const scrub = (s) => String(s).split(key || '\u0000').join('[key]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[key]');
  return async function handle({ method, path, headers = {}, body = '', raw = null }) {
    if (headers.origin !== origin) return json(403, { error: 'Only HQ on this Mac can use the assistant.' });
    if (method === 'OPTIONS') return { status: 204, headers: allowOrigin, body: '' };
    if (method === 'GET' && path === '/session') return json(200, { token, model: MODEL, dictation: Boolean(transcribe) }, allowOrigin);
    // Dictation: sound in, text out, all on this Mac (transcribe.mjs). No key, no model API,
    // no spending counter: nothing here costs money or leaves the Mac.
    if (method === 'POST' && path === '/transcribe') {
      if (!sameToken(headers['x-hq-assistant-token'], token)) return json(403, { error: 'Reload HQ to reconnect the assistant.' }, allowOrigin);
      if (!transcribe) return json(503, { error: 'Dictation is not set up on this Mac (whisper.cpp and its model).' }, allowOrigin);
      const audio = raw ?? Buffer.from(body || '', 'binary');
      if (!audio.length) return json(400, { error: 'No sound was recorded.' }, allowOrigin);
      if (audio.length > TRANSCRIBE_LIMITS.bytes) return json(413, { error: 'That recording is too long: one minute at most.' }, allowOrigin);
      try {
        const text = await transcribe(audio);
        return json(200, { text }, allowOrigin);
      } catch (error) {
        log('assistant: dictation failed:', scrub(error?.message ?? error));
        return json(502, { error: 'The dictation could not be read. Try again, a little closer to the microphone.' }, allowOrigin);
      }
    }
    if (method !== 'POST' || path !== '/assistant') return json(404, { error: 'Not found' }, allowOrigin);
    if (!sameToken(headers['x-hq-assistant-token'], token)) return json(403, { error: 'Reload HQ to reconnect the assistant.' }, allowOrigin);
    // Bytes, not characters: the size proof (one token per byte at most) is in bytes.
    if (Buffer.byteLength(body, 'utf8') > HELPER_LIMITS.body) return json(413, { error: 'That request is too long.' }, allowOrigin);
    if (!key) return json(503, { error: 'The assistant key file is missing on this Mac.' }, allowOrigin);
    let input;
    try { input = JSON.parse(body); } catch { return json(400, { error: 'Bad request.' }, allowOrigin); }
    if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > HELPER_LIMITS.messages) return json(400, { error: 'Bad request.' }, allowOrigin);
    // The page may not bring its own instructions or tools: the helper owns both.
    if ('system' in input || 'tools' in input || 'model' in input) return json(400, { error: 'Bad request.' }, allowOrigin);
    // Text only (no image or document blocks): that is what keeps one prompt at most one token per byte.
    if (!input.messages.every(plainMessage)) return json(400, { error: 'Bad request.' }, allowOrigin);
    const day = today(); const mon = month();
    // Under the lock: read both copies, check, RESERVE the worst this call can cost, save.
    // Refused BEFORE the call whenever that reservation would pass the ceiling.
    let verdict;
    try {
      verdict = counter.transact((u) => {
        if (u.day !== day) { u.day = day; u.count = 0; u.cost = 0; }
        if (u.month !== mon) { u.month = mon; u.month_cost = 0; }
        if ((u.month_cost || 0) + WORST_CALL_USD > MONTHLY_CEILING_USD) return 'ceiling';
        if ((u.count || 0) >= HELPER_LIMITS.perDay) return 'day';
        u.count = (u.count || 0) + 1;
        u.cost = (u.cost || 0) + WORST_CALL_USD;
        u.month_cost = (u.month_cost || 0) + WORST_CALL_USD;
        return 'reserved';
      });
    } catch (error) {
      log('assistant: counter failed:', scrub(error?.message ?? error));
      return json(503, { error: COUNTER_OFF }, allowOrigin);
    }
    if (verdict === 'ceiling') return json(429, { error: `The assistant has used its $${MONTHLY_CEILING_USD} for ${monthName(mon)}. It resumes on 1 ${nextMonthName(mon)}; HQ works as usual.` }, allowOrigin);
    if (verdict === 'day') return json(429, { error: `Today's ${HELPER_LIMITS.perDay} questions are used up. It resets tomorrow.` }, allowOrigin);
    /** Turns the reservation into the real cost (or gives it all back with spent = 0). A failed
     *  settle keeps the reservation: the counter can only ever read high, never low. */
    const settle = (spent) => {
      try {
        return counter.transact((u) => {
          const back = WORST_CALL_USD - spent;
          if (u.month === mon) u.month_cost = Math.max(0, (u.month_cost || 0) - back);
          if (u.day === day) u.cost = Math.max(0, (u.cost || 0) - back);
          return { ...u };
        });
      } catch (error) { log('assistant: settle failed, reservation kept:', scrub(error?.message ?? error)); return null; }
    };
    try {
      const out = await callModel({
        model: MODEL, max_tokens: HELPER_LIMITS.maxTokens,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: toolDefinitions().map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
        messages: withToday(input.messages, day),
        output_config: { effort: 'low' },
      });
      // A call for a tool outside the closed list is dropped, never run.
      const content = (out.content || []).filter((b) => b.type !== 'tool_use' || TOOL_NAMES.includes(b.name));
      // The real cost, even in the impossible case it is above the reservation: the count never reads low.
      // An answer without readable usage keeps the whole reservation: never counted as free.
      const readable = Number.isInteger(out?.usage?.input_tokens) && Number.isInteger(out?.usage?.output_tokens);
      const now = (readable ? settle(callCost(out.usage)) : null) ?? (() => { try { return counter.read(); } catch { return {}; } })();
      return json(200, { content, stop_reason: out.stop_reason, used_today: now.count ?? 0, limit: HELPER_LIMITS.perDay,
        cost_today: Number((now.cost || 0).toFixed(4)), cost_month: Number((now.month_cost || 0).toFixed(4)), ceiling_month: MONTHLY_CEILING_USD }, allowOrigin);
    } catch (error) {
      log('assistant: model call failed:', scrub(error?.status ?? ''), scrub(error?.message ?? error));
      // An HTTP answer (it has a status) is not billed: give the reservation back. A timeout or a
      // dropped connection may have reached Anthropic: keep it, unless the request never left.
      if (Number.isInteger(error?.status) || neverSent(error)) settle(0);
      const limit = spendLimitMessage(error);
      if (limit) return json(429, { error: limit }, allowOrigin);
      return json(502, { error: 'The assistant could not answer just now. HQ works as usual.' }, allowOrigin);
    }
  };
}

function readKey() {
  try { return readFileSync(join(CONFIG, 'anthropic-key'), 'utf8').trim(); } catch { return ''; }
}

async function main() {
  const port = Number(process.env.HQ_ASSISTANT_PORT || 8789);
  const key = readKey();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // 30 s, no retry: a dead network ends in a plain message, and a spend-limit answer
  // (400 or 429) is never sent again.
  const client = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 0 }) : null;
  const handle = createHelper({
    origin: process.env.HQ_ASSISTANT_ORIGIN || ORIGIN, // the demo (8790) for screenshots only
    key, token: randomBytes(32).toString('hex'), store: fileStore(),
    transcribe: canTranscribe() ? (audio) => transcribeAudio(audio) : null,
    today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date()),
    callModel: (req) => client.messages.create(req),
    log: (...a) => console.error(...a),
  });
  const server = createServer((req, res) => {
    // Bytes, not characters (NIRMATA H1): « é » is 2 bytes, a CJK character 3.
    const chunks = []; let bytes = 0;
    const cap = req.url === '/transcribe' ? TRANSCRIBE_LIMITS.bytes : HELPER_LIMITS.body;
    req.on('data', (c) => { bytes += c.length; if (bytes > cap + 1) { req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => {
      if (bytes > cap) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'That request is too long.' })); return; }
      const raw = Buffer.concat(chunks);
      const body = req.url === '/transcribe' ? '' : raw.toString('utf8');
      const out = await handle({ method: req.method, path: req.url, headers: req.headers, body, raw: req.url === '/transcribe' ? raw : null });
      res.writeHead(out.status, out.headers); res.end(out.body);
    });
  });
  server.listen(port, '127.0.0.1', () => console.error(`assistant helper on 127.0.0.1:${port}${key ? '' : ' (no key file: answers 503)'}`));
  // Dies with the Dock app: when the parent goes away, so does the helper.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent || process.ppid === 1) process.exit(0); }, 5000).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
