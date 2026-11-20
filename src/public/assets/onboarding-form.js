// The onboarding questionnaire: what is asked at the first meeting, in French
// (the client's language) with English beside it. Data only — the screen
// that draws it is screens/onboarding.js; the answers are one flat object
// saved to D1 key by key (prospects.onboarding).
//
// Field types:
//   entities  pick among the prospect's own businesses (multi)
//   entity    pick one of the businesses ticked above (or of all, when none is)
//   chips     pick any number of the options
//   choice    pick one option (tap it again to clear)
//   text      one line;  long  a few lines
//   social    per business: networks to run, where it stands, posts a week
//
// Nothing here may invite what a doctor's public communication cannot carry
// in Belgium (law of 23 May 2013 on aesthetic medicine): no prices, no
// patient testimonials, no before/after.
//
// A field's label is the question as it is asked; `short` is how the summary
// names it.
//
// Keys never change once used: answers are filed under them.

export const LANGS = ['fr', 'en'];

const o = (id, fr, en) => ({ id, fr, en });

const NETWORKS = [o('instagram', 'Instagram', 'Instagram'), o('facebook', 'Facebook', 'Facebook'),
  o('linkedin', 'LinkedIn', 'LinkedIn'), o('tiktok', 'TikTok', 'TikTok'), o('youtube', 'YouTube', 'YouTube')];

export const SOCIAL = {
  networks: NETWORKS,
  state: [o('none', 'Inexistant', 'None yet'), o('low', 'Peu actif', 'Barely used'), o('active', 'Actif', 'Active')],
  perWeek: [o('0', '0', '0'), o('1', '1', '1'), o('2-3', '2–3', '2–3'), o('4+', '4 et +', '4+')],
};

