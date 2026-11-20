// Leads — the whole of the old dashboard, inside HQ.
//
// The shape is the old app's v3 layout: business tabs, a sidebar of pipeline
// stages and attention counters that are all filters, a toolbar with search
// and five counted dropdowns, and the table. A row opens the popup
// (screens/leads-popup.js) rather than a docked panel.
//
// Facts and state arrive once from GET /api/leads and are filtered, counted
// and sorted in the browser, exactly as they were before — that is what lets
// every dropdown option carry the number of leads it would actually give
// you. Every write goes straight back to D1. The only thing this screen
// remembers locally is which tab and sort you left it on.

import { el, fillViewport, clear, hero, emptyState } from '../dom.js';
import { apiFetch, ApiError } from '../api.js';
import {
  toast, download, copyText, closeAllModals, openModal,
} from '../leads-ui.js';
import {
  STAGES, STAGE_BY, TILES, SORTS, DIMENSIONS, CONTACT_LABEL, VERIFIED,
  normalizeLead, businessTabs, stageCounts, inPlay, wonShare, attentionCounts,
  dimOptions, visibleLeads, hasFilters, dueReason, relTime, openInfo, openedToday,
  tierClass, isUrl, shortUrl, toCsv, csvFilename,
} from '../leads-lib.js';
import {
  gmailStatus, fetchReplies, syncMailbox, forgetGmailStatus, autoSyncMailbox, authorizeUrl,
} from '../leads-gmail.js';
import { openLeadPopup } from './leads-popup.js';
import { fetchReviews, scanReplies } from '../replies-ui.js';
import { loadProfile, openProfileEditor } from './leads-profile.js';
import { openAddLead } from './add-lead.js';
import { checkLeadBatches } from '../lead-batches-ui.js';
import { AGENCIES, isPersonalDataset } from '../personal-lists.js';
import { samePersonMap } from '../same-person.js';
const TRAVEL_TAB = 'Travel list';
import { openCulling, closeCulling } from './leads-cull.js';

const TAB_KEY = 'hq.leads.business';
const SORT_KEY = 'hq.leads.sort';

/** Opens only exist for leads that have actually been written to, and the
 *  API hands them back one lead at a time. Sweeping every lead would be
 *  hundreds of requests, so only the ones that could have been opened are
 *  swept, newest first, and never more than this many. */
const OPENS_SWEEP_LIMIT = 150;
const PHONE = '(max-width: 760px)';
const isPhone = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches;
const ROWS_FIRST = 120; // drawn at once: more than a tall screen shows
const ROWS_MORE = 200; // each time the end of the drawn rows comes near
const ROWS_AHEAD = 40; // how near: this many rows before the last one drawn

let teardown = null;

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode, or storage off */ }
}

