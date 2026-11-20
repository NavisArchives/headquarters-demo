// Quick personalization: the culling view over the Leads screen (Andy, 27 Oct).
//
// One line per coded lead (S1…, B1…, F1…): the code, big enough to read
// aloud; the name, town and sector; one « Open site » button; and the three
// marks. Andy opens a site, looks, and says « S3: … » in the LEADS chat;
// LEADS writes the email from his words. Nothing is written here except
// the marks, which are the lead's own state (see leads-cull-lib.js).
//
// Keys: ↑/↓ or j/k move · Enter or o opens the site · 1 ✓ noted · 2 ✕ skip ·
// 3 ★ priority · Esc closes. Only the list scrolls; feedback is a toast.
//
// P (Travel stays, Andy's personal list, 28 Oct) is its own tab: each row says
// what the place offers and how to apply, and the decisions are ✉ Email myself
// · ✎ Fill their form · ✕ Skip (keys 1 2 3). Choosing ✉ or ✎ opens a ready-to-
// copy message (EN / ES) and his documents. There is no send button: nothing is
// ever sent from HQ for this list; he sends from his own Gmail or the portal.

import { el } from '../dom.js';
import { apiFetch, ApiError } from '../api.js';
import { toast } from '../leads-ui.js';
import { createSession, sessionBar } from '../cull-session.js';
import { normalizeLead } from '../leads-lib.js';
import {
  MARKETS, MARK_FILTERS, TRAVEL_FILTERS, FIELDS, codeOf, marksOf, togglePatch, cullView, cullCounts, fieldCounts,
  isPersonal, offerOf, applyHow, travelMessage, seenOf, sendBadge, listingOf, conditionsOf, tierOf,
} from '../leads-cull-lib.js';

/** Andy's application kit, in Drive « TRAVEL KIT » (also on his Desktop). */
const KIT_FOLDER = 'https://drive.google.com/drive/folders/1j85FA6H0avXdqDnsbgl5Y4CAtIHpDrIQ';
const KIT = [
  ['CV · Yoga & Wellness', '1_1turUy5e61ezz9FTXLRID-rTtbHVcJs'],
  ['CV · Yoga & Wellness, without photo', '1kLjJB3qB1oHMdnMPta-FXvzgJheuRJ1Y'],
  ['CV · Wellness Curator', '1NdDH9bQNBoh1aK5GDY9pCkUR92m_fY1q'],
  ['CV · Hospitality & Content', '1pR-4MWSRjmWqKVi8oG-8Bvpa5BURTla1'],
  ['Certificate · 200h Vinyasa (Yogashala)', '15joM8YYrCJRVHKHp7OQ7GtlGCjfoZsrZ'],
  ['Certificate · 300h Shivayog Ashram', '1uyf3BOS6ikHXcr2OFGoPjFlB-zyISNCN'],
].map(([label, id]) => ({ label, url: `https://drive.google.com/file/d/${id}/view` }));

const VIEW_KEY = 'hq.leads.cull';

export function ensureCullCss() {
  if (typeof document === 'undefined' || document.getElementById('cull-css')) return;
  const link = document.createElement('link');
  link.id = 'cull-css';
  link.rel = 'stylesheet';
  link.href = '/assets/cull.css';
  document.head.appendChild(link);
}

function recallView() {
  try { return { market: 'all', mark: 'todo', field: 'all', ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { return { market: 'all', mark: 'todo', field: 'all' }; }
}
function rememberView(view) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* not remembered */ }
}

const MARK_BUTTONS = [
  { mark: 'noted', key: '1', glyph: '✓', label: 'Noted' },
  { mark: 'skip', key: '2', glyph: '✕', label: 'Skip' },
  { mark: 'priority', key: '3', glyph: '★', label: 'Priority' },
];
const TRAVEL_BUTTONS = [
  { mark: 'email', key: '1', glyph: '✉', label: 'Email myself' },
  { mark: 'form', key: '2', glyph: '✎', label: 'Fill their form' },
  { mark: 'skip', key: '3', glyph: '✕', label: 'Skip' },
];
const buttonsFor = (lead) => (isPersonal(codeOf(lead)?.letter) ? TRAVEL_BUTTONS : MARK_BUTTONS);
const filtersFor = (market) => (isPersonal(market) ? TRAVEL_FILTERS : MARK_FILTERS);