export const SECTIONS = [
  {
    id: 'activities',
    fr: 'Vos activités',
    en: 'Your businesses',
    fields: [
      { key: 'activities', type: 'entities', fr: 'Quelles activités le projet concerne-t-il ?', en: 'Which of your businesses does the project cover?', short: { fr: 'Activités concernées', en: 'Businesses concerned' } },
      { key: 'activities.priority', type: 'entity', fr: 'Par laquelle commencer ?', en: 'Which one first?', short: { fr: 'À commencer par', en: 'Start with' } },
    ],
  },
  {
    id: 'web',
    fr: 'Site web',
    en: 'Website',
    fields: [
      {
        key: 'web.state', type: 'choice', fr: 'Où en est votre site actuel ?', en: 'Where does your current site stand?', short: { fr: 'Le site actuel', en: 'The current site' },
        options: [o('ok', 'Il me convient', 'It works for me'), o('refresh', 'À rafraîchir', 'Needs a refresh'),
          o('new', 'À refaire entièrement', 'Start again'), o('none', 'Pas encore de site', 'No site yet')],
      },
      {
        key: 'web.languages', type: 'chips', fr: 'En quelles langues ?', en: 'In which languages?', short: { fr: 'Langues', en: 'Languages' },
        options: [o('fr', 'Français', 'French'), o('nl', 'Néerlandais', 'Dutch'), o('en', 'Anglais', 'English'), o('de', 'Allemand', 'German')],
      },
      {
        key: 'web.news', type: 'choice', fr: 'Publier des articles ou des actualités ?', en: 'Publish articles or news?', short: { fr: 'Articles et actualités', en: 'Articles and news' },
        options: [o('no', 'Non', 'No'), o('sometimes', 'De temps en temps', 'Now and then'), o('monthly', 'Chaque mois', 'Monthly'), o('weekly', 'Chaque semaine', 'Weekly')],
      },
      {
        key: 'web.features', type: 'chips', fr: 'Que doit-on trouver sur le site ?', en: 'What should the site include?', short: { fr: 'À prévoir sur le site', en: 'On the site' },
        options: [o('booking', 'Prise de rendez-vous', 'Online booking'), o('procedures', 'Pages par intervention', 'A page per procedure'),
          o('team', 'Présentation de l’équipe', 'The team'),
          o('faq', 'Questions fréquentes', 'FAQ'), o('contact', 'Formulaire de contact', 'Contact form')],
      },
      { key: 'web.notes', type: 'text', fr: 'Des sites que vous aimez, des remarques ?', en: 'Sites you like, any remarks?', short: { fr: 'Sites que vous aimez, remarques', en: 'Sites you like, remarks' } },
    ],
  },
  {
    id: 'video',
    fr: 'Vidéo',
    en: 'Video',
    fields: [
      {
        key: 'video.kinds', type: 'chips', fr: 'Quels formats vidéo vous intéressent ?', en: 'Which video formats interest you?', short: { fr: 'Formats souhaités', en: 'Formats' },
        options: [o('reels', 'Reels / formats courts', 'Reels / short form'), o('interviews', 'Interviews', 'Interviews'),
          o('explainers', 'Explications d’interventions', 'Procedure explainers'), o('clinic', 'Présentation de la clinique', 'Clinic film'),
          o('events', 'Conférences et événements', 'Talks and events'), o('courses', 'Vidéos de formation', 'Course videos')],
      },
      {
        key: 'video.per_month', type: 'choice', fr: 'Combien de vidéos par mois ?', en: 'How many videos a month?', short: { fr: 'Vidéos par mois', en: 'Videos a month' },
        options: [o('0', 'Aucune', 'None'), o('1-2', '1–2', '1–2'), o('3-4', '3–4', '3–4'), o('5-8', '5–8', '5–8'), o('8+', '8 et +', '8+')],
      },
    ],
  },
  {
    id: 'photo',
    fr: 'Photo',
    en: 'Photo',
    fields: [
      {
        key: 'photo.kinds', type: 'chips', fr: 'Que faut-il photographier ?', en: 'What should be photographed?', short: { fr: 'Sujets', en: 'Subjects' },
        options: [o('portraits', 'Portraits', 'Portraits'), o('clinic', 'Clinique et espaces', 'Clinic and rooms'),
          o('team', 'Équipe au travail', 'Team at work'), o('details', 'Détails et matériel', 'Details and equipment'),
          o('events', 'Événements et formations', 'Events and courses')],
      },
      {
        key: 'photo.days', type: 'choice', fr: 'Combien de journées de prise de vue par an ?', en: 'How many shoot days a year?', short: { fr: 'Journées de prise de vue par an', en: 'Shoot days a year' },
        options: [o('1', '1', '1'), o('2', '2', '2'), o('3-4', '3–4', '3–4'), o('monthly', 'Chaque mois', 'Monthly'), o('tbd', 'À définir', 'To decide')],
      },
    ],
  },
  {
    id: 'social',
    fr: 'Réseaux sociaux',
    en: 'Social media',
    intro: { fr: 'Pour chaque activité : les réseaux à gérer, où ils en sont, et combien de publications par semaine.', en: 'For each business: the networks to run, where they stand, and how many posts a week.' },
    fields: [
      { key: 'social', type: 'social', fr: '', en: '' },
    ],
  },
  {
    id: 'team',
    fr: 'Équipe',
    en: 'Team',
    fields: [
      {
        key: 'team.size', type: 'choice', fr: 'Combien de personnes dans l’équipe ?', en: 'How many people on the team?', short: { fr: 'Nombre de collaborateurs', en: 'People on the team' },
        options: [o('1-5', '1–5', '1–5'), o('6-10', '6–10', '6–10'), o('11-25', '11–25', '11–25'), o('26-50', '26–50', '26–50'), o('50+', '50 et +', '50+')],
      },
      {
        key: 'team.on_camera', type: 'chips', fr: 'Qui peut apparaître à l’image ?', en: 'Who can appear on camera?', short: { fr: 'Qui peut apparaître à l’image', en: 'Who can appear on camera' },
        options: [o('founder', 'Le docteur', 'The doctor'), o('doctors', 'Les médecins', 'The doctors'), o('team', 'L’équipe', 'The team'),
          o('nobody', 'Personne', 'Nobody')],
      },
      { key: 'team.contact', type: 'text', fr: 'Qui sera notre contact au quotidien ?', en: 'Who will be our day-to-day contact?', short: { fr: 'Personne de contact au quotidien', en: 'Day-to-day contact' } },
    ],
  },
  {
    id: 'compliance',
    fr: 'Validation médicale',
    en: 'Medical sign-off',
    fields: [
      {
        key: 'compliance.approver', type: 'chips', fr: 'Qui valide les textes médicaux ?', en: 'Who approves medical wording?', short: { fr: 'Qui valide les textes médicaux', en: 'Who approves medical wording' },
        options: [o('founder', 'Le docteur', 'The doctor'), o('doctor', 'Un autre médecin', 'Another doctor'),
          o('legal', 'Un juriste', 'A lawyer'), o('tbd', 'À définir', 'To decide')],
      },
      {
        key: 'compliance.delay', type: 'choice', fr: 'En combien de temps ?', en: 'How quickly?', short: { fr: 'Délai de validation', en: 'Time to approve' },
        options: [o('24h', '24 h', '24 h'), o('48h', '48 h', '48 h'), o('week', 'Une semaine', 'A week')],
      },
      { key: 'compliance.notes', type: 'text', fr: 'Des règles particulières à respecter ?', en: 'Any particular rules to follow?', short: { fr: 'Règles à respecter', en: 'Rules to follow' } },
    ],
  },
  {
    id: 'portal',
    fr: 'Portail patients',
    en: 'Client portal',
    fields: [
      {
        key: 'portal.features', type: 'chips', fr: 'Qu’est-ce qui faciliterait la vie de vos patients ?', en: 'What would make your patients’ lives easier?', short: { fr: 'Fonctions utiles', en: 'Useful features' },
        options: [o('booking', 'Rendez-vous en ligne', 'Online booking'), o('documents', 'Partage de documents', 'Document sharing'),
          o('forms', 'Formulaires avant consultation', 'Pre-visit forms'), o('aftercare', 'Consignes après intervention', 'Aftercare instructions'),
          o('reminders', 'Rappels automatiques', 'Automatic reminders'), o('payments', 'Paiement en ligne', 'Online payment')],
      },
      { key: 'portal.tools', type: 'text', fr: 'Quels logiciels utilisez-vous aujourd’hui ?', en: 'Which software do you use today?', short: { fr: 'Logiciels utilisés aujourd’hui', en: 'Software used today' } },
    ],
  },
  {
    id: 'academy',
    fr: 'Académie',
    en: 'Academy',
    fields: [
      {
        key: 'academy.features', type: 'chips', fr: 'De quoi l’académie a-t-elle besoin ?', en: 'What does the academy need?', short: { fr: 'Besoins', en: 'Needs' },
        options: [o('enrolment', 'Inscriptions en ligne', 'Online enrolment'), o('schedule', 'Planning des formations', 'Course schedule'),
          o('attendance', 'Suivi des présences (accréditation)', 'Attendance for accreditation'), o('certificates', 'Certificats automatiques', 'Automatic certificates'),
          o('portal', 'Espace étudiant', 'Student area'), o('elearning', 'Cours en ligne', 'E-learning'), o('payments', 'Paiements', 'Payments')],
      },
      {
        key: 'academy.students', type: 'choice', fr: 'Combien d’étudiants par an ?', en: 'How many students a year?', short: { fr: 'Étudiants par an', en: 'Students a year' },
        options: [o('<50', 'Moins de 50', 'Under 50'), o('50-200', '50–200', '50–200'), o('200-500', '200–500', '200–500'), o('500+', '500 et +', '500+')],
      },
      { key: 'academy.tools', type: 'text', fr: 'Comment est-ce géré aujourd’hui ?', en: 'How is it handled today?', short: { fr: 'Comment est-ce géré aujourd’hui ?', en: 'How is it handled today?' } },
    ],
  },
  {
    id: 'goals',
    fr: 'Objectifs',
    en: 'Goals',
    fields: [
      {
        key: 'goals.six_months', type: 'chips', fr: 'Dans six mois, qu’est-ce qui aura changé ?', en: 'In six months, what will have changed?', short: { fr: 'Dans six mois', en: 'In six months' },
        options: [o('patients', 'Plus de patients', 'More patients'), o('premium', 'Une image plus premium', 'A more premium image'),
          o('awareness', 'Plus de notoriété', 'Better known'), o('academy', 'Lancer l’académie', 'Launch the academy'),
          o('time', 'Gagner du temps', 'Save time'), o('hiring', 'Recruter', 'Hire')],
      },
      { key: 'goals.notes', type: 'long', fr: 'En vos propres mots', en: 'In your own words', short: { fr: 'En vos mots', en: 'In your words' } },
    ],
  },
  {
    id: 'practical',
    fr: 'Budget et calendrier',
    en: 'Budget and timing',
    fields: [
      {
        key: 'budget.project', type: 'choice', fr: 'Quel budget pour le lancement ?', en: 'What budget for the launch?', short: { fr: 'Budget de lancement', en: 'Launch budget' },
        options: [o('<5k', 'Moins de 5 000 €', 'Under €5,000'), o('5-15k', '5 000 – 15 000 €', '€5,000–15,000'),
          o('15-30k', '15 000 – 30 000 €', '€15,000–30,000'), o('30k+', '30 000 € et +', '€30,000+'), o('tbd', 'À discuter', 'To discuss')],
      },
      {
        key: 'budget.monthly', type: 'choice', fr: 'Et chaque mois, pour le contenu et le suivi ?', en: 'And each month, for content and care?', short: { fr: 'Budget mensuel (contenu, suivi)', en: 'Monthly budget (content, care)' },
        options: [o('<1k', 'Moins de 1 000 €', 'Under €1,000'), o('1-2.5k', '1 000 – 2 500 €', '€1,000–2,500'),
          o('2.5-5k', '2 500 – 5 000 €', '€2,500–5,000'), o('5k+', '5 000 € et +', '€5,000+'), o('tbd', 'À discuter', 'To discuss')],
      },
      {
        key: 'start.when', type: 'choice', fr: 'Quand souhaitez-vous démarrer ?', en: 'When would you like to start?', short: { fr: 'Démarrage', en: 'Start' },
        options: [o('asap', 'Dès que possible', 'As soon as possible'), o('november', 'Novembre', 'November'),
          o('december', 'Décembre', 'December'), o('2027', 'Début 2027', 'Early 2027')],
      },
      {
        key: 'decision.who', type: 'chips', fr: 'Qui prend la décision ?', en: 'Who makes the decision?', short: { fr: 'Qui décide', en: 'Who decides' },
        options: [o('founder', 'Le docteur', 'The doctor'), o('partners', 'Les associés', 'The partners'), o('management', 'La direction', 'Management')],
      },
      {
        key: 'reporting.rhythm', type: 'choice', fr: 'À quel rythme suivre les résultats ?', en: 'How often should we report results?', short: { fr: 'Suivi des résultats', en: 'Reporting' },
        options: [o('monthly', 'Chaque mois', 'Monthly'), o('quarterly', 'Chaque trimestre', 'Quarterly'), o('none', 'Pas nécessaire', 'Not needed')],
      },
      {
        key: 'reporting.format', type: 'chips', fr: 'Sous quelle forme ?', en: 'In what form?', short: { fr: 'Sous quelle forme', en: 'How' },
        options: [o('call', 'Un appel', 'A call'), o('report', 'Un rapport écrit', 'A written report'), o('dashboard', 'Un tableau de bord', 'A dashboard')],
      },
    ],
  },
  {
    id: 'notes',
    fr: 'Notes',
    en: 'Notes',
    fields: [
      { key: 'notes', type: 'long', fr: 'Tout ce qu’il faut retenir', en: 'Anything else to remember', short: { fr: 'Tout ce qu’il faut retenir', en: 'Anything else to remember' } },
    ],
  },
];

