// The same doctor filed twice (NIRMATA, 14 Nov: Becker and Marin sat in both the Belgian and
// the Luxembourg surgeon lists). One place, read by the Worker's send list and the Leads screen.
//
// Only lists of people: in business lists a shared name (« Hotel Astoria », « Atelier L ») is
// usually a different business, so matching there would mislead. A match is a hint to check,
// never a block: two surgeons can share a name.

/** Lists whose leads are people, by name (the surgeon lists today). */
export const isPeopleDataset = (key) => String(key ?? '').startsWith('plastic-surgeons-');

// Titles and their spellings across FR, NL, DE and EN; dropped before comparing.
const TITLES = new Set(['dr', 'dre', 'drs', 'prof', 'pr', 'docteur', 'dokter', 'md', 'phd', 'mr', 'mrs', 'mme', 'm']);

/** « Dr. Joé  Becker » and « BECKER Joe » -> « becker joe »: no accents, case, titles,
 *  punctuation or word order. Empty when nothing is left. */
export function personKey(name) {
  const plain = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = plain.split(/[^a-z]+/).filter((w) => w && !TITLES.has(w));
  return words.sort().join(' ');
}

/** uid -> the other leads that look like the same person: [{ uid, dataset }].
 *  Only leads of people lists, and only names of two words or more. */
export function samePersonMap(leads) {
  const groups = new Map();
  for (const lead of leads ?? []) {
    if (!isPeopleDataset(lead?.dataset)) continue;
    const key = personKey(lead.name);
    if (key.split(' ').length < 2) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  }
  const out = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const lead of group) {
      out.set(lead.uid, group.filter((o) => o.uid !== lead.uid).map((o) => ({ uid: o.uid, dataset: o.dataset })));
    }
  }
  return out;
}
