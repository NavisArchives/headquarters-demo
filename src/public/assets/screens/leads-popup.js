// The lead popup — everything the old app's docked panel held, in HQ's
// modal. Left: the outreach draft (languages, who it is to, mode, subject,
// body, send), the angle for when they reply, why they are on the list.
// Right: the eight-stage status grid, the details, the follow-up date, the
// notes, and what has happened to this lead.
//
// Facts and state come from GET /api/leads/<uid>; every edit is a PATCH, a
// PUT or a DELETE against that lead's own routes. Nothing is remembered in
// the browser.

import { el, clear } from '../dom.js';
import { apiFetch, ApiError } from '../api.js';
import { openTimeline } from './outreach.js';
import { identity } from '../identity.js';
import { leadToProject } from './orders.js';
import {
  openModal, toast, copyText, copyRichHtml, openTab, openHtmlTab,
} from '../leads-ui.js';
import { createGmailDraft, authorizeUrl } from '../leads-gmail.js';
import { outreachRefusal } from '../personal-lists.js';
import { reviewCard, ensureRepliesCss } from '../replies-ui.js';
import {
  STAGES, STAGE_BY, MODES, SEGMENT_LABEL, VERIFIED, CONTACT_LABEL,
  normalizeLead, langsFor, segmentFor, stageStamp, relTime, formatDay, dueReason,
  openInfo, tierClass, applyGreetingName, gmailComposeUrl, searchUrl, letterHtml, COMPOSE_URL_LIMIT, contactHref, isUrl, shortUrl, isWebLead,
  dayPlus } from '../leads-lib.js';

const DRAFT_DEBOUNCE_MS = 600;
const NOTES_DEBOUNCE_MS = 400;
const NAME_DEBOUNCE_MS = 300;

const PASTE_KEYS = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V';

/** Leads whose `new` -> `looked` advance has already been sent this session. */
const advanced = new Set();

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.pending = () => timer !== null;
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

function errorText(error) {
  return error instanceof ApiError ? error.message : 'something went wrong';
}

