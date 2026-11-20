// The budget estimate for the light questionnaire ("Site web (léger)"):
// worked out from what the client ticks in "La formule" (and the photo
// question), shown to Andy on the prospect page only. Never on the client's
// screen, the safe view or the live mirror: none of those import this file.
//
// THE PRICE TABLE. Andy fills it in: `once` is the one-off price, `monthly`
// the price per month, both in euros. `null` means "not set yet" and shows as
// "à chiffrer" in the estimate.

export const PRICES = {
  // Andy, 19 Oct: "2000 is very reasonable for a website … and 100 a month."
  site: { label: 'Un site', once: 2000, monthly: 100 },
  // Waiting for Andy's confirmation (NIRMATA proposed +€800 from his Morel tiers).
  cms: { label: 'Un éditeur', once: null, monthly: null },
  portal: { label: 'Un portail pour vous', once: null, monthly: null },
  patients: { label: 'Un espace patients', once: null, monthly: null },
  // A 6-month package: a shoot day + editing = 33 reels + interviews. Andy gives the price.
  social: { label: 'Réseaux sociaux (6 mois)', once: null, monthly: null },
  // Waiting for Andy's confirmation (NIRMATA proposed +€1,800 from his Morel tiers).
  photo: { label: 'Paquet photo', once: null, monthly: null },
  // « Le contenu » (19 Oct): each video is priced on its own once Andy says.
  'video-practice': { label: 'Vidéo du cabinet', once: null, monthly: null },
  'video-interview': { label: 'Vidéo interview', once: null, monthly: null },
  'video-animation': { label: 'Vidéo animation', once: null, monthly: null },
};

/**
 * PRICE POINTS Andy reads from during a call (F32: "with this, with that,
 * without that"), on his side only. Andy, 19 Oct: the site €2,000 and €100 a
 * month. The two bigger tiers wait for his prices (null = "à chiffrer").
 */
export const PRICE_POINTS = {
  monthly: 100,
  tiers: [
    { label: 'Site seul', once: 2000, includes: 'Le site, en ligne, tenu à jour par nous' },
    { label: 'Site + gestion + prise de rendez-vous', once: null, includes: 'Un éditeur pour modifier vous-même, la prise de rendez-vous intégrée' },
    { label: 'Site + gestion + RDV + journée de tournage', once: null, includes: 'Tout ce qui précède, et une journée photo/vidéo au cabinet' },
  ],
};

/**
 * The estimate: one line per option chosen, the totals of what has a price,
 * and how many still need one.
 */
export function estimate(answers = {}, prices = PRICES) {
  const chosen = new Set(Array.isArray(answers['light.needs']) ? answers['light.needs'] : []);
  // « Le contenu »: photos bring the photo pack, each video its own line.
  for (const item of Array.isArray(answers['light.content']) ? answers['light.content'] : []) chosen.add(item === 'photos' ? 'photo' : item);
  const lines = Object.entries(prices)
    .filter(([id]) => chosen.has(id))
    .map(([id, p]) => ({
      id, label: p.label, once: p.once ?? null, monthly: p.monthly ?? null,
      pending: p.once == null && p.monthly == null,
    }));
  return {
    lines,
    once: lines.reduce((sum, l) => sum + (l.once ?? 0), 0),
    monthly: lines.reduce((sum, l) => sum + (l.monthly ?? 0), 0),
    pending: lines.filter((l) => l.pending).length,
  };
}

const euro = (n) => `€${n.toLocaleString('en-GB')}`;

/** "€1,200 + €70/month" for a line or a total; "à chiffrer" when unset. */
export function priceText({ once, monthly }) {
  const parts = [];
  if (once) parts.push(euro(once));
  if (monthly) parts.push(`${euro(monthly)}/month`);
  return parts.length ? parts.join(' + ') : 'à chiffrer';
}
