/* My info — everything the owner pastes into creator and partner forms, in one
   place: who he is, where to find him, and "tell us about yourself" in the
   voice of each brand. Pure data and pure helpers; the screen renders it, the
   worker stores an edited copy under the `myinfo` setting.

   Two brands, never mixed (see outreach.js): andyssarchives for UGC and
   influencer work, Realis Studio for websites and social media. Nothing here
   uses Andy's full name in a text a client would read. */

export const DEFAULT_MYINFO = {
  person: {
    name: 'Sam',
    location: 'Ghent, Belgium',
    languages: 'Dutch, French, English',
    phone: '+32 000 00 00 00',
    inbox: 'owner@example.com (private — the brand addresses below are what goes on forms)',
  },
  channels: [
    { label: 'Instagram', handle: '@fieldnote.example', url: 'https://www.example.com/fieldnote', audience: '' },
    { label: 'Portfolio — UGC', handle: 'fieldnote.example', url: 'https://fieldnote.example', audience: '' },
    { label: 'Portfolio — websites', handle: 'kestrelstudio.example', url: 'https://kestrelstudio.example', audience: '' },
  ],
  brands: {
    archive: {
      name: 'Fieldnote',
      email: 'contact@fieldnote.example',
      site: 'https://fieldnote.example',
      offer: 'UGC and short-form video: talking head, product demo, unboxing, tutorial. Written, shot and edited in-house, delivered in three languages.',
      categories: 'Food and drink · lifestyle · home',
      history: 'Sample text for the demo: short campaigns for small food and home brands.',
      about: {
        EN: "I'm Sam, a filmmaker and UGC creator running a small studio, Fieldnote. One shoot, three markets.",
        FR: "Je suis Sam, vidéaste et créateur UGC, à la tête d'un petit studio, Fieldnote. Un tournage, trois marchés.",
        NL: 'Ik ben Sam, filmmaker en UGC-creator met een kleine studio, Fieldnote. Eén draaidag, drie markten.',
      },
      short: {
        EN: 'Filmmaker and UGC creator (Fieldnote). NL/FR/EN: one shoot, three markets.',
        FR: 'Vidéaste et créateur UGC (Fieldnote). NL/FR/EN : un tournage, trois marchés.',
        NL: 'Filmmaker en UGC-creator (Fieldnote). NL/FR/EN: één draaidag, drie markten.',
      },
    },
    realis: {
      name: 'Kestrel Studio',
      email: 'hello@kestrelstudio.example',
      site: 'https://kestrelstudio.example',
      offer: 'Complete website rebuilds — new structure, new design, fast on mobile — and the social media that sends people to them. Trilingual sites (NL/FR/EN) as standard.',
      categories: 'Architects · clinics · established practices and studios',
      history: 'Sample text for the demo: two recent rebuilds for an architecture practice and a clinic.',
      about: {
        EN: 'Kestrel Studio designs and builds websites and social media for architects and clinics: complete rebuilds, trilingual, fast on mobile.',
        FR: 'Kestrel Studio conçoit des sites web et des réseaux sociaux pour architectes et cliniques : refontes complètes, trilingues, rapides sur mobile.',
        NL: 'Kestrel Studio ontwerpt websites en social media voor architecten en klinieken: volledige herbouwen, drietalig, snel op mobiel.',
      },
      short: {
        EN: 'Kestrel Studio: websites and social media for architects and clinics. Complete rebuilds, trilingual.',
        FR: 'Kestrel Studio : sites web et réseaux sociaux pour architectes et cliniques. Refontes complètes, trilingues.',
        NL: 'Kestrel Studio: websites en social media voor architecten en klinieken. Volledige herbouwen, drietalig.',
      },
    },
  },
};

export const LANGS = ['EN', 'FR', 'NL'];

/** Deep-merge a saved copy onto the defaults, so a new default field shows
 *  up even in a copy saved before it existed. Arrays (channels) are taken
 *  whole from the saved copy when present. */
export function mergeMyInfo(saved) {
  if (!saved || typeof saved !== 'object') return structuredClone(DEFAULT_MYINFO);
  const out = structuredClone(DEFAULT_MYINFO);
  out.person = { ...out.person, ...(saved.person || {}) };
  if (Array.isArray(saved.channels)) out.channels = saved.channels.map((c) => ({ label: '', handle: '', url: '', audience: '', ...c }));
  for (const key of Object.keys(out.brands)) {
    const s = saved.brands?.[key] || {};
    out.brands[key] = {
      ...out.brands[key], ...s,
      about: { ...out.brands[key].about, ...(s.about || {}) },
      short: { ...out.brands[key].short, ...(s.short || {}) },
    };
  }
  return out;
}

/** Every text a form might ask for, flat, with a label — what the screen
 *  renders and what "copy" puts on the clipboard. */
export function fieldsFor(info) {
  const out = [];
  const p = info.person;
  out.push({ group: 'person', key: 'name', label: 'First name', value: p.name });
  out.push({ group: 'person', key: 'location', label: 'Location', value: p.location });
  out.push({ group: 'person', key: 'languages', label: 'Languages', value: p.languages });
  out.push({ group: 'person', key: 'phone', label: 'Phone', value: p.phone });
  out.push({ group: 'person', key: 'inbox', label: 'Inbox', value: p.inbox });
  for (const [key, b] of Object.entries(info.brands)) {
    out.push({ group: key, key: 'email', label: 'Email on forms', value: b.email });
    out.push({ group: key, key: 'site', label: 'Website', value: b.site });
    out.push({ group: key, key: 'offer', label: 'What I offer', value: b.offer });
    out.push({ group: key, key: 'categories', label: 'Categories', value: b.categories });
    out.push({ group: key, key: 'history', label: 'Track record', value: b.history });
    for (const lang of LANGS) out.push({ group: key, key: `short.${lang}`, label: `Short bio · ${lang}`, value: b.short[lang] });
    for (const lang of LANGS) out.push({ group: key, key: `about.${lang}`, label: `Tell us about yourself · ${lang}`, value: b.about[lang] });
  }
  return out;
}
