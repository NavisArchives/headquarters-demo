import { closerBody } from './closer.js';

/* Outreach — per-lead email drafts, in the lead's language, adapted to the segment.
   Generic across lists: templates are keyed by dataset `business`, so a new list
   only needs an entry in TPL.

   Ported from leads/assets/outreach.js. Every hook, every segment rule, every
   language rule, every sentence of every template is unchanged. What changed is
   only the shape: `window.Outreach` became ES module exports, and `localStorage`
   reads/writes (the profile, saved drafts, the saved greeting name) were removed
   — that data now arrives as parameters (`profile`, `draft`) instead. The module
   is pure: no DOM, no globals, no storage. */

/* Two brands, never mixed. Website leads (dataset business "Web design") are
   written as Realis Studio; every UGC / influencer lead as andyssarchives.
   The brand decides studio, address, portfolio, socials and the email's hero
   image; the person's profile only ever supplies name and phone. Nothing in
   a Realis email mentions Andy's personal story. */
export const BRANDS = {
  realis: {
    key: "realis",
    studio: "Realis Studio",
    email: "hello@realisstudio.com",
    portfolio: "https://realisstudio.com",
    social: "",
    hero: "https://realisstudio.com/og.png"
  },
  archive: {
    key: "archive",
    studio: "andyssarchives",
    email: "contact@andyssarchives.com",
    portfolio: "https://ugc.andyssarchives.com",
    social: "@fieldnote.studio",
    hero: ""
  }
};
var BRAND_KEYS = ["studio", "email", "portfolio", "social", "hero"];

/* UGC lists carry business "UGC"; every other list (Web design, Plastic
   surgeons, Architects, …) is a website prospect and belongs to Realis. */
export function isWebLead(row) {
  var b = String((row && row.business) || "").trim().toLowerCase();
  return b !== "" && b !== "ugc";
}
/* The Dr letter is for plastic surgeons only (audit A2, 13 Nov): every website
   lead used to get it, architects and law firms included. A surgeon is a lead
   from one of the plastic-surgeons-<country> lists, whose business is
   « Plastic surgeons »; their category says what kind of site they have, not
   what they do. */
export function isSurgeonLead(row) {
  if (/^plastic-surgeons(-|$)/.test(String((row && row.dataset) || ""))) return true;
  return String((row && row.business) || "").trim().toLowerCase() === "plastic surgeons";
}
/* What the pop-up says when a website lead has no letter of its own yet.
   MARKETING writes that copy and NIRMATA checks it; HQ never improvises one. */
export var NO_SECTOR_COPY = "No email for this sector yet: the Dr letter is for surgeons only. MARKETING is writing the copy for this kind of lead. You can write your own here.";
export function brandFor(row) {
  return isWebLead(row) ? BRANDS.realis : BRANDS.archive;
}

export const DEFAULT_PROFILE = {
  name: "Andy",
  studio: BRANDS.archive.studio,
  email: BRANDS.archive.email,
  phone: "+32 400 00 00 00",
  portfolio: BRANDS.archive.portfolio,
  social: BRANDS.archive.social,
  hero: ""
};

// Merge a partial profile onto the defaults the same way the old app's
// localStorage-backed `profile()` did: an empty or missing value falls back.
// Then the brand overrides its own fields — a saved profile cannot put the
// andyssarchives address under a Realis Studio email.
function resolveProfile(p, brand) {
  p = p || {};
  var o = {};
  for (var k in DEFAULT_PROFILE) o[k] = p[k] != null && p[k] !== "" ? p[k] : DEFAULT_PROFILE[k];
  if (brand) BRAND_KEYS.forEach(function (k) { o[k] = brand[k]; });
  return o;
}

/** The profile a lead's email is signed with: the person plus the lead's brand. */
export function profileFor(row, profile) {
  return resolveProfile(profile, brandFor(row));
}

/* ---------- which language, which angle ---------- */

var NL_COUNTRIES = ["Netherlands", "Belgium"];
var FR_COUNTRIES = ["France", "Belgium", "Switzerland", "Luxembourg"];

export function langsFor(row) {
  var have = (row.languages || []).slice();
  var out = [];
  // the language you'd actually write this one in, first
  if (have.indexOf("NL") !== -1 && NL_COUNTRIES.indexOf(row.country) !== -1) out.push("NL");
  if (have.indexOf("FR") !== -1 && FR_COUNTRIES.indexOf(row.country) !== -1) out.push("FR");
  ["EN", "FR", "NL"].forEach(function (l) { if (have.indexOf(l) !== -1 && out.indexOf(l) === -1) out.push(l); });
  return out.length ? out : ["EN"];
}

/* A prospect with no website of their own is a different conversation from a
   prospect with a dated one: you cannot say you came across their site, and
   you are not offering a rebuild. The scrape already knows which is which —
   `category` is "No site" and payload.extra.Need is "no website" for 238 of
   the 326 surgeons — so the template asks rather than assuming. */
export function hasSite(row) {
  var need = row && row.extra && row.extra.Need;
  if (typeof need === "string" && need.trim().toLowerCase() === "no website") return false;
  var category = String((row && row.category) || "").trim().toLowerCase();
  if (category === "no site") return false;
  return true;
}

/* "LA LOUVIERE" is how the register writes it; nobody writes their own town
   that way. Title-case it so a sentence built around it reads like a person
   wrote it. */