/**
 * "Site web (léger)": six short sections for a first call about a site
 * (NIRMATA, 18 Oct, from the Fontaine call prep; reworded by Andy, F27, so he
 * can read each question aloud). French only; keys under `light.`, never
 * shared with the full questionnaire.
 *
 * Beyond the full questionnaire's fields, a field here may have:
 * - `preset`: the answer it starts with, saved when the questionnaire opens;
 * - `when`: { key, is } — shown (and counted) only while that answer is `is`;
 * - `hint`: a line under the question;
 * and an option may have `desc`, a line under its label.
 * The budget is not a question: HQ computes it (pricing.js) and shows it to
 * Andy only, never on the client's screen or the live mirror.
 */
import { slotOptions } from './schedule.js';

const f = (fr) => ({ fr });
const of = (id, fr, desc) => (desc ? { id, fr, desc: { fr: desc } } : { id, fr });
export const LIGHT_SECTIONS = [
  {
    id: 'format', ...f('La formule'),
    fields: [
      {
        key: 'light.needs', type: 'chips', ...f('Quels sont vos besoins ?'), short: f('Besoins'), preset: ['site'],
        options: [
          of('site', 'Un site'),
          of('cms', 'Un éditeur (vous modifiez vous-même)'),
          of('portal', 'Un portail pour vous'),
          of('patients', 'Un espace patients', 'Vos patients échangent avec vous : photos, notes vocales, messages. Comme sur WhatsApp, mais dans votre espace sécurisé.'),
          of('social', 'Réseaux sociaux'),
          of('photo', 'Paquet photo'),
        ],
      },
    ],
  },
  {
    id: 'brand', ...f('Qui est concerné ?'),
    fields: [
      {
        key: 'light.practice', type: 'choice', ...f(''), short: f('Le site concerne'),
        options: [of('solo', 'Vous seul(e)'), of('clinic', 'Le cabinet / la clinique (plusieurs praticiens)')],
      },
      { key: 'light.practice.name', type: 'text', ...f('Quel est le nom du cabinet ?'), short: f('Nom du cabinet'), when: { key: 'light.practice', is: 'clinic' } },
    ],
  },
  {
    id: 'languages', ...f('Les langues'),
    fields: [
      {
        key: 'light.langs', type: 'chips', ...f('En quelles langues ?'), short: f('Langues'),
        options: [of('fr', 'Français'), of('nl', 'Néerlandais'), of('en', 'Anglais')],
      },
    ],
  },
  {
    id: 'pages', ...f('Les pages'),
    fields: [
      {
        key: 'light.areas', type: 'chips', ...f('Quelles interventions présenter ?'), short: f('Interventions'),
        options: [of('face', 'Visage'), of('breasts', 'Seins'), of('abdomen', 'Abdomen'), of('post-weight-loss', 'Après perte de poids'),
          of('skin', 'Peau'), of('intimate', 'Chirurgie intime'), of('injections', 'Injections'),
          of('mole', 'Ablation de grain de beauté'), of('consult', 'Consultation pré/post-opératoire'),
          of('laser', 'Laser'), of('aesthetic', 'Médecine esthétique (fillers, toxine)'), of('other', 'Autre')],
      },
      { key: 'light.areas.other', type: 'text', ...f('Lesquelles ?'), short: f('Autres interventions'), when: { key: 'light.areas', has: 'other' } },
      {
        key: 'light.pages', type: 'chips', ...f('Et aussi'), short: f('Autres pages'),
        options: [of('about', 'À propos (parcours, formation)'), of('contact', 'Contact et rendez-vous')],
      },
      {
        key: 'light.texts', type: 'choice', ...f('Avez-vous déjà des textes ?'), short: f('Textes'),
        options: [of('yes', 'Oui'), of('no', 'Non'), of('some', 'En partie')],
      },
      {
        key: 'light.booking.now', type: 'chips', ...f('Comment vos patients prennent-ils rendez-vous aujourd’hui ?'), short: f('Rendez-vous aujourd’hui'),
        options: [of('doctoranytime', 'Doctoranytime'), of('whatsapp', 'WhatsApp'), of('phone', 'Téléphone / secrétariat'),
          of('clinic', 'Via la clinique ou l’hôpital'), of('doctena', 'Doctena'), of('rosa', 'Rosa'), of('other', 'Autre')],
      },
      { key: 'light.booking.other', type: 'text', ...f('Lequel ?'), short: f('Autre prise de rendez-vous'), when: { key: 'light.booking.now', has: 'other' } },
      {
        key: 'light.booking', type: 'choice', ...f(''), short: f('Prise de rendez-vous'),
        options: [of('keep', 'Garder l’actuel'), of('new', 'Prévoir une nouvelle prise de rendez-vous')],
      },
    ],
  },
  {
    // Only when "Réseaux sociaux" is ticked in La formule (F32).
    id: 'socials', ...f('Réseaux sociaux'), when: { key: 'light.needs', has: 'social' },
    fields: [
      {
        key: 'light.social.formats', type: 'chips', ...f('Quels formats ?'), short: f('Formats'),
        options: [{ ...of('interview', 'Vidéo interview'), inspire: 'interview' }, of('carousel', 'Carrousel'), of('reels', 'Reels')],
      },
      { key: 'light.social.start', type: 'slots', track: 'social', ...f('Quand commencer les réseaux sociaux ?'), short: f('Début réseaux sociaux') },
    ],
  },
  {
    // « Le contenu » (Andy, 19 Oct): photos and videos. The id stays 'photos'
    // so saved setups keep it. Each video option can show its example in a pop-up.
    id: 'photos', ...f('Le contenu'),
    fields: [
      {
        key: 'light.content', type: 'chips', ...f('Quel contenu souhaitez-vous ?'), short: f('Contenu'),
        options: [of('photos', 'Photos (le cabinet et vous)'), { ...of('video-practice', 'Vidéo du cabinet'), inspire: 'practice' },
          { ...of('video-interview', 'Vidéo interview'), inspire: 'interview' }, { ...of('video-animation', 'Vidéo animation'), inspire: 'animation' }],
      },
      {
        key: 'light.pro_photos', type: 'choice', ...f('Avez-vous déjà du contenu professionnel ?'), short: f('Contenu existant'),
        options: [of('have', 'Oui, j’en ai'), of('shoot', 'À prévoir (séance / tournage)')],
      },
    ],
  },
  {
    id: 'domain', ...f('Domaine et calendrier'),
    fields: [
      {
        key: 'light.domain', type: 'choice', ...f('Avez-vous déjà acheté un nom de domaine ?'), short: f('Nom de domaine'),
        options: [of('yes', 'Oui'), of('no', 'Non')],
      },
      { key: 'light.domain.name', type: 'text', ...f('Lequel ?'), short: f('Domaine'), when: { key: 'light.domain', is: 'yes' } },
      { key: 'light.domain.wish', type: 'text', ...f('Quel nom souhaiteriez-vous ?'), short: f('Domaine souhaité'), when: { key: 'light.domain', is: 'no' } },
      { key: 'light.start.site', type: 'slots', track: 'site', ...f('Quand souhaitez-vous commencer ?'), short: f('Début du site') },
      { key: 'light.start.date', type: 'text', ...f('Ou une autre date'), short: f('Autre date de début') },
    ],
  },
];

