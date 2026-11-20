// The live page of an onboarding questionnaire: the client follows it on his
// own screen during a video call while Andy fills it in HQ, and types the open
// answers himself (the domain, the practice name, notes: F31).
//
// NIRMATA, 18 Oct (Fontaine call, 20 Oct): "/live/<random token>, one per
// onboarding, expiring after 7 days, revocable … updates within ~2 seconds …
// text and CSS only; no money, notes or other clients."
//
// Like the calendar feed this runs before authenticate(): the client has no
// HQ session. The token in the path is its only gate: 64 hex characters for
// the first links, <name>-<6 characters> (30 bits) since F31, with a cap of
// 20 wrong tries per address and minute. An unknown, expired or revoked token
// answers 404 like any unknown path. The client writes only open text answers
// his questionnaire shows, at most 30 a minute (clientWrite). It reads only
// what the safe view reads (getLiveView: name, organisation, brand, entities,
// answers), and the page polls /live/<token>.json every 2 seconds.
//
// HQ is in password mode (ACCESS_TEAM is empty), so nothing stands in front of
// the Worker. If Cloudflare Access is ever put in front of
// hq.example.com, /live/* needs a bypass rule there, like /cal/*.

import { getLiveView, clientWrite, liveBlocked, recordLiveMiss, LIVE_TOKEN, TooManyWrites } from './prospects-db.js';
import { ValidationError } from './db.js';
import { identityFrom } from '../shared/identity.js';
import { flowModel, flowPage } from './flow.js';
import {
  SOCIAL, SEP, t, socialKeys, sectionAnswered, summarise, fieldShown, resolveSections, clientWritable, shownSections,
  examplesOf, youtube, youtubeEmbed, configFor,
} from '../public/assets/onboarding-form.js';

const PATH = /^\/live\/([a-z0-9-]{1,64})(\.json|\/answer)?$/;

/**
 * Realis Studio's host for its clients' onboarding pages: it serves nothing
 * else (Andy, 19 Oct: "I only want onboarding"). live.example.com, used
 * for a few hours, is retired: while Cloudflare still sends it here it answers
 * 404 to everything, so it can never show HQ.
 */
export const REALIS_LIVE_HOST = 'onboarding.example.com';
export const REALIS_HOSTS = Object.freeze([REALIS_LIVE_HOST]);
const RETIRED_HOSTS = Object.freeze(['live.example.com']);
const REALIS_PATH = /^\/(?:live\/)?([a-z0-9-]{1,64})(\.json|\/answer)?$/;

/** The address a client opens: on Realis Studio's own domain for a Realis prospect. */
export function liveUrl(brand, token, { demoOrigin = null } = {}) {
  if (demoOrigin) return `${demoOrigin}/live/${token}`;
  return brand === 'archive' ? `https://hq.example.com/live/${token}` : `https://${REALIS_LIVE_HOST}/${token}`;
}
export const POLL_MS = 2000;
const BODY_MAX = 8192;

const filled = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '');

