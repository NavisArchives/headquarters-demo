// Approved closer() copy from daily/templates.py, HEADQUARTERS ANSWER.md,
// 19 Nov 2026. Only its name/practice slots are interpolated; no copy rewriting.
const SIG = {
  FR: 'Andy\nRealis Studio, Bruxelles\nrealisstudio.com',
  NL: 'Andy\nRealis Studio, Brussel\nrealisstudio.com',
  EN: 'Andy\nRealis Studio, Brussels\nrealisstudio.com',
};
const AGAIN = {
  FR: 'Si le sujet revient un jour, il vous suffit de répondre à ce message.',
  NL: 'Wordt het ooit een onderwerp, dan volstaat een antwoord op dit bericht.',
  EN: 'If it ever becomes a topic, simply reply to this message.',
};
const GENERIC = {
  FR: 'C’est mon dernier message : je vous ai écrit deux fois au sujet de votre site internet et je ne voudrais pas insister. Je vous retire donc de notre liste de prospects.',
  NL: 'Dit is mijn laatste bericht: ik schreef u twee keer over uw website en ik wil niet aandringen. Ik haal u dus van onze prospectlijst.',
  EN: 'This is my last message: I’ve written to you twice about your website and I don’t want to insist. I’ll remove you from our prospect list.',
};

export function closerBody({ lang, name = '', medical = false, clinic = false, title = 'Dr' }) {
  if (!Object.hasOwn(SIG, lang)) return null;
  let greeting = { FR: 'Bonjour,', NL: 'Goedendag,', EN: 'Hello,' }[lang];
  let body = GENERIC[lang];
  let close = { FR: 'Bien à vous,', NL: 'Met vriendelijke groeten,', EN: 'Best regards,' }[lang];
  if (medical) {
    greeting = {
      FR: name ? `Bonjour ${title === 'Pr' ? 'Professeur' : 'Docteur'} ${name},` : 'Bonjour,',
      NL: name ? `Beste ${title === 'Pr' ? 'professor' : 'dokter'} ${name},` : 'Goedendag,',
      EN: name ? `Dear Dr ${name},` : 'Hello,',
    }[lang];
    const what = {
      FR: `d’un site internet pour votre ${clinic ? 'clinique' : 'cabinet'}`,
      NL: `een website voor uw ${clinic ? 'kliniek' : 'praktijk'}`,
      EN: `a website for your ${clinic ? 'clinic' : 'practice'}`,
    }[lang];
    body = {
      FR: `C’est mon dernier message : je vous ai écrit deux fois au sujet ${what} et je ne voudrais pas insister. Je vous retire donc de notre liste de prospects.`,
      NL: `Dit is mijn laatste bericht: ik schreef u twee keer over ${what} en ik wil niet aandringen. Ik haal u dus van onze prospectlijst.`,
      EN: `This is my last message: I’ve written to you twice about ${what} and I don’t want to insist. I’ll remove you from our prospect list.`,
    }[lang];
    close = { FR: 'Bien cordialement,', NL: 'Met vriendelijke groeten,', EN: 'Kind regards,' }[lang];
  }
  return [greeting, body, AGAIN[lang], close, SIG[lang]].join('\n\n');
}