/**
 * Inspiration (F32, reworked 19 Oct): examples Andy adds per prospect
 * (form_config.media), each of a kind. A video option of that kind shows a
 * small « Voir l'inspiration » link that opens the example in a pop-up; the
 * old inline section is no longer drawn. The section stays in setups as the
 * place where Andy manages the examples.
 */
export const INSPIRATION_KINDS = [['interview', 'Vidéo interview'], ['practice', 'Vidéo du cabinet'], ['animation', 'Vidéo animation']];
const KIND_ALIASES = { video: 'interview' }; // the first examples were filed as 'video'
export const exampleKind = (item) => KIND_ALIASES[item?.tab] ?? item?.tab ?? 'interview';
export const INSPIRATION = {
  id: 'inspiration', ...f('Inspiration'), info: true, examples: true,
  fields: [{ key: 'media', type: 'media', ...f('') }],
};
/** The first example (Andy, F32): the interview format, from 0:34. */
export const DEFAULT_MEDIA = [{ tab: 'interview', url: 'https://www.youtube.com/watch?v=Z5nzpaH6ebw&t=34s', title: 'Interview' }];

/** The examples of one kind in a setup. */
export const examplesOf = (config, kind) => (config?.media ?? []).filter((m) => exampleKind(m) === kind);

/** A YouTube link as an id and a start second; null for any other link. */
export function youtube(url) {
  const m = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url ?? '');
  if (!m) return null;
  const t = /[?&#](?:t|start)=(\d+)s?/.exec(url);
  return { id: m[1], start: t ? Number(t[1]) : 0 };
}
/** The embed address (privacy-enhanced mode) and its poster image. */
export const youtubeEmbed = ({ id, start }) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ''}`;
export const youtubePoster = ({ id }) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** Every section a questionnaire can use, by id. */
export const LIBRARY = Object.fromEntries([...LIGHT_SECTIONS, INSPIRATION, ...SECTIONS].map((s) => [s.id, s]));

/**
 * The templates in the code (F31): the base one every new prospect gets, and
 * the full one Dr Renard was onboarded with. Templates Andy saves live in the
 * database (onboarding_templates). A config: the sections in order, the
 * questions turned off, Andy's own questions, and the example videos.
 */
export const BUILTIN_TEMPLATES = [
  { id: 'base', name: 'Base (site)', config: { sections: [...LIGHT_SECTIONS.map((s) => s.id), 'inspiration'], off: [], custom: [], media: DEFAULT_MEDIA } },
  { id: 'full', name: 'Complet (Dr Renard)', config: { sections: SECTIONS.map((s) => s.id), off: [], custom: [], media: [] } },
];
export const builtinConfig = (id) => structuredClone(BUILTIN_TEMPLATES.find((tpl) => tpl.id === id)?.config ?? BUILTIN_TEMPLATES[0].config);

/** The config a prospect uses: its own, else the one its old `template` column names. */
export function configFor(prospect = {}) {
  if (prospect.form_config && typeof prospect.form_config === 'object') return prospect.form_config;
  // Before F31 every prospect had the full questionnaire unless set to 'light'.
  return builtinConfig(prospect.template === 'light' ? 'base' : 'full');
}

const CUSTOM_KEY = /^custom\.[a-z0-9]{1,12}$/;
const CUSTOM_SECTION = /^c-[a-z0-9-]{1,30}$/;
const OPTION_ID = /^[a-z0-9-]{1,40}$/;
/** What an own question can be (22 Oct, phone questionnaire): text, long text, one choice, several choices. */
export const CUSTOM_TYPES = Object.freeze(['text', 'long', 'choice', 'chips', 'approve']);
/** Approval mode (24 Oct): the client reads prepared content and approves it, or says what to change. */
export const APPROVE_OPTIONS = Object.freeze([{ id: 'approved', fr: 'Approuvé' }, { id: 'changed', fr: 'À modifier' }]);
const ACCENT = /^#[0-9a-fA-F]{6}$/;
const cleanString = (value, max, what) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${what} must be text of at most ${max} characters`);
  return value.trim();
};
const httpsUrl = (u) => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(u);