function field(fieldDef, answers, entities, config) {
  const label = t(fieldDef, 'fr');
  const value = answers[fieldDef.key];
  const hint = fieldDef.hint ? t(fieldDef.hint, 'fr') : '';
  const choose = (options, multi) => ({
    label,
    hint,
    // « Voir l'inspiration »: an option's example, played in a pop-up on the client's side only.
    examples: (fieldDef.options ?? []).filter((o) => o.inspire).map((o) => {
      const item = examplesOf(config, o.inspire)[0];
      if (!item) return null;
      const yt = youtube(item.url);
      return { label: t(o, 'fr'), title: item.title ?? '', ...(yt ? { embed: youtubeEmbed(yt) } : { url: item.url }) };
    }).filter(Boolean),
    options: options.map((opt) => ({
      label: t(opt, 'fr'),
      desc: opt.desc ? t(opt.desc, 'fr') : '',
      on: multi ? Array.isArray(value) && value.includes(opt.id) : value === opt.id,
    })),
  });
  switch (fieldDef.type) {
    case 'choice': return choose(fieldDef.options, false);
    case 'chips': return choose(fieldDef.options, true);
    case 'entities': return choose(entities.map((e) => ({ id: e.id, fr: e.name })), true);
    case 'entity': {
      const chosen = entities.filter((e) => (answers.activities ?? []).includes(e.id));
      return choose(chosen.map((e) => ({ id: e.id, fr: e.name })), false);
    }
    case 'social': {
      const lines = entities.map((entity) => {
        const keys = socialKeys(entity.id);
        const nets = (answers[keys.networks] ?? []).map((id) => t(SOCIAL.networks.find((n) => n.id === id), 'fr') || id);
        const state = answers[keys.state] ? t(SOCIAL.state.find((s) => s.id === answers[keys.state]), 'fr') : '';
        const per = answers[keys.perWeek] ? `${t(SOCIAL.perWeek.find((p) => p.id === answers[keys.perWeek]), 'fr')} par semaine` : '';
        return { label: entity.name, value: [nets.join(', '), state, per].filter(Boolean).join(SEP) };
      });
      return { label, lines };
    }
    default: {
      const text = filled(value) ? String(value) : '';
      // The open questions are the client's to type in, too (F31).
      return clientWritable(fieldDef)
        ? { label, hint, input: { key: fieldDef.key, long: fieldDef.type === 'long', value: text } }
        : { label, hint, text };
    }
  }
}

/**
 * What the mirror shows, built from the safe fields only. The same shape goes
 * into the first HTML and into every poll.
 */
export function liveModel(form, env = {}) {
  const who = identityFrom(env);
  const answers = form.answers ?? {};
  const config = form.config ?? configFor(form);
  const sections = shownSections(resolveSections(config), answers);
  const entities = form.entities ?? [];
  return {
    brand: (form.brand === 'archive' ? who.brandUgc : who.brandWeb).toUpperCase(),
    name: form.name,
    organisation: form.organisation ?? '',
    updated_at: form.updated_at ?? null,
    expires_at: form.expires_at,
    sections: sections.map((section) => ({
      id: section.id,
      title: t(section, 'fr'),
      info: Boolean(section.info),
      done: !section.info && sectionAnswered(section, answers),
      media: section.media ?? null,
      fields: section.info ? [] : section.fields.filter((f) => fieldShown(f, answers))
        .map((f) => field(f, answers, entities, config)).filter((f) => f.label || f.lines?.length || f.options?.length || f.input),
    })),
    summary: summarise(answers, entities, 'fr', sections),
  };
}

