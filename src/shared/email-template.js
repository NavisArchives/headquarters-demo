/* The designed email — "Reintroduction Email" layout: a 680px table on a warm
   sand ground, Georgia headline and closing, Helvetica body, one solid and one
   outlined button, hosted hero photo. Built from the plain-text draft, so every
   edit in the panel carries straight over.

   Ported whole from the `htmlEmail()` function in leads/assets/outreach.js — see
   the note in this repo's phase-4 task report for why the literal disk file
   `leads/assets/email-template.js` (a `window.BRAND_EMAIL_TEMPLATE` string with a
   base64-embedded hero photo) was not the porting source: it is unreferenced by
   `leads/assets/app.js` and embeds the very image the ten-minute/hosted-URL rule
   below exists to forbid. The real, in-use "designed email" builder — 680px width,
   the PORTFOLIO/TIKTOK buttons, the serif closing, the signature block, the
   hosted-not-embedded hero — is `Outreach.htmlEmail`, and that is what is ported
   here, reshaped into a pure function.

   Shape changes only: `row`/`lang`/`subject` (DOM/app-state concerns) are gone;
   the caller now passes the composed `body` text directly, a resolved `profile`,
   and a ready-made `pixelUrl` (replacing the old `window.LEADS_TRACKING` global
   and in-module `row.uid` + `Date.now()` construction — token/URL assembly is the
   API's job now, not this module's). Every line of markup, every style value,
   every rule about what appears and when, is unchanged. */

import { DEFAULT_PROFILE } from './outreach.js';

function resolveProfile(p) {
  p = p || {};
  var o = {};
  for (var k in DEFAULT_PROFILE) o[k] = p[k] != null && p[k] !== "" ? p[k] : DEFAULT_PROFILE[k];
  return o;
}

var EC = { ground: "#f3efe8", card: "#faf8f4", ink: "#2b2320", body: "#3d3430", muted: "#7a6a58", rule: "#ddd5c9" };
var EW = 680; /* desktop card width — still inside Gmail's reading pane */
var ESERIF = "Georgia,'Times New Roman',serif", ESANS = "Helvetica,Arial,sans-serif";
/* The photo is loaded from a public URL, not embedded. Gmail re-encodes a message
   when you press Send and drops embedded images, which arrived as a broken box. */
var HERO_URL = "https://leads.example.com/hero.jpg";
function heroSrc(profile) {
  var custom = (profile.hero || "").trim();
  return /^https?:\/\//i.test(custom) ? custom : HERO_URL;
}
function eesc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function ttUrl(handle) { var h = String(handle || "").replace(/^@/, "").trim(); return h ? "https://www.tiktok.com/@" + h : ""; }