/** A config as stored: only known sections, sane sizes, https links. Throws a message on anything else. */
export function cleanConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the questionnaire setup must be an object');
  // Sections of Andy's own (an architect is not asked about breasts): an id and a title.
  const ownSections = Array.isArray(raw.customSections) ? raw.customSections : [];
  if (ownSections.length > 12) throw new Error('at most 12 own sections');
  const cleanSections = ownSections.map((x) => {
    if (!x || !CUSTOM_SECTION.test(x.id) || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 120) {
      throw new Error('an own section needs an id like c-parcours and a title of at most 120 characters');
    }
    return { id: x.id, title: x.title.trim() };
  });
  const known = (id) => Boolean(LIBRARY[id]) || cleanSections.some((x) => x.id === id);
  const sections = Array.isArray(raw.sections) ? [...new Set(raw.sections)] : [];
  if (!sections.length || sections.some((id) => !known(id))) throw new Error('unknown section in the questionnaire');
  const off = Array.isArray(raw.off) ? [...new Set(raw.off)] : [];
  if (off.length > 200 || off.some((k) => typeof k !== 'string' || k.length > 80)) throw new Error('bad list of hidden questions');
  const custom = Array.isArray(raw.custom) ? raw.custom : [];
  if (custom.length > 40) throw new Error('at most 40 own questions');
  const keys = new Set();
  const cleanCustom = custom.map((c) => {
    if (!c || !CUSTOM_KEY.test(c.key) || !known(c.section) || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 300) {
      throw new Error('an own question needs a section and a label of at most 300 characters');
    }
    if (keys.has(c.key)) throw new Error(`two own questions share the key ${c.key}`);
    keys.add(c.key);
    const type = c.type ?? 'long';
    if (!CUSTOM_TYPES.includes(type)) throw new Error(`an own question is ${CUSTOM_TYPES.join(', ')}`);
    const out = { key: c.key, section: c.section, label: c.label.trim(), type };
    if (type === 'choice' || type === 'chips') {
      const options = Array.isArray(c.options) ? c.options : [];
      if (options.length < 2 || options.length > 12) throw new Error('a choice question needs 2 to 12 options');
      const ids = new Set();
      out.options = options.map((o) => {
        if (!o || !OPTION_ID.test(o.id) || ids.has(o.id) || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 120) {
          throw new Error('each option needs a unique id (a-z, 0-9, -) and a label of at most 120 characters');
        }
        ids.add(o.id);
        return { id: o.id, label: o.label.trim() };
      });
      // « Autre » (24 Oct): one more option; picking it asks the client to type what (<key>.other).
      if (c.other) {
        if (out.options.some((o) => o.id === 'autre')) throw new Error('the option id autre is kept for « Autre »');
        out.other = true;
      }
      if (type === 'chips' && c.max !== undefined && c.max !== null) {
        if (!Number.isInteger(c.max) || c.max < 1 || c.max > out.options.length + (out.other ? 1 : 0)) throw new Error('max must be between 1 and the number of options');
        out.max = c.max;
      }
    }
    if (type === 'approve') {
      const content = cleanString(c.content, 4000, 'the content to approve');
      if (!content) throw new Error('an approval needs the content to approve');
      out.content = content;
    }
    const hint = cleanString(c.hint, 200, 'a hint');
    if (hint) out.hint = hint;
    if (c.optional) out.optional = true;
    return out;
  });
  const media = Array.isArray(raw.media) ? raw.media : [];
  if (media.length > 6) throw new Error('at most 6 example videos');
  const cleanMedia = media.map((m) => {
    if (!m || !httpsUrl(m.url) || (m.poster && !httpsUrl(m.poster)) || (m.title && (typeof m.title !== 'string' || m.title.length > 120))
      || (m.tab && !INSPIRATION_KINDS.some(([id]) => id === exampleKind(m)))) {
      throw new Error('an example needs an https link (and an https poster image, if any)');
    }
    return { tab: exampleKind(m), url: m.url, ...(m.poster ? { poster: m.poster } : {}), ...(m.title ? { title: m.title.trim() } : {}) };
  });
  const welcome = cleanString(raw.welcome, 400, 'the welcome text');
  const thanks = cleanString(raw.thanks, 400, 'the thank-you text');
  const optionalIntro = cleanString(raw.optionalIntro, 200, 'the optional intro');
  const firstName = cleanString(raw.firstName, 40, 'the first name');
  if (raw.accent !== undefined && raw.accent !== null && raw.accent !== '' && !ACCENT.test(raw.accent)) throw new Error('accent must be a colour like #8FC5F2');
  return {
    sections, off, custom: cleanCustom, media: cleanMedia,
    ...(cleanSections.length ? { customSections: cleanSections } : {}),
    // The client answers on his own, one question per screen (22 Oct).
    ...(raw.clientAnswers ? { clientAnswers: true } : {}),
    // Speak to him with « tu » (Alexis's questions do).
    ...(raw.tu ? { tu: true } : {}),
    ...(welcome ? { welcome } : {}),
    ...(thanks ? { thanks } : {}),
    ...(optionalIntro ? { optionalIntro } : {}),
    // « Bonjour Alexis »: the name he goes by, when it is not the first word of his name.
    ...(firstName ? { firstName } : {}),
    // The client's own colour on his questionnaire; everything else is the shared template.
    ...(raw.accent ? { accent: raw.accent } : {}),
  };
}