function recall(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function errorText(error) {
  return error instanceof ApiError ? error.message : 'something went wrong';
}

export async function renderLeads(ctx) {
  // Re-entering the screen replaces the previous one: drop its listeners and
  // shut anything it left open.
  if (teardown) teardown();
  closeAllModals();

  const fragment = document.createDocumentFragment();

  /* ---------------- data ---------------- */


  // Dataset titles and the notes on how each list was built live behind the
  // workspace route; a failure there costs a nicer name, nothing more.
  const listTitles = {};
  let datasetMeta = [];
  // Everything at once: from Lima each read is a round trip to Europe (13 Nov).
  const [listed, workspace, profileLoaded, gmail, replies, funnel] = await Promise.all([
    apiFetch('/api/leads'),
    apiFetch('/api/leads/workspace?only=datasets').catch(() => null),
    loadProfile(),
    gmailStatus(),
    fetchReplies(),
    fetchReviews('open'),
  ]);
  const leads = (listed?.leads ?? []).map(normalizeLead);
  // One letter per inbox (NIRMATA, 14 Nov): how many leads share each address, across every list.
  const inboxCount = new Map();
  for (const lead of leads) {
    const key = String(lead.email || '').trim().toLowerCase();
    if (key) inboxCount.set(key, (inboxCount.get(key) ?? 0) + 1);
  }
  // The same doctor filed in two lists (NIRMATA, 14 Nov): uid -> the other leads with that name.
  const samePerson = samePersonMap(leads);
  if (workspace?.datasets) {
    datasetMeta = workspace.datasets.map((d) => d.meta).filter(Boolean);
    for (const meta of datasetMeta) listTitles[meta.key] = meta.title || meta.key;
  }

  let profile = profileLoaded;
  let gmailInfo = gmail;
  const opens = {};

  const state = {
    business: recall(TAB_KEY, 'all'),
    sort: recall(SORT_KEY, 'fit'),
    tile: null,
    q: '',
    dims: Object.fromEntries(DIMENSIONS.map((d) => [d.field, []])),
  };
  if (!SORTS.some((s) => s.v === state.sort)) state.sort = 'fit';

  const tabs = businessTabs(leads);
  if (!tabs.some((tab) => tab.v === state.business)) state.business = 'all';

  const listTitle = (dataset) => listTitles[dataset] || dataset;

  // Most list titles already open with the business ("UGC — brands, agencies
  // and platforms…"), and the crumb says the business right before it. Drop
  // the repeat rather than reading "UGC · UGC — …".
  const crumbTitle = (row) => {
    const title = listTitle(row.dataset);
    const prefix = `${row.business} — `;
    return title.startsWith(prefix) ? title.slice(prefix.length) : title;
  };

  /* ---------------- the reply funnel ---------------- */

  // What HQ has read and stored beats what the bridge classified on the fly:
  // a review is a reading that survived, with proposals attached. Folding it
  // into the same address-keyed map means "Replies to act on" counts open
  // reviews without the tile having to learn a second shape.
  const INTENT_BUCKET = {
    auto_reply: 'auto', not_interested: 'declined', sign_up_elsewhere: 'signup',
  };
  let reviews = funnel.reviews;
  let canReadReplies = funnel.canRead;
  let readNote = funnel.readNote;

  function foldReviews() {
    for (const review of reviews) {
      if (!review.from_email) continue;
      replies[review.from_email] = {
        bucket: INTENT_BUCKET[review.intent] || 'warm',
        why: review.summary || 'HQ read this reply',
        when: review.received_at || review.reviewed_at || '',
        subject: review.subject || '',
        excerpt: review.body_excerpt || '',
        links: [],
        from: review.from_email,
      };
    }
  }
  foldReviews();

  /** The review for a lead, matched on the address HQ stored it under. */
  const reviewFor = (row) => {
    const address = (row.email || '').toLowerCase();
    if (!address) return null;
    return reviews.find((review) => review.from_email === address) || null;
  };

  async function reloadReviews() {
    const again = await fetchReviews('open');
    reviews = again.reviews;
    canReadReplies = again.canRead;
    readNote = again.readNote;
    foldReviews();
    paintSide();
  }

  const filterCtx = () => ({ opens, replies, now: Date.now() });

  let visible = [];

  /* ---------------- header ---------------- */

  const head = hero(
    'The',
    'pipeline',
    leads.length
      ? `${leads.length} leads across ${datasetMeta.length || new Set(leads.map((l) => l.dataset)).size} lists`
      : 'nothing imported yet',
  );

  const actions = el('div', 'leads-head');

  const syncBtn = el('button', 'chip-btn mac-only', 'Sync mailbox'); // the Mac reads the mailbox: hidden on a phone (audit D17, P12)
  syncBtn.type = 'button';
  syncBtn.title = gmailInfo.connected
    ? 'Read your Sent and Inbox and move the leads it recognises'
    : 'Reading your mailbox needs HQ running on the Mac';
  syncBtn.addEventListener('click', async () => {
    if (!gmailInfo.connected) { toast(gmailInfo.expired ? 'Your Gmail sign-in expired: press Connect Gmail' : 'Reading your mailbox needs HQ running on the Mac, with Gmail connected'); return; }
    syncBtn.disabled = true;
    toast('Reading your mailbox…');
    try {
      const result = await syncMailbox();
      toast(`${result.applied} moved · ${result.skipped} already right`
        + (result.unmatched ? ` · ${result.unmatched} unmatched` : ''));
      if (result.applied) {
        const again = await apiFetch('/api/leads');
        leads.splice(0, leads.length, ...(again?.leads ?? []).map(normalizeLead));
        refresh();
        toast(`Gmail: ${result.applied} lead${result.applied === 1 ? '' : 's'} updated from your mailbox`);
      }
    } catch (error) {
      toast(errorText(error));
    } finally {
      syncBtn.disabled = false;
    }
  });
  actions.appendChild(syncBtn);

  // Signing Gmail in again (it lapses every 7 days while Google's app is in
  // Testing). Shown only when the bridge answers and Gmail is not connected;
  // the consent opens in a new tab and the button goes once it took.
  const connectBtn = el('button', 'chip-btn', 'Connect Gmail');
  connectBtn.type = 'button';
  connectBtn.title = 'Sign Gmail in again with owner@example.com';
  const paintConnect = () => { connectBtn.hidden = !gmailInfo.configured || gmailInfo.connected || gmailInfo.unreachable; };
  paintConnect();
  connectBtn.addEventListener('click', async () => {
    const url = await authorizeUrl();
    if (!url) { toast('Gmail sign-in needs HQ running on the Mac'); return; }
    window.open(url, '_blank', 'noopener');
    toast('Finish the Google sign-in in the new tab, then come back here');
    // Back on this tab: ask once more, and say so when it worked.
    window.addEventListener('focus', async function back() {
      window.removeEventListener('focus', back);
      forgetGmailStatus();
      gmailInfo = await gmailStatus({ refresh: true });
      paintConnect();
      if (gmailInfo.connected) toast(`Gmail connected · ${gmailInfo.email}`);
    });
  });
  actions.appendChild(connectBtn);

  // Reading replies needs the Mac (for the mailbox) and something that can
  // read (an API key, or Claude Code on that same Mac). Whatever is missing
  // is a state the button wears, in the Worker's own words — never an error,
  // and never "needs an API key" when a key is not what is missing.
  const scanBtn = el('button', 'chip-btn mac-only', 'Scan replies');
  scanBtn.type = 'button';
  scanBtn.title = 'Read the replies that came in and propose what to do about them';
  scanBtn.addEventListener('click', async () => {
    // Whatever is missing is said when the button is pressed, never beside it.
    if (!gmailInfo.connected) { toast(gmailInfo.expired ? 'Your Gmail sign-in expired: press Connect Gmail' : 'Scanning replies needs HQ running on the Mac, with Gmail connected'); return; }
    if (!canReadReplies) { toast(readNote); return; }
    scanBtn.disabled = true;
    toast('Reading your replies…');
    const result = await scanReplies();
    toast(result.note);
    scanBtn.disabled = false;
    if (result.ok) await reloadReviews();
  });
  actions.appendChild(scanBtn);

  const profileBtn = el('button', 'chip-btn', 'Your details');
  profileBtn.type = 'button';
  profileBtn.title = 'Name, portfolio, TikTok, phone — used in every draft';
  profileBtn.addEventListener('click', () => openProfile());
  actions.appendChild(profileBtn);

  // Somebody found on a clinic page belongs in the pipeline before they are
  // forgotten. Until now the only way in was a whole dataset import, and the
  // empty state told you to run curl.
  const addBtn = el('button', 'chip-btn', '+ Add lead');
  addBtn.type = 'button';
  addBtn.title = 'Put one person on a list by hand';
  addBtn.addEventListener('click', () => openAddLead(datasetMeta, (lead) => {
    // The screen builds its whole list once, so the honest refresh is to
    // render the route again rather than patch a row into place.
    toast(`${lead.name} is on the list`);
    ctx.navigate('/leads');
  }));
  actions.appendChild(addBtn);

  // Batches NIRMATA approved import by themselves; this is the « now » button.
  const importBtn = el('button', 'chip-btn', 'Import now');
  importBtn.type = 'button';
  importBtn.title = 'Import the lead batches NIRMATA has approved';
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    try {
      const fresh = await checkLeadBatches({ run: true });
      if (!fresh.length) toast('Nothing approved is waiting');
      else if (fresh.some((b) => b.result === 'imported')) ctx.navigate('/leads');
    } catch (error) {
      toast(error?.message || 'Could not import');
    } finally {
      importBtn.disabled = false;
    }
  });
  actions.appendChild(importBtn);

  const exportBtn = el('button', 'chip-btn', 'Export CSV');
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', async () => {
    if (!visible.length) { toast('Nothing to export'); return; }
    // The list carries a trimmed record; the file gets the whole one
    // (pitch, research, every extra field), in the order on screen.
    exportBtn.disabled = true;
    try {
      const shown = visible.slice();
      const params = new URLSearchParams({ full: '1' });
      if (state.business && state.business !== 'all') params.set('business', state.business);
      const found = await apiFetch(`/api/leads?${params}`);
      const byUid = new Map((found?.leads ?? []).map((l) => [l.uid, l]));
      // The list row keeps what changed on screen since load (stage, notes…);
      // the full record adds the long fields the list does not carry.
      const rows = shown.map((lead) => {
        const full = byUid.get(lead.uid);
        if (!full) return lead;
        const whole = normalizeLead(full);
        return { ...lead, pitch: whole.pitch, research: whole.research, openingLine: whole.openingLine, extra: whole.extra };
      });
      download(csvFilename(state.business), toCsv(rows, listTitles), 'text/csv');
      toast(`Exported ${rows.length} lead${rows.length === 1 ? '' : 's'}`);
    } catch (error) {
      toast(error?.message || 'Could not export');
    } finally {
      exportBtn.disabled = false;
    }
  });
  actions.appendChild(exportBtn);

  // Quick personalization: the coded leads (S1…, B1…, F1…) one by one, to open,
  // look at and mark while Andy dictates his notes in the LEADS chat.
  const cullBtn = el('button', 'chip-btn', 'Quick personalization');
  cullBtn.type = 'button';
  cullBtn.title = 'Open each coded lead\'s site, mark it, dictate your notes by its code';
  // Agencies are culled only from their own tab, client lists never with them (13 Nov).
  // The Travel stays only from the Travel list tab: Andy's own list never sits
  // beside the outreach lists (13 Nov).
  cullBtn.addEventListener('click', () => openCulling(
    leads.filter((l) => (state.business === AGENCIES) === (l.business === AGENCIES)
      && (state.business === TRAVEL_TAB) === isPersonalDataset(l.dataset)
      // An address that unsubscribed or bounced is never culled for outreach (0027).
      && !l.suppressed),
    { onChanged: () => refresh() },
  ));
  actions.appendChild(cullBtn);

  head.appendChild(actions);
  fragment.appendChild(head);

  function openProfile() {
    openProfileEditor(profile, (saved) => { profile = saved; });
  }

  /* ---------------- nothing imported yet ---------------- */

  if (!leads.length) {
    const card = el('section', 'card');
    card.appendChild(emptyState(
      'No leads imported yet',
      'The lists are on disk but nothing has been loaded into the database, so there is nothing to work through.',
    ));
    card.appendChild(el(
      'p',
      'hint',
      'Load them with an authenticated POST to /api/leads/import, whose body is '
      + '{ "datasets": [ … ] } as scripts/import-leads.mjs reads them off disk. '
      + 'Then reload this page.',
    ));
    fragment.appendChild(card);
    teardown = null;
    return fragment;
  }

  /* ---------------- the phone's two panes (P6 block 3) ----------------
     On a phone the page stays still: « List » is the table (the one region
     that scrolls) under the business tabs and the search; « Summary » is the
     pipeline and attention cards, the actions and how the lists were built.
     The List count is the list's own: the « N shown » above the table. */
  let pane = 'list';
  const segBar = el('div', 'tabs leads-seg');
  segBar.setAttribute('role', 'tablist');
  segBar.setAttribute('aria-label', 'Leads');
  const segTabs = {};
  for (const [key, label] of [['list', 'List'], ['summary', 'Summary']]) {
    const tab = el('button', 'tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.seg = key;
    tab.appendChild(el('span', 'l', label));
    if (key === 'list') tab.appendChild(el('span', 'n', '0'));
    tab.addEventListener('click', () => showPane(key));
    segTabs[key] = tab;
    segBar.appendChild(tab);
  }
  fragment.appendChild(segBar);

  /* ---------------- tab strip ---------------- */

  const tabStrip = el('div', 'tabs');
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'Business');
  fragment.appendChild(tabStrip);

  function paintTabs() {
    clear(tabStrip);
    for (const tab of tabs) {
      const button = el('button', 'tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.business === tab.v));
      button.appendChild(document.createTextNode(tab.label));
      button.appendChild(el('span', 'n', String(tab.n)));
      button.addEventListener('click', () => {
        state.business = tab.v;
        state.tile = null;
        for (const dimension of DIMENSIONS) state.dims[dimension.field] = [];
        remember(TAB_KEY, tab.v);
        refresh();
      });
      tabStrip.appendChild(button);
    }
  }

  /* ---------------- layout ---------------- */

  const layout = el('div', 'leads');
  const side = el('aside', 'side');
  side.setAttribute('aria-label', 'Filters');
  const main = el('div');
  main.style.cssText = 'display:flex;flex-direction:column;gap:14px;min-width:0';
  layout.appendChild(side);
  layout.appendChild(main);
  fragment.appendChild(layout);

  /* ---------------- sidebar ---------------- */

  function tileRow({ className, pressed, swatch, glyph, label, count, hint, onClick }) {
    const row = el('button', `side-row${className ? ` ${className}` : ''}`);
    row.type = 'button';
    row.setAttribute('aria-pressed', String(pressed));
    if (hint) row.title = hint;
    row.appendChild(swatch ? el('i', 'sw') : el('span', 'g', glyph || ''));
    row.appendChild(el('span', null, label));
    row.appendChild(el('span', 'n', String(count)));
    row.addEventListener('click', onClick);
    return row;
  }

  function setTile(value) {
    state.tile = state.tile === value ? null : value;
    refresh();
    // On a phone the tiles are in Summary: show the list they just filtered.
    if (isPhone()) showPane('list');
  }

  function paintSide() {
    clear(side);
    const scoped = leads.filter((lead) => state.business === 'all' || lead.business === state.business);
    const counts = stageCounts(scoped);
    const attention = attentionCounts(scoped, filterCtx());

    const pipeline = el('section', 'card');
    const pipeHead = el('div', 'side-head');
    pipeHead.appendChild(el('h3', 'h6', 'Pipeline'));
    pipeHead.appendChild(el('span', 'tot', `${inPlay(counts)} in play`));
    pipeline.appendChild(pipeHead);

    const dist = el('div', 'dist');
    dist.setAttribute('role', 'img');
    dist.setAttribute('aria-label', 'Stage distribution');
    for (const stage of STAGES) {
      if (!counts[stage.v]) continue;
      const slice = el('i', `st-${stage.v}`);
      slice.style.flex = String(counts[stage.v]);
      slice.title = `${stage.label} ${counts[stage.v]}`;
      dist.appendChild(slice);
    }
    pipeline.appendChild(dist);

    const stageList = el('div', 'side-list');
    for (const stage of STAGES) {
      stageList.appendChild(tileRow({
        className: `st-${stage.v}`,
        pressed: state.tile === stage.v,
        swatch: true,
        label: stage.label,
        count: counts[stage.v] || 0,
        hint: stage.v === 'won' ? wonShare(counts) : stage.hint,
        onClick: () => setTile(stage.v),
      }));
    }
    pipeline.appendChild(stageList);
    side.appendChild(pipeline);

    const attentionCard = el('section', 'card');
    const attentionHead = el('div', 'side-head');
    attentionHead.appendChild(el('h3', 'h6', 'Attention'));
    attentionCard.appendChild(attentionHead);

    const attentionList = el('div', 'side-list');
    for (const tile of TILES) {
      const count = attention[tile.v] || 0;
      attentionList.appendChild(tileRow({
        className: tile.v === 'due' && count > 0 ? 'hot' : '',
        pressed: state.tile === tile.v,
        glyph: tile.glyph,
        label: tile.label,
        count,
        hint: tile.hint,
        onClick: () => setTile(tile.v),
      }));
    }
    attentionCard.appendChild(attentionList);
    side.appendChild(attentionCard);
  }

  /* ---------------- toolbar ---------------- */

  const toolbar = el('section', 'card leads-toolbar');
  toolbar.setAttribute('aria-label', 'Search and filters');
  main.appendChild(toolbar);

  const searchInput = el('input', 'search');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search names, cities, categories, pitch angles, research and notes…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', 'Search leads');
  searchInput.addEventListener('input', debounce(() => {
    state.q = searchInput.value;
    paintSide();
    paintPickers();
    paintRows();
  }, 130));
  // Words that only live in a lead's research or pitch: the list no longer
  // carries those (13 Nov), so the server searches the whole record and its
  // hits join the ones found here.
  searchInput.addEventListener('input', debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 3) { state.serverHits = null; return; }
    try {
      const found = await apiFetch(`/api/leads?only=uids&q=${encodeURIComponent(q)}`);
      if (searchInput.value.trim() !== q) return; // typed on since
      state.serverHits = { q, uids: new Set(found?.uids ?? []) };
      paintSide();
      paintPickers();
      paintRows();
    } catch { /* the local search still stands */ }
  }, 400));

  const pickerHost = el('div', 'picker');

  function paintToolbarShell() {
    clear(toolbar);
    const row = el('div', 'searchrow');
    row.appendChild(searchInput);
    row.appendChild(el('kbd', null, '/'));

    const sort = el('select', 'sortsel');
    sort.setAttribute('aria-label', 'Sort');
    for (const option of SORTS) {
      const node = el('option', null, option.label);
      node.value = option.v;
      if (option.v === state.sort) node.selected = true;
      sort.appendChild(node);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      remember(SORT_KEY, sort.value);
      paintRows();
    });
    row.appendChild(sort);

    const clearBtn = el('button', 'btn quiet small', 'Clear ×');
    clearBtn.type = 'button';
    clearBtn.hidden = !hasFilters(state);
    clearBtn.addEventListener('click', () => {
      state.q = '';
      searchInput.value = '';
      state.tile = null;
      for (const dimension of DIMENSIONS) state.dims[dimension.field] = [];
      refresh();
    });
    row.appendChild(clearBtn);

    // Phone only (CSS): the pickers live in a sheet behind one counted button.
    const chosenCount = DIMENSIONS.reduce((n, d) => n + state.dims[d.field].length, 0);
    const filtersBtn = el('button', `btn quiet small filters-btn${chosenCount ? ' on' : ''}`, chosenCount ? `Filters · ${chosenCount}` : 'Filters');
    filtersBtn.type = 'button';
    filtersBtn.setAttribute('aria-haspopup', 'dialog');
    filtersBtn.addEventListener('click', openFilterSheet);
    row.appendChild(filtersBtn);

    toolbar.appendChild(row);
    if (!filterSheet) toolbar.appendChild(pickerHost);
  }

  /** The filters as a sheet from the bottom of a phone: every list open, ticked
   *  in place; « Done », the backdrop or Escape close it and the pickers go
   *  back into the toolbar. */
  let filterSheet = null;
  function openFilterSheet() {
    if (filterSheet) return;
    const sheet = openModal({
      className: 'narrow filter-sheet',
      label: 'Filters',
      onClose: () => {
        filterSheet = null;
        toolbar.appendChild(pickerHost);
        paintPickers();
        paintToolbarShell();
      },
    });
    filterSheet = sheet;
    const headRow = el('div', 'filter-sheet__head');
    headRow.appendChild(el('h2', null, 'Filters'));
    const done = el('button', 'btn primary small', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => sheet.close());
    headRow.appendChild(done);
    // On a phone the sort and « Clear » live here too, so the search row keeps its room.
    const sortBlock = el('div', 'filter-sheet__sort');
    sortBlock.appendChild(el('p', 'eyebrow', 'Sort'));
    const sort = el('select', 'sortsel');
    sort.setAttribute('aria-label', 'Sort');
    for (const option of SORTS) {
      const node = el('option', null, option.label);
      node.value = option.v;
      if (option.v === state.sort) node.selected = true;
      sort.appendChild(node);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      remember(SORT_KEY, sort.value);
      paintRows();
    });
    sortBlock.appendChild(sort);
    const clearAll = el('button', 'btn quiet small', 'Clear all filters');
    clearAll.type = 'button';
    clearAll.hidden = !hasFilters(state);
    clearAll.addEventListener('click', () => {
      state.q = '';
      searchInput.value = '';
      state.tile = null;
      for (const dimension of DIMENSIONS) state.dims[dimension.field] = [];
      sheet.close();
      refresh();
    });
    sortBlock.appendChild(clearAll);
    sheet.modal.append(headRow, sortBlock, pickerHost);
    paintPickers();
  }

  /** One counted, multi-select dropdown per dimension — the old app's chips,
   *  in the shape the mockup's toolbar wants. */
  function paintPickers() {
    clear(pickerHost);
    for (const dimension of DIMENSIONS) {
      const options = dimOptions(leads, dimension, state, filterCtx());
      const chosen = state.dims[dimension.field];
      if (options.length < 2 && !chosen.length) continue;

      const details = el('details', `dd${chosen.length ? ' on' : ''}`);
      const summary = el('summary');
      summary.appendChild(document.createTextNode(dimension.label));
      if (chosen.length) summary.appendChild(el('span', 'n', String(chosen.length)));
      details.appendChild(summary);

      const menu = el('div', 'dd-menu');
      for (const option of options) {
        const on = chosen.includes(option.value);
        const button = el('button', 'dd-opt');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(on));
        button.appendChild(el('i', null, on ? '✓' : ''));
        button.appendChild(el('span', null, option.value));
        button.appendChild(el('span', 'n', String(option.count)));
        button.addEventListener('click', () => {
          const at = chosen.indexOf(option.value);
          if (at === -1) chosen.push(option.value); else chosen.splice(at, 1);
          paintSide();
          paintToolbarShell();
          paintPickers();
          paintRows();
          // Keep the dropdown you are working in open, so picking two values
          // in a row does not mean opening it twice.
          const again = pickerHost.querySelector(`details[data-dim="${dimension.field}"]`);
          if (again) again.open = true;
        });
        menu.appendChild(button);
      }
      details.dataset.dim = dimension.field;
      details.appendChild(menu);
      if (filterSheet) details.open = true;
      pickerHost.appendChild(details);
    }
  }

  // One dropdown open at a time, and a click anywhere else shuts it.
  const onDocumentClick = (event) => {
    if (!root.isConnected) { detach(); return; }
    if (event.target.closest('.dd') || filterSheet) return;
    for (const open of pickerHost.querySelectorAll('details[open]')) open.open = false;
  };

  /* ---------------- table ---------------- */

  const tableCard = el('section', 'card');
  tableCard.setAttribute('aria-label', 'Leads');
  main.appendChild(tableCard);

  function contactCell(lead) {
    const cell = el('td', 'c-contact');
    const route = CONTACT_LABEL[lead.contactType] || lead.contactType || '';
    const shown = lead.email || (isUrl(lead.contact) ? shortUrl(lead.contact) : lead.contact) || '—';
    const button = el('button');
    button.type = 'button';
    button.style.cssText = 'font:inherit;color:inherit;background:none;border:0;padding:0;text-align:left;cursor:pointer';
    button.title = 'Copy';
    button.appendChild(el('span', 'k', route));
    button.appendChild(document.createTextNode(shown));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      copyText(lead.email || lead.contact || '', route || 'Contact');
    });
    cell.appendChild(button);
    return cell;
  }

  function leadRow(lead, position) {
    const stage = STAGE_BY[lead.stage] || STAGE_BY.new;
    const row = el('tr', stage.v === 'won' || stage.v === 'passed' ? 'done' : '');
    row.tabIndex = 0;
    row.setAttribute('aria-selected', 'false');

    const starCell = el('td');
    starCell.style.width = '28px';
    const star = el('button', `starbtn${lead.starred ? ' on' : ''}`, lead.starred ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-label', `Star ${lead.name}`);
    star.setAttribute('aria-pressed', String(lead.starred));
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleStar(lead);
    });
    starCell.appendChild(star);
    row.appendChild(starCell);

    const stageCell = el('td', `st-${stage.v}`);
    stageCell.appendChild(el('span', 'stagepill', `${stage.glyph} ${stage.label}`));
    row.appendChild(stageCell);

    const who = el('td', 'who-cell');
    const name = el('b');
    if (state.business === 'all') name.appendChild(el('span', 'biz', lead.business));
    name.appendChild(document.createTextNode(lead.name));
    const verified = VERIFIED[lead.verified];
    if (verified && verified[0]) {
      const tick = el('span', 'verif', verified[0]);
      tick.style.color = verified[2];
      tick.title = verified[1];
      name.appendChild(tick);
    }
    who.appendChild(name);
    who.appendChild(el('small', null, [lead.subcategory, lead.city].filter(Boolean).join(' · ')));
    const sharing = inboxCount.get(String(lead.email || '').trim().toLowerCase()) ?? 0;
    if (sharing > 1) {
      const chip = el('small', 'inbox-shared', `Shared inbox · ${sharing} leads · one letter per inbox`);
      chip.title = 'Several leads share this address: write to it once, whichever lead it is filed under.';
      who.appendChild(chip);
    }
    if (lead.linkedinSentAt) {
      const chip = el('small', 'linkedin-sent', `LinkedIn sent · ${String(lead.linkedinSentAt).slice(0, 10)}`);
      chip.title = 'Andy messaged this lead on LinkedIn himself.';
      who.appendChild(chip);
    }
    const twins = samePerson.get(lead.uid) ?? [];
    if (twins.length) {
      const lists = [...new Set(twins.map((t) => listTitles[t.dataset] || t.dataset))].join(', ');
      const chip = el('small', 'inbox-shared', `Same person? · also in ${lists}`);
      chip.title = 'Another lead has this name. If it is the same doctor, write once and pass the other.';
      who.appendChild(chip);
    }
    row.appendChild(who);

    row.appendChild(el('td', null, lead.category));
    const where = el('td', 'c-dim', lead.country || '');
    if (lead.area && lead.area !== lead.country) where.appendChild(el('small', null, lead.area));
    row.appendChild(where);
    row.appendChild(contactCell(lead));

    const fitCell = el('td');
    const fit = el('span', 'fit');
    fit.appendChild(el('span', 'score', String(lead.scoreLabel || lead.score)));
    fit.appendChild(el('span', `tierpill ${tierClass(lead.tier)}`, lead.tier));
    fitCell.appendChild(fit);
    row.appendChild(fitCell);

    const seen = openInfo(opens[lead.uid]);
    const due = dueReason(lead);
    const touchedCell = el('td', `c-touched${seen ? ' seen' : due ? ' due' : ''}`);
    if (seen) {
      touchedCell.textContent = openedToday(opens[lead.uid])
        ? '◉ opened today'
        : `◉ opened ${relTime(seen.last)}`;
      touchedCell.title = `Opened ${seen.count} time${seen.count === 1 ? '' : 's'}, first ${relTime(seen.first)}`;
    } else {
      touchedCell.textContent = due || (lead.updatedAt ? relTime(lead.updatedAt) : '—');
      if (due) touchedCell.title = 'Follow-up due';
    }
    row.appendChild(touchedCell);

    const open = () => openPopup(position);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    return row;
  }

  /* The table draws its first rows at once and the rest as they scroll into
   * view (13 Nov): 4,600 rows took the screen ~1 s to build on every filter
   * change. A redraw after one lead changed keeps what was drawn and where the
   * list was scrolled to. */
  let drawn = 0;
  let lastWrap = null;
  function paintRows({ keepPlace = false } = {}) {
    const keep = keepPlace && lastWrap ? { count: drawn, top: lastWrap.scrollTop } : null;
    visible = visibleLeads(leads, state, filterCtx());
    const scope = leads.filter((lead) => state.business === 'all' || lead.business === state.business).length;

    clear(tableCard);
    const eyebrow = el('p', 'eyebrow');
    eyebrow.appendChild(document.createTextNode(
      `${visible.length} shown${visible.length !== scope ? ` of ${scope}` : ''}`,
    ));
    eyebrow.appendChild(el('span', null, SORTS.find((s) => s.v === state.sort)?.label || 'Best fit first'));
    tableCard.appendChild(eyebrow);

    if (!visible.length) {
      const again = el('button', 'btn quiet', 'Clear filters');
      again.type = 'button';
      again.addEventListener('click', () => {
        state.q = '';
        searchInput.value = '';
        state.tile = null;
        for (const dimension of DIMENSIONS) state.dims[dimension.field] = [];
        refresh();
      });
      tableCard.appendChild(emptyState(
        'No leads match',
        'Release a stage or an attention filter, drop a dropdown, or clear the search.',
        again,
      ));
      return;
    }

    const wrap = el('div', 'tablewrap');
    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const column of ['', 'Status', 'Lead', 'Category', 'Country', 'Contact', 'Fit', 'Touched']) {
      headRow.appendChild(el('th', null, column));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const body = el('tbody');
    drawn = 0;
    const drawMore = (upTo) => {
      const end = Math.min(visible.length, upTo);
      const rows = document.createDocumentFragment();
      for (; drawn < end; drawn += 1) rows.appendChild(leadRow(visible[drawn], drawn));
      body.appendChild(rows);
    };
    drawMore(Math.max(ROWS_FIRST, keep?.count ?? 0));
    table.appendChild(body);
    wrap.appendChild(table);
    if (drawn < visible.length && typeof window !== 'undefined') {
      // Once a row some way before the last one drawn has come into view, or
      // been scrolled past (a scrollbar drag jumps), the next rows are drawn.
      // The list scrolls in its card on a desktop and with the page on a phone,
      // so both are listened to.
      let pending = false;
      const check = () => {
        pending = false;
        if (!body.isConnected) { stop(); return; }
        while (drawn < visible.length) {
          const near = body.children[Math.max(0, drawn - ROWS_AHEAD)];
          if (!near || near.getBoundingClientRect().top > window.innerHeight) break;
          drawMore(drawn + ROWS_MORE);
        }
        if (drawn >= visible.length) stop();
      };
      const onScroll = () => { if (!pending) { pending = true; requestAnimationFrame(check); } };
      const stop = () => {
        wrap.removeEventListener('scroll', onScroll);
        window.removeEventListener('scroll', onScroll);
      };
      wrap.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
    } else {
      drawMore(visible.length);
    }
    tableCard.appendChild(wrap);
    lastWrap = wrap;
    segTabs.list.querySelector('.n').textContent = String(visible.length);
    wrap.classList.toggle('scroll-region', pane === 'list');
    // The list scrolls inside its card; the filters above it stay put.
    fillViewport(wrap, { bottom: 110 }); // room for the key hints under it
    if (keep) requestAnimationFrame(() => requestAnimationFrame(() => { wrap.scrollTop = keep.top; }));

    const hints = el('div', 'keyhints');
    for (const [key, what] of [['/', 'search'], ['j k', 'move'], ['↵', 'open'], ['1–8', 'stage'], ['s', 'star'], ['esc', 'close']]) {
      const hint = el('span');
      hint.appendChild(el('kbd', null, key));
      hint.appendChild(document.createTextNode(what));
      hints.appendChild(hint);
    }
    tableCard.appendChild(hints);
  }

  /* ---------------- how each list was built ---------------- */

  if (datasetMeta.length) {
    const note = el('details', 'lists-note');
    note.appendChild(el('summary', null, 'How each list was built, and how it is scored'));
    for (const meta of datasetMeta) {
      const card = el('section', 'card');
      card.appendChild(el('p', 'eyebrow', `${meta.business} · ${meta.row_count ?? ''} leads · collected ${meta.collected || '—'}`));
      card.appendChild(el('p', 'value', meta.title || meta.key));
      if (meta.subtitle) card.appendChild(el('p', null, meta.subtitle));
      if (meta.method) {
        const line = el('p');
        line.appendChild(el('b', null, 'Method. '));
        line.appendChild(document.createTextNode(meta.method));
        card.appendChild(line);
      }
      if (meta.scoring) {
        const line = el('p');
        line.appendChild(el('b', null, 'Scoring. '));
        line.appendChild(document.createTextNode(meta.scoring));
        card.appendChild(line);
      }
      note.appendChild(card);
    }
    main.appendChild(note);
  }

  /* ---------------- actions ---------------- */

  async function toggleStar(lead) {
    try {
      const body = await apiFetch(`/api/leads/${lead.uid}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred: !lead.starred }),
      });
      if (body?.lead) applyLead(normalizeLead(body.lead));
    } catch (error) {
      toast(errorText(error));
    }
  }

  function applyLead(next) {
    const at = leads.findIndex((lead) => lead.uid === next.uid);
    if (at !== -1) leads[at] = next;
    paintSide();
    paintRows({ keepPlace: true });
  }

  function openPopup(position) {
    if (!visible[position]) return;
    openLeadPopup(visible, position, {
      listTitle,
      crumbTitle,
      navigate: ctx?.navigate,
      profile: () => profile,
      openProfile,
      gmail: () => gmailInfo,
      reviewFor,
      onReviewsChanged: reloadReviews,
      onLeadChanged: (lead) => applyLead(lead),
      onOpens: (uid, timestamps) => {
        opens[uid] = timestamps;
        paintSide();
      },
    });
  }

  function step(delta) {
    if (!visible.length) return;
    const at = delta > 0 ? 0 : visible.length - 1;
    openPopup(at);
  }

  function refresh() {
    paintTabs();
    paintSide();
    paintToolbarShell();
    paintPickers();
    paintRows();
  }

  /* ---------------- keyboard ---------------- */

  const onKeydown = (event) => {
    if (!root.isConnected) { detach(); return; }
    if (document.querySelector('.scrim')) return; // the popup owns the keyboard
    if (document.querySelector('.cull')) return; // so does Quick personalization
    const tag = (event.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (event.key === 'Escape' && typing) { event.target.blur(); return; }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === '/') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); step(1); return; }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); step(-1); return; }
    if (event.key === 'Enter' || event.key === 'o') { event.preventDefault(); openPopup(0); }
  };

  function detach() {
    closeCulling();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onDocumentClick);
    phoneQuery?.removeEventListener?.('change', placeActions);
    if (teardown === detach) teardown = null;
  }

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick);
  teardown = detach;

  /* ---------------- first paint ---------------- */

  // /leads?lead=<uid> — a warm-lead mission (or a report) points at one lead.
  // Every list and no filter, so the lead is on screen; then it opens.
  const wanted = new URLSearchParams(window.location.search).get('lead');
  const linked = wanted && leads.some((lead) => lead.uid === wanted);
  if (linked) {
    state.business = 'all';
    state.tile = null;
    state.q = '';
    for (const field of Object.keys(state.dims)) state.dims[field] = [];
  }
  // /leads?tile=due — Home's "Follow up N leads" row: every list, that tile on.
  // /leads?business=Travel%20trip — the morning briefing opens a list's own tab.
  const wantedBusiness = new URLSearchParams(window.location.search).get('business');
  if (!linked && wantedBusiness && leads.some((lead) => lead.business === wantedBusiness)) {
    state.business = wantedBusiness;
    state.tile = null;
  }
  const wantedTile = new URLSearchParams(window.location.search).get('tile');
  if (!linked && TILES.some((tile) => tile.v === wantedTile)) {
    state.business = 'all';
    state.tile = wantedTile;
  }

  const root = el('div', 'phone-frame leads-screen');
  const outreachTabs=el('div','tabs ow-db-tabs');
  const overview=el('button','btn small','Outreach overview');overview.type='button';overview.addEventListener('click',()=>ctx.navigate('/outreach'));
  const database=el('button','btn small','Database');database.type='button';database.setAttribute('aria-current','page');
  outreachTabs.append(overview,database);root.appendChild(outreachTabs);
  root.appendChild(fragment);
  function showPane(key) {
    pane = key;
    root.dataset.seg = key;
    for (const [k, tab] of Object.entries(segTabs)) tab.setAttribute('aria-selected', String(k === key));
    lastWrap?.classList.toggle('scroll-region', key === 'list');
    layout.classList.toggle('scroll-region', key === 'summary');
  }
  showPane(pane);
  // On a phone the actions belong to Summary, under the two tabs, so the tabs
  // never move between panes; on a wider screen they are back in the header.
  const placeActions = () => {
    if (isPhone()) { if (actions.parentNode !== layout) layout.prepend(actions); } else if (actions.parentNode !== head) head.appendChild(actions);
  };
  placeActions();
  const phoneQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE) : null;
  phoneQuery?.addEventListener?.('change', placeActions);
  refresh();
  if (linked) {
    setTimeout(() => {
      const at = visible.findIndex((lead) => lead.uid === wanted);
      if (at !== -1 && root.isConnected) openPopup(at);
    }, 0);
  }

  // The mailbox, read on its own every ten minutes at most: when it moved a
  // stage or a follow-up date, the list is fetched and drawn again.
  autoSyncMailbox().then(async (result) => {
    if (!result || !(result.applied || result.updated) || !root.isConnected) return;
    const again = await apiFetch('/api/leads');
    leads.splice(0, leads.length, ...(again?.leads ?? []).map(normalizeLead));
    refresh();
  }).catch(() => {});

  // The pixel's timestamps are per lead, so only the leads that could have
  // been opened are asked about — everything from `sent` onwards, most
  // recently touched first, and never more than the sweep limit.
  sweepOpens();

  async function sweepOpens() {
    const sentIdx = STAGE_BY.sent.idx;
    const candidates = leads
      .filter((lead) => (STAGE_BY[lead.stage]?.idx ?? 0) >= sentIdx)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, OPENS_SWEEP_LIMIT);
    if (!candidates.length) return;

    // One request for all of them (13 Nov); it used to be one per lead.
    let found = false;
    try {
      const body = await apiFetch('/api/leads/opens', {
        method: 'POST',
        readOnly: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uids: candidates.map((lead) => lead.uid) }),
      });
      for (const [uid, timestamps] of Object.entries(body?.opens ?? {})) {
        if (Array.isArray(timestamps) && timestamps.length) { opens[uid] = timestamps; found = true; }
      }
    } catch { /* the opens are never worth failing the screen for */ }
    if (found && root.isConnected) { paintSide(); paintRows(); }
  }

  // The Gmail bridge may come up after the screen did (the Mac woke, the
  // consent finished). One late re-check keeps the popup's buttons honest.
  setTimeout(async () => {
    if (!root.isConnected) return;
    forgetGmailStatus();
    const again = await gmailStatus({ refresh: true });
    if (again.connected !== gmailInfo.connected || again.expired !== gmailInfo.expired) {
      gmailInfo = again;
      paintConnect();
      syncBtn.title = again.connected
        ? 'Read your Sent and Inbox and move the leads it recognises'
        : 'Reading your mailbox needs HQ running on the Mac';
    }
  }, 4000);

  return root;
}
