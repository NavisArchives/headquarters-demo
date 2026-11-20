// The morning briefing over the Overview (Andy, 22 Oct): the Overview blurred
// behind, « Good morning, Andy » in the Realis neon (it lights up once, a
// flicker, then holds), then the findings: their names stacked on the left,
// one card at a time on the right, Next / Previous (buttons, arrow keys, a
// swipe), « 2 / 5 », Esc or ✕ back to the Overview.
//
// Opens by itself on the first HQ visit of the day (a date in localStorage,
// per browser) and again from the « Briefing » button. The cards come from
// GET /api/briefing (briefing.js on the Worker): leads and Travel live, the rest
// pushed each morning.

import { el } from './dom.js';
import { apiFetch } from './api.js';

const SEEN = 'hq.briefing.seen';
const TYPE_LABEL = { today: 'Today', pipeline: 'Pipeline', leads: 'Leads', travel: 'Travel list', emails: 'Important emails', commits: 'Changes', reports: 'Findings', note: 'Note' };

export function ensureBriefingCss() {
  if (typeof document === 'undefined' || document.getElementById('briefing-css')) return;
  const link = document.createElement('link');
  link.id = 'briefing-css';
  link.rel = 'stylesheet';
  link.href = '/assets/briefing.css';
  document.head.appendChild(link);
}