/** The sections to show for a config: in its order, without the questions turned off, with Andy's own. */
/** Today in Brussels (the slots' "next Monday" is Andy's and his clients' day, not UTC's). */
export const brusselsToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function resolveSections(config, today = brusselsToday()) {
  const c = config ?? builtinConfig('base');
  const off = new Set(c.off ?? []);
  // Start slots become ordinary choices, worked out for today (schedule.js).
  const ready = (fd) => (fd.type === 'slots' ? { ...fd, type: 'choice', options: slotOptions(fd.track, today) } : fd);
  const own = (c.customSections ?? []).map((x) => ({ id: x.id, fr: x.title, fields: [], custom: true }));
  const lookup = (id) => LIBRARY[id] ?? own.find((x) => x.id === id);
  return (c.sections ?? []).map(lookup).filter(Boolean).map((section) => {
    if (section.id === 'inspiration') return { ...section, media: c.media ?? [] };
    const mine = (c.custom ?? []).filter((q) => q.section === section.id).map(ownQuestion);
    return { ...section, fields: [...section.fields.filter((fd) => !off.has(fd.key)).map(ready), ...mine] };
  }).filter((section) => section.fields.length && !section.examples);
}

/** An own question as a field like the library's. */
function ownQuestion(q) {
  const field = { key: q.key, type: q.type ?? 'long', fr: q.label, short: { fr: q.label }, custom: true };
  if (q.options) field.options = [...q.options.map((o) => ({ id: o.id, fr: o.label })), ...(q.other ? [{ id: 'autre', fr: 'Autre' }] : [])];
  if (q.other) field.other = true;
  if (q.type === 'approve') { field.content = q.content; field.options = APPROVE_OPTIONS.map((o) => ({ ...o })); }
  if (q.max) field.max = q.max;
  if (q.hint) field.hint = { fr: q.hint };
  if (q.optional) field.optional = true;
  return field;
}

