// The client answers on his own phone (NIRMATA mission, 22 Oct; Andy: « the
// client is lazy, make the onboarding also available mobile, have him answer
// a few essential questions »). When a prospect's setup has `clientAnswers`,
// his onboarding link shows this instead of the call mirror: one question per
// screen, « 3 sur 8 », Retour / Suivant, Passer for what is optional, every
// tap saved at once, a thank-you at the end. Same link, same token, same
// /answer endpoint and limits as the mirror (clientWrite).
//
// Only the questions the client may answer reach the page, with his own
// answers to them: never notes, prices, contact details or the stage.

import { identityFrom } from '../shared/identity.js';
import { t, resolveSections, clientWritable, configFor } from '../public/assets/onboarding-form.js';

const ASKABLE = new Set(['text', 'long', 'choice', 'chips', 'approve']);
const ACCENT = /^#[0-9a-fA-F]{6}$/;

/** What the phone flow needs: the questions in order (essentials first), and his answers to them. */
export function flowModel(form, env = {}) {
  const who = identityFrom(env);
  const config = form.config ?? configFor(form);
  const answers = form.answers ?? {};
  const questions = [];
  for (const section of resolveSections(config)) {
    for (const field of section.fields) {
      if (!ASKABLE.has(field.type) || !clientWritable(field, config)) continue;
      questions.push({
        key: field.key,
        section: t(section, 'fr'),
        sectionWhen: section.when ?? null,
        label: t(field, 'fr') || t(field.short, 'fr'),
        type: field.type,
        options: (field.options ?? []).map((o) => ({ id: o.id, label: t(o, 'fr'), desc: o.desc ? t(o.desc, 'fr') : '' })),
        max: field.max ?? null,
        optional: Boolean(field.optional),
        hint: field.hint ? t(field.hint, 'fr') : '',
        when: field.when ?? null,
        ...(field.type === 'approve' ? { content: field.content ?? '' } : {}),
        ...(field.other ? { other: true } : {}),
      });
    }
  }
  // The essentials first, then the optional ones, each group in the setup's order.
  questions.sort((a, b) => Number(a.optional) - Number(b.optional));
  // His answers to these questions, and the notes he left on approvals.
  const keys = new Set(questions.flatMap((q) => [q.key, ...(q.type === 'approve' ? [`${q.key}.note`] : []), ...(q.other ? [`${q.key}.other`] : [])]));
  const mine = Object.fromEntries([...keys].filter((k) => answers[k] !== undefined).map((k) => [k, answers[k]]));
  return {
    brand: (form.brand === 'archive' ? who.brandUgc : who.brandWeb).toUpperCase(),
    name: form.name,
    // « Bonjour Alexis »: the name he goes by (setup firstName), else the first word of his name.
    firstName: config.firstName || String(form.name ?? '').trim().split(/\s+/)[0] || '',
    tu: Boolean(config.tu),
    welcome: config.welcome ?? '',
    accent: ACCENT.test(config.accent ?? '') ? config.accent : null,
    thanks: config.thanks ?? '',
    optionalIntro: config.optionalIntro ?? '',
    questions,
    answers: mine,
  };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** JSON inside a <script> tag: nothing that can close it. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/*
 * The look is the Aubin editor's review sheet, which Andy chose for every
 * client (24 Oct): its "marine" tokens, a sheet with a letter-spaced eyebrow,
 * the question as its title, a filled progress bar with « 2/5 », the answers
 * on a navy field card, outlined « Retour » and filled « Suivant → », and the
 * done card. One template; a client changes only the accent (form_config.accent).
 */
const CSS = `
:root { color-scheme: dark;
  --ground: #0B1626; --card: #122238; --soft: #182D48; --ink: #E9EFF7; --ink-2: #BCC9DC; --muted: #8A9DB8;
  --line: #24395A; --line-soft: #1B2E4A; --accent: #8FC5F2; --on-accent: #081522; --accent-soft: #15324D;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --sans: 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; color: var(--ink); font: 17px/1.5 var(--sans); -webkit-text-size-adjust: 100%; }
body { min-height: 100dvh; background: radial-gradient(120% 80% at 50% 0%, #10213A 0%, var(--ground) 60%) fixed, var(--ground); }
button { font: inherit; color: inherit; }
.page { min-height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); justify-items: center; padding: 0 20px 28px; }
.brandbar { width: min(560px, 100%); display: flex; justify-content: space-between; align-items: center; padding: max(16px, env(safe-area-inset-top)) 4px 14px; }
.brand { font: 600 12px var(--mono); letter-spacing: .18em; color: var(--ink-2); }
.saved { font-size: 13px; color: var(--accent); opacity: 0; transition: opacity .3s; }
.saved.on { opacity: 1; } .saved.bad { color: #E89A93; opacity: 1; }
.sheet { width: min(560px, 100%); align-self: center; display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--card); border: 1px solid var(--line); border-radius: 28px; box-shadow: 0 30px 80px -30px rgba(0, 0, 0, .9); overflow: hidden; }
.sheet { max-height: calc(100dvh - 90px); }
.sheet__head { padding: 24px 24px 0; }
.sheet__top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.sheet__top .saved { flex: none; }
.eyebrow { margin: 0 0 8px; font: 500 12.5px var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--ink-2); }
.title { margin: 0; font-size: clamp(24px, 6vw, 30px); font-weight: 500; letter-spacing: -.025em; line-height: 1.18; overflow-wrap: anywhere; }
.prog { display: flex; align-items: center; gap: 14px; margin: 18px 0 0; }
.prog[hidden] { display: none; }
.prog__bar { flex: 1; height: 8px; border-radius: 999px; background: var(--soft); overflow: hidden; }
.prog__bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--accent); transition: width .35s ease; }
.prog__n { font: 500 14px var(--mono); color: var(--ink-2); white-space: nowrap; min-width: 3.4em; text-align: right; }
.sheet__body { padding: 20px 24px 22px; overflow-y: auto; }
.hint { margin: 0 0 14px; color: var(--muted); font-size: 15px; }
.fcard { display: grid; gap: 10px; padding: 18px; border-radius: 18px; background: var(--soft); }
.fcard__eyebrow { margin: 0; font: 500 12px var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
.opt { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 12px 16px; text-align: left; background: var(--card); border: 1px solid var(--line); border-radius: 14px; cursor: pointer; font-size: 17px; }
.opt__box { flex: none; width: 22px; height: 22px; border: 1.5px solid var(--muted); border-radius: 50%; display: grid; place-items: center; }
.multi .opt__box { border-radius: 6px; }
/* Several choices: a check mark in the square; one choice: a dot in the circle. */
.opt[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.opt[aria-pressed="true"] .opt__box { border-color: var(--accent); background: var(--accent); }
.opt[aria-pressed="true"] .opt__box::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--on-accent); }
.multi .opt[aria-pressed="true"] .opt__box::after { width: 6px; height: 11px; border-radius: 0; background: none; border: solid var(--on-accent); border-width: 0 2.5px 2.5px 0; transform: translate(0, -1px) rotate(45deg); }
.opt:disabled { opacity: .4; cursor: default; }
.opt small { display: block; color: var(--muted); font-size: 14px; }
.max { margin: 2px 0 0; font-size: 14px; color: var(--muted); }
.in { width: 100%; font: inherit; font-size: 17px; color: var(--ink); padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
/* A text answer is the field card itself: one surface, as the editor's field. */
.in.surface { padding: 18px; border-radius: 18px; background: var(--soft); border-color: var(--soft); }
.fieldwrap { display: grid; gap: 10px; }
.in::placeholder { color: var(--muted); }
.in:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.in[hidden] { display: none; }
textarea.in { min-height: 150px; resize: none; line-height: 1.5; }
.mic { margin: 0; font-size: 14px; color: var(--muted); }
.content { margin: 0; white-space: pre-wrap; font-size: 16.5px; line-height: 1.6; color: var(--ink); overflow-wrap: anywhere; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.sheet__foot { padding: 16px 24px max(20px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line-soft); background: var(--card); display: grid; gap: 10px; }
.row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 10px; }
.btn { min-height: 54px; padding: 0 22px; border-radius: 999px; border: 1px solid var(--line); background: transparent; cursor: pointer; font-size: 17px; color: var(--ink); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 500; }
.btn.primary:disabled { background: transparent; border-color: var(--line); color: var(--muted); cursor: default; }
.btn[hidden], .quiet[hidden] { display: none; }
.row.solo { grid-template-columns: minmax(0, 1fr); }
.quiets { display: flex; justify-content: center; gap: 18px; }
.quiets:not(:has(button:not([hidden]))) { display: none; }
.quiet { justify-self: center; min-height: 44px; padding: 0 12px; background: none; border: 0; color: var(--muted); font-size: 15px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.done { display: grid; gap: 14px; padding: 22px; border-radius: 18px; background: var(--soft); }
.done h2 { margin: 0; font-size: clamp(26px, 7vw, 34px); font-weight: 400; letter-spacing: -.025em; line-height: 1.12; }
.done__pill { margin: 0; padding: 12px 16px; border-radius: 12px; background: var(--card); color: var(--ink-2); font-size: 15.5px; }
.list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.list button { width: 100%; text-align: left; min-height: 48px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); cursor: pointer; }
.gone { padding: 24px; text-align: center; color: var(--muted); }
/* The phone: a bottom sheet, as the editor's. The studio's name sits on the dim,
   blurred backdrop above; the sheet's content sits right above its buttons, the
   sheet grows upwards for long content and scrolls inside, and rides on the keyboard. */
.backdrop { display: none; }
@media (max-width: 767px) {
  .page { padding: 0; display: block; }
  .brandbar { display: none; }
  .backdrop { display: grid; position: fixed; inset: 0; z-index: 0; align-content: start; justify-items: center; padding: max(26px, env(safe-area-inset-top)) 20px 0;
    background: radial-gradient(90% 60% at 50% 18%, #1A3355 0%, #0B1626 70%); }
  .backdrop__brand { font: 600 15px var(--mono); letter-spacing: .3em; color: rgba(233, 239, 247, .5); filter: blur(.4px); text-shadow: 0 0 18px rgba(143, 197, 242, .35); }
  .backdrop__dim { position: fixed; inset: 0; background: rgba(4, 10, 20, .35); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2; width: 100%; max-height: calc(100dvh - 72px); min-height: 0;
    border-radius: 26px 26px 0 0; border: 1px solid var(--line); border-bottom: 0; box-shadow: 0 -24px 60px -20px rgba(0, 0, 0, .7); }
  .sheet__head { padding: 22px 20px 0; }
  .sheet__body { padding: 16px 20px 18px; }
  .sheet__foot { padding: 12px 20px max(14px, env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) { .prog__bar i, .saved { transition: none; } }
`;

const SCRIPT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('flow-data').textContent);
  var answers = data.answers || {};
  var Q = data.questions;
  var tu = data.tu;
  var T = {
    welcome: 'Bienvenue', start: 'Commencer →', resume: 'Reprendre →', next: 'Suivant →', skip: 'Passer', back: 'Retour',
    finish: 'Terminer', cont: 'Continuer →', optional: 'Facultatif',
    intro: tu ? 'Quelques questions pour préparer ton site.' : 'Quelques questions pour préparer votre site.',
    introLine: tu ? 'Tu réponds quand tu veux : chaque réponse est enregistrée aussitôt.' : 'Vous répondez quand vous voulez : chaque réponse est enregistrée aussitôt.',
    mic: tu ? 'Astuce : tu peux dicter avec le micro du clavier.' : 'Astuce : vous pouvez dicter avec le micro du clavier.',
    placeholder: tu ? 'Ta réponse' : 'Votre réponse',
    change: tu ? 'Qu’est-ce qu’on change ?' : 'Qu’est-ce qu’on change ?',
    otherWhat: tu ? 'Précise ici' : 'Précisez ici',
    approve: 'Approuver', modify: 'Modifier',
    max: function (n) { return n + ' choix maximum'; }, several: 'Plusieurs choix possibles',
    optTitle: 'L’essentiel est fait, merci !',
    optLine: function (n) { return 'Encore ' + n + ' question' + (n > 1 ? 's' : '') + ' facultative' + (n > 1 ? 's' : '') + (tu ? ', si tu as un moment.' : ', si vous avez un moment.'); },
    allApproved: function (n) { return 'Les ' + n + ' champs sont approuvés.'; },
    mixed: function (a, c) { return a + ' champ' + (a > 1 ? 's' : '') + ' approuvé' + (a > 1 ? 's' : '') + ', ' + c + ' à modifier.'; },
    allSaved: function (n) { return 'Les ' + n + ' réponses sont enregistrées.'; },
    someSaved: function (a, n) { return a + ' réponse' + (a > 1 ? 's' : '') + ' sur ' + n + ' enregistrée' + (a > 1 ? 's' : '') + '.'; },
    approvedLine: tu ? 'Tout est approuvé, merci. Nous revenons vers toi très vite.' : 'Tout est approuvé, merci. Nous revenons vers vous très vite.',
    savedLine: tu ? 'Nous revenons vers toi très vite.' : 'Nous revenons vers vous très vite.',
    missing: 'Sans réponse pour l’instant :', review: 'Tout revoir',
    saved: 'Enregistré ✓', failed: 'Pas enregistré, réessayez', minutes: function (n) { return 'environ ' + n + ' minute' + (n > 1 ? 's' : ''); },
    questions: function (n) { return n + ' question' + (n > 1 ? 's' : ''); }, gone: 'Ce lien n’est plus actif.'
  };
  var $ = function (id) { return document.getElementById(id); };
  var main = $('main'), eyebrow = $('eyebrow'), title = $('title'), prog = $('prog'), bar = $('bar'), count = $('count');
  var savedNotes = [$('saved'), $('saved2')];
  var foot = $('foot'), backBtn = $('back'), nextBtn = $('next'), skipBtn = $('skip'), row = $('row'), altBtn = $('alt'), back2 = $('back2');
  var onNext = null, onAlt = null;
  var screen = { kind: 'welcome' };
  var timers = {}, savedTimer = null, stopped = false;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function filled(v) { return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== ''; }
  function shown(rule) { if (!rule) return true; var v = answers[rule.key]; return 'has' in rule ? Array.isArray(v) && v.indexOf(rule.has) >= 0 : v === rule.is; }
  function visible() { return Q.filter(function (q) { return shown(q.sectionWhen) && shown(q.when); }); }
  function essentials() { return visible().filter(function (q) { return !q.optional; }); }
  function optionals() { return visible().filter(function (q) { return q.optional; }); }
  function answered(q) { return q.type === 'approve' ? answers[q.key] === 'approved' || answers[q.key] === 'changed' : filled(answers[q.key]); }

  function note(ok) {
    savedNotes.forEach(function (n) { if (!n) return; n.textContent = ok ? T.saved : T.failed; n.className = 'saved ' + (ok ? 'on' : 'bad'); });
    clearTimeout(savedTimer);
    if (ok) savedTimer = setTimeout(function () { savedNotes.forEach(function (n) { if (n) n.className = 'saved'; }); }, 1500);
  }
  function stop() { stopped = true; foot.hidden = true; prog.hidden = true; eyebrow.textContent = ''; title.textContent = T.gone; main.replaceChildren(); }
  function save(key, value) {
    if (stopped) return Promise.resolve();
    return fetch(location.pathname + '/answer', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: value }) })
      .then(function (r) { if (r.status === 404) { stop(); return; } note(r.ok); })
      .catch(function () { note(false); });
  }
  function set(key, value, wait) {
    if (!filled(value)) { delete answers[key]; value = null; } else answers[key] = value;
    clearTimeout(timers[key]);
    if (wait) { timers[key] = setTimeout(function () { delete timers[key]; save(key, value); }, wait); return; }
    save(key, value);
  }
  function flush() { Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); delete timers[k]; save(k, answers[k] === undefined ? null : answers[k]); }); }

  function head(eye, text, n, total) {
    eyebrow.textContent = eye; title.textContent = text;
    prog.hidden = !total;
    if (total) { count.textContent = n + '/' + total; bar.style.width = Math.round((n / total) * 100) + '%'; }
  }
  // The footer: Retour (outlined) and the main button; « Passer » as a quiet link under them.
  // opts.alt: an outlined second choice (Modifier) in place of Retour, which then moves to the quiet links.
  function footer(opts) {
    var alt = Boolean(opts.alt);
    backBtn.hidden = !opts.back || alt; altBtn.hidden = !alt; if (alt) altBtn.textContent = opts.alt;
    back2.hidden = !(opts.back && alt);
    row.className = 'row' + (opts.back || alt ? '' : ' solo');
    nextBtn.textContent = opts.next; nextBtn.disabled = Boolean(opts.disabled);
    skipBtn.hidden = !opts.skip; if (opts.skip) skipBtn.textContent = opts.skip;
    onNext = opts.onNext || null; onAlt = opts.onAlt || null;
  }

  function drawWelcome() {
    var n = essentials().length;
    head(T.welcome, 'Bonjour ' + (data.firstName || data.name), 0, 0);
    var card = el('div', 'fcard');
    // Andy's welcome (or the standard lines) in body size under the greeting.
    card.appendChild(el('p', 'content', data.welcome || (T.intro + ' ' + T.introLine)));
    card.appendChild(el('p', 'mic', T.questions(n) + ' · ' + T.minutes(Math.max(2, Math.round(n * 0.6)))));
    main.replaceChildren(card);
    var started = visible().some(answered);
    footer({ back: false, next: started ? T.resume : T.start });
  }

  function drawQuestion(q, n, total) {
    head(q.section.toUpperCase() + (q.optional ? ' · ' + T.optional.toUpperCase() : ''), q.label, n, total);
    var box = el('div');
    if (q.hint) box.appendChild(el('p', 'hint', q.hint));
    var card = el('div', 'fcard');
    if (q.type === 'approve') {
      // The prepared content; the decision lives in the footer: Approuver (filled), Modifier (outlined).
      card.appendChild(el('p', 'content', q.content));
      var change = el('textarea', 'in surface'); change.placeholder = T.change; change.maxLength = 4000;
      change.value = answers[q.key + '.note'] || '';
      change.setAttribute('aria-label', T.change);
      change.addEventListener('input', function () { set(q.key + '.note', change.value.trim() ? change.value : null, 600); });
      box.appendChild(card); box.appendChild(change);
      var approve = function () { set(q.key, 'approved'); paint(); setTimeout(function () { if (screen.key === q.key) go(1); }, 320); };
      var paint = function () {
        var v = answers[q.key];
        change.hidden = v !== 'changed';
        if (v === 'changed') footer({ back: true, alt: T.approve, onAlt: approve, next: T.next, skip: null });
        else footer({ back: true, alt: T.modify, onAlt: function () { set(q.key, 'changed'); paint(); change.focus(); }, next: T.approve, onNext: approve, skip: v ? null : T.skip });
      };
      main.replaceChildren(box); paint(); return;
    }
    if (q.type === 'choice' || q.type === 'chips') {
      var multi = q.type === 'chips';
      if (multi) card.classList.add('multi');
      card.setAttribute('role', 'group'); card.setAttribute('aria-labelledby', 'title');
      var buttons = [];
      var refresh = function () {
        var picked = multi ? (answers[q.key] || []) : [answers[q.key]];
        buttons.forEach(function (b) {
          var on = picked.indexOf(b.dataset.id) >= 0;
          b.setAttribute('aria-pressed', String(on));
          b.disabled = multi && q.max && !on && picked.length >= q.max;
        });
        updateNext(q);
      };
      q.options.forEach(function (o) {
        var b = el('button', 'opt'); b.type = 'button'; b.dataset.id = o.id;
        b.appendChild(el('span', 'opt__box'));
        var text = el('span', null, o.label); if (o.desc) text.appendChild(el('small', null, o.desc)); b.appendChild(text);
        b.addEventListener('click', function () {
          if (multi) {
            var list = (answers[q.key] || []).slice(); var at = list.indexOf(o.id);
            if (at >= 0) list.splice(at, 1); else list.push(o.id);
            set(q.key, list); refresh();
          } else {
            var again = answers[q.key] === o.id;
            set(q.key, again ? null : o.id); refresh();
            if (!again && o.id !== 'autre') setTimeout(function () { if (screen.key === q.key) go(1); }, 320);
            if (o.id === 'autre') setTimeout(function () { var i = card.querySelector('input.in'); if (i) i.focus(); }, 30);
          }
        });
        buttons.push(b); card.appendChild(b);
      });
      if (multi) card.appendChild(el('p', 'max', q.max ? T.max(q.max) : T.several));
      // « Autre »: a line to type what, shown while it is picked.
      if (q.other) {
        var otherIn = el('input', 'in'); otherIn.type = 'text'; otherIn.maxLength = 300; otherIn.placeholder = T.otherWhat;
        otherIn.setAttribute('aria-label', T.otherWhat); otherIn.value = answers[q.key + '.other'] || '';
        otherIn.addEventListener('input', function () { set(q.key + '.other', otherIn.value.trim() ? otherIn.value : null, 600); });
        card.appendChild(otherIn);
        var paintOther = function () { var v = answers[q.key]; otherIn.hidden = !(multi ? (v || []).indexOf('autre') >= 0 : v === 'autre'); };
        var oldRefresh = refresh; refresh = function () { oldRefresh(); paintOther(); };
      }
      box.appendChild(card); main.replaceChildren(box); refresh(); return;
    }
    var input = el(q.type === 'long' ? 'textarea' : 'input', 'in surface');
    if (q.type !== 'long') { input.type = 'text'; input.enterKeyHint = 'next'; }
    input.value = answers[q.key] || ''; input.placeholder = T.placeholder;
    input.maxLength = q.type === 'long' ? 4000 : 300;
    input.setAttribute('aria-labelledby', 'title');
    input.addEventListener('input', function () { set(q.key, input.value.trim() ? input.value : null, 600); updateNext(q); });
    if (q.type !== 'long') input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(1); } });
    var wrapIn = el('div', 'fieldwrap'); wrapIn.appendChild(input);
    if (q.type === 'long') wrapIn.appendChild(el('p', 'mic', T.mic));
    box.appendChild(wrapIn); main.replaceChildren(box);
    setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (x) { input.focus(); } }, 60);
    updateNext(q);
  }
  // « Suivant → » fills once answered; until then it waits, and « Passer » is there.
  function updateNext(q) { var has = answered(q); footer({ back: true, next: T.next, disabled: !has, skip: has ? null : T.skip }); }

  function drawOptionalIntro() {
    var n = optionals().length;
    head(T.optional.toUpperCase(), T.optTitle, 1, 1);
    var card = el('div', 'fcard'); card.appendChild(el('p', 'content', data.optionalIntro || T.optLine(n)));
    main.replaceChildren(card);
    footer({ back: true, next: T.cont, skip: T.finish });
  }
  function drawDone() {
    var ess = essentials(), all = visible();
    var done = ess.filter(answered);
    var approvals = all.filter(function (q) { return q.type === 'approve'; });
    var allApprove = approvals.length && approvals.length === all.length;
    var approvedAll = allApprove && approvals.every(function (q) { return answers[q.key] === 'approved'; });
    // As the review sheet: the kind above, the client's name, the bar full, then the done card.
    head(allApprove ? 'Validation' : 'Questionnaire', data.name, done.length, ess.length || 1);
    var card = el('div', 'done');
    card.appendChild(el('p', 'fcard__eyebrow', 'Terminé'));
    var changed = approvals.filter(function (q) { return answers[q.key] === 'changed'; }).length;
    var approvedN = approvals.filter(function (q) { return answers[q.key] === 'approved'; }).length;
    var heading = approvedAll ? T.allApproved(approvals.length)
      : allApprove && done.length === ess.length ? T.mixed(approvedN, changed)
      : done.length === ess.length ? T.allSaved(ess.length) : T.someSaved(done.length, ess.length);
    card.appendChild(el('h2', null, heading));
    card.appendChild(el('p', 'done__pill', data.thanks || (approvedAll ? T.approvedLine : T.savedLine)));
    var missing = ess.filter(function (q) { return !answered(q); });
    if (missing.length) {
      card.appendChild(el('p', 'mic', T.missing));
      var ul = el('ul', 'list');
      missing.forEach(function (q) { var li = el('li'); var b = el('button', null, q.label); b.type = 'button'; b.addEventListener('click', function () { show({ kind: 'q', key: q.key }); }); li.appendChild(b); ul.appendChild(li); });
      card.appendChild(ul);
    }
    main.replaceChildren(card);
    footer({ back: true, next: T.review });
  }

  function sequence() {
    var list = [{ kind: 'welcome' }];
    essentials().forEach(function (q) { list.push({ kind: 'q', key: q.key }); });
    var opt = optionals();
    if (opt.length) { list.push({ kind: 'optional' }); opt.forEach(function (q) { list.push({ kind: 'q', key: q.key }); }); }
    list.push({ kind: 'done' });
    return list;
  }
  function position() { var list = sequence(); for (var i = 0; i < list.length; i++) if (list[i].kind === screen.kind && (screen.kind !== 'q' || list[i].key === screen.key)) return i; return 0; }
  function show(target) {
    flush(); screen = target; window.scrollTo(0, 0); $('body').scrollTop = 0;
    if (target.kind === 'welcome') return drawWelcome();
    if (target.kind === 'optional') return drawOptionalIntro();
    if (target.kind === 'done') return drawDone();
    var q = visible().filter(function (x) { return x.key === target.key; })[0];
    if (!q) return go(1);
    var group = q.optional ? optionals() : essentials();
    drawQuestion(q, group.indexOf(q) + 1, group.length);
  }
  function go(step) { var list = sequence(); show(list[Math.max(0, Math.min(list.length - 1, position() + step))]); }

  nextBtn.addEventListener('click', function () {
    if (onNext) return onNext();
    if (screen.kind === 'welcome') { var first = essentials().filter(function (q) { return !answered(q); })[0]; return first ? show({ kind: 'q', key: first.key }) : go(1); }
    if (screen.kind === 'done') return show({ kind: 'q', key: (essentials()[0] || visible()[0]).key });
    go(1);
  });
  skipBtn.addEventListener('click', function () { if (screen.kind === 'optional') return show({ kind: 'done' }); go(1); });
  backBtn.addEventListener('click', function () { go(-1); });
  back2.addEventListener('click', function () { go(-1); });
  altBtn.addEventListener('click', function () { if (onAlt) onAlt(); });
  if (window.visualViewport) {
    var sheet = document.querySelector('.sheet');
    var lift = function () { var vv = window.visualViewport; sheet.style.bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px'; };
    window.visualViewport.addEventListener('resize', lift); window.visualViewport.addEventListener('scroll', lift);
  }
  window.addEventListener('pagehide', flush);
  show({ kind: 'welcome' });
})();
`;

export function flowPage(model, nonce) {
  const accent = model.accent ? `:root { --accent: ${model.accent}; }` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#122238">
<title>${esc(model.brand)} · Questionnaire</title>
<style nonce="${nonce}">${CSS}${accent}</style>
</head>
<body>
<div class="page">
  <header class="brandbar"><span class="brand">${esc(model.brand)}</span><span class="saved" id="saved" role="status"></span></header>
  <div class="backdrop" aria-hidden="true"><span class="backdrop__brand">${esc(model.brand)}</span><span class="backdrop__dim"></span></div>
  <section class="sheet" aria-labelledby="title">
    <div class="sheet__head">
      <div class="sheet__top"><p class="eyebrow" id="eyebrow"></p><span class="saved" id="saved2" role="status"></span></div>
      <h1 class="title" id="title"></h1>
      <div class="prog" id="prog" hidden><div class="prog__bar"><i id="bar"></i></div><span class="prog__n" id="count"></span></div>
    </div>
    <div class="sheet__body" id="body"><div id="main"><noscript><p>Ce questionnaire a besoin de JavaScript.</p></noscript></div></div>
    <footer class="sheet__foot" id="foot">
      <div class="row" id="row"><button type="button" class="btn" id="back">Retour</button><button type="button" class="btn" id="alt" hidden>Modifier</button><button type="button" class="btn primary" id="next">Commencer →</button></div>
      <div class="quiets"><button type="button" class="quiet" id="back2" hidden>Retour</button><button type="button" class="quiet" id="skip" hidden>Passer</button></div>
    </footer>
  </section>
</div>
<script type="application/json" id="flow-data">${scriptJson({ name: model.name, firstName: model.firstName, tu: model.tu, welcome: model.welcome, thanks: model.thanks, optionalIntro: model.optionalIntro, questions: model.questions, answers: model.answers })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