function iconButton(glyph, label, onClick) {
  const button = el('button', 'x', glyph);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function sectionHead(title, action) {
  const head = el('div', 'sec-head');
  head.appendChild(el('h6', null, title));
  if (action) head.appendChild(action);
  return head;
}

function smallButton(label, onClick, className = 'btn quiet small') {
  const button = el('button', className, label);
  button.type = 'button';
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

/**
 * Open the popup on `leads[index]`. `host` is the screen's contract:
 *
 *   listTitle(dataset)     the full name of the list a lead came from
 *   crumbTitle(lead)       that name as the crumb wants it, without the repeat
 *   profile()              the current outreach profile, for the warning line
 *   openProfile()          open "Your details"
 *   gmail()                the cached /api/gmail/status answer
 *   onLeadChanged(lead)    a lead's state changed — repaint the table
 *   onOpens(uid, opens)    the pixel timestamps this lead turned out to have
 */
/** Subjects typed this session, to warn when one repeats within a batch. */
const usedSubjects = new Map();

export function openLeadPopup(leads, startIndex, host) {
  // Defined before the shell so the shell's own close (backdrop, Escape,
  // navigating away) can unhook the keyboard as well.
  let stopListening = () => {};
  const { modal, close } = openModal({
    className: 'lead-modal',
    label: 'Lead',
    onClose: () => stopListening(),
  });

  let index = startIndex;
  let lead = leads[index];
  let events = [];
  let replies = []; // what they wrote back, newest first (audit C11)
  let opens = [];
  let drafts = {};
  let composed = null;
  let loadError = null;
  let busy = false;

  // `toName` is the greeting name as typed, kept here so a re-render (a
  // stage change, a star) never throws away what is in the TO field.
  modal.appendChild(smallButton('Complete timeline', () => void openTimeline(lead.uid).catch(e=>toast(e.message)), 'btn quiet'));
  const ui = { mode: 'email', lang: null, toName: null, tab: 'overview', hook: '', subjectLine: '' };

  /* ---------------- the wire ---------------- */

  /** `uid` is taken when a save is scheduled, never when it fires: by then j/k
   *  may have moved the pop-up to the next lead (audit, 13 Nov). */
  async function patchState(patch, uid = lead.uid) {
    const body = await apiFetch(`/api/leads/${uid}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (body?.lead) {
      const fresh = normalizeLead(body.lead);
      const at = leads.findIndex((l) => l.uid === uid);
      if (at >= 0) leads[at] = fresh;
      if (lead.uid === uid) lead = fresh;
      host.onLeadChanged(fresh);
      return fresh;
    }
    return lead;
  }

  /** A lead the server sent back after a write: everywhere at once. */
  function takeLead(body, uid) {
    if (!body?.lead) return lead;
    const fresh = normalizeLead(body.lead);
    const at = leads.findIndex((l) => l.uid === uid);
    if (at >= 0) leads[at] = fresh;
    if (lead.uid === uid) lead = fresh;
    host.onLeadChanged(fresh);
    return fresh;
  }

  /* Andy says he sent it (audit A4, A5). Opening Gmail or writing a draft is
     not sending: the lead used to be marked « sent » right then, even from
     « in talks » or « won ». The server moves the stage forward only, logs
     « first email » or « follow-up », and sets the next date on the 7/14
     rhythm, so « Follow-up due » clears. The toast offers Undo. */
  const sendRequests = new Map();
  async function confirmSent(mode = ui.mode) {
    const uid = lead.uid;
    const kind = mode === 'followup' ? 'followup' : 'email';
    const requestKey=`${uid}:${kind}`;
    if(!sendRequests.has(requestKey))sendRequests.set(requestKey,crypto.randomUUID());
    try {
      const body = await apiFetch(`/api/leads/${uid}/sent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: kind, request_id: sendRequests.get(requestKey), subject: modal.querySelector('.subjbox')?.value ?? null, body: modal.querySelector('.bodybox')?.value ?? null, sender: composed?.from ?? null }),
      });
      const fresh = takeLead(body, uid);
      const next = fresh.followUp ? ` · next touch ${fresh.followUp}` : ' · no more follow-ups planned';
      toast(`${kind === 'followup' ? 'Follow-up' : 'Email'} recorded as sent${next}`, {
        action: { label: 'Undo', onClick: () => undoSent(uid, body.undo) },
      });
      if (lead.uid === uid) render();
    } catch (error) {
      toast(errorText(error));
    }
  }

  async function undoSent(uid, undo) {
    try {
      const body = await apiFetch(`/api/leads/${uid}/sent/undo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(undo),
      });
      takeLead(body, uid);
      toast('Undone: not recorded as sent');
      if (lead.uid === uid) render();
    } catch (error) {
      toast(errorText(error));
    }
  }

  /* « LinkedIn sent » (NIRMATA, 14 Nov): Andy sends the message himself on LinkedIn, in his
     name, and says so here. It never moves the email stage; the toast offers Undo. */
  async function confirmLinkedIn() {
    const uid = lead.uid;
    try {
      const body = await apiFetch(`/api/leads/${uid}/linkedin`, { method: 'POST' });
      takeLead(body, uid);
      toast('LinkedIn message recorded as sent', { action: { label: 'Undo', onClick: () => undoLinkedIn(uid, body.undo) } });
      if (lead.uid === uid) render();
    } catch (error) {
      toast(errorText(error));
    }
  }

  async function undoLinkedIn(uid, undo) {
    try {
      const body = await apiFetch(`/api/leads/${uid}/linkedin/undo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(undo),
      });
      takeLead(body, uid);
      toast('Undone: LinkedIn message not recorded');
      if (lead.uid === uid) render();
    } catch (error) {
      toast(errorText(error));
    }
  }

  /** After Gmail opened (or a draft was written): the one-tap way to say it went. */
  const sentAction = () => ({ label: 'Mark as sent', onClick: () => confirmSent() });

  async function fetchCompose(lang, mode) {
    const params = new URLSearchParams();
    if (lang) params.set('lang', lang);
    if (mode) params.set('mode', mode);
    // The one sentence that is about this prospect and nobody else. It is
    // kept in memory for the length of the pop-up: once the draft is saved
    // the sentence is inside the text, which is where it belongs.
    if (ui.hook) params.set('hook', ui.hook);
    // A local business's subject is Andy's own, like the hook (sector copy, 13 Nov).
    if (ui.subjectLine) params.set('subject', ui.subjectLine);
    return apiFetch(`/api/leads/${lead.uid}/compose?${params.toString()}`);
  }

  async function loadDetail() {
    const body = await apiFetch(`/api/leads/${lead.uid}`);
    lead = normalizeLead(body.lead);
    leads[index] = lead;
    events = body.lead?.events ?? [];
    opens = Array.isArray(body.opens) ? body.opens : [];
    replies = Array.isArray(body.replies) ? body.replies : [];
    drafts = body.drafts && typeof body.drafts === 'object' ? body.drafts : {};
    host.onOpens(lead.uid, opens);
    host.onLeadChanged(lead);
  }

  /* ---------------- rendering ---------------- */

  function renderHead() {
    const head = el('div', 'modal-head');
    const left = el('div');

    left.appendChild(el('div', 'crumb', `${lead.business} · ${host.crumbTitle(lead)}`));

    const title = el('h2', null, lead.name);
    left.appendChild(title);

    if (lead.website) {
      const link = el('a', 'dom', `${lead.domain || shortUrl(lead.website)} ↗`);
      link.href = lead.website;
      link.target = '_blank';
      link.rel = 'noreferrer';
      left.appendChild(link);
    }

    const row = el('div');
    row.style.cssText = 'display:flex;align-items:center;gap:9px;margin-top:7px;flex-wrap:wrap';

    const stage = STAGE_BY[lead.stage] || STAGE_BY.new;
    const stageWrap = el('span', `st-${lead.stage}`);
    stageWrap.appendChild(el('span', 'stagepill', `${stage.glyph} ${stage.label}`));
    row.appendChild(stageWrap);

    row.appendChild(el('span', `tierpill ${tierClass(lead.tier)}`, `${lead.tier} · ${lead.scoreLabel}`));

    const verified = VERIFIED[lead.verified];
    if (verified) {
      const badge = el('span', 'verif', `${verified[0] ? `${verified[0]} ` : ''}${verified[1]}`);
      badge.style.color = verified[2];
      badge.title = verified[1];
      row.appendChild(badge);
    }

    const star = el('button', `starbtn${lead.starred ? ' on' : ''}`, lead.starred ? '★' : '☆');
    star.type = 'button';
    star.title = 'Star (s)';
    star.setAttribute('aria-label', 'Star this lead');
    star.setAttribute('aria-pressed', String(lead.starred));
    star.addEventListener('click', () => toggleStar());
    row.appendChild(star);
    left.appendChild(row);

    head.appendChild(left);

    const nav = el('div', 'navbtns');
    const prev = iconButton('‹', 'Previous lead (←)', () => step(-1));
    prev.disabled = index <= 0;
    const next = iconButton('›', 'Next lead (→)', () => step(1));
    next.disabled = index >= leads.length - 1;
    nav.appendChild(prev);
    nav.appendChild(next);
    nav.appendChild(iconButton('✕', 'Close (Esc)', close));
    head.appendChild(nav);

    return head;
  }

  /* ---------- left column: the draft ---------- */

  function renderComposer() {
    const wrap = el('div', 'sec');
    const segment = segmentFor(lead);

    const refusal = outreachRefusal(lead);
    if (refusal) {
      wrap.appendChild(el('h6', null, 'Outreach draft'));
      wrap.appendChild(el('p', 'sendhelp', refusal));
      return wrap;
    }

    if (segment === 'source') {
      wrap.appendChild(el('h6', null, 'Outreach draft'));
      wrap.appendChild(el(
        'p',
        'sendhelp',
        'This is a prospecting source, not a company to pitch. Use it to find leads, then add them to a list.',
      ));
      return wrap;
    }

    const languages = langsFor(lead);
    const lang = languages.includes(ui.lang) ? ui.lang : languages[0];
    ui.lang = lang;

    const pills = el('div', 'langs');
    for (const code of languages) {
      const pill = el('button', null, code);
      pill.type = 'button';
      pill.setAttribute('aria-pressed', String(code === lang));
      pill.addEventListener('click', () => { ui.lang = code; reload({ composeOnly: true }); });
      pills.appendChild(pill);
    }
    wrap.appendChild(sectionHead('Outreach draft', pills));

    // TO — the greeting name, and the address it will actually go to.
    const to = el('div', 'torow');
    to.appendChild(el('span', 'lbl', 'To'));
    const toBox = el('div', 'to');
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = ui.toName ?? (drafts[lang]?.to_name || composed?.toName || lead.name);
    nameInput.placeholder = lead.name;
    nameInput.setAttribute('aria-label', 'Greeting name (defaults to the agency or brand)');
    toBox.appendChild(nameInput);
    const address = lead.email
      || (lead.phone ? `${lead.phone} · no email` : (lead.contact || 'no contact address'));
    toBox.appendChild(el('small', null, address));
    to.appendChild(toBox);
    wrap.appendChild(to);

    // Mode, and which template segment this lead falls into.
    const modeRow = el('div', 'moderow');
    const modes = el('div', 'modes');
    for (const mode of MODES) {
      const button = el('button', null, mode.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(mode.v === ui.mode));
      button.addEventListener('click', () => { ui.mode = mode.v; reload({ composeOnly: true }); });
      modes.appendChild(button);
    }
    modeRow.appendChild(modes);
    modeRow.appendChild(el('span', 'segname', SEGMENT_LABEL[segment] || segment));
    wrap.appendChild(modeRow);

    if (loadError) {
      toast(`The draft could not be composed: ${loadError}`);
      return wrap;
    }
    if (!composed) {
      wrap.appendChild(el('p', 'sendhelp', 'Composing…'));
      return wrap;
    }

    // Why this one, in a sentence. The templates are built around this line
    // and nothing ever filled it, so every website email went out identical
    // but for the name. Typing here rewrites the draft; leaving it empty
    // falls back to the line built from their town.
    const why = el('input', 'subjbox why-line');
    why.type = 'text';
    why.value = ui.hook || '';
    // Architects and local businesses: no email without Andy's own line.
    const sector = composed.sector || null;
    why.placeholder = sector
      ? 'Your one line about their site (required): it finishes « En parcourant votre site, … »'
      : 'Why them, in one sentence — leave empty for the default';
    why.setAttribute('aria-label', 'Why this prospect');
    why.addEventListener('change', () => {
      const next = why.value.trim();
      if (next === (ui.hook || '')) return;
      ui.hook = next;
      reload({ composeOnly: true });
    });
    if (ui.mode !== 'followup' || !sector) wrap.appendChild(why);

    if ((sector === 'local' || sector === 'clinic') && ui.mode !== 'dm') {
      const line = el('input', 'subjbox why-line');
      line.type = 'text';
      line.value = ui.subjectLine || '';
      line.placeholder = ui.mode === 'followup'
        ? 'The subject your first email had (required)'
        : 'Subject: a few words on the problem you saw (required, different for each lead)';
      line.setAttribute('aria-label', 'Subject line for this lead');
      line.addEventListener('change', () => {
        const next = line.value.trim();
        if (next === (ui.subjectLine || '')) return;
        ui.subjectLine = next;
        const key = next.toLowerCase();
        const other = key && ui.mode !== 'followup' ? usedSubjects.get(key) : null;
        if (other && other !== lead.uid) toast('This subject is already on another lead in this batch: give each lead its own.');
        if (key && ui.mode !== 'followup') usedSubjects.set(key, lead.uid);
        reload({ composeOnly: true });
      });
      wrap.appendChild(line);
    }

    const subject = el('input', 'subjbox');
    subject.type = 'text';
    subject.value = composed.subject || '';
    subject.placeholder = 'Subject';
    subject.setAttribute('aria-label', 'Subject');
    if (ui.mode !== 'dm') wrap.appendChild(subject);

    const body = el('textarea', 'bodybox');
    body.value = composed.body || '';
    body.spellcheck = true;
    body.setAttribute('aria-label', 'Message');
    wrap.appendChild(body);

    // Nothing is said beside the buttons: autosave is silent, and anything
    // worth telling arrives as a toast.
    const savedNote = { set textContent(v) { /* silent */ } };

    /* ---- the draft is saved per language, as the API stores it ---- */
    const designed = lead.business === 'UGC' && ui.mode === 'email';
    let htmlFresh = true;

    // The lead, language and text are taken when the save is scheduled (audit, 13 Nov).
    const saveDraft = debounce(async (uid, lang, draft) => {
      savedNote.textContent = 'Saving…';
      try {
        await apiFetch(`/api/leads/${uid}/draft/${lang}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        // The pop-up has moved on to another lead: the save landed where it belongs, nothing to repaint.
        if (uid !== lead.uid) return;
        drafts[lang] = draft;
        savedNote.textContent = 'Draft saved';
        // The designed email is built on the worker from the saved draft, so
        // it is only trustworthy once the save has landed. Refreshing it here
        // keeps Open in Gmail and Preview synchronous when they are pressed.
        const fresh = await fetchCompose(ui.lang, ui.mode);
        composed = { ...composed, designedHtml: fresh.designedHtml };
        htmlFresh = true;
        paintActions();
      } catch (error) {
        toast(`Draft not saved: ${errorText(error)}`);
      }
    }, DRAFT_DEBOUNCE_MS);

    function markEdited() {
      htmlFresh = false;
      savedNote.textContent = 'Saving…';
      paintActions();
      saveDraft(lead.uid, ui.lang, { subject: subject.value, body: body.value, to_name: nameInput.value.trim() });
    }

    subject.addEventListener('input', markEdited);
    body.addEventListener('input', markEdited);

    const renameSoon = debounce(() => {
      body.value = applyGreetingName(body.value, nameInput.value, ui.lang);
      markEdited();
    }, NAME_DEBOUNCE_MS);
    nameInput.addEventListener('input', () => { ui.toName = nameInput.value; renameSoon(); });

    /* ---- the buttons ---- */
    const actions = el('div', 'sendrow');

    const gmail = host.gmail();

    /** What the bridge needs to write the draft: the designed HTML for a UGC
     *  email, the plain message for a DM or a follow-up. */
    function draftPayload() {
      return {
        uid: lead.uid,
        to: lead.email || '',
        subject: subject.value,
        body: body.value,
        html: designed ? (composed.designedHtml || '') : '',
        // The brand's address (from the compose API) is the draft's From; the
        // person's profile address is only a fallback for an old response.
        account: composed.from || host.profile().email || '',
      };
    }

    /** The lead has gone out: move it to sent, and schedule the next touch
     *  in the same breath. Scheduling here rather than leaving it to the
     *  owner is the whole point — before this, not one lead of 540 carried a
     *  follow-up date, so every first email was also the last. An existing
     *  date is never overwritten. */
    /** Write the draft. A draft waiting in Gmail has not been sent: the lead
     *  moves only when Andy says it went (Mark as sent). */
    async function writeGmailDraft() {
      return createGmailDraft(draftPayload());
    }

    function noAddressNote() {
      return lead.email
        ? ''
        : ` This lead has no published email, so add one in Gmail — its route is ${CONTACT_LABEL[lead.contactType] || lead.contactType}.`;
    }

    /** With no Gmail connection: the message goes on the clipboard (the
     *  designed email as rich text where there is one) and Gmail's compose
     *  window opens already holding the plain text. The old app's route. */
    /**
     * Open Gmail with the message already written: recipient, subject and
     * body all carried in the URL.
     *
     * The one thing the URL cannot carry is the sender. Gmail ignores a
     * `from` parameter, so the window opens as the account's default address
     * and the alias has to be switched by hand. Since sending a Realis email
     * from the personal address is exactly the mistake that must not happen,
     * the message names the address to pick rather than leaving it implied.
     */
    function pasteIntoCompose() {
      const html = designed ? composed.designedHtml : '';
      const url = gmailComposeUrl(lead.email, subject.value, body.value);
      // Past the URL limit the body would arrive truncated, which is worse
      // than being asked to paste it, so that case falls back deliberately.
      const tooLong = url.length > COMPOSE_URL_LIMIT;
      const copied = html
        ? copyRichHtml(html)
        : (tooLong ? copyText(body.value, 'Email') : false);

      const win = openTab(tooLong && !html
        ? gmailComposeUrl(lead.email, subject.value, '')
        : url);
      if (!win) {
        toast('Your browser blocked the Gmail window. Allow pop-ups for this page, then press Open in Gmail again.');
        return;
      }

      const from = composed.from ? `Set From to ${composed.from}` : 'Check the From address';
      if (html) {
        toast(copied
          ? `Opened with the message ready. ${from}, press ${PASTE_KEYS} for the designed version, then Send.`
          : `Opened with the plain text. ${from}. For the design, use Preview, select it all, copy, and paste over it.`, { action: sentAction() });
      } else if (tooLong) {
        toast(`That message is too long for the link. ${from}, press ${PASTE_KEYS} to paste it, then Send.`, { action: sentAction() });
      } else {
        toast(`Opened in Gmail, ready to send. ${from}, then Send.`, { action: sentAction() });
      }
    }

    const openGmail = el('button', 'btn primary', 'Open in Gmail');
    openGmail.type = 'button';
    openGmail.addEventListener('click', () => {
      if (openGmail.disabled) return;
      // Always the plain compose window: address, subject and text already in
      // it, in Andy's Gmail. No API, no stored login, nothing that can expire.
      pasteIntoCompose();
    });
    actions.appendChild(openGmail);

    // The same compose window with only the address and subject in it; the
    // email itself goes to the clipboard as a clean letter, pasted with ⌘V.
    const copyTemplate = el('button', 'btn', 'Copy template');
    copyTemplate.type = 'button';
    copyTemplate.addEventListener('click', () => {
      if (copyTemplate.disabled) return;
      const copied = copyRichHtml(letterHtml(body.value, composed.pixelUrl));
      const win = openTab(gmailComposeUrl(lead.email, subject.value, ''));
      if (!win) {
        toast('Your browser blocked the Gmail window. Allow pop-ups for this page, then press Copy template again.');
        return;
      }
      const from = composed.from ? `Set From to ${composed.from}` : 'Check the From address';
      toast(copied
        ? `Template copied. Click in the message, press ${PASTE_KEYS}, ${from.charAt(0).toLowerCase() + from.slice(1)}, then Send.`
        : 'Gmail opened, but the template could not be copied. Use Open in Gmail instead.', copied ? { action: sentAction() } : {});
    });
    actions.appendChild(copyTemplate);

    // Sent it from Gmail a while ago: say so here, whenever (the toast fades).
    if (ui.mode !== 'dm') actions.appendChild(smallButton('Mark as sent', () => confirmSent(), 'btn quiet'));
    else actions.appendChild(smallButton('Mark as sent on LinkedIn', () => confirmLinkedIn(), 'btn quiet'));

    // The same write, without stealing the tab — for building a batch of
    // drafts and going through them in Gmail afterwards.
    const draftOnly = smallButton('Draft only', async () => {
      if (draftOnly.disabled) return;
      draftOnly.disabled = true;
      try {
        const result = await writeGmailDraft();
        toast(`Draft saved in ${result?.email || gmail.email || 'Gmail'}, waiting in your drafts.${noAddressNote()}`, { action: sentAction() });
        render();
      } catch (error) {
        toast(errorText(error));
      } finally {
        draftOnly.disabled = false;
        paintActions();
      }
    }, 'btn quiet');
    // Draft only needed the Gmail API bridge; Open in Gmail covers sending.

    // Look them up without leaving the lead: the registers are thin, and the
    // fastest way to know whether someone really has a site is to search.
    actions.appendChild(smallButton('Search', () => openTab(searchUrl(lead)), 'btn quiet'));

    const preview = smallButton('Preview', () => {
      if (!composed.designedHtml) { toast('Nothing to preview yet'); return; }
      openHtmlTab(composed.designedHtml);
    }, 'btn quiet');
    // Plain-text leads have no designed version to preview.
    if (designed) actions.appendChild(preview);

    actions.appendChild(smallButton(
      'Copy',
      () => copyText(body.value, ui.mode === 'dm' ? 'Message' : 'Email'),
      'btn quiet',
    ));

    actions.appendChild(smallButton('Reset', async () => {
      saveDraft.cancel();
      try {
        await apiFetch(`/api/leads/${lead.uid}/draft/${ui.lang}`, { method: 'DELETE' });
      } catch (error) {
        // A lead with no saved draft answers 404 — there is simply nothing to
        // undo, and recomposing below is still the right thing to do.
        if (!(error instanceof ApiError) || error.status !== 404) {
          toast(errorText(error));
          return;
        }
      }
      delete drafts[ui.lang];
      toast('Draft reset');
      reload({ composeOnly: true });
    }, 'btn link'));

    wrap.appendChild(actions);

    /* ---- what the buttons can do right now ---- */
    function paintActions() {
      // Both routes send what has been saved, so neither is offered while a
      // keystroke is still on its way to the draft endpoint.
      const saving = saveDraft.pending() || !htmlFresh;

      openGmail.disabled = !lead.email || saving;
      openGmail.title = !lead.email
        ? 'This lead has no published email address'
        : (saving ? 'Saving your draft…' : 'Opens Gmail with the email already written');

      copyTemplate.disabled = !lead.email || saving;
      copyTemplate.title = !lead.email
        ? 'This lead has no published email address'
        : (saving ? 'Saving your draft…' : 'Opens Gmail with the address filled in and copies the template to paste');

      preview.disabled = !composed.designedHtml || saving;
      preview.title = saving ? 'Saving your draft…' : 'Open the designed email in a new tab';
    }


    paintActions();
    return wrap;
  }

  /**
   * "What they said" — the reading of this lead's reply, and the proposals it
   * produced. It is here because this is where you decide what to do about
   * them; accepting still goes through the missions API, exactly as it does
   * on the Missions screen.
   */
  function renderReview() {
    const review = host.reviewFor ? host.reviewFor(lead) : null;
    if (!review) return null;
    ensureRepliesCss();
    const wrap = el('div', 'sec');
    wrap.appendChild(sectionHead('What they said'));
    wrap.appendChild(reviewCard(review, async () => {
      if (host.onReviewsChanged) await host.onReviewsChanged();
      render();
    }, { showHead: false }));
    return wrap;
  }

  function renderAngle() {
    if (!lead.pitch) return null;
    const wrap = el('div', 'sec');
    wrap.appendChild(sectionHead(
      'Angle · for when they reply',
      smallButton('Copy', () => copyText(lead.pitch, 'Angle')),
    ));
    wrap.appendChild(el('div', 'angle', lead.pitch));
    return wrap;
  }

  function renderWhy() {
    if (!lead.evidence && !lead.research) return null;
    const wrap = el('div', 'sec');
    wrap.appendChild(el('h6', null, 'Why they are on the list'));
    const why = el('div', 'why');
    if (lead.evidence) {
      const line = el('p');
      line.appendChild(el('b', null, 'Evidence. '));
      line.appendChild(document.createTextNode(lead.evidence));
      if (lead.evidenceUrl) {
        line.appendChild(document.createTextNode(' '));
        const source = el('a', null, 'Source ↗');
        source.href = lead.evidenceUrl;
        source.target = '_blank';
        source.rel = 'noreferrer';
        line.appendChild(source);
      }
      why.appendChild(line);
    }
    if (lead.research) {
      const line = el('p');
      line.appendChild(el('b', null, 'Research. '));
      line.appendChild(document.createTextNode(lead.research));
      why.appendChild(line);
    }
    wrap.appendChild(why);
    return wrap;
  }

  /* ---------- right column ---------- */

  function renderStatus() {
    const wrap = el('div', 'sec');
    wrap.appendChild(el('h6', null, 'Status'));

    const grid = el('div', 'stagegrid');
    for (const stage of STAGES) {
      const button = el('button', `stagebtn st-${stage.v}`);
      button.type = 'button';
      button.title = `${stage.hint} (${stage.key})`;
      button.setAttribute('aria-pressed', String(lead.stage === stage.v));
      button.appendChild(el('i', 'sw'));
      button.appendChild(el('span', null, stage.label));
      const stamped = stageStamp(lead, stage.v, events);
      if (stamped) button.appendChild(el('span', 'd', relTime(stamped)));
      button.addEventListener('click', () => setStage(stage.v));
      grid.appendChild(button);
    }
    wrap.appendChild(grid);

    const follow = el('div', 'follow');
    const label = el('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted)';
    label.appendChild(document.createTextNode('Follow-up'));
    const date = el('input');
    date.type = 'date';
    date.value = lead.followUp || '';
    date.setAttribute('aria-label', 'Follow-up date');
    date.addEventListener('change', () => guard(() => patchState({ follow_up: date.value || null })
      .then(() => { toast(date.value ? `Follow-up set for ${date.value}` : 'Follow-up cleared'); render(); })));
    label.appendChild(date);
    follow.appendChild(label);

    // Typing a date into a native picker for every lead is the kind of
    // friction that quietly stops a follow-up ever being set. Three presets
    // cover almost every case; the picker stays for the rest.
    for (const [days, text] of [[3, '+3d'], [7, '+1w'], [14, '+2w']]) {
      follow.appendChild(smallButton(text, () => {
        const when = dayPlus(days);
        return guard(() => patchState({ follow_up: when })
          .then(() => { toast(`Follow-up set for ${when}`); render(); }));
      }));
    }

    if (lead.followUp) {
      follow.appendChild(smallButton('Clear', () => guard(() => patchState({ follow_up: null })
        .then(() => { toast('Follow-up cleared'); render(); }))));
    }
    const due = dueReason(lead);
    if (due) follow.appendChild(el('span', 'duepill', `◷ Due now · ${due}`));

    const seen = openInfo(opens);
    if (seen) {
      const pill = el(
        'span',
        'seenpill',
        `◉ Opened ${seen.count}× · last ${relTime(seen.last)}`,
      );
      pill.title = 'Counted when a mail client loads the image in your email';
      follow.appendChild(pill);
    }
    wrap.appendChild(follow);
    return wrap;
  }

  function renderDetails() {
    const wrap = el('div', 'sec');
    wrap.appendChild(el('h6', null, 'Details'));

    const rows = [];
    const route = CONTACT_LABEL[lead.contactType] || lead.contactType || 'Contact';
    rows.push(['Contact', lead.contact || lead.email || '—', contactHref(lead)]);
    if (lead.email && lead.email !== lead.contact) rows.push(['Email', lead.email, `mailto:${lead.email}`]);
    if (lead.phone) rows.push(['Phone', lead.phone, `tel:${lead.phone.replace(/[^\d+]/g, '')}`]);
    if (lead.contactAlt) rows.push(['Also', lead.contactAlt, isUrl(lead.contactAlt) ? lead.contactAlt : null]);
    rows.push(['Route', route, null]);
    rows.push(['Category', [lead.category, lead.subcategory].filter(Boolean).join(' · '), null]);
    rows.push(['Area', [lead.city, lead.area].filter(Boolean).join(' · ') || '—', null]);
    if (lead.region) rows.push(['Region', lead.region, null]);
    rows.push(['Country', lead.country, null]);
    rows.push(['Languages', lead.languages.join(' / ') || '—', null]);
    rows.push(['Website', lead.domain || '—', lead.website || null]);
    rows.push(['List', host.listTitle(lead.dataset), null]);

    // `extra` is whatever the list's own researcher wrote down. Some of it
    // became a column of its own at import ("Region", "Market"), so anything
    // that repeats a row already shown — by name or by value — is dropped
    // rather than printed twice under two headings.
    const shown = new Set(rows.map(([key]) => key.toLowerCase()));
    const values = new Set(rows.map(([, value]) => value));
    for (const [key, value] of Object.entries(lead.extra)) {
      const text = String(value);
      if (shown.has(key.toLowerCase()) || values.has(text)) continue;
      rows.push([key, text, null]);
      shown.add(key.toLowerCase());
      values.add(text);
    }

    rows.push(['Follow-up', lead.followUp || 'none set', null]);
    rows.push(['Touched', lead.updatedAt ? relTime(lead.updatedAt) : 'never', null]);

    const list = el('dl', 'kv');
    for (const [key, value, href] of rows) {
      list.appendChild(el('dt', null, key));
      const dd = el('dd');
      if (href) {
        const link = el('a', null, value);
        link.href = href;
        if (/^https?:/i.test(href)) { link.target = '_blank'; link.rel = 'noreferrer'; }
        dd.appendChild(link);
      } else {
        dd.textContent = value;
      }
      list.appendChild(dd);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function renderNotes() {
    const wrap = el('div', 'sec');
    const saved = el('span', 'saved-note', lead.notes ? 'Saved' : '');
    wrap.appendChild(sectionHead('Your notes', saved));

    const area = el('textarea', 'notesbox');
    area.value = lead.notes || '';
    area.placeholder = 'Anything you want to remember…';
    area.setAttribute('aria-label', 'Your notes about this lead');

    const save = debounce(async (uid, text) => {
      try {
        await patchState({ notes: text }, uid);
        saved.textContent = `Saved ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      } catch (error) {
        saved.textContent = errorText(error);
      }
    }, NOTES_DEBOUNCE_MS);

    area.addEventListener('input', () => { saved.textContent = 'Saving…'; save(lead.uid, area.value); });
    wrap.appendChild(area);
    return wrap;
  }

  function renderTimeline() {
    const wrap = el('div', 'sec');
    wrap.appendChild(el('h6', null, 'What has happened'));

    const entries = [];
    for (const event of events) {
      if (!event?.at) continue;
      let text = '';
      if (event.kind === 'stage') text = `Moved to ${STAGE_BY[event.detail]?.label || event.detail}`;
      else if (event.kind === 'star') text = event.detail === '1' ? 'Starred' : 'Unstarred';
      else if (event.kind === 'note') text = 'Notes edited';
      else if (event.kind === 'followup') text = event.detail ? `Follow-up set for ${event.detail}` : 'Follow-up cleared';
      else if (event.kind === 'opened') text = 'Opened your email';
      else if (event.kind === 'replied') text = 'They replied';
      else if (event.kind === 'linkedin') text = 'You messaged them on LinkedIn';
      else if (event.kind === 'bounced') text = 'An email to them bounced';
      else if (event.kind === 'not_sent') text = 'An email to them was never sent (Gmail limit)';
      else text = event.kind;
      entries.push({ at: event.at, text });
    }
    for (const at of opens) entries.push({ at, text: 'A mail client loaded the image in your email' });

    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const list = el('ol', 'timeline');
    if (!entries.length) {
      const item = el('li', 'tl');
      item.appendChild(el('span', 'when', '—'));
      item.appendChild(el('span', null, 'Nothing yet. Opening this lead is already its first move.'));
      list.appendChild(item);
    } else {
      for (const entry of entries.slice(0, 24)) {
        const item = el('li', 'tl');
        item.appendChild(el('span', 'when', `${formatDay(entry.at)} · ${relTime(entry.at)}`));
        item.appendChild(el('span', null, entry.text));
        list.appendChild(item);
      }
    }
    wrap.appendChild(list);
    return wrap;
  }

  /* ---------------- assembling ---------------- */

  /** Anything typed but not yet saved has to survive a repaint, so the
   *  editors are read back into `composed` before the DOM is thrown away. */
  function snapshot() {
    if (!composed) return;
    const subject = modal.querySelector('.subjbox');
    const body = modal.querySelector('.bodybox');
    if (subject || body) {
      composed = {
        ...composed,
        subject: subject ? subject.value : composed.subject,
        body: body ? body.value : composed.body,
      };
    }
  }

  /**
   * `fromServer` means `composed` was just replaced by a fresh compose, so
   * the editors on screen are the *old* draft and must not be read back over
   * it — that is what made Reset appear to do nothing. Every other repaint
   * (a stage change, a star, a follow-up) keeps what has been typed.
   */
  /* The panes behind the floating circles on the left of the pop-up. Each
     one is a small screen of its own; nothing scrolls except a pane's body
     when it has to. */
  const TABS = [
    { id: 'overview', glyph: 'i', label: 'Overview' },
    { id: 'email', glyph: '\u2709', label: 'Email' },
    { id: 'notes', glyph: '\u270E', label: 'Notes' },
  ];

  /* ---------- the overview: who they are, where they stand, what to do ---------- */
  function glance() {
    const web = isWebLead(lead);
    const chips = [];
    const brand = web ? identity().brandWeb : identity().brandUgc;
    chips.push({ t: brand, cls: 'g-brand', title: web ? `A website prospect — written as ${brand}` : `A UGC lead — written as ${brand}` });
    if (web) chips.push({ t: lead.domain ? `Has a site · ${lead.domain}` : 'No website', cls: lead.domain ? '' : 'g-warn' });
    else chips.push({ t: [lead.category, lead.subcategory].filter(Boolean).join(' · ') || 'Brand', cls: '' });
    if (lead.languages.length) chips.push({ t: lead.languages.join(' / '), cls: '' });
    const route = CONTACT_LABEL[lead.contactType] || lead.contactType;
    chips.push({ t: lead.email ? `Email · ${lead.email}` : (route ? `Reach by ${route}` : 'No contact'), cls: lead.email ? '' : 'g-warn' });
    if (lead.city || lead.country) chips.push({ t: [lead.city, lead.country].filter(Boolean).join(', '), cls: '' });
    return chips;
  }

  function nextStep() {
    const lang = langsFor(lead)[0];
    const web = isWebLead(lead);
    const what = web ? `the Realis note in ${lang}` : `the andyssarchives intro in ${lang}`;
    switch (lead.stage) {
      case 'new': return `Read who they are below, then send ${what}.`;
      case 'looked': return `You have looked at them — decide: send ${what}, or pass.`;
      case 'shortlist': return `Shortlisted — send ${what}.`;
      case 'sent': return lead.followUp ? `Sent — wait for a reply; follow up on ${lead.followUp}.` : 'Sent — wait for a reply, or set a follow-up date.';
      case 'replied': return 'They answered — read the reply and respond.';
      case 'talks': return 'In talks — keep the conversation moving.';
      case 'won': return 'Accepted — this one is a client now.';
      case 'passed': return 'Passed — nothing to do unless they come back.';
      default: return '';
    }
  }

  function renderOverview() {
    const pane = el('div', 'overview');
    const top = el('div', 'glance');
    for (const c of glance()) {
      const chip = el('span', `gchip ${c.cls}`.trim(), c.t);
      if (c.title) chip.title = c.title;
      top.appendChild(chip);
    }
    pane.appendChild(top);
    const step = nextStep();
    if (step) {
      const next = el('div', 'nextstep');
      next.appendChild(el('span', 'nextstep__k', 'Next'));
      next.appendChild(el('span', 'nextstep__v', step));
      const go = el('button', 'btn primary small', 'Write the email');
      go.type = 'button';
      go.addEventListener('click', () => { ui.tab = 'email'; render(); });
      if (!['won', 'passed'].includes(lead.stage)) next.appendChild(go);

      // A lead that said yes becomes work: a client and an order, filled in
      // from what this row already knows.
      const make = el('button', 'btn small', 'Make it a project');
      make.type = 'button';
      make.title = 'Create the client and an order from this lead';
      make.addEventListener('click', () => leadToProject(lead, {
        navigate: (path) => { close(); host.navigate?.(path); },
        onChange: () => { reload(); },
      }));
      if (lead.stage !== 'passed') next.appendChild(make);
      pane.appendChild(next);
    }
    // Their reply, readable here and on a phone (audit C11, P7): it used to be
    // only a grey « replied » line, with the words themselves nowhere.
    if (replies.length) {
      const said = el('section', 'their-reply');
      const last = replies[0];
      said.appendChild(el('p', 'label', `Their reply · ${last.received_at ? relTime(last.received_at) : 'date unknown'}`));
      if (last.summary) said.appendChild(el('p', 'their-reply__sum', last.summary));
      if (last.excerpt) said.appendChild(el('blockquote', 'their-reply__text', last.excerpt));
      if (replies.length > 1) said.appendChild(el('p', 'hint', `${replies.length - 1} earlier repl${replies.length === 2 ? 'y' : 'ies'} on file`));
      pane.appendChild(said);
    }
    const grid = el('div', 'pane-grid');
    const left = el('div');
    left.appendChild(renderDetails());
    grid.appendChild(left);
    const right = el('div');
    right.appendChild(renderStatus());
    const why = renderWhy();
    if (why) right.appendChild(why);
    const angle = renderAngle();
    if (angle) right.appendChild(angle);
    right.appendChild(renderTimeline());
    grid.appendChild(right);
    pane.appendChild(grid);
    return pane;
  }

  function renderRail() {
    const rail = el('nav', 'rail');
    rail.setAttribute('aria-label', 'Lead sections');
    for (const t of TABS) {
      const b = el('button', `rail__btn${ui.tab === t.id ? ' is-on' : ''}`);
      b.type = 'button';
      b.title = t.label;
      b.setAttribute('aria-label', t.label);
      b.setAttribute('aria-pressed', String(ui.tab === t.id));
      b.appendChild(el('span', 'rail__glyph', t.glyph));
      b.appendChild(el('span', 'rail__lbl', t.label));
      b.addEventListener('click', () => { ui.tab = t.id; render(); });
      rail.appendChild(b);
    }
    return rail;
  }

  function render({ fromServer = false } = {}) {
    if (!fromServer) snapshot();
    clear(modal);
    modal.appendChild(renderRail());
    modal.appendChild(renderHead());

    const pane = el('div', `pane pane-${ui.tab}`);
    if (ui.tab === 'email') {
      pane.appendChild(renderComposer());
      const review = renderReview();
      if (review) pane.appendChild(review);
    } else if (ui.tab === 'overview') {
      pane.appendChild(renderOverview());
    } else {
      pane.appendChild(renderNotes());
    }
    modal.appendChild(pane);
    modal.scrollTop = 0;
  }

  /* ---------------- actions ---------------- */

  async function guard(run) {
    if (busy) return;
    busy = true;
    try {
      await run();
    } catch (error) {
      toast(errorText(error));
    } finally {
      busy = false;
    }
  }

  function setStage(stage) {
    if (lead.stage === stage) return;
    guard(async () => {
      await patchState({ stage });
      const detail = await apiFetch(`/api/leads/${lead.uid}`);
      events = detail.lead?.events ?? events;
      toast(`${lead.name} → ${STAGE_BY[stage].label}`);
      render();
    });
  }

  function toggleStar() {
    guard(async () => {
      await patchState({ starred: !lead.starred });
      render();
    });
  }

  /**
   * Load (or reload) everything the popup shows. `composeOnly` keeps the
   * lead and its events and only recomposes — what a language or mode pill
   * needs.
   */
  async function reload({ composeOnly = false } = {}) {
    loadError = null;
    if (!composeOnly) composed = null;
    render();

    let fromServer = false;
    try {
      if (!composeOnly) {
        await loadDetail();
        // Looking at a lead is itself a move: the old app advanced an
        // untouched lead to "Looked at" the moment you opened it.
        if (lead.stage === 'new' && !advanced.has(lead.uid)) {
          advanced.add(lead.uid);
          await patchState({ stage: 'looked' });
          const again = await apiFetch(`/api/leads/${lead.uid}`);
          events = again.lead?.events ?? events;
        }
      }
      const languages = langsFor(lead);
      const lang = languages.includes(ui.lang) ? ui.lang : languages[0];
      ui.lang = lang;
      composed = await fetchCompose(lang, ui.mode);
      // A website lead outside surgery has no letter yet (audit A2): say why,
      // in a pop-up, and leave the fields empty for Andy's own words.
      if (composed?.noDraft) toast(composed.noDraft);
      fromServer = true;
    } catch (error) {
      loadError = errorText(error);
    }
    render({ fromServer });
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= leads.length) return;
    index = next;
    lead = leads[index];
    events = [];
    replies = [];
    opens = [];
    drafts = {};
    ui.mode = 'email';
    ui.lang = null;
    ui.toName = null;
    // One lead's own line and subject never carry over to the next one.
    ui.hook = '';
    ui.subjectLine = '';
    reload();
  }

  /* ---------------- keyboard ---------------- */

  function onKeydown(event) {
    const tag = (event.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'ArrowLeft' || event.key === 'k') { event.preventDefault(); step(-1); return; }
    if (event.key === 'ArrowRight' || event.key === 'j') { event.preventDefault(); step(1); return; }
    if (event.key === 's') { event.preventDefault(); toggleStar(); return; }
    const stage = STAGES.find((s) => s.key === event.key);
    if (stage) { event.preventDefault(); setStage(stage.v); }
  }

  document.addEventListener('keydown', onKeydown);
  stopListening = () => document.removeEventListener('keydown', onKeydown);

  reload();
  return close;
}