/** The sections the client sees given his answers: a section with a `when` only once it applies. */
export const shownSections = (sections, answers = {}) => sections.filter((section) => fieldShown(section, answers));

/**
 * What the client may answer himself on his link: the open text questions;
 * and, when the setup lets him answer on his own (clientAnswers), the
 * choices too. Never Andy's business lists or social rows.
 */
export const clientWritable = (field, config = null) => field.type === 'text' || field.type === 'long'
  || (Boolean(config?.clientAnswers) && (field.type === 'choice' || field.type === 'chips' || field.type === 'approve'));

/** Whether a value is a valid answer to a field the client writes; a message when not. */
export function clientValueProblem(field, value) {
  if (value === null) return null;
  if (field.type === 'text' || field.type === 'long') return typeof value === 'string' ? null : 'text only';
  const ids = new Set((field.options ?? []).map((o) => o.id));
  if (field.type === 'choice' || field.type === 'approve') return typeof value === 'string' && ids.has(value) ? null : 'not one of the choices';
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && ids.has(v))) return 'not among the choices';
  if (new Set(value).size !== value.length) return 'a choice twice';
  if (field.max && value.length > field.max) return `at most ${field.max} choices`;
  return null;
}

/** Kept for older callers: the two questionnaires by their old names. */
export const TEMPLATES = { full: SECTIONS, light: LIGHT_SECTIONS };

