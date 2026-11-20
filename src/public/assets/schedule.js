// When a project can start (F32): the start slots the questionnaire offers
// for "Quand souhaitez-vous commencer ?", and how long each kind of project
// takes, so each slot shows a start and an expected end.
//
// ANDY SETS THESE. `start` is 'next-monday' (worked out on the day) or a date
// (YYYY-MM-DD). `weeks` is how long a project runs; null shows "fin à
// confirmer" instead of an end date, so nothing is promised before Andy says.

export const SCHEDULE = {
  slots: [
    { id: 'next-monday', label: 'Lundi prochain', start: 'next-monday' },
    { id: 'nov-14', label: 'À partir du 14 novembre', start: '2026-11-14' },
  ],
  weeks: { site: null, social: null },
};

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The Monday after `today` (never today itself), as YYYY-MM-DD. */
export function nextMonday(today) {
  const at = Date.parse(`${today}T00:00:00Z`);
  const weekday = new Date(at).getUTCDay(); // 0 Sunday … 6 Saturday
  return iso(at + (((8 - weekday) % 7) || 7) * DAY);
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** "lun. 26 oct." */
export function frenchDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const days = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The slots as answer options for one kind of project: the option's id is
 * the start date itself (so an answer never shifts), its line the expected end.
 * A slot already past is left out.
 */
export function slotOptions(track, today, schedule = SCHEDULE) {
  const weeks = schedule.weeks?.[track] ?? null;
  return schedule.slots
    .map((slot) => ({ slot, start: slot.start === 'next-monday' ? nextMonday(today) : slot.start }))
    .filter(({ start }) => start >= today)
    .map(({ slot, start }) => ({
      id: start,
      fr: slot.label,
      desc: {
        fr: `Début ${frenchDay(start)} · ${weeks ? `fin prévue ${frenchDay(iso(Date.parse(`${start}T00:00:00Z`) + weeks * 7 * DAY))}` : 'fin à confirmer'}`,
      },
    }));
}