export function buildDesignedEmail(opts) {
  opts = opts || {};
  var body = opts.body;
  var p = resolveProfile(opts.profile);
  var pixelUrl = opts.pixelUrl;

  var blocks = String(body).replace(/\r\n/g, "\n").split(/\n\s*\n/).map(function (b) { return b.trim(); }).filter(Boolean);

  /* pull the pieces the design treats differently */
  var sig = "";
  if (blocks.length > 1 && /\n/.test(blocks[blocks.length - 1])) sig = blocks.pop();
  var closing = "";
  var last = blocks[blocks.length - 1] || "";
  if (blocks.length > 1 && last.indexOf("\n") === -1 && last.length <= 70 && !/^(portfolio|tiktok)\s*:/i.test(last)) closing = blocks.pop();
  var head = (blocks.shift() || "").split("\n");
  var heading = head.shift() || "", sub = head.join(" ");
  var paras = [], links = null;
  blocks.forEach(function (b) {
    if (/^(portfolio|tiktok)\s*:/im.test(b)) { links = links || true; return; }
    paras.push(b);
  });

  var pad = function (v) { return 'class="pad" style="padding:' + v + ';"'; };
  var text = function (t, top) {
    return '<tr><td ' + pad(top + 'px 56px 0 56px') + '><div style="font-family:' + ESANS + ';font-size:17px;line-height:27px;color:' + EC.body + ';">' +
      eesc(t).replace(/\n/g, "<br>") + '</div></td></tr>';
  };

  var rows = '';
  if (p.studio) rows += '<tr><td ' + pad('36px 56px 20px 56px') + '><div style="font-family:' + ESERIF + ';font-size:13px;letter-spacing:3px;text-transform:uppercase;color:' + EC.muted + ';line-height:18px;">' + eesc(p.studio) + '</div></td></tr>';
  var hero = heroSrc(p);
  if (hero) rows += '<tr><td style="padding:0;"><img src="' + eesc(hero) + '" width="' + EW + '" alt="' + eesc(p.name) + '" style="display:block;width:100%;max-width:' + EW + 'px;height:auto;border:0;"></td></tr>';
  if (heading) rows += '<tr><td ' + pad('40px 56px 0 56px') + '><div style="font-family:' + ESERIF + ';font-size:34px;line-height:40px;color:' + EC.ink + ';">' + eesc(heading) + '</div></td></tr>';
  if (sub) rows += text(sub, 12);
  paras.forEach(function (t) { rows += text(t, 20); });

  var tk = ttUrl(p.social);
  if (links && (p.portfolio || tk)) {
    rows += '<tr><td ' + pad('32px 56px 0 56px') + '><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      (p.portfolio ? '<td bgcolor="' + EC.ink + '" style="background-color:' + EC.ink + ';border-radius:2px;"><a href="' + eesc(p.portfolio) + '" style="display:block;padding:14px 26px;font-family:' + ESANS + ';font-size:14px;letter-spacing:1px;text-transform:uppercase;color:' + EC.card + ';text-decoration:none;">Portfolio</a></td>' : "") +
      (p.portfolio && tk ? '<td width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>' : "") +
      (tk ? '<td style="border:1px solid ' + EC.ink + ';border-radius:2px;"><a href="' + eesc(tk) + '" style="display:block;padding:13px 26px;font-family:' + ESANS + ';font-size:14px;letter-spacing:1px;text-transform:uppercase;color:' + EC.ink + ';text-decoration:none;">TikTok ' + eesc(String(p.social).replace(/^@?/, "@")) + '</a></td>' : "") +
      '</tr></table></td></tr>';
  }
  if (closing) rows += '<tr><td ' + pad('36px 56px 0 56px') + '><div style="font-family:' + ESERIF + ';font-size:22px;line-height:30px;color:' + EC.ink + ';">' + eesc(closing) + '</div></td></tr>';

  if (sig) {
    var lines = sig.split("\n").map(function (l, i, a) {
      if (i === 0) return '<strong style="color:' + EC.ink + ';">' + eesc(l) + '</strong>';
      if (/^\+?[\d\s().-]{7,}$/.test(l.trim())) return '<a href="tel:' + eesc(l.replace(/[^\d+]/g, "")) + '" style="color:' + EC.body + ';text-decoration:none;">' + eesc(l) + '</a>';
      if (i === a.length - 1 && /·/.test(l)) return '<span style="color:' + EC.muted + ';letter-spacing:2px;font-size:13px;">' + eesc(l) + '</span>';
      return eesc(l);
    }).join("<br>");
    rows += '<tr><td ' + pad('28px 56px 40px 56px') + '><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ' + EC.rule + ';"><tr><td style="padding:24px 0 0 0;font-family:' + ESANS + ';font-size:15px;line-height:24px;color:' + EC.body + ';">' + lines + '</td></tr></table></td></tr>';
  } else rows += '<tr><td style="padding:0 0 40px 0;font-size:0;line-height:0;">&nbsp;</td></tr>';

  /* One transparent pixel, unique per send, so an open can be told apart from a
     cached copy. It is the last thing in the email and is never visible. The
     original built this from `window.LEADS_TRACKING` + `row.uid` + `Date.now()`;
     the caller (the worker's compose route) now builds the finished URL, keyed
     to a per-send token stored in D1/KV, and passes it straight through. */
  var track = "";
  if (pixelUrl) {
    track = '<img src="' + eesc(pixelUrl) + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">';
  }

  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<title>' + eesc(heading) + '</title>' +
    '<!--[if mso]><style>table,td{font-family:Arial,sans-serif!important;}</style><![endif]-->' +
    '<style>@media only screen and (max-width:700px){.wrap{width:100%!important;}.pad{padding-left:24px!important;padding-right:24px!important;}}</style>' +
    '</head><body style="margin:0;padding:0;background-color:' + EC.ground + ';">' +
    (sub ? '<span style="display:none;font-size:1px;color:' + EC.ground + ';line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">' + eesc(sub) + '</span>' : "") +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' + EC.ground + ';">' +
    '<tr><td align="center" style="padding:32px 12px;">' +
    '<table role="presentation" class="wrap" width="' + EW + '" cellpadding="0" cellspacing="0" border="0" style="width:' + EW + 'px;max-width:' + EW + 'px;background-color:' + EC.card + ';">' +
    rows + '</table></td></tr></table>' + track + '</body></html>';
}