/** Today on this computer, YYYY-MM-DD. */
export const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Whether the briefing should open by itself: the first visit of the day. */
export function firstVisitToday(storage = globalThis.localStorage, now = new Date()) {
  try { return storage?.getItem(SEEN) !== today(now); } catch { return false; }
}
function markSeen(storage = globalThis.localStorage) {
  try { storage?.setItem(SEEN, today()); } catch { /* private window: it opens again tomorrow anyway */ }
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The neon words: each letter a tube that lights up on its own, once. */
function neon(text, cls) {
  const line = el('span', `brf-neon__line ${cls ?? ''}`.trim());
  line.setAttribute('aria-hidden', 'true');
  [...text].forEach((ch, i) => {
    const span = el('span', ch === ' ' ? 'brf-neon__gap' : 'brf-neon__ch', ch === ' ' ? ' ' : ch);
    // A few letters catch a beat late, like real tubes warming up.
    span.style.setProperty('--d', `${(i * 47) % 420 + (i % 5 === 3 ? 260 : 0)}ms`);
    line.appendChild(span);
  });
  return line;
}

function item(entry, go) {
  const row = el('li', 'brf-item');
  const text = el('div', 'brf-item__text');
  const label = entry.href ? el('a', 'brf-item__label', entry.label) : el('b', 'brf-item__label', entry.label);
  if (entry.href) {
    label.href = entry.href;
    if (/^https?:/.test(entry.href)) { label.target = '_blank'; label.rel = 'noopener noreferrer'; label.append(' ↗'); }
    else label.addEventListener('click', (event) => { event.preventDefault(); go(entry.href); });
  }
  text.appendChild(label);
  if (entry.detail) text.appendChild(el('span', 'brf-item__detail', entry.detail));
  row.appendChild(text);
  if (entry.meta) row.appendChild(el('span', 'brf-item__meta', entry.meta));
  return row;
}

function cardFor(finding, go) {
  const card = el('article', `brf-card is-${finding.type}`);
  const kind = TYPE_LABEL[finding.type] ?? finding.type;
  // The kind above the title, unless it would only repeat it.
  if (kind.toLowerCase() !== String(finding.title).toLowerCase()) card.appendChild(el('p', 'brf-card__eyebrow', kind));
  card.appendChild(el('h2', 'brf-card__title', finding.title));
  if (finding.summary) card.appendChild(el('p', 'brf-card__summary', finding.summary));
  const counts = Object.entries(finding.counts ?? {});
  if (counts.length) {
    const row = el('div', 'brf-counts');
    for (const [name, value] of counts) {
      const chip = el('div', 'brf-count');
      chip.append(el('b', null, String(value)), el('span', null, name));
      row.appendChild(chip);
    }
    card.appendChild(row);
  }
  if (finding.lists?.length) {
    const table = el('div', 'brf-lists');
    for (const list of finding.lists.slice(0, 6)) {
      const r = el('div', 'brf-list');
      r.append(el('span', 'brf-list__name', list.title), el('span', 'brf-list__n', `${list.hot} hot · ${list.warm} warm${list.fresh ? ` · ${list.fresh} new` : ''}`));
      table.appendChild(r);
    }
    card.appendChild(table);
  }
  if (finding.note) card.appendChild(el('p', 'brf-card__note', finding.note));
  // The live lists show their top 3 whole, then a link to the rest (nothing cut in half).
  // The pipeline card lists every item it counts: each is something to act on (NIRMATA F1, 30 Oct).
  // « Today » lists every money item too: each one is cash (audit C12).
  const shown = finding.live && !['pipeline', 'today'].includes(finding.type) ? (finding.items ?? []).slice(0, 3) : (finding.items ?? []);
  if (shown.length) {
    const list = el('ul', 'brf-items');
    for (const entry of shown) list.appendChild(item(entry, go));
    card.appendChild(list);
  }
  const allHref = finding.href ?? (finding.type === 'leads' ? '/leads' : null);
  if (allHref) {
    const n = finding.type === 'travel' ? finding.counts?.total : finding.counts?.hot;
    const all = el('a', 'brf-card__all', finding.type === 'leads' ? `See all ${n ?? ''} hot leads →`.replace('  ', ' ')
      : finding.type === 'pipeline' ? 'Open the pipeline →'
      : finding.type === 'today' ? 'Open Home →'
      : `Open the list${n ? ` (${n})` : ''} →`);
    all.href = allHref;
    all.addEventListener('click', (event) => { event.preventDefault(); go(allHref); });
    // Shown in the footer, beside Previous / Next: always in view, never under the fade.
    card.allLink = all;
  }
  return card;
}

/** « Good morning / afternoon / evening » by the clock Andy is looking at
 *  (audit C12, M5: it said « Good morning » at 20:40 in Lima). */
export function greetingFor(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Which day the briefing speaks for: today, and the date its written notes
 *  are from when that is not today (audit C12, M5). */
export function briefingDateLine(briefingDate, now = new Date()) {
  const fmt = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (!briefingDate || briefingDate === today(now)) return fmt(now);
  const d = new Date(`${briefingDate}T12:00:00`);
  return `${fmt(now)} · the written notes are from ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/**
 * Open the briefing. `ctx.navigate` follows HQ links; `name` is Andy.
 * Returns the layer (tests) and a close().
 */
export async function openBriefing(ctx = {}, { name = 'Andy', load = () => apiFetch('/api/briefing') } = {}) {
  ensureBriefingCss();
  markSeen();
  if (document.querySelector('.brf')) return null;
  const back = document.activeElement;
  const layer = el('div', 'brf is-intro');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  const hello = greetingFor();
  layer.setAttribute('aria-label', `${hello}, ${name}`);
  document.documentElement.classList.add('brf-open');

  // 1. The neon greeting.
  const intro = el('div', 'brf-intro');
  const sign = el('h1', 'brf-neon');
  sign.append(neon(`${hello.toUpperCase()},`), neon(name.toUpperCase(), 'is-name'));
  const sr = el('span', 'sr-only', `${hello}, ${name}`);
  sign.appendChild(sr);
  intro.appendChild(sign);
  const dateLine = el('p', 'brf-intro__date', briefingDateLine(null));
  intro.appendChild(dateLine);
  layer.appendChild(intro);

  // 2. The briefing itself.
  const panel = el('section', 'brf-panel');
  const head = el('header', 'brf-head');
  const mark = el('p', 'brf-head__mark');
  mark.append(el('span', 'brf-head__neon', `${hello}, ${name}`));
  const step = el('span', 'brf-head__step');
  const close = el('button', 'brf-x', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the briefing');
  head.append(mark, step, close);
  const nav = el('nav', 'brf-names');
  nav.setAttribute('aria-label', 'Findings');
  const stage = el('div', 'brf-stage');
  const foot = el('footer', 'brf-foot');
  const footLink = el('div', 'brf-foot__all');
  foot.appendChild(footLink);
  const prev = el('button', 'btn', '← Previous');
  prev.type = 'button';
  const next = el('button', 'btn primary', 'Next →');
  next.type = 'button';
  foot.append(prev, next);
  const body = el('div', 'brf-body');
  const right = el('div', 'brf-right');
  right.append(stage, foot);
  body.append(right);
  panel.append(head, body);
  // The names sit on the blurred backdrop, left of the card (Andy); on a phone, a chip row inside it.
  const shell = el('div', 'brf-shell');
  shell.append(nav, panel);
  layer.appendChild(shell);
  const phone = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
  const place = () => { if (phone?.matches) body.prepend(nav); else shell.prepend(nav); };
  place();
  phone?.addEventListener?.('change', place);
  document.body.appendChild(layer);

  let findings = [];
  let at = 0;
  const shut = () => {
    phone?.removeEventListener?.('change', place);
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('brf-open');
    layer.remove();
    back?.focus?.();
  };
  const go = (href) => { shut(); ctx.navigate?.(href); };

  function show(index) {
    if (!findings.length) return;
    at = Math.max(0, Math.min(findings.length - 1, index));
    for (const [i, button] of [...nav.children].entries()) button.setAttribute('aria-current', i === at ? 'step' : 'false');
    nav.children[at]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const card = cardFor(findings[at], go);
    stage.replaceChildren(card);
    footLink.replaceChildren(...(card.allLink ? [card.allLink] : []));
    step.textContent = `${at + 1} / ${findings.length}`;
    prev.disabled = at === 0;
    next.textContent = at === findings.length - 1 ? 'Open HQ' : 'Next →';
  }
  prev.addEventListener('click', () => show(at - 1));
  next.addEventListener('click', () => { if (at === findings.length - 1 || !findings.length) shut(); else show(at + 1); });
  close.addEventListener('click', shut);
  const onKey = (event) => {
    if (event.key === 'Escape') shut();
    else if (layer.classList.contains('is-intro') && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight')) { event.preventDefault(); reveal(); }
    else if (event.key === 'ArrowRight') show(at + 1);
    else if (event.key === 'ArrowLeft') show(at - 1);
  };
  document.addEventListener('keydown', onKey);
  // A swipe on the card: left = next, right = previous.
  let startX = null;
  stage.addEventListener('pointerdown', (event) => { startX = event.clientX; });
  stage.addEventListener('pointerup', (event) => {
    if (startX === null) return;
    const dx = event.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 60) show(at + (dx < 0 ? 1 : -1));
  });

  let revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    layer.classList.remove('is-intro');
    layer.classList.add('is-panel');
    queueMicrotask(() => next.focus());
  }
  intro.addEventListener('click', reveal);

  let loaded = true;
  try {
    const briefing = (await load()).briefing ?? {};
    findings = briefing.findings ?? [];
    dateLine.textContent = briefingDateLine(briefing.date ?? null);
  } catch {
    findings = [];
    loaded = false;
  }
  // « A quiet morning » only when it really is one: a briefing that failed to
  // load says so (audit item 16).
  if (!findings.length) {
    findings = [loaded
      ? { id: 'quiet', type: 'note', title: 'A quiet day', summary: 'Nothing new since yesterday. The Overview has the rest.' }
      : { id: 'failed', type: 'note', title: 'The briefing did not load', summary: 'Nothing is wrong with your day: HQ could not reach it. Home has the to-do list; open the briefing again later.' }];
  }
  for (const [i, f] of findings.entries()) {
    const b = el('button', 'brf-name', f.title);
    b.type = 'button';
    b.addEventListener('click', () => show(i));
    nav.appendChild(b);
  }
  show(0);
  // The greeting holds a moment, then the briefing comes up (at once without motion).
  if (reduced()) reveal(); else setTimeout(reveal, 2600);
  return { layer, close: shut, show, reveal };
}