function townOf(row) {
  var city = String((row && row.city) || "").trim();
  if (!city) return "";
  return city.toLowerCase().replace(/(^|[\s'\u2019-])([a-z\u00e0-\u00ff])/g, function (m, edge, ch) {
    return edge + ch.toUpperCase();
  });
}

export function segmentFor(row) {
  if (isWebLead(row)) return "webdesign";
  var c = (row.category || "").toLowerCase();
  if (c.indexOf("agency") !== -1 || c.indexOf("platform") !== -1) return "agency";
  if (c.indexOf("community") !== -1 || c.indexOf("source") !== -1) return "source";
  if (c.indexOf("beauty") !== -1) return "beauty";
  if (c.indexOf("food") !== -1) return "food";
  if (c.indexOf("tech") !== -1) return "tech";
  return "brand";
}

export var SEGMENT_LABEL = {
  beauty: "Beauty brand", food: "Food brand", tech: "Tech brand", brand: "Brand",
  agency: "Agency / platform roster", source: "Not an outreach target", webdesign: "Web design prospect"
};

/* ---------- the opening hook ---------- */

var HOOK = {
  EN: {
    programme: "I came across your creator programme and wanted to put myself forward directly rather than through a platform.",
    job: "I saw you were looking for a UGC creator, and wanted to introduce myself directly.",
    blank: "[One line on why them specifically — pull it from “Why they are on the list” in the panel.]"
  },
  FR: {
    programme: "Je suis tombé sur votre programme créateurs et je préfère me présenter directement plutôt que via une plateforme.",
    job: "J'ai vu que vous cherchiez un créateur UGC, et je voulais me présenter directement.",
    blank: "[Une phrase sur eux en particulier — à reprendre de « Why they are on the list » dans le panneau.]"
  },
  NL: {
    programme: "Ik kwam jullie creator-programma tegen en stel me liever direct voor dan via een platform.",
    job: "Ik zag dat jullie een UGC-creator zoeken, en wilde me even direct voorstellen.",
    blank: "[Eén zin over hen specifiek — haal die uit “Why they are on the list” in het paneel.]"
  }
};

function hookFor(row, lang) {
  /* A line written for this exact lead, in their language, beats any template.
     data.json carries it as openingLine: {nl: "...", fr: "..."}. */
  var own = row.openingLine && row.openingLine[String(lang).toLowerCase()];
  if (own) return own;
  /* A website prospect with nothing online gets a line built from the town
     the register gave, so it is true by construction. With no town there is
     no sentence at all, rather than a sentence about nowhere. */
  if (isWebLead(row) && !hasSite(row)) {
    var l = WEB_NEW_HOOK[lang] ? lang : "EN";
    return townOf(row) ? WEB_NEW_HOOK[l].replace(/\{\{town\}\}/g, townOf(row)) : "";
  }
  var h = HOOK[lang] || HOOK.EN;
  var e = ((row.evidence || "") + " " + (row.research || "")).toLowerCase();
  if (/job ad|posting|casting|hiring|role|vacature|job board/.test(e)) return h.job;
  if (/programme|program|creator|roster|recruit|sign ?up|application|apply|ambassador|talent pool/.test(e)) return h.programme;
  return h.blank;
}

/* ---------- templates ---------- */
/* Tokens: {{brand}} {{name}} {{hook}} {{sig}} */

var SIGN = {
  EN: "Best,\n{{sig}}",
  FR: "Bien à vous,\n{{sig}}",
  NL: "Groeten,\n{{sig}}"
};

var T = {};

/* Every email has the same spine:
     1. the return-from-travel intro + portfolio link   (INTRO, per language)
     2. why you, for this kind of company               (per segment)
     3. the hook about them                             ({{hook}})
     4. the ask                                         (CLOSE, per language)
   Segments only change block 2, so the voice stays yours everywhere. */

var INTRO = {
  EN: "{{greeting}},\n\n" +
    "I spent the last two years travelling through Europe. I'm back in Europe now and eager to get back to working with brands — I've just updated my portfolio: {{portfolio}}\n",
  FR: "{{greeting}},\n\n" +
    "J'ai passé les deux dernières années à voyager à travers l’Europe. Je suis de retour en Europe et j'ai très envie de retravailler avec des marques — je viens de mettre mon portfolio à jour : {{portfolio}}\n",
  NL: "{{greeting}},\n\n" +
    "Ik heb de afgelopen twee jaar door Europa gereisd. Ik ben terug in Europa en heb veel zin om weer met merken te werken — mijn portfolio is net bijgewerkt: {{portfolio}}\n"
};

var CLOSE = {
  EN: "I'd love to get in touch and see whether there are campaigns we could work on together. Could you tell me what your current UGC briefs and rates look like?\n\n" + SIGN.EN,
  FR: "J'aimerais beaucoup échanger avec vous et voir s'il y a des campagnes sur lesquelles nous pourrions travailler ensemble. Pourriez-vous me dire à quoi ressemblent vos briefs UGC et vos tarifs actuels ?\n\n" + SIGN.FR,
  NL: "Ik kom graag in contact om te kijken of er campagnes zijn waar we samen aan kunnen werken. Kun je me laten weten hoe jullie UGC-briefings en tarieven er nu uitzien?\n\n" + SIGN.NL
};

var CLOSE_AGENCY = {
  EN: "I'd love to be considered for your roster. What does your onboarding look like, and what rates do you typically work with?\n\n" + SIGN.EN,
  FR: "Je serais ravi d'être considéré pour votre réseau de créateurs. Comment se passe votre onboarding, et avec quels tarifs travaillez-vous généralement ?\n\n" + SIGN.FR,
  NL: "Ik word graag opgenomen in jullie creator-bestand. Hoe ziet jullie onboarding eruit, en met welke tarieven werken jullie doorgaans?\n\n" + SIGN.NL
};

/* Web-design prospects are cold B2B, written as Realis Studio: no personal
   story, no travel, nothing about Andy beyond the first name. The studio is
   specialised in websites and social media for architects and plastic
   surgeons, and the ask is a visual take rather than a rate card. */
var INTRO_WEB = {
  EN: "{{greeting}},\n\nI'm Andy from Realis Studio, a Brussels studio specialised in websites and social media for architects and plastic surgeons. I came across your website and wanted to flag one thing.\n",
  FR: "{{greeting}},\n\nJe suis Andy, de Realis Studio, un studio bruxellois spécialisé dans les sites web et les réseaux sociaux des architectes et des chirurgiens plasticiens. Je suis tombé sur votre site et je voulais relever un point.\n",
  NL: "{{greeting}},\n\nIk ben Andy van Realis Studio, een Brussels studio gespecialiseerd in websites en social media voor architecten en plastisch chirurgen. Ik kwam uw website tegen en wilde één ding aanstippen.\n"
};
var CLOSE_WEB = {
  EN: "Could I send you a short visual take — what your homepage would look like rebuilt? No obligation; if it isn't for you, you've lost nothing.\n\n" + SIGN.EN,
  FR: "Puis-je vous envoyer une courte proposition visuelle — à quoi ressemblerait votre page d'accueil reconstruite ? Sans engagement ; si cela ne vous parle pas, vous n'aurez rien perdu.\n\n" + SIGN.FR,
  NL: "Mag ik u een korte visuele voorzet sturen — hoe uw homepage er opnieuw opgebouwd uit zou zien? Vrijblijvend; als het niets voor u is, bent u niets kwijt.\n\n" + SIGN.NL
};

/* ---------- website prospects who have no website ----------
   238 of the 326 surgeons on the list have no site of their own; the register
   entry is all there is. The "I came across your website" opening is false for
   them, and an offer to rebuild a homepage they do not have is worse than no
   offer. So they get their own intro, their own ask, their own subject and
   their own nudge. Nothing here is personal and nothing names a country: the
   studio speaks, not the person. */
var INTRO_WEB_NEW = {
  EN: "{{greeting}},\n\nI'm Andy from Realis Studio. We design websites and run social media for architects and plastic surgeons, in Dutch, French and English.\n\nI went looking for your practice online and found your entry in the register, but no site of your own. That is why I'm writing.\n",
  FR: "{{greeting}},\n\nJe suis Andy, de Realis Studio. Nous concevons les sites web et g\u00e9rons les r\u00e9seaux sociaux des architectes et des chirurgiens plasticiens, en n\u00e9erlandais, en fran\u00e7ais et en anglais.\n\nJ'ai cherch\u00e9 votre cabinet en ligne : j'ai trouv\u00e9 votre fiche au registre, mais aucun site qui vous appartienne. C'est la raison de ce message.\n",
  NL: "{{greeting}},\n\nIk ben Andy van Realis Studio. Wij ontwerpen websites en verzorgen social media voor architecten en plastisch chirurgen, in het Nederlands, Frans en Engels.\n",
};
/* The Dutch intro's second paragraph is built separately: "praktijk" and the
   register sentence read better after the greeting than inside it. */
INTRO_WEB_NEW.NL += "\nIk zocht uw praktijk online en vond uw vermelding in het register, maar geen eigen site. Daarom schrijf ik u.\n";

var CLOSE_WEB_NEW = {
  EN: "If it is useful, I can put together a first page for your practice and send it to you: who you are, what you treat, where you consult and how someone reaches you. Looking at it costs nothing and commits you to nothing.\n\nShall I?\n\n" + SIGN.EN,
  FR: "Si cela vous est utile, je peux pr\u00e9parer une premi\u00e8re page pour votre cabinet et vous l'envoyer : qui vous \u00eates, ce que vous traitez, o\u00f9 vous consultez et comment vous joindre. La regarder ne co\u00fbte rien et ne vous engage \u00e0 rien.\n\nJe la pr\u00e9pare ?\n\n" + SIGN.FR,
  NL: "Als het u iets lijkt, maak ik een eerste pagina voor uw praktijk en stuur ik die door: wie u bent, wat u behandelt, waar u consulteert en hoe men u bereikt. Kijken kost niets en verplicht u tot niets.\n\nZal ik dat doen?\n\n" + SIGN.NL,
};

/* The one line that is about them and nobody else. Built from the town the
   register gives, so it is true by construction; when there is no town the
   paragraph simply does not appear. */
var WEB_NEW_HOOK = {
  EN: "Someone in {{town}} looking for a plastic surgeon searches before they call, and today what they find is the register rather than you.",
  FR: "Quelqu'un \u00e0 {{town}} qui cherche un chirurgien plasticien commence par une recherche, et aujourd'hui il tombe sur le registre plut\u00f4t que sur vous.",
  NL: "Wie in {{town}} een plastisch chirurg zoekt, zoekt eerst online \u2014 en vindt vandaag het register in plaats van u.",
};

var SUBJECT_WEB_NEW = {
  EN: "A first website for your practice",
  FR: "Un premier site pour votre cabinet",
  NL: "Een eerste website voor uw praktijk",
};

var FOLLOWUP_WEB_NEW = {
  EN: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nBringing this back up once in case it got buried \u2014 no pressure either way.\n\nIf a site for the practice is not something you want, say so and I will leave you be. If it is, I can have that first page with you this week.\n\n" + SIGN.EN },
  FR: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nJe remonte ce message une fois, au cas o\u00f9 il serait pass\u00e9 inaper\u00e7u \u2014 sans insistance.\n\nSi un site pour le cabinet ne vous int\u00e9resse pas, dites-le et je n'y reviendrai plus. Si c'est le cas, je peux vous envoyer cette premi\u00e8re page cette semaine.\n\n" + SIGN.FR },
  NL: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nIk breng dit \u00e9\u00e9n keer terug naar boven, voor het geval het ondergesneeuwd raakte \u2014 geen druk.\n\nAls een site voor de praktijk niets voor u is, laat het weten en ik val u niet meer lastig. Zo ja, dan stuur ik die eerste pagina deze week door.\n\n" + SIGN.NL },
};

var DM_WEB_NEW = {
  EN: "{{greeting}}, I'm Andy from Realis Studio \u2014 we design websites and run social media for architects and plastic surgeons. I looked for your practice online and found the register entry but no site of your own. Would a first page be useful? Work: {{portfolio}}",
  FR: "{{greeting}}, je suis Andy, de Realis Studio \u2014 nous concevons les sites web et g\u00e9rons les r\u00e9seaux sociaux des architectes et des chirurgiens plasticiens. J'ai cherch\u00e9 votre cabinet en ligne : j'ai trouv\u00e9 le registre, mais aucun site \u00e0 vous. Une premi\u00e8re page vous serait-elle utile ? R\u00e9alisations : {{portfolio}}",
  NL: "{{greeting}}, ik ben Andy van Realis Studio \u2014 wij ontwerpen websites en verzorgen social media voor architecten en plastisch chirurgen. Ik zocht uw praktijk online en vond wel het register, maar geen eigen site. Zou een eerste pagina nuttig zijn? Werk: {{portfolio}}",
};

/* The pitch for a practice with nothing online yet: no "rebuild", no "dated",
   and the proof point named rather than implied. */
var WHY_WEB_NEW = {
  EN: "We build the whole thing: the structure, the design, the text in all three languages, the photography if you want it, and the search setup that makes you findable. Recent work includes an architecture practice and a plastic surgeon in Brussels: {{portfolio}}",
  FR: "Nous faisons l'ensemble : la structure, le design, les textes dans les trois langues, la photographie si vous le souhaitez, et le r\u00e9f\u00e9rencement qui vous rend trouvable. R\u00e9cemment : un bureau d'architectes et un chirurgien plasticien \u00e0 Bruxelles : {{portfolio}}",
  NL: "Wij doen het geheel: de structuur, het ontwerp, de teksten in de drie talen, de fotografie als u dat wenst, en de vindbaarheid in de zoekmachines. Recent onder meer een architectenbureau en een plastisch chirurg in Brussel: {{portfolio}}",
};

/* block 2 — why you, per segment */
var WHY = {
  beauty: {
    EN: "Most of my work has been in beauty: long-term ambassador for Brand One, Brand Two, Brand Three and Brand Four, and paid campaigns for Brand Five and Brand Six. Before that I sold fragrance in-store for Chanel, Dior and YSL, so I'm used to explaining a product to someone who is about to buy it. I write, shoot and edit everything myself, and deliver natively in Dutch, French and English — one shoot day covers three markets instead of three castings.",
    FR: "L'essentiel de mon travail s'est fait en beauté : ambassadeur longue durée pour Brand One, Brand Two, Brand Three et Brand Four, et campagnes rémunérées pour Brand Five et Brand Six. Avant cela, j'ai vendu du parfum en boutique pour Chanel, Dior et YSL — j'ai l'habitude d'expliquer un produit à quelqu'un qui s'apprête à l'acheter. J'écris, je filme et je monte moi-même, et je livre en néerlandais, en français et en anglais : une journée de tournage couvre trois marchés au lieu de trois castings.",
    NL: "Het grootste deel van mijn werk zit in beauty: langlopend ambassadeurschap voor Brand One, Brand Two, Brand Three en Brand Four, en betaalde campagnes voor Brand Five en Brand Six. Daarvoor verkocht ik parfum in de winkel voor Chanel, Dior en YSL — ik ben gewend een product uit te leggen aan iemand die op het punt staat te kopen. Ik schrijf, film en monteer alles zelf en lever native in het Nederlands, Frans en Engels — één draaidag dekt drie markten in plaats van drie castings."
  },
  tech: {
    EN: "I'm a filmmaker and a full-stack developer, which is an unusual pairing in this work: I can set a product up, use it properly and show it actually working on camera, rather than faking the demo. On the brand side I've been a long-term ambassador for Brand One, Brand Two, Brand Three and Brand Four and shot paid campaigns for Brand Five and Brand Six, so the ad craft is there too. I write, shoot and edit myself and deliver natively in Dutch, French and English.",
    FR: "Je suis à la fois vidéaste et développeur full-stack, une combinaison rare dans ce métier : je peux installer un produit, l'utiliser réellement et le montrer en fonctionnement à l'écran, au lieu de simuler la démo. Côté marques, j'ai été ambassadeur longue durée pour Brand One, Brand Two, Brand Three et Brand Four, et j'ai tourné des campagnes rémunérées pour Brand Five et Brand Six. J'écris, je filme et je monte moi-même, et je livre en néerlandais, en français et en anglais.",
    NL: "Ik ben filmmaker én full-stack developer, een zeldzame combinatie in dit werk: ik kan een product opzetten, het echt gebruiken en op camera laten werken in plaats van de demo te faken. Aan de merkkant was ik langlopend ambassadeur voor Brand One, Brand Two, Brand Three en Brand Four en draaide ik betaalde campagnes voor Brand Five en Brand Six. Ik schrijf, film en monteer zelf en lever native in het Nederlands, Frans en Engels."
  },
  food: {
    EN: "Food is the category where the gap between phone footage and someone who can actually light it shows up immediately — I come from film production and write, shoot, light and edit myself. Brand side: long-term ambassador for Brand One, Brand Two, Brand Three and Brand Four, and paid campaigns for Brand Five and Brand Six. I deliver natively in Dutch, French and English, so one shoot day covers Flanders, Wallonia and your international market instead of three separate castings.",
    FR: "Le food est la catégorie où l'écart entre une vidéo au téléphone et quelqu'un qui sait éclairer se voit immédiatement — je viens de la production audiovisuelle et j'écris, filme, éclaire et monte moi-même. Côté marques : ambassadeur longue durée pour Brand One, Brand Two, Brand Three et Brand Four, et campagnes rémunérées pour Brand Five et Brand Six. Je livre en néerlandais, en français et en anglais : une journée de tournage couvre la Flandre, la Wallonie et votre marché international au lieu de trois castings séparés.",
    NL: "Food is de categorie waar het verschil tussen telefoonbeelden en iemand die echt kan belichten meteen opvalt — ik kom uit de filmproductie en schrijf, film, belicht en monteer zelf. Aan de merkkant: langlopend ambassadeurschap voor Brand One, Brand Two, Brand Three en Brand Four, en betaalde campagnes voor Brand Five en Brand Six. Ik lever native in het Nederlands, Frans en Engels: één draaidag dekt Vlaanderen, Wallonië én jullie internationale markt in plaats van drie aparte castings."
  },
  agency: {
    EN: "I'm a filmmaker and UGC creator running a small studio, andyssarchives, between Berlin and Brussels. I deliver natively in Dutch, French and English — in practice, the same campaign in two or three language versions from one shoot, with no second casting. Background: long-term ambassador for Brand One, Brand Two, Brand Three and Brand Four, paid campaigns for Brand Five and Brand Six, and a film-production background, so I write, shoot, light and edit myself. I also build software, which makes me quick on the tech and app briefs other creators tend to avoid.",
    FR: "Je suis vidéaste et créateur UGC, à la tête d'un petit studio, andyssarchives, entre Berlin et Bruxelles. Je livre en néerlandais, en français et en anglais — concrètement, la même campagne en deux ou trois versions linguistiques depuis un seul tournage, sans second casting. Parcours : ambassadeur longue durée pour Brand One, Brand Two, Brand Three et Brand Four, campagnes rémunérées pour Brand Five et Brand Six, et une formation en production audiovisuelle — j'écris, je filme, j'éclaire et je monte moi-même. Je développe aussi des logiciels, ce qui me rend rapide sur les briefs tech et applis.",
    NL: "Ik ben filmmaker en UGC-creator met een kleine studio, andyssarchives, tussen Berlijn en Brussel. Ik lever native in het Nederlands, Frans en Engels — in de praktijk: dezelfde campagne in twee of drie taalversies vanuit één draaidag, zonder tweede casting. Achtergrond: langlopend ambassadeurschap voor Brand One, Brand Two, Brand Three en Brand Four, betaalde campagnes voor Brand Five en Brand Six, en een achtergrond in filmproductie — ik schrijf, film, belicht en monteer zelf. Daarnaast bouw ik software, waardoor ik snel ben op tech- en app-briefings waar andere creators vanaf blijven."
  },
  webdesign: {
    EN: "We design and build complete rebuilds: new structure, new design, fast on mobile, ready to be found. We can also run the social media that sends people to it. Recent work includes an architecture practice and a plastic surgeon in Brussels: {{portfolio}}",
    FR: "Nous concevons et réalisons des refontes complètes, avec une nouvelle structure, un nouveau design, rapide sur mobile, prêt à être trouvé. Nous pouvons aussi gérer les réseaux sociaux qui y amènent du monde. Récemment : un bureau d'architectes et un chirurgien plasticien à Bruxelles : {{portfolio}}",
    NL: "Wij ontwerpen en bouwen volledige herbouwen: nieuwe structuur, nieuw ontwerp, snel op mobiel, klaar om gevonden te worden. Wij kunnen ook de social media verzorgen die mensen naar de site brengt. Recent onder meer een architectenbureau en een plastisch chirurg in Brussel: {{portfolio}}"
  }
};

var SUBJECT = {
  beauty:    { EN: "Back in Europe — UGC creator (EN/FR/NL) for {{brand}}", FR: "De retour en Europe — créateur UGC (FR/NL/EN) pour {{brand}}", NL: "Terug in Europa — UGC-creator (NL/FR/EN) voor {{brand}}" },
  tech:      { EN: "UGC creator who can actually demo the product — {{brand}}", FR: "Créateur UGC capable de vraiment démontrer le produit — {{brand}}", NL: "UGC-creator die het product echt kan demonstreren — {{brand}}" },
  food:      { EN: "Back in Europe — UGC and food video for {{brand}}", FR: "De retour en Europe — UGC et vidéo food pour {{brand}}", NL: "Terug in Europa — UGC en foodvideo voor {{brand}}" },
  agency:    { EN: "Creator application — EN/FR/NL, Berlin & Brussels", FR: "Candidature créateur — FR/NL/EN, Berlin & Bruxelles", NL: "Aanmelding als creator — NL/FR/EN, Berlijn & Brussel" },
  webdesign: { EN: "Your website — a quick note from Realis Studio", FR: "Votre site — une remarque rapide de Realis Studio", NL: "Uw website — korte opmerking van Realis Studio" }
};

/* ---------- the soft introduction (default email) ----------
   Andy's own wording. No pitch, no rates: a hello, the story, the door left open.
   The detailed segment pitches above stay available as PITCH for a later touch. */
/* how Andy describes himself in the first line. Tech brands get a shorter version;
   beauty, food, agencies and everything else the full one. */
var SELF = {
  EN: { all: "a Dutch- and French-speaking creator", tech: "a Dutch- and French-speaking creator" },
  FR: { all: "créateur de contenu néerlandophone et francophone", tech: "créateur de contenu néerlandophone et francophone" },
  NL: { all: "een Nederlands- en Franstalige creator", tech: "een Nederlands- en Franstalige creator" }
};
function selfFor(row, lang) { var v = SELF[lang] || SELF.EN; return segmentFor(row) === "tech" ? v.tech : v.all; }
var SOFT_SIGN = "{{me}}\n{{studio}}\n{{phone}}\nNL · FR · EN";
var SOFT = {
  EN: {
    subject: "Back to creating, let me introduce myself ;)",
    body: "{{greeting}}!\nHope all is well with you! ☺️\n\n" +
      "I’d like to briefly introduce myself: I’m Andy, {{self}}, now back home in Belgium.\n\n" +
      "I’ve spent the past few years travelling through Europe, and I’m now back in Europe and excited to start collaborating with brands again.\n\n" +
      "I’ve been creating content for over five years and would love to connect, hear what you’re currently working on, and see if there could be a fit for an upcoming campaign. " +
      "Here are the links to my profiles and portfolio.\n\n" +
      "Portfolio: {{portfolio}}\nTikTok: {{social}}\n\nHope to talk soon! 🌸\n\n" + SOFT_SIGN
  },
  FR: {
    subject: "De retour à la création, je me présente ;)",
    body: "{{greeting}} !\nJ’espère que tout va bien de votre côté ! ☺️\n\n" +
      "Je me permets de me présenter brièvement : je suis Andy, {{self}}, de retour en Belgique.\n\n" +
      "J’ai passé ces dernières années à voyager à travers l’Europe, et je suis maintenant de retour en Europe, ravi de recommencer à collaborer avec des marques.\n\n" +
      "Je crée du contenu depuis plus de cinq ans et j’aimerais beaucoup échanger avec vous, découvrir ce sur quoi vous travaillez en ce moment et voir s’il pourrait y avoir une place pour moi sur une prochaine campagne. " +
      "Je vous laisse également les liens vers mes profils et mon portfolio.\n\n" +
      "Portfolio : {{portfolio}}\nTikTok : {{social}}\n\nAu plaisir d’échanger bientôt ! 🌸\n\n" + SOFT_SIGN
  },
  NL: {
    subject: "Back to creating, let me introduce myself ;)",
    body: "{{greeting}}!\nHopelijk gaat alles goed met jullie! ☺️\n\n" +
      "Ik wil me even kort voorstellen: ik ben Andy, {{self}}, en ik woon nu terug in België.\n\n" +
      "De afgelopen jaren ben ik door Europa gereisd. Nu ben ik terug in Europa en heb ik er veel zin in om opnieuw met merken samen te werken.\n\n" +
      "Ik maak al meer dan vijf jaar content en zou graag in contact komen, horen waar jullie momenteel mee bezig zijn en kijken of er een match is voor een volgende campagne. " +
      "Hieronder vinden jullie mijn portfolio en TikTok.\n\n" +
      "Portfolio: {{portfolio}}\nTikTok: {{social}}\n\nHopelijk tot snel! 🌸\n\n" + SOFT_SIGN
  }
};
var SOFT_DM = {
  EN: "{{greeting}}! I’m Andy, {{self}}, living in Belgium. I’ve spent the past few years travelling through Europe and I’m now back in Europe, excited to collaborate with brands again. I’ve been creating content for over five years and would love to connect and hear what you’re working on. Portfolio: {{portfolio}}",
  FR: "{{greeting}} ! Je suis Andy, {{self}}, installé en Belgique. J’ai passé ces dernières années à voyager à travers l’Europe et je suis de retour en Europe, ravi de recommencer à collaborer avec des marques. Je crée du contenu depuis plus de cinq ans et j’aimerais échanger avec vous sur vos projets en cours. Portfolio : {{portfolio}}",
  NL: "{{greeting}}! Ik ben Andy, {{self}}, en ik woon in België. De afgelopen jaren heb ik door Europa gereisd en nu ben ik terug in Europa, met veel zin om weer met merken samen te werken. Ik maak al meer dan vijf jaar content en kom graag in contact om te horen waar jullie mee bezig zijn. Portfolio: {{portfolio}}"
};

var PITCH = {};
["beauty", "tech", "food", "agency", "webdesign"].forEach(function (seg) {
  PITCH[seg] = {}; T[seg] = {};
  ["EN", "FR", "NL"].forEach(function (l) {
    var web = seg === "webdesign";
    var close = web ? CLOSE_WEB[l] : (seg === "agency" ? CLOSE_AGENCY[l] : CLOSE[l]);
    var intro = web ? INTRO_WEB[l] : INTRO[l];
    PITCH[seg][l] = {
      subject: SUBJECT[seg][l],
      body: web ? intro + "\n{{hook}}\n\n" + WHY[seg][l] + "\n\n" + close
                : intro + "\n" + WHY[seg][l] + "\n\n{{hook}}\n\n" + close
    };
    /* web-design prospects keep their short, specific note; every UGC segment opens softly */
    T[seg][l] = web ? PITCH[seg][l] : SOFT[l];
  });
});
T.brand = T.beauty; PITCH.brand = PITCH.beauty;

/* --- DM versions (Instagram / LinkedIn) --- */
var DM = {
  EN: "{{greeting}}, I'm Andy from Realis Studio, a Brussels studio that designs and builds websites and runs social media for architects and plastic surgeons. I came across your site and have one concrete suggestion. Could I send you a short visual take on your homepage? Work: {{portfolio}}",
  FR: "{{greeting}}, je suis Andy, de Realis Studio, un studio bruxellois qui conçoit des sites web et gère les réseaux sociaux d'architectes et de chirurgiens plasticiens. Je suis tombé sur votre site et j'ai une suggestion concrète. Puis-je vous envoyer une courte proposition visuelle pour votre page d'accueil ? Réalisations : {{portfolio}}",
  NL: "{{greeting}}, ik ben Andy van Realis Studio, een Brussels studio dat websites ontwerpt en bouwt en social media verzorgt voor architecten en plastisch chirurgen. Ik kwam uw site tegen en heb één concrete suggestie. Mag ik een korte visuele voorzet voor uw homepage sturen? Werk: {{portfolio}}"
};

/* --- follow-up (language only, no segment) --- */
var FOLLOWUP = {
  EN: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nJust floating this back up in case it got buried — no pressure either way.\n\nIf UGC isn't something you're commissioning right now, tell me and I'll stop taking up your inbox. If it is, I can send a short sample for {{brand}} this week.\n\n" + SIGN.EN },
  FR: { subject: "{{subjectRef}}", body: "Bonjour {{name}},\n\nJe me permets de remonter ce message au cas où il serait passé inaperçu — sans insistance.\n\nSi l'UGC n'est pas d'actualité chez vous en ce moment, dites-le-moi et je n'encombrerai plus votre boîte. Si ça l'est, je peux vous envoyer un court échantillon pour {{brand}} cette semaine.\n\n" + SIGN.FR },
  NL: { subject: "{{subjectRef}}", body: "Hallo {{name}},\n\nIk breng dit even terug naar boven voor het geval het ondergesneeuwd raakte — geen druk.\n\nAls UGC nu niet aan de orde is, laat het weten en ik stop met je inbox vullen. Zo ja, dan stuur ik deze week een korte proefvideo voor {{brand}}.\n\n" + SIGN.NL }
};


/* the same nudge for a website prospect: no UGC, no sample video */
var FOLLOWUP_WEB = {
  EN: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nJust floating this back up in case it got buried — no pressure either way.\n\nIf a new website isn't on the agenda right now, tell me and I'll stop taking up your inbox. If it is, I can send the visual take on {{brand}}'s homepage this week.\n\n" + SIGN.EN },
  FR: { subject: "{{subjectRef}}", body: "Bonjour {{name}},\n\nJe me permets de remonter ce message au cas où il serait passé inaperçu — sans insistance.\n\nSi un nouveau site n'est pas d'actualité pour le moment, dites-le-moi et je n'encombrerai plus votre boîte. Si ça l'est, je peux vous envoyer la proposition visuelle pour la page d'accueil de {{brand}} cette semaine.\n\n" + SIGN.FR },
  NL: { subject: "{{subjectRef}}", body: "{{greeting}},\n\nIk breng dit één keer terug naar boven voor het geval het ondergesneeuwd raakte — geen druk.\n\nAls een nieuwe website nu niet aan de orde is, laat het weten en ik val u niet meer lastig. Zo ja, dan stuur ik deze week de visuele voorzet voor de homepage van {{brand}}.\n\n" + SIGN.NL }
};

/* ---------- assembly ---------- */

// Unused in the original too (dead even there — `fill()` builds the greeting from
// `GREET` below, not from this). Kept, verbatim, because it is not this port's job
// to prune what the original never used.
var GREETING = { EN: "there", FR: "", NL: "" };

function greetingFor(row, lang) {
  if (lang === "FR") return "Bonjour"; // handled inside template as "Bonjour {{name}}," -> strip
  return "";
}

function signature(lang, profile) {
  var p = profile, lines = [];
  lines.push(p.name + (p.studio ? " — " + p.studio : ""));
  if (p.portfolio) lines.push(p.portfolio);
  var c = [];
  if (p.email) c.push(p.email);
  if (p.phone) c.push(p.phone);
  if (c.length) lines.push(c.join(" · "));
  if (p.social) lines.push(p.social);
  return lines.join("\n");
}

var GREET = {
  EN: { named: "Hi ", bare: "Hi" },
  FR: { named: "Bonjour ", bare: "Bonjour" },
  NL: { named: "Hallo ", bare: "Hallo" }
};

// The greeting-name resolution `fill()` always did: what was typed for this lead,
// otherwise the lead's own name/company.
function nameFor(row, extra) {
  return ((extra && extra.name) || "").trim() || (row.name || "").trim();
}

/* "Yanis Haddad" -> "Haddad", for "Bonjour Docteur Haddad". The
   registers give first name then family name, so everything after the first
   word is the family name ("Jean Dupuis", "Pieter Van den Berg"). */
export function surnameOf(name) {
  var words = String(name || "").trim().replace(/^(?:dr\.?|docteur|dokter|prof\.?)\s+/i, "").split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.slice(1).join(" ") : (words[0] || "");
}

function fill(s, row, lang, extra, profile) {
  var p = profile;
  var g = GREET[lang] || GREET.EN;
  /* greet the contact by first name when you have one, otherwise the company itself. */
  var name = nameFor(row, extra);
  var surname = surnameOf(name);
  return s.replace(/\{\{greeting\}\}/g, name ? g.named + name : g.bare)
          .replace(/ \{\{surname\}\}/g, surname ? " " + surname : "")
          .replace(/\{\{name\}\}/g, name || (lang === "EN" ? "there" : ""))
          .replace(/\{\{brand\}\}/g, row.name)
          .replace(/\{\{hook\}\}/g, (extra && extra.hook) || hookFor(row, lang))
          /* The « why them » line in Andy's own letters: only the sentence he
             typed in the pop-up (Andy, 14 Nov). Never a lead's openingLine (a
             research agent wrote those) and never a generic hook. Empty, the
             paragraph is dropped, so the letter is byte for byte his template. */
          .replace(/\{\{whyThem\}\}/g, (extra && extra.hook) || "")
          .replace(/\{\{portfolio\}\}/g, p.portfolio || "[add your portfolio link in Your details]")
          .replace(/\{\{sig\}\}/g, signature(lang, p))
          .replace(/\{\{self\}\}/g, selfFor(row, lang))
          .replace(/\{\{me\}\}/g, (p.name || "").split(" ")[0] || "Andy")
          .replace(/\{\{studio\}\}/g, p.studio || "Andy’s Archive")
          .replace(/\{\{phone\}\}/g, p.phone || "[phone number]")
          .replace(/\{\{social\}\}/g, p.social || "[TikTok handle]")
          .replace(/\{\{town\}\}/g, townOf(row))
          .replace(/\{\{subjectRef\}\}/g, (extra && extra.subjectRef) || row.name);
}

// Upgrade only a bare opening in saved drafts; preserve the rest of the user's text.
function personalizeGreeting(body, row, lang, extra) {
  var name = nameFor(row, extra);
  var bare = { NL: /^Hallo(?=\s*[!,])/, FR: /^Bonjour(?=\s*[!,])/, EN: /^Hi(?: there)?(?=\s*[!,])/ }[lang];
  return name && bare ? body.replace(bare, function () { return GREET[lang].named + name; }) : body;
}

/* A website prospect with nothing online yet gets its own spine. It is built
   here rather than in the T table because the table is static and this one
   depends on the row: the town paragraph is only written when the register
   gave a town, so the email never carries a sentence about nowhere. */
function webNewTemplate(row, lang) {
  var l = INTRO_WEB_NEW[lang] ? lang : "EN";
  return {
    subject: SUBJECT_WEB_NEW[l],
    body: INTRO_WEB_NEW[l] + "\n{{hook}}\n\n" + WHY_WEB_NEW[l] + "\n\n" + CLOSE_WEB_NEW[l],
  };
}


/* ---------- Andy's own Realis templates (30 September 2026) ----------
   Written by him, kept verbatim: two variants, three languages. The only
   tokens are the greeting, which carries the lead's name, and nothing else —
   no hook paragraph, no portfolio slot, no generated sentence about their
   town. The example link is the Aubin site because it is the one finished
   surgeon build. The phone number sits in the body on purpose: these go to
   people who pick up a phone faster than they answer an email. */
var REALIS_CITY = { EN: "Brussels", FR: "Bruxelles", NL: "Brussel" };
var REALIS_SIGN = {
  EN: "Kind regards,\nAndy\nRealis Studio\n" + REALIS_CITY.EN,
  FR: "Bien \u00e0 vous,\nAndy\nRealis Studio\n" + REALIS_CITY.FR,
  NL: "Met vriendelijke groet,\nAndy\nRealis Studio\n" + REALIS_CITY.NL
};
/* Andy's own French and Dutch first emails, word for word, and the English
   one written to match them. Each is written
   for both cases ("créer ou faire évoluer", "nieuwe ... of bestaande"), so a
   surgeon with a site and one without get the same letter; only the subject
   differs. {{surname}} is the doctor's family name. */
var REALIS_LETTER = {
  FR: "Bonjour Docteur {{surname}},\n\nJ\u2019esp\u00e8re que vous allez bien.\n\nJe me permets de vous contacter au nom de Realis Studio, un studio bruxellois sp\u00e9cialis\u00e9 dans la conception et le d\u00e9veloppement de sites internet et de solutions digitales pour les chirurgiens plasticiens et les professionnels de la m\u00e9decine esth\u00e9tique.\n\n{{whyThem}}\n\nNous avons r\u00e9cemment r\u00e9alis\u00e9 le site du Dr Marc Aubin, en accordant une attention particuli\u00e8re \u00e0 la pr\u00e9sentation de son expertise et \u00e0 l\u2019exp\u00e9rience des patients.\n\nVous pouvez d\u00e9couvrir notre travail ici :\nhttps://www.docteuraubin.example\n\nNous d\u00e9veloppons \u00e9galement des outils sur mesure : chaque praticien dispose notamment d\u2019un espace de gestion pour modifier lui-m\u00eame ses interventions et les contenus de son site, \u00e0 tout moment.\n\nJe souhaitais savoir si vous envisagiez actuellement de cr\u00e9er ou de faire \u00e9voluer le site internet de votre cabinet.\n\nSi tel est le cas, je serais ravi d\u2019\u00e9changer avec vous afin de mieux comprendre vos besoins et de vous soumettre une proposition adapt\u00e9e.\n\nJe vous remercie pour votre attention.\n\nBien cordialement,\n\nAndy\nRealis Studio, Bruxelles\nhttps://realisstudio.com",
  NL: "Beste dokter {{surname}},\n\nMijn naam is Andy en ik neem contact met u op namens Realis Studio, een Brusselse studio gespecialiseerd in het ontwerpen en ontwikkelen van websites en digitale oplossingen voor plastisch chirurgen en esthetische praktijken.\n\n{{whyThem}}\n\nOnlangs realiseerden we de website van Dr. Marc Aubin, met bijzondere aandacht voor de presentatie van zijn expertise en de gebruikservaring van pati\u00ebnten.\n\nU kunt ons werk hier bekijken:\nhttps://www.docteuraubin.example\n\nWe ontwikkelen ook tools op maat: zo krijgt u een eigen beheeromgeving om zelf uw behandelingen en de inhoud van uw website aan te passen, wanneer u maar wilt.\n\nIk vroeg me af of u momenteel overweegt om een nieuwe website te laten ontwikkelen of uw bestaande website te vernieuwen.\n\nMocht u interesse hebben, dan bespreek ik graag kort uw wensen om u vervolgens een voorstel op maat te kunnen bezorgen.\n\nMet vriendelijke groeten,\n\nAndy\nRealis Studio, Brussel\nhttps://realisstudio.com",
  EN: "Dear Dr {{surname}},\n\nI hope you are well.\n\nI am writing on behalf of Realis Studio, a Brussels-based studio specialising in the design and development of websites and digital tools for plastic surgeons and aesthetic medicine professionals.\n\n{{whyThem}}\n\nWe recently created the website of Dr Marc Aubin, with particular attention to the presentation of his expertise and to the patient experience.\n\nYou can see our work here:\nhttps://www.docteuraubin.example\n\nWe also build tailor-made software: each practitioner gets their own management space to update their procedures and website content themselves, whenever they like.\n\nI wanted to ask whether you are currently considering creating a new website for your practice or updating your existing one.\n\nIf so, I would be glad to speak with you to better understand your needs and send you a tailored proposal.\n\nThank you for your attention.\n\nKind regards,\n\nAndy\nRealis Studio, Brussels\nhttps://realisstudio.com"
};

var REALIS_NO_SITE = {
  FR: {
    subject: "\u00c0 l\u2019attention du Dr {{surname}}",
    body: REALIS_LETTER.FR
  },
  NL: {
    subject: "Ter attentie van Dr {{surname}}",
    body: REALIS_LETTER.NL
  },
  EN: {
    subject: "For the attention of Dr {{surname}}",
    body: REALIS_LETTER.EN
  }
};

var REALIS_HAS_SITE = {
  FR: {
    subject: "\u00c0 l\u2019attention du Dr {{surname}}",
    body: REALIS_LETTER.FR
  },
  NL: {
    subject: "Ter attentie van Dr {{surname}}",
    body: REALIS_LETTER.NL
  },
  EN: {
    subject: "For the attention of Dr {{surname}}",
    body: REALIS_LETTER.EN
  }
};

/* The nudge, in the same voice as the first email and with the same three-line
   sign-off. Before this the follow-up fell back to the generated block, so the
   second message introduced a studio address and a portfolio link the first
   one never mentioned. */
var REALIS_FOLLOWUP = {
  FR: { subject: "{{subjectRef}}", body: "Bonjour Docteur {{surname}},\n\nUn bref suivi de mon pr\u00e9c\u00e9dent message.\n\nCe qui distingue nos sites : vous modifiez vous-m\u00eame vos interventions, vos textes et vos photos, quand vous le souhaitez, sans d\u00e9pendre d\u2019un prestataire. Un exemple : https://www.docteuraubin.example\n\nAuriez-vous dix minutes cette semaine pour en parler ? Un simple \u00ab non merci \u00bb me convient aussi.\n\nBien cordialement,\n\nAndy\nRealis Studio, Bruxelles\nhttps://realisstudio.com" },
  NL: { subject: "{{subjectRef}}", body: "Beste dokter {{surname}},\n\nEen korte opvolging van mijn vorige bericht.\n\nWat onze websites anders maakt: u past zelf uw behandelingen, teksten en foto\u2019s aan, wanneer u wilt, zonder afhankelijk te zijn van een externe partij. Een voorbeeld: https://www.docteuraubin.example\n\nHeeft u deze week tien minuten om het te bespreken? Een kort \u201cnee, bedankt\u201d is ook prima.\n\nMet vriendelijke groeten,\n\nAndy\nRealis Studio, Brussel\nhttps://realisstudio.com" },
  EN: { subject: "{{subjectRef}}", body: "Dear Dr {{surname}},\n\nA short follow-up to my previous message.\n\nWhat sets our websites apart: you update your procedures, texts and photos yourself, whenever you like, without depending on anyone. An example: https://www.docteuraubin.example\n\nDo you have ten minutes this week to talk about it? A simple \u201cno thanks\u201d is fine too.\n\nKind regards,\n\nAndy\nRealis Studio, Brussels\nhttps://realisstudio.com" }
};

/* ---------- sector copy: architects (A) and local businesses (B) ----------
   Written by MARKETING, approved by NIRMATA on 13 Nov with four changes
   (REPORTS/2026-11-13-LEADS-sector-copy.md). Kept word for word. Their rules:
   no draft without Andy's own line about the site ({{hook}}), and for B
   without his subject; no URL, price, client name or « AI »; never Agencies,
   Travel, suppressed, NL or CH recipients, nor a generic address; one follow-up
   only, at least 7 days after the first email, never after a reply. */
export function sectorOf(row) {
  if (isSurgeonLead(row)) return "surgeon";
  var business = String((row && row.business) || "").trim().toLowerCase();
  var dataset = String((row && row.dataset) || "");
  if (business === "architects" || /^architects(-|$)/.test(dataset)) return "architect";
  if (/^web-wave(-|$)/.test(dataset)) return "local";
  /* Aesthetic clinics (MARKETING, approved 13 Nov; Andy cut the method
     sentences). Dental, eye care and the other clinics have no copy yet. */
  if (/^aesthetic-clinics(-|$)/.test(dataset)) return "clinic";
  if (business === "clinics" && /aesthetic|esth[eé]ti/i.test(String((row && row.category) || "") + " " + String((row && row.subcategory) || ""))) return "clinic";
  return null;
}

var SECTOR_GREET = { FR: "Bonjour,", NL: "Beste,", EN: "Hello," };
var SECTOR_SIG = "Andy\nRealis Studio";

var ARCHITECT_FIRST = {
  FR: { subject: "Votre site, {{brand}}", body: "{{sectorGreet}}\n\nEn parcourant votre site, {{ownHook}}\n\nJe suis Andy, de Realis Studio : je crée des sites pour les bureaux d'architecture.\n\nSeriez-vous intéressés par un site qui mette mieux votre travail en avant ?\n\nSi ce n'est pas pour vous, un simple « non merci » suffit, et je ne vous écrirai plus.\n\nBien à vous,\n{{sectorSig}}" },
  NL: { subject: "Jullie website, {{brand}}", body: "{{sectorGreet}}\n\nBij een bezoek aan jullie website {{ownHook}}\n\nIk ben Andy van Realis Studio: ik maak websites voor architectenbureaus.\n\nHebben jullie interesse in een site die jullie werk beter toont?\n\nPast het niet, dan volstaat een kort « nee, bedankt », en dan schrijf ik jullie niet meer.\n\nGroeten,\n{{sectorSig}}" },
  EN: { subject: "Your website, {{brand}}", body: "{{sectorGreet}}\n\nLooking at your website, {{ownHook}}\n\nI'm Andy, from Realis Studio: I build websites for architecture offices.\n\nWould you be interested in a site that shows your work better?\n\nIf it's not for you, a simple « no thanks » is enough, and I won't write again.\n\nKind regards,\n{{sectorSig}}" }
};

var SECTOR_FOLLOWUP_FR = { subject: "{{subjectRef}}", body: "{{sectorGreet}}\n\nJe me permets de remonter ce message une seule fois, au cas où il vous aurait échappé.\n\nEst-ce un sujet pour vous en ce moment ?\n\nSi ce n'est pas le cas, un simple « non merci » suffit, et je ne vous écrirai plus.\n\nBien à vous,\n{{sectorSig}}" };
var SECTOR_FOLLOWUP_EN = { subject: "{{subjectRef}}", body: "{{sectorGreet}}\n\nJust bringing this back up once in case it got buried. No pressure either way.\n\nIs this something you'd like to look at right now?\n\nIf not, a simple « no thanks » is enough, and I won't write again.\n\nKind regards,\n{{sectorSig}}" };
var ARCHITECT_FOLLOWUP = {
  FR: SECTOR_FOLLOWUP_FR,
  NL: { subject: "{{subjectRef}}", body: "{{sectorGreet}}\n\nIk breng dit één keer terug naar boven, voor het geval het ondergesneeuwd raakte. Geen druk.\n\nIs dat nu een onderwerp voor jullie?\n\nPast het niet, dan volstaat een kort « nee, bedankt », en dan schrijf ik jullie niet meer.\n\nGroeten,\n{{sectorSig}}" },
  EN: SECTOR_FOLLOWUP_EN
};

/* B's proof sentence: an osteopath or a spa hears only about the architecture office. */
var LOCAL_PROOF = {
  FR: { both: "Nous avons notamment réalisé le site d'un bureau d'architectes et celui d'un cabinet médical à Bruxelles.", office: "Nous avons notamment réalisé le site d'un bureau d'architectes à Bruxelles." },
  NL: { both: "We maakten onder meer de website van een architectenbureau en van een medische praktijk in Brussel.", office: "We maakten onder meer de website van een architectenbureau in Brussel." },
  EN: { both: "Our recent work includes the site of an architecture office and of a medical practice in Brussels.", office: "Our recent work includes the site of an architecture office in Brussels." }
};
var LOCAL_FIRST = {
  FR: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nEn parcourant votre site, j'ai remarqué un point : {{ownHook}}\n\nJe suis Andy, de Realis Studio, un studio bruxellois qui crée des sites web sur mesure. {{localProof}}\n\nJe me demandais si vous envisagiez de le moderniser. Seriez-vous ouverts à un court échange ?\n\nSi ce n'est pas d'actualité, un simple « non merci » suffit, et je ne vous écrirai plus.\n\nBien à vous,\n{{sectorSig}}" },
  NL: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nBij het doorlopen van uw website viel me iets op: {{ownHook}}\n\nIk ben Andy van Realis Studio, een Brusselse studio die websites op maat maakt. {{localProof}}\n\nIk vroeg me af of u eraan denkt om hem te vernieuwen. Zou u openstaan voor een kort gesprek?\n\nAls het nu niet past, volstaat een eenvoudig « nee, bedankt », en dan schrijf ik u niet meer.\n\nMet vriendelijke groet,\n{{sectorSig}}" },
  EN: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nLooking through your website, I noticed one thing: {{ownHook}}\n\nI'm Andy, from Realis Studio, a Brussels studio that builds custom websites. {{localProof}}\n\nI was wondering whether you were thinking of updating it. Would you be open to a short conversation?\n\nIf it's not the right time, a simple « no thanks » is enough, and I won't write again.\n\nKind regards,\n{{sectorSig}}" }
};
var LOCAL_FOLLOWUP = {
  FR: SECTOR_FOLLOWUP_FR,
  NL: { subject: "{{subjectRef}}", body: "{{sectorGreet}}\n\nIk breng dit één keer terug naar boven, voor het geval het ondergesneeuwd raakte. Geen druk.\n\nIs dat nog een onderwerp voor u?\n\nPast het niet, dan volstaat een kort « nee, bedankt », en dan schrijf ik u niet meer.\n\nGroeten,\n{{sectorSig}}" },
  EN: SECTOR_FOLLOWUP_EN
};

/* C. Aesthetic clinics (REPORTS/2026-11-13-LEADS-clinics-and-surgeon-copy.md,
   part 1, with the Verdict's FR follow-up line and Andy's cut: the intro ends
   at « …sur mesure. »). The clinic is named; the subject is Andy's own. */
var CLINIC_FIRST = {
  FR: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nEn parcourant le site de {{brand}}, j'ai remarqu\u00e9 un point : {{ownHook}}\n\nJe suis Andy, de Realis Studio, un studio bruxellois qui cr\u00e9e des sites sur mesure.\n\nEnvisagez-vous de faire \u00e9voluer votre site en ce moment ?\n\nSi ce n'est pas d'actualit\u00e9, un simple \u00ab non merci \u00bb suffit, et je ne vous \u00e9crirai plus.\n\nBien \u00e0 vous,\n{{sectorSig}}" },
  NL: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nBij het doorlopen van de website van {{brand}} viel me iets op: {{ownHook}}\n\nIk ben Andy van Realis Studio, een Brusselse studio die websites op maat maakt.\n\nDenkt u er momenteel aan om uw website te vernieuwen?\n\nAls het nu niet past, volstaat een eenvoudig \u00ab nee, bedankt \u00bb, en dan schrijf ik u niet meer.\n\nMet vriendelijke groet,\n{{sectorSig}}" },
  EN: { subject: "{{lineSubject}}", body: "{{sectorGreet}}\n\nLooking through {{brand}}'s website, I noticed one thing: {{ownHook}}\n\nI'm Andy, from Realis Studio, a Brussels studio that builds custom websites.\n\nAre you thinking of updating your site at the moment?\n\nIf it's not the right time, a simple \u00ab no thanks \u00bb is enough, and I won't write again.\n\nKind regards,\n{{sectorSig}}" }
};
var CLINIC_FOLLOWUP = {
  FR: SECTOR_FOLLOWUP_FR,
  NL: { subject: "{{subjectRef}}", body: "{{sectorGreet}}\n\nIk breng dit \u00e9\u00e9n keer terug naar boven, voor het geval het ondergesneeuwd raakte. Geen druk.\n\nIs dat nu een onderwerp voor u?\n\nPast het niet, dan volstaat een kort \u00ab nee, bedankt \u00bb, en dan schrijf ik u niet meer.\n\nMet vriendelijke groet,\n{{sectorSig}}" },
  EN: SECTOR_FOLLOWUP_EN
};

/* What stops a sector draft, in the words the pop-up shows. */
export var SECTOR_REFUSAL = {
  country: "No draft: cold email goes to Belgium, Luxembourg and France only, never the Netherlands or Switzerland.",
  generic: "No draft: this is a generic address (info@, contact@…). Cold email goes to a person's own address only.",
  hook: "Write your one line about their site first (Why them): the email says nothing it cannot back up without it.",
  subject: "Write the subject first: a few words on the problem you saw, different for each lead in a batch.",
  subjectRef: "Type the subject your first email had, so the follow-up carries the same subject.",
  replied: "No follow-up: they have replied. Answer them instead.",
  twice: "No follow-up: this lead has had its one follow-up already.",
  early: "No follow-up yet: it goes at least 7 days after the first email."
};

var GENERIC_LOCAL = /^(info|infos|contact|contacts|hello|hallo|bonjour|office|admin|administratie|administration|mail|email|secretariat|secretariaat|accueil|reception|receptie|bureau|kantoor|team|sales|welcome|post|general|direction|agence|atelier|studio|webmaster|support|service|booking|reservation|reservations|commercial)$/;
export function isGenericAddress(row) {
  var type = row && row.extra && row.extra.emailType;
  if (type === "generic") return true;
  if (type === "personal") return false;
  var local = String((row && row.email) || "").split("@")[0].toLowerCase().replace(/[._-]?\d+$/, "");
  return GENERIC_LOCAL.test(local);
}
function inNlOrCh(row) {
  var c = String((row && row.country) || "").trim().toLowerCase();
  return c === "nl" || c === "ch" || c === "netherlands" || c === "the netherlands" || c === "nederland" || c === "switzerland" || c === "suisse" || c === "schweiz";
}
function daysBetween(fromIso, toIso) {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86400000;
}

/* Why a sector draft cannot be written now, or null. `history` comes from the
   caller (the worker reads it): { replied, sends, lastSentAt, now }. */
export function sectorRefusal(row, sector, mode, extra, history) {
  if (inNlOrCh(row)) return SECTOR_REFUSAL.country;
  if (isGenericAddress(row)) return SECTOR_REFUSAL.generic;
  var h = history || {};
  if (mode === "closer") {
    if (h.replied) return SECTOR_REFUSAL.replied;
    return h.sends === 2 ? null : "The closer requires exactly two logged emails.";
  }
  if (mode === "followup") {
    if (h.replied) return SECTOR_REFUSAL.replied;
    if ((h.sends || 0) >= 2) return SECTOR_REFUSAL.twice;
    if (!h.lastSentAt || daysBetween(h.lastSentAt, h.now || new Date().toISOString()) < 7) return SECTOR_REFUSAL.early;
    return null;
  }
  if (!(extra && extra.hook)) return SECTOR_REFUSAL.hook;
  if ((sector === "local" || sector === "clinic") && !(extra && extra.subject)) return SECTOR_REFUSAL.subject;
  return null;
}

function fillSector(s, row, lang, extra) {
  var l = SECTOR_GREET[lang] ? lang : "EN";
  var spaOrOsteo = /ost[eé]opath|\bspa\b|wellness/i.test(String(row.category || "") + " " + String(row.subcategory || ""));
  return s.replace(/\{\{sectorGreet\}\}/g, SECTOR_GREET[l])
          .replace(/\{\{sectorSig\}\}/g, SECTOR_SIG)
          .replace(/\{\{brand\}\}/g, row.name || "")
          .replace(/\{\{ownHook\}\}/g, (extra && extra.hook) || "")
          .replace(/\{\{lineSubject\}\}/g, (extra && extra.subject) || "")
          .replace(/\{\{localProof\}\}/g, LOCAL_PROOF[l][spaOrOsteo ? "office" : "both"])
          .replace(/\{\{subjectRef\}\}/g, (extra && extra.subjectRef) || "");
}

/* The follow-up repeats the first email's subject (no « Re: »: it is a new email, Andy 16 Nov). A's can be rebuilt; B's was Andy's
   own, so the pop-up asks for it again (the same Subject field). */
function followUpSubjectRef(row, sector, lang, extra) {
  var l = ARCHITECT_FIRST[lang] ? lang : "EN";
  if (sector === "architect") return fillSector(ARCHITECT_FIRST[l].subject, row, l, extra);
  return (extra && extra.subject) || "";
}

function sectorDraft(row, sector, lang, mode, extra) {
  var l = ARCHITECT_FIRST[lang] ? lang : "EN";
  var sets = {
    architect: [ARCHITECT_FIRST, ARCHITECT_FOLLOWUP],
    local: [LOCAL_FIRST, LOCAL_FOLLOWUP],
    clinic: [CLINIC_FIRST, CLINIC_FOLLOWUP]
  }[sector];
  var set = mode === "followup" ? sets[1] : sets[0];
  var t = set[l];
  return { subject: fillSector(t.subject, row, l, extra), body: fillSector(t.body, row, l, extra) };
}

function tplFor(row, lang) {
  var seg = segmentFor(row);
  /* Every Realis lead now gets Andy's own copy, picked on the one thing that
     changes the opening sentence: whether they already have a site. The older
     generated variants are kept below for reference but no longer sent. */
  if (seg === "webdesign") {
    if (!isSurgeonLead(row)) return null; /* never the Dr letter to another sector */
    var set = hasSite(row) ? REALIS_HAS_SITE : REALIS_NO_SITE;
    return set[lang] || set.EN;
  }
  var t = T[seg] || T.brand;
  return t[lang] || t.EN || T.brand.EN;
}

function draft(row, lang, extra, profile) {
  var t = tplFor(row, lang);
  if (!t) return null;
  return { subject: fill(t.subject, row, lang, extra, profile), body: noPlaceholders(fill(t.body, row, lang, extra, profile)) };
}

/* A template note like "[one line on why them specifically]" is a message to Andy,
   never to the recipient. If one survives, drop that paragraph rather than send it. */
function noPlaceholders(body) {
  return String(body).split(/\n{2,}/)
    .filter(function (para) { return !/^\s*\[[^\]]{10,}\]\s*$/.test(para); })
    /* A slot that resolved to nothing leaves an empty paragraph, and an empty
       paragraph reads as a formatting mistake. Drop it. */
    .filter(function (para) { return para.trim() !== ""; })
    .join("\n\n");
}
function dmDraft(row, lang, extra, profile) {
  var set = SOFT_DM;
  if (isWebLead(row)) set = hasSite(row) ? DM : DM_WEB_NEW;
  return fill(set[lang] || set.EN, row, lang, extra, profile);
}
function followUp(row, lang, extra, profile) {
  var set = FOLLOWUP;
  if (isWebLead(row)) {
    if (!isSurgeonLead(row)) return null; /* the Realis nudge says « Dr » too */
    set = REALIS_FOLLOWUP;
  }
  var f = set[lang] || set.EN;
  /* The follow-up repeats the subject the first email actually carried, with
     no « Re: »: it goes out as a new email, never inside the first one's
     thread, so « Re: » would be a fake reply (Andy, 16 Nov 2026). */
  var ref = Object.assign({}, extra);
  if (!ref.subjectRef) ref.subjectRef = fill(tplFor(row, lang).subject, row, lang, extra, profile);
  return { subject: fill(f.subject, row, lang, ref, profile), body: fill(f.body, row, lang, ref, profile) };
}

