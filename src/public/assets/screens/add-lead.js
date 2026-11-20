// One lead, added by hand.
//
// The pipeline's only entrance used to be a whole dataset import, and the
// empty state told you to run curl. That is no use when you have just found
// a surgeon's number on a clinic page and want them in the pipeline before
// you close the tab.
//
// Three things this form deliberately does not ask for, because the server
// decides them: the lead's id, which is derived from the name so it can never
// collide with or silently overwrite somebody; the tier, which comes from the
// list's own thresholds; and the business, which comes from the list, because
// it is what chooses which brand writes to this person.
import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { toast, openModal } from '../leads-ui.js';

const LANGS = ['NL', 'FR', 'EN', 'DE'];

function field(label, control, hint) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'label', label));
  wrap.append(control);
  if (hint) wrap.append(el('small', 'field-hint', hint));
  return wrap;
}

function input(name, { placeholder = '', type = 'text', value = '' } = {}) {
  const node = el('input', 'text-input');
  node.type = type;
  node.name = name;
  node.value = value;
  if (placeholder) node.placeholder = placeholder;
  return node;
}

/**
 * @param {object[]} datasets  the lists, from the workspace route
 * @param {(lead: object) => void} onAdded
 */
export function openAddLead(datasets, onAdded) {
  const lists = (datasets ?? []).filter((d) => d?.key);
  if (!lists.length) {
    toast('No lists loaded — reload the page and try again');
    return;
  }

  const { modal, close } = openModal({ className: 'narrow', label: 'Add a lead' });

  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.append(el('div', 'crumb', 'Leads'), el('h2', null, 'Add a lead'));
  head.append(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', close);
  nav.append(x);
  head.append(nav);
  modal.append(head);

  const form = el('form', 'ord-form');

  const list = el('select', 'text-input');
  for (const meta of lists) {
    const option = el('option', null, `${meta.title || meta.key} · ${meta.business}`);
    option.value = meta.key;
    list.append(option);
  }

  const name = input('name', { placeholder: 'Dr Élodie Lefèvre' });
  const email = input('email', { placeholder: 'info@clinic.be', type: 'email' });
  const phone = input('phone', { placeholder: '+32 2 000 00 00', type: 'tel' });
  const website = input('website', { placeholder: 'https://… — leave empty if they have none', type: 'url' });
  const city = input('city', { placeholder: 'Gent' });
  const why = input('why', { placeholder: 'Where you found them, or why they are worth writing to' });

  const langs = el('div', 'langpick');
  const langBoxes = new Map();
  for (const code of LANGS) {
    const label = el('label', 'langpick__one');
    const box = el('input');
    box.type = 'checkbox';
    box.value = code;
    langBoxes.set(code, box);
    label.append(box, el('span', null, code));
    langs.append(label);
  }

  form.append(
    field('Which list', list, 'The list decides the brand that writes to them and how they are scored.'),
    field('Name', name),
    field('Email', email),
    field('Phone', phone),
    field('Website', website, 'Leave it empty if they have none. The first email is written differently for someone with no site.'),
    field('City', city),
    field('Languages', langs),
    field('Why them', why, 'One line. It becomes the personal sentence in the first email.'),
  );

  const actions = el('div', 'sendrow');
  const save = el('button', 'btn primary', 'Add lead');
  save.type = 'submit';
  actions.append(save);
  form.append(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!name.value.trim()) { toast('A name is required'); return; }
    save.disabled = true;
    try {
      const made = await apiFetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: list.value,
          name: name.value.trim(),
          email: email.value.trim(),
          phone: phone.value.trim(),
          website: website.value.trim(),
          city: city.value.trim(),
          why: why.value.trim(),
          languages: [...langBoxes].filter(([, box]) => box.checked).map(([code]) => code),
        }),
      });
      close();
      onAdded?.(made?.lead ?? { name: name.value.trim() });
    } catch (error) {
      toast(error?.message || 'That lead could not be added');
      save.disabled = false;
    }
  });

  modal.append(form);
  name.focus();
}