/**
 * Opens the culling view. `leads` is the Leads screen's own (normalised)
 * array; a changed lead is written back into it and `onChanged(lead)` is
 * called, so the screen underneath stays true.
 */
let current = null;

/** Closes the culling view if it is open (the Leads screen calls this on leave). */
export function closeCulling() { current?.close(); }

export function openCulling(leads, { onChanged } = {}) {
  ensureCullCss();
  closeCulling();
  const view = recallView();
  let rows = [];
  let at = 0;

  const root = el('div', 'cull');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Quick personalization');

  const head = el('div', 'cull-head');
  const titleBox = el('div', 'cull-title');
  const sub = el('p', 'cull-sub');
  titleBox.append(el('h2', null, 'Quick personalization'), sub);
  const counter = el('p', 'cull-counter');
  const docs = el('button', 'chip-btn', 'Documents');
  docs.type = 'button';
  docs.title = 'Your CVs and yoga certificates (Drive « TRAVEL KIT »)';
  docs.addEventListener('click', () => openSheet(null));
  const close = el('button', 'chip-btn', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => shut());
  const headEnd = el('div', 'cull-head-end');
  // One quiet progress line under the title instead of two loud counters (13 Nov).
  const progress = el('div', 'cull-progress');
  const progressBar = el('span', 'cull-progress-bar');
  const progressFill = el('i');
  progressBar.append(progressFill);
  progress.append(progressBar, counter);
  titleBox.append(progress);
  head.append(titleBox, headEnd);

  // Talk while you click (13 Nov): record, a clock, sites opened, « Say codes ».
  const session = createSession({ toast, onChange: () => { bar.paint(); paintFilters(); paintRows(); } });
  const bar = sessionBar(session, { el });
  headEnd.append(bar, docs, close);
  session.checkUnfinished();

  const filters = el('div', 'cull-filters');
  const marketRow = el('div', 'cull-seg cull-markets');
  marketRow.setAttribute('aria-label', 'Market');
  // On a phone the lists are one dropdown, not rows of chips (NIRMATA I2, 29 Oct).
  const marketPick = el('select', 'sortsel cull-market-select');
  marketPick.setAttribute('aria-label', 'List');
  marketPick.addEventListener('change', () => setView({ market: marketPick.value }));
  const markRow = el('div', 'cull-seg cull-marks-filter');
  markRow.setAttribute('aria-label', 'Mark');
  // The field of work: chips on a computer, one dropdown on a phone.
  const fieldRow = el('div', 'cull-seg cull-fields');
  fieldRow.setAttribute('aria-label', 'Field');
  const fieldPick = el('select', 'sortsel cull-field-select');
  fieldPick.setAttribute('aria-label', 'Field');
  fieldPick.addEventListener('change', () => setView({ field: fieldPick.value }));
  filters.append(marketPick, marketRow, fieldPick, fieldRow, markRow);

  const list = el('div', 'cull-list');
  list.setAttribute('role', 'listbox');
  const keys = el('p', 'cull-keys');

  root.append(head, filters, list, keys);
  document.body.appendChild(root);
  // The page behind must not scroll while the layer is up (phones especially).
  const html = document.documentElement;
  const before = [html.style.overflow, document.body.style.overflow];
  html.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  /** A filter chip; `short` is what it says on a phone (the full label stays its name). */
  function segButton(label, on, pick, short) {
    const b = el('button', `cull-chip${on ? ' is-on' : ''}`);
    if (short && short !== label) {
      const l = el('span', 'l', label);
      const sh = el('span', 's', short);
      l.setAttribute('aria-hidden', 'true');
      sh.setAttribute('aria-hidden', 'true');
      b.append(l, sh);
      b.setAttribute('aria-label', label);
    } else {
      b.textContent = label;
    }
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', pick);
    return b;
  }

  /** Only lists that have leads here; the Travel stays are the whole view or none of it.
   *  Runs before the rows are picked, so the view and the rows always agree. */
  function settleMarket() {
    const counts = cullCounts(leads, 'all');
    const markets = MARKETS.filter((m) => counts.byMarket[m.v] > 0);
    const onlyPersonal = markets.length > 0 && markets.every((m) => isPersonal(m.v));
    if (onlyPersonal && view.market !== markets[0].v) view.market = markets[0].v;
    if (!onlyPersonal && (isPersonal(view.market) || (view.market !== 'all' && !markets.some((m) => m.v === view.market)))) view.market = 'all';
    return { markets, onlyPersonal };
  }

  function paintFilters() {
    const counts = cullCounts(leads, 'all');
    // Only lists that have leads here. The Travel stays come only from the Travel list
    // tab (leads.js scopes what is passed in), so they never sit beside outreach lists.
    const { markets, onlyPersonal } = settleMarket();
    marketRow.replaceChildren(
      segButton(`All · ${counts.all}`, view.market === 'all', () => setView({ market: 'all' })),
      ...markets.map((m) => segButton(`${m.v} · ${m.label} · ${counts.byMarket[m.v]}`, view.market === m.v, () => setView({ market: m.v }))),
    );
    const travel = isPersonal(view.market);
    marketPick.hidden = onlyPersonal;
    const options = [['all', `All lists · ${counts.all}`], ...markets.filter((m) => !isPersonal(m.v)).map((m) => [m.v, `${m.v} · ${m.label} · ${counts.byMarket[m.v]}`])];
    marketPick.replaceChildren(...options.map(([v, label]) => { const o = el('option', null, label); o.value = v; return o; }));
    marketPick.value = view.market;
    markRow.replaceChildren(...filtersFor(view.market).map((f) => segButton(f.label, view.mark === f.v, () => setView({ mark: f.v }), f.short)));
    // Fields with a live count for this list; an empty field is not offered.
    const fc = fieldCounts(leads, view.market);
    const fields = FIELDS.filter((f) => fc[f.v] > 0);
    fieldRow.hidden = travel;
    fieldPick.hidden = travel;
    fieldRow.replaceChildren(
      segButton(`All fields · ${fc.all}`, view.field === 'all', () => setView({ field: 'all' }), 'All'),
      ...fields.map((f) => segButton(`${f.label} · ${fc[f.v]}`, view.field === f.v, () => setView({ field: f.v }), f.short)),
    );
    fieldPick.replaceChildren(...[['all', `All fields · ${fc.all}`], ...fields.map((f) => [f.v, `${f.label} · ${fc[f.v]}`])]
      .map(([v, label]) => { const o = el('option', null, label); o.value = v; return o; }));
    fieldPick.value = view.field;
    const c = cullCounts(leads, view.market, travel ? 'all' : view.field);
    const base = cullView(leads, { ...view, mark: 'all' });
    const opened = base.filter((l) => session.openedUids.has(l.uid)).length;
    counter.textContent = travel
      ? `${c.decided} decided of ${c.total} · ${c.email} ✉ · ${c.form} ✎ · ${c.skipped} skipped`
      : `${c.noted} noted · ${opened} opened · ${c.skipped} skipped of ${c.total}`;
    progressFill.style.width = `${c.total ? Math.round((100 * (travel ? c.decided : c.noted + c.skipped)) / c.total) : 0}%`;
    docs.hidden = !travel;
    sub.textContent = travel
      ? 'Your own list: open each place, then decide. Nothing is sent from HQ; you write from your own Gmail or their page.'
      : (session.recording ? 'Recording. Open a site, then say what you see.' : 'Open each site and note what a visitor would notice.');
    keys.textContent = travel
      ? '↑ ↓ move · Enter open site · 1 ✉ email myself · 2 ✎ their form · 3 ✕ skip · Esc close'
      : '↑ ↓ move · Enter open site · 1 ✓ noted · 2 ✕ skip · 3 ★ priority · Esc close';
  }

  function setView(next) {
    Object.assign(view, next);
    // A mark filter that does not exist on the new tab falls back to « To do ».
    if (!filtersFor(view.market).some((f) => f.v === view.mark)) view.mark = 'todo';
    // A field with no rows on a new outreach list falls back to all fields;
    // the Travel list ignores the field, so it is kept for the way back.
    if (view.field !== 'all' && !isPersonal(view.market) && !(fieldCounts(leads, view.market)[view.field] > 0)) view.field = 'all';
    rememberView(view);
    at = 0;
    paint();
  }

  function rowFor(lead, i) {
    const c = codeOf(lead);
    const m = marksOf(lead);
    const travel = isPersonal(c.letter);
    const seenBefore = session.openedUids.has(lead.uid);
    const row = el('div', `cull-row${travel ? ' is-travel' : ''}${i === at ? ' is-at' : ''}${m.skip ? ' is-skip' : ''}${seenBefore ? ' is-opened' : ''}`);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === at ? 'true' : 'false');
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) { at = i; paintRows(); } });

    row.append(el('b', 'cull-code', c.code));
    const who = el('div', 'cull-who');
    const name = el('b', null, lead.name || lead.business);
    // A row that may not be emailed says so (LEADS's extra.sendable); there is
    // no send path from here either way.
    const badge = travel ? null : sendBadge(lead);
    // The web-wave tier on every row that has one, so the T1-first order is visible (13 Nov).
    const tier = travel ? 9 : tierOf(lead);
    if (badge || tier < 9) {
      const nameLine = el('span', 'cull-name');
      nameLine.append(name);
      if (tier < 9) {
        const t = el('span', `cull-badge is-tier is-t${tier}`, `T${tier}`);
        t.title = `Tier ${tier} (T1 is the best fit)`;
        nameLine.append(t);
      }
      if (badge) {
        const pill = el('span', `cull-badge is-${badge.kind}`, badge.label);
        if (badge.why) pill.title = badge.why;
        nameLine.append(pill);
      }
      who.append(nameLine);
    } else {
      who.append(name);
    }
    if (travel) {
      who.append(el('small', null, [lead.city, applyHow(lead).label].filter(Boolean).join(' · ')));
      const offer = offerOf(lead);
      if (offer) who.append(el('small', 'cull-offer', `Offers: ${offer}`));
    } else {
      who.append(el('small', null, [lead.city, lead.subcategory || lead.category].filter(Boolean).join(' · ') || '—'));
      // What LEADS saw on the site, as a hint for Andy's look (never email text).
      const seen = seenOf(lead);
      if (seen) who.append(el('small', 'cull-seen', seen));
    }
    row.append(who);

    // An offer found on a job board or portal opens there: their homepage
    // does not show it. The sheet keeps a second button for their site.
    const listing = travel ? listingOf(lead) : null;
    const open = el('button', `btn cull-open${seenBefore ? ' is-opened' : ''}`, seenBefore ? '✓ Opened' : (listing ? 'Open listing' : 'Open site'));
    open.type = 'button';
    if (listing) open.title = listing;
    open.disabled = !listing && !lead.website;
    open.addEventListener('click', () => { at = i; openSite(); });
    row.append(open);

    const marks = el('div', 'cull-marks');
    for (const b of buttonsFor(lead)) {
      const on = m[b.mark];
      const btn = el('button', `cull-mark${on ? ' is-on' : ''}`, b.glyph);
      btn.type = 'button';
      btn.title = `${b.label} (${b.key})`;
      btn.setAttribute('aria-label', b.label);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.disabled = b.mark !== 'priority' && m.locked;
      if (travel) btn.classList.add('is-decision');
      btn.addEventListener('click', () => { at = i; toggle(b.mark); });
      marks.append(btn);
    }
    row.append(marks);
    return row;
  }

  function paintRows() {
    // One height for every row in the view: three lines as soon as one row has a hint.
    list.classList.toggle('has-hints', rows.some((l) => !isPersonal(codeOf(l).letter) && seenOf(l)));
    list.replaceChildren(...rows.map(rowFor));
    if (!rows.length) {
      list.append(el('p', 'cull-empty', cullCounts(leads, 'all').all
        ? 'Nothing in this view. Try another market or mark.'
        : 'No coded leads yet. LEADS adds the codes (S1…, B1…, F1…, P1… for Travel) to each list.'));
    }
    list.children[at]?.scrollIntoView?.({ block: 'nearest' });
  }

  function paint() {
    settleMarket();
    rows = cullView(leads, view);
    if (at >= rows.length) at = Math.max(rows.length - 1, 0);
    paintFilters();
    paintRows();
  }

  function openSite() {
    const lead = rows[at];
    const url = (lead && codeOf(lead).letter === 'P' ? listingOf(lead) : null) || lead?.website;
    if (!url) { toast('No site on this lead'); return; }
    window.open(url, '_blank', 'noopener');
    session.opened(lead, codeOf(lead).code);
  }

  let busy = false;
  async function toggle(mark) {
    const lead = rows[at];
    if (!lead || busy) return;
    const patch = togglePatch(lead, mark);
    if (!patch) {
      toast(isPersonal(codeOf(lead).letter)
        ? `${codeOf(lead).code} is already ${lead.stage}`
        : `${codeOf(lead).code} is already ${lead.stage}: only ★ can change`);
      return;
    }
    busy = true;
    try {
      const body = await apiFetch(`/api/leads/${lead.uid}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const fresh = body?.lead ? normalizeLead({ ...lead, ...body.lead, payload: lead.payload }) : lead;
      // The list's own copy keeps its facts (payload, extra); only state changes.
      const updated = { ...lead, stage: fresh.stage, starred: fresh.starred };
      const idx = leads.indexOf(lead);
      if (idx >= 0) leads[idx] = updated;
      onChanged?.(updated);
      const on = marksOf(updated)[mark];
      toast(`${codeOf(updated).code} · ${buttonsFor(updated).find((b) => b.mark === mark).label}${on ? '' : ' removed'}`);
      // A decided lead leaves the « To do » view; stay on the same place.
      paint();
      // Email myself / their form: the message and the documents, ready to copy.
      if (on && (mark === 'email' || mark === 'form')) openSheet(updated);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save the mark');
    } finally {
      busy = false;
    }
  }

  /* -------- the Travel sheet: message + documents (never a send button) -------- */

  let sheet = null;
  function closeSheet() { sheet?.remove(); sheet = null; }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Could not copy: select the text and copy it'); }
  }

  /** `lead` = the place to write to; null = only the documents. */
  function openSheet(lead) {
    closeSheet();
    sheet = el('div', 'cull-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', lead ? 'Your message' : 'Your documents');
    const panel = el('div', 'cull-sheet__panel');
    const top = el('div', 'cull-sheet__top');
    top.append(el('h3', null, lead ? `${codeOf(lead).code} · ${lead.name}` : 'Your documents'));
    const x = el('button', 'chip-btn', 'Close');
    x.type = 'button';
    x.addEventListener('click', closeSheet);
    top.append(x);
    panel.append(top);

    if (lead) {
      const how = applyHow(lead);
      const howRow = el('div', 'cull-sheet__how');
      howRow.append(el('p', null, how.kind === 'email'
        ? `Write to ${how.address} from your own Gmail, with the documents below attached.`
        : `${how.label}: paste the message there and attach the documents below.`));
      const acts = el('div', 'cull-sheet__acts');
      if (how.address) {
        const ca = el('button', 'btn small', 'Copy address');
        ca.type = 'button';
        ca.addEventListener('click', () => copy(how.address, 'Address'));
        acts.append(ca);
      }
      const listing = listingOf(lead);
      if (listing) {
        const ol = el('button', 'btn small', 'Open listing');
        ol.type = 'button';
        ol.title = listing;
        ol.addEventListener('click', () => window.open(listing, '_blank', 'noopener'));
        acts.append(ol);
      }
      const own = listing ? lead.website : (how.url || lead.website);
      if (own) {
        const op = el('button', 'btn small', !listing && how.kind === 'portal' ? 'Open their page' : 'Open their site');
        op.type = 'button';
        op.addEventListener('click', () => window.open(own, '_blank', 'noopener'));
        acts.append(op);
      }
      howRow.append(acts);
      panel.append(howRow);

      // The conditions, before the message: Andy reads what they ask first.
      const conditions = conditionsOf(lead);
      if (conditions) {
        const cond = el('p', 'cull-sheet__cond');
        cond.append(el('b', null, 'What they ask: '), document.createTextNode(conditions));
        panel.append(cond);
      }

      let lang = 'en';
      const langs = el('div', 'cull-seg');
      const text = el('textarea', 'text-input cull-sheet__text');
      text.rows = 12;
      text.setAttribute('aria-label', 'Your message');
      const paintLang = () => {
        text.value = travelMessage(lead, lang);
        langs.replaceChildren(...[['en', 'English'], ['es', 'Español']].map(([v, label]) => {
          const b = el('button', `cull-chip${lang === v ? ' is-on' : ''}`, label);
          b.type = 'button';
          b.addEventListener('click', () => { lang = v; paintLang(); });
          return b;
        }));
      };
      paintLang();
      const copyMsg = el('button', 'btn small primary', 'Copy message');
      copyMsg.type = 'button';
      copyMsg.addEventListener('click', () => copy(text.value, 'Message'));
      const msgHead = el('div', 'cull-sheet__msghead');
      msgHead.append(langs, copyMsg);
      panel.append(msgHead, text);
    }

    const kit = el('div', 'cull-kit');
    kit.append(el('p', 'cull-kit__title', 'Documents · Drive « TRAVEL KIT » (also on your Desktop)'));
    const files = el('div', 'cull-kit__files');
    for (const f of KIT) {
      const a = el('a', 'cull-kit__file', f.label);
      a.href = f.url;
      a.target = '_blank';
      a.rel = 'noopener';
      files.append(a);
    }
    const folder = el('a', 'cull-kit__file is-folder', 'Open the whole folder');
    folder.href = KIT_FOLDER;
    folder.target = '_blank';
    folder.rel = 'noopener';
    files.append(folder);
    kit.append(files);
    panel.append(kit);

    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    root.append(sheet);
  }

  function onKey(e) {
    if (!root.isConnected) { shut(); return; }
    if (sheet) { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } return; }
    if (e.target.closest?.('input, textarea, select')) return;
    const k = e.key;
    if (k === 'Escape') { shut(); return; }
    if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); at = Math.min(at + 1, rows.length - 1); paintRows(); return; }
    if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); at = Math.max(at - 1, 0); paintRows(); return; }
    if (k === 'Enter' || k === 'o') { e.preventDefault(); openSite(); return; }
    const lead = rows[at];
    const b = lead && buttonsFor(lead).find((x) => x.key === k);
    if (b) { e.preventDefault(); toggle(b.mark); }
  }
  document.addEventListener('keydown', onKey);

  function shut() {
    // Closing never loses a recording: it finishes and saves first.
    if (session.recording) session.finish();
    closeSheet();
    document.removeEventListener('keydown', onKey);
    root.remove();
    [html.style.overflow, document.body.style.overflow] = before;
    if (current?.close === shut) current = null;
  }

  paint();
  current = { close: shut };
  return current;
}