/* ---------- compose: the one entry point the API/UI needs ----------
   mode: 'email' | 'dm' | 'followup' — the original's "email" (draft), "dm" (dmDraft)
   and "follow" (followUp) modes, renamed 'followup' for the new call site.
   `draft` is a previously-saved draft (from D1, replacing the old localStorage
   "leads.drafts"): when given, it is returned — personalizing only a still-bare
   greeting — rather than recomputed from the template. */
export function compose(row, opts) {
  opts = opts || {};
  var lang = opts.lang || langsFor(row)[0];
  var mode = opts.mode || "email";
  var profile = resolveProfile(opts.profile, brandFor(row));
  var saved = opts.draft;

  if (mode === "closer") {
    var history = opts.history || {};
    var originalSubject = opts.originalSubject;
    var noCloser = !isWebLead(row) ? "No approved closer for this sector."
      : !["FR", "NL", "EN"].includes(lang) || !(row.languages || []).includes(lang) ? "No matching approved closer language."
      : inNlOrCh(row) ? SECTOR_REFUSAL.country
      : history.replied || ["replied", "talks", "won", "passed"].includes(row.stage) ? "They replied or the lead is closed."
      : history.sends !== 2 ? "The closer requires exactly two logged emails."
      : !originalSubject || !originalSubject.trim() ? "The original subject is unknown."
      : /^\s*(re|tr|fw|fwd|aw|wg|antw)\s*:/i.test(originalSubject) ? "The original subject has a reply prefix."
      : null;
    if (noCloser) return { subject: "", body: "", noDraft: noCloser };
    return {
      subject: originalSubject,
      body: closerBody({ lang: lang, name: surnameOf(row.name), medical: isSurgeonLead(row), clinic: opts.clinic === true, title: opts.title || "Dr" }),
      toName: "", template: "closer-3rd"
    };
  }

  if (saved && (saved.body || saved.subject)) {
    var extraSaved = { name: saved.toName || "" };
    var body = personalizeGreeting(saved.body || "", row, lang, extraSaved);
    return { subject: saved.subject || "", body: body, toName: nameFor(row, extraSaved) };
  }

  /* The one line that is about this prospect and nobody else. The templates
     have always had a slot for it — `{{hook}}` — and nothing ever filled it,
     so `noPlaceholders` quietly deleted the paragraph and every website email
     went out identical but for the greeting. Now the caller can supply it. */
  var extra = {};
  if (typeof opts.hook === "string" && opts.hook.trim()) extra.hook = opts.hook.trim();
  /* Architects and local businesses: MARKETING's approved copy, under its guards. */
  var sector = isWebLead(row) && mode !== "dm" ? sectorOf(row) : null;
  /* The agency rule « no NL or CH recipients » holds for surgeons too: the
     post-release check found a plastic-surgeons-netherlands lead getting the
     Dr letter. Only who gets the letter changes; its text does not. */
  if (sector === "surgeon" && inNlOrCh(row)) return { subject: "", body: "", toName: "", noDraft: SECTOR_REFUSAL.country, sector: sector };
  if (sector === "architect" || sector === "local" || sector === "clinic") {
    if (typeof opts.subject === "string" && opts.subject.trim()) extra.subject = opts.subject.trim();
    var refusal = sectorRefusal(row, sector, mode, extra, opts.history);
    if (refusal) return { subject: "", body: "", toName: "", noDraft: refusal, sector: sector };
    if (mode === "followup") {
      extra.subjectRef = opts.originalSubject || followUpSubjectRef(row, sector, lang, extra);
      if (!extra.subjectRef) return { subject: "", body: "", toName: "", noDraft: SECTOR_REFUSAL.subjectRef, sector: sector };
    }
    var sd = sectorDraft(row, sector, lang, mode, extra);
    return { subject: sd.subject, body: sd.body, toName: "", sector: sector };
  }
  if (mode === "dm") {
    return { subject: "", body: noPlaceholders(dmDraft(row, lang, extra, profile)), toName: nameFor(row, extra) };
  }
  if (mode === "followup") {
    if (opts.originalSubject) extra.subjectRef = opts.originalSubject;
    var f = followUp(row, lang, extra, profile);
    if (!f) return { subject: "", body: "", toName: nameFor(row, extra), noDraft: NO_SECTOR_COPY };
    return { subject: f.subject, body: f.body, toName: nameFor(row, extra) };
  }
  var d = draft(row, lang, extra, profile);
  if (!d) return { subject: "", body: "", toName: nameFor(row, extra), noDraft: NO_SECTOR_COPY };
  return { subject: d.subject, body: d.body, toName: nameFor(row, extra) };
}

// Template tables, exported for anything downstream that needs to inspect them
// (e.g. a "preview all segments" tool). Not part of the old window.Outreach API,
// which only ever exposed PITCH and SOFT — the rest were closure-private; kept
// private here too, except where a future caller plainly needs the shape.
export { PITCH, SOFT };
export { resolveProfile };