/* ---- the page. Only the Worker renders: the first paint, and every poll
   (which answers with the sections and the side list as HTML). ---- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const VIDEO_FILE = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

function renderNav(model) {
  const two = (n) => (n < 10 ? `0${n}` : String(n));
  return `${model.sections.map((s, i) => `<a href="#s-${esc(s.id)}" class="${s.done ? 'done' : ''}"><span class="num">${two(i + 1)}</span>${esc(s.title)}</a>`).join('')}<a href="#s-recap" class="recap">Récapitulatif</a>`;
}

function renderSections(model) {
  const body = (f) => {
    if (f.options) {
      return `<div class="opts">${f.options.map((o) => (o.desc
        ? `<span class="opt card${o.on ? ' on' : ''}"><b>${esc(o.label)}</b><small>${esc(o.desc)}</small></span>`
        : `<span class="opt${o.on ? ' on' : ''}">${esc(o.label)}</span>`)).join('')}</div>`;
    }
    if (f.lines) {
      return f.lines.length
        ? `<dl class="lines">${f.lines.map((l) => `<dt>${esc(l.label)}</dt><dd>${l.value ? esc(l.value) : '<span class="none">—</span>'}</dd>`).join('')}</dl>`
        : '<p class="none">—</p>';
    }
    if (f.input) {
      const attrs = `data-key="${esc(f.input.key)}" aria-label="${esc(f.label)}" maxlength="${f.input.long ? 2000 : 300}" placeholder="Vous pouvez écrire ici"`;
      return f.input.long
        ? `<textarea class="in" rows="3" ${attrs}>${esc(f.input.value)}</textarea>`
        : `<input class="in" type="text" ${attrs} value="${esc(f.input.value)}">`;
    }
    return f.text ? `<p class="text">${esc(f.text)}</p>` : '<p class="none">—</p>';
  };
  const inspire = (f) => (f.examples?.length
    ? `<p class="insp-links">Voir l’inspiration&nbsp;: ${f.examples.map((x) => `<button type="button" class="insp" ${x.embed ? `data-embed="${esc(x.embed)}"` : `data-file="${esc(x.url)}"`} data-title="${esc(x.title || x.label)}">▶ ${esc(x.label)}</button>`).join(' · ')}</p>` : '');
  // The last section: everything answered, to read through together (F32).
  const recap = `<section class="sec recap" id="s-recap"><h2>Récapitulatif</h2><p class="hint">Relisez tranquillement&nbsp;: si quelque chose ne va pas, dites-le-nous.</p>${model.summary.length
    ? model.summary.map((g) => `<h3>${esc(g.title)}</h3><dl class="lines">${g.lines.map((l) => `<dt>${esc(l.label)}</dt><dd>${esc(l.value)}</dd>`).join('')}</dl>`).join('')
    : '<p class="none">Les réponses apparaîtront ici.</p>'}</section>`;
  return model.sections.map((s) => `<section class="sec${s.done ? ' done' : ''}" id="s-${esc(s.id)}">
<h2>${esc(s.title)}</h2>
${s.fields.map((f) => `<div class="field">${f.label ? `<p class="q">${esc(f.label)}</p>` : ''}${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}${body(f)}${inspire(f)}</div>`).join('\n')}
</section>`).join('\n') + recap;
}

const CSS = `
:root { color-scheme: light; --ink: #111; --muted: #6b7280; --soft: #9ca3af; --line: #e5e7eb; --band: #f3f4f6;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace; --sans: Geist, 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: var(--ink); font: 15px/1.5 var(--sans); }
html { scroll-padding-top: 84px; }
.top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px max(16px, calc((100% - 1148px) / 2)); background: #fff; border-bottom: 1px solid var(--line); }
.brand { display: grid; gap: 2px; min-width: 0; }
.brand b { font: 700 13px var(--mono); letter-spacing: .14em; }
.brand small { font-size: 13px; color: var(--muted); }
.live { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; animation: pulse 2s ease-in-out infinite; }
.live.off .dot { background: var(--soft); animation: none; }
@keyframes pulse { 50% { opacity: .35; } }
.body { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 0; max-width: 1180px; margin: 0 auto; padding: 0 16px; }
/* The sections down the side, ticked when answered: the layout Andy likes (F31). */
.nav { position: sticky; top: 72px; align-self: start; display: grid; gap: 2px; padding: 32px 16px 24px 0; max-height: calc(100vh - 80px); overflow: auto; }
.nav a { display: block; padding: 8px 12px; color: var(--muted); text-decoration: none; font-size: 14.5px; border-left: 2px solid transparent; }
.nav a:hover { color: var(--ink); border-left-color: var(--line); }
.nav a.done { color: var(--ink); } .nav a.done::after { content: ' ✓'; color: #16a34a; }
.nav .num { font: 12px var(--mono); margin-right: 10px; color: var(--soft); }
main { min-width: 0; padding: 0 0 80px 40px; border-left: 1px solid var(--line); }
.title { padding: 40px 0 8px; }
.title h1 { margin: 0; font-weight: 300; font-size: clamp(30px, 6vw, 48px); letter-spacing: -.035em; line-height: 1.05; overflow-wrap: anywhere; }
.title p { margin: 8px 0 0; font-size: 17px; color: var(--muted); }
.sec { padding: 28px 0; border-bottom: 1px solid var(--line); }
.sec h2 { margin: 0 0 14px; font-weight: 400; font-size: 22px; letter-spacing: -.015em; }
.sec.done h2::after { content: ' ✓'; color: #16a34a; font-size: 18px; }
.field { margin: 0 0 16px; }
.q { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.opts { display: flex; flex-wrap: wrap; gap: 8px; }
.opt { display: inline-block; padding: 7px 12px; border: 1px solid var(--line); color: var(--muted); font-size: 14.5px; transition: background .3s, color .3s, border-color .3s; }
.opt.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.opt.card { display: grid; gap: 3px; max-width: 340px; padding: 10px 14px; }
.opt.card b { font-weight: 500; } .opt.card small { font-size: 13px; line-height: 1.4; color: var(--muted); }
.opt.card.on small { color: #d1d5db; }
.hint { margin: -4px 0 8px; font-size: 13.5px; color: var(--soft); }
.text { margin: 0; font-size: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.none { margin: 0; color: var(--soft); }
.in { width: 100%; max-width: 560px; font: inherit; font-size: 16px; color: var(--ink); padding: 10px 12px; border: 1px solid var(--line); background: #fff; border-radius: 0; }
.in:focus { outline: 2px solid var(--ink); outline-offset: -1px; }
textarea.in { resize: vertical; min-height: 84px; }
.lines { display: grid; grid-template-columns: minmax(0, 12em) minmax(0, 1fr); gap: 6px 16px; margin: 0; }
.lines dt { color: var(--muted); } .lines dd { margin: 0; }
.insp-links { margin: 8px 0 0; font-size: 13.5px; color: var(--muted); }
.insp { font: inherit; font-size: 14px; color: var(--ink); background: none; border: 0; padding: 4px 2px; min-height: 36px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.pop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.72); }
.pop__box { position: relative; width: min(960px, 100%); background: #000; }
.pop__box iframe, .pop__box video { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: #000; }
.pop__x { position: absolute; top: -48px; right: 0; width: 44px; height: 44px; font: inherit; font-size: 20px; color: #fff; background: none; border: 0; cursor: pointer; }
@media (max-width: 760px) { .pop { padding: 0; } .pop__box { width: 100%; height: 100%; display: grid; align-content: center; } .pop__x { top: 8px; right: 8px; z-index: 1; } }
.recap h3 { margin: 18px 0 6px; font: 500 12px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.nav a.recap { margin-top: 10px; color: var(--ink); }
.gone { padding: 64px 0; font-size: 18px; color: var(--muted); }
.note { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--ink); color: #fff; font-size: 13px; padding: 8px 16px; border-radius: 999px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.note.show { opacity: 1; }
@media (max-width: 760px) {
  .brand small { display: none; } .lines { grid-template-columns: 1fr; } .lines dd { margin-bottom: 8px; }
  .body { grid-template-columns: minmax(0, 1fr); }
  .nav { display: none; }
  main { padding: 0 0 80px; border-left: 0; }
}
`;

/** The page's script: poll, swap in the sections (keeping what the client is typing), send what he types. */
function clientScript(model) {
  return `
(function () {
  var last = ${JSON.stringify(model.updated_at)};
  var main = document.getElementById('sections');
  var nav = document.getElementById('nav');
  var live = document.getElementById('live');
  var label = document.getElementById('live-label');
  var note = document.getElementById('note');
  var stopped = false, timers = {}, noteTimer = null;
  function say(text) { note.textContent = text; note.className = 'note show'; clearTimeout(noteTimer); noteTimer = setTimeout(function () { note.className = 'note'; }, 2200); }
  function stop(text) {
    stopped = true; live.className = 'live off'; label.textContent = 'Lien inactif';
    main.replaceChildren(); nav.replaceChildren();
    var p = document.createElement('p'); p.className = 'gone'; p.textContent = text; main.appendChild(p);
  }
  function send(key, value) {
    fetch(location.pathname + '/answer', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: value }) })
      .then(function (r) {
        if (r.status === 404) { stop('Ce lien n’est plus actif. Merci de l’avoir suivi.'); return; }
        if (r.status === 429) { say('Un instant : trop de changements en une minute.'); return; }
        if (!r.ok) { say('Pas enregistré. Réessayez.'); return; }
        say('Enregistré');
      }).catch(function () { say('Pas de connexion : pas encore enregistré.'); });
  }
  // An example in a pop-up, on this page only: ✕, Esc or a click outside closes it and stops it.
  function openPop(btn) {
    var back = document.activeElement;
    var scrim = document.createElement('div'); scrim.className = 'pop';
    scrim.setAttribute('role', 'dialog'); scrim.setAttribute('aria-modal', 'true'); scrim.setAttribute('aria-label', btn.getAttribute('data-title'));
    var box = document.createElement('div'); box.className = 'pop__box';
    var x = document.createElement('button'); x.type = 'button'; x.className = 'pop__x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Fermer');
    var player;
    if (btn.getAttribute('data-embed')) {
      player = document.createElement('iframe'); player.src = btn.getAttribute('data-embed'); player.title = btn.getAttribute('data-title');
      player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; player.allowFullscreen = true;
      player.referrerPolicy = 'strict-origin-when-cross-origin';
    } else {
      player = document.createElement('video'); player.controls = true; player.autoplay = true; player.playsInline = true; player.src = btn.getAttribute('data-file');
    }
    box.appendChild(x); box.appendChild(player); scrim.appendChild(box); document.body.appendChild(scrim); x.focus();
    function shut() { document.removeEventListener('keydown', key); scrim.remove(); if (back && back.focus) back.focus(); }
    function key(e) { if (e.key === 'Escape') shut(); }
    x.addEventListener('click', shut);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) shut(); });
    document.addEventListener('keydown', key);
  }
  main.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.insp');
    if (btn) openPop(btn);
  });
  main.addEventListener('input', function (e) {
    var key = e.target && e.target.getAttribute('data-key');
    if (!key) return;
    clearTimeout(timers[key]);
    var value = e.target.value;
    timers[key] = setTimeout(function () { delete timers[key]; send(key, value.trim() ? value : null); }, 700);
  });
  function swap(html, navHtml) {
    // What the client is typing stays as it is, caret included.
    var active = document.activeElement, key = active && active.getAttribute && active.getAttribute('data-key');
    var mine = {};
    main.querySelectorAll('[data-key]').forEach(function (el) { if (timers[el.getAttribute('data-key')] || el === active) mine[el.getAttribute('data-key')] = el.value; });
    var start = key ? active.selectionStart : 0, end = key ? active.selectionEnd : 0;
    // An open pop-up lives outside the sections, so a video keeps playing through updates.
    main.innerHTML = html; nav.innerHTML = navHtml;
    Object.keys(mine).forEach(function (k) { var el = main.querySelector('[data-key="' + k.replace(/"/g, '') + '"]'); if (el) el.value = mine[k]; });
    if (key) { var again = main.querySelector('[data-key="' + key.replace(/"/g, '') + '"]'); if (again) { again.focus(); try { again.setSelectionRange(start, end); } catch (x) {} } }
  }
  function tick() {
    if (stopped) return;
    fetch(location.pathname + '.json', { cache: 'no-store', credentials: 'omit' }).then(function (r) {
      if (r.status === 404) { stop('Ce lien n’est plus actif. Merci de l’avoir suivi.'); return null; }
      return r.ok ? r.json() : null;
    }).then(function (model) {
      live.className = 'live';
      if (model && model.updated_at !== last) { last = model.updated_at; swap(model.html, model.nav); }
    }).catch(function () { live.className = 'live off'; })
      .then(function () { if (!stopped) setTimeout(tick, ${POLL_MS}); });
  }
  setTimeout(tick, ${POLL_MS});
})();
`;
}

export function livePage(model, nonce) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(model.brand)} · Questionnaire de démarrage</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand"><b>${esc(model.brand)}</b><small>Questionnaire de démarrage</small></div>
  <span class="live" id="live"><span class="dot"></span><span id="live-label">En direct</span></span>
</header>
<div class="body">
  <nav class="nav" id="nav" aria-label="Sections">${renderNav(model)}</nav>
  <main>
    <div class="title"><h1>${esc(model.name)}</h1>${model.organisation ? `<p>${esc(model.organisation)}</p>` : ''}</div>
    <div id="sections">${renderSections(model)}</div>
  </main>
</div>
<div class="note" id="note" role="status"></div>
<script nonce="${nonce}">${clientScript(model)}</script>
</body>
</html>`;
}

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function plain(text, status) {
  return new Response(text, { status, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
/** A wrong or ended link: a plain French page, no brand, no HQ. */
const GONE_PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Lien inactif</title></head>'
  + '<body style="margin:0;font:17px/1.5 system-ui,-apple-system,sans-serif;color:#111;background:#fff"><p style="max-width:560px;margin:18vh auto 0;padding:0 24px">Ce lien n’existe pas ou n’est plus actif.</p></body></html>';
const notFound = () => new Response(GONE_PAGE, {
  status: 404,
  headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });

function nonceValue() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** GET /live/<token>, /live/<token>.json; POST /live/<token>/answer. Null when the path is not one. */
export async function handleLive(request, env, url) {
  if (!url.pathname.startsWith('/live/')) return null;
  if (!env.DB) return notFound();
  const match = PATH.exec(url.pathname);
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  // Too many wrong links from one address: stop answering for the minute.
  if (await liveBlocked(env.DB, address)) return plain('Trop d’essais. Réessayez dans une minute.', 429);
  const miss = async () => { await recordLiveMiss(env.DB, address); return notFound(); };
  if (!match || !LIVE_TOKEN.test(match[1])) return miss();
  const [, token, kind] = match;

  if (kind === '/answer') {
    if (request.method !== 'POST') return notFound();
    if (Number(request.headers.get('Content-Length') ?? 0) > BODY_MAX) return json({ error: 'too long' }, 413);
    let body;
    try {
      const text = await request.text();
      if (text.length > BODY_MAX) return json({ error: 'too long' }, 413);
      body = JSON.parse(text);
    } catch { return json({ error: 'body must be JSON' }, 400); }
    if (!body || typeof body !== 'object' || typeof body.key !== 'string') return json({ error: 'key is required' }, 400);
    try {
      const saved = await clientWrite(env.DB, token, body.key, body.value ?? null);
      if (!saved) return miss();
      return json({ ok: true, updated_at: saved.updated_at });
    } catch (error) {
      if (error instanceof TooManyWrites) return json({ error: error.message }, 429);
      if (error instanceof ValidationError) return json({ error: error.message }, 400);
      console.error('live answer:', error);
      return json({ error: 'something went wrong' }, 500);
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  const form = await getLiveView(env.DB, token);
  if (!form) return miss();
  const model = liveModel(form, env);
  if (kind === '.json') {
    // The sections and the side list ready to show, rendered (and escaped) here.
    const body = { updated_at: model.updated_at, expires_at: model.expires_at, html: renderSections(model), nav: renderNav(model) };
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const nonce = nonceValue();
  // The client answers on his own (setup `clientAnswers`): one question per screen.
  const page = form.config?.clientAnswers ? flowPage(flowModel(form, env), nonce) : livePage(model, nonce);
  return new Response(request.method === 'HEAD' ? null : page, {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      // Example videos and their posters come from https links Andy adds.
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src https://i.ytimg.com; media-src https:; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

/**
 * Everything onboarding.example.com answers: a client's live page at
 * /<name>-<code> (or /live/<name>-<code>), its .json and /answer, and a 404
 * for anything else. Null on any other host.
 */
export async function handleLiveHost(request, env, url) {
  if (RETIRED_HOSTS.includes(url.hostname)) return notFound();
  if (!REALIS_HOSTS.includes(url.hostname)) return null;
  const match = REALIS_PATH.exec(url.pathname);
  if (!match) return notFound();
  const inner = new URL(url);
  inner.pathname = `/live/${match[1]}${match[2] ?? ''}`;
  return handleLive(request, env, inner);
}