/** The text of a label or an option in a language, French when missing. */
export const t = (thing, lang) => (thing?.[lang] ?? thing?.fr ?? '');

/** The keys a social row writes for one business. */
export const socialKeys = (entityId) => ({
  networks: `social.${entityId}.networks`,
  state: `social.${entityId}.state`,
  perWeek: `social.${entityId}.per_week`,
});

/** The separator the client reads: a middle dot with room on both sides. */
export const SEP = '\u2002·\u2002';

const filled = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '');

/** Whether a section has at least one answer. */
/** Whether a field is asked, given the other answers (its `when`). */
export const fieldShown = (field, answers = {}) => !field.when
  || ('has' in field.when ? Array.isArray(answers[field.when.key]) && answers[field.when.key].includes(field.when.has) : answers[field.when.key] === field.when.is);

export function sectionAnswered(section, answers = {}) {
  return section.fields.filter((field) => fieldShown(field, answers)).some((field) => (field.type === 'social'
    ? Object.keys(answers).some((key) => key.startsWith('social.') && filled(answers[key]))
    : filled(answers[field.key])));
}

/** How many sections have an answer, out of how many. */
export function progress(answers = {}, sections = SECTIONS) {
  const asked = sections.filter((section) => !section.info && fieldShown(section, answers));
  const done = asked.filter((section) => sectionAnswered(section, answers)).length;
  return { done, total: asked.length };
}

/** An option's label for a stored id; an id no option has is shown as it is. */
function optionLabel(field, id, lang) {
  return t(field.options?.find((opt) => opt.id === id), lang) || id;
}

/**
 * The answers as lines a person reads: one entry per answered field, grouped
 * by section, in the questionnaire's order. Feeds the summary on screen and,
 * later, the proposal.
 */
export function summarise(answers = {}, entities = [], lang = 'fr', sections = SECTIONS) {
  const nameOf = (id) => entities.find((e) => e.id === id)?.name ?? id;
  const out = [];
  for (const section of sections) {
    if (section.info || !fieldShown(section, answers)) continue;
    const lines = [];
    for (const field of section.fields) {
      if (field.type === 'social') {
        for (const entity of entities) {
          const keys = socialKeys(entity.id);
          const nets = (answers[keys.networks] ?? []).map((id) => t(NETWORKS.find((n) => n.id === id), lang) || id);
          const state = answers[keys.state] ? t(SOCIAL.state.find((s) => s.id === answers[keys.state]), lang) : '';
          const per = answers[keys.perWeek] ? `${t(SOCIAL.perWeek.find((p) => p.id === answers[keys.perWeek]), lang)} ${lang === 'en' ? 'a week' : 'par semaine'}` : '';
          const value = [nets.join(', '), state, per].filter(Boolean).join(SEP);
          if (value) lines.push({ label: entity.name, value });
        }
        continue;
      }
      const value = answers[field.key];
      if (!filled(value) || !fieldShown(field, answers)) continue;
      let text;
      if (field.type === 'entities') text = value.map(nameOf).join(', ');
      else if (field.type === 'entity') text = nameOf(value);
      else if (field.type === 'chips' || field.type === 'choice') {
        // « Autre » reads as what the client typed.
        const other = answers[`${field.key}.other`];
        const label = (id) => (id === 'autre' && field.other && filled(other) ? `Autre : ${other}` : optionLabel(field, id, lang));
        text = field.type === 'chips' ? value.map(label).join(', ') : label(value);
      }
      else if (field.type === 'approve') {
        // « À modifier » carries what the client wants changed (<key>.note).
        const note = answers[`${field.key}.note`];
        text = `${optionLabel(field, value, lang)}${value === 'changed' && filled(note) ? ` : ${note}` : ''}`;
      }
      else text = String(value);
      lines.push({ key: field.key, label: t(field.short ?? field, lang), value: text });
    }
    if (lines.length) out.push({ id: section.id, title: t(section, lang), lines });
  }
  return out;
}
