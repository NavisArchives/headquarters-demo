// What Andy types is never lost (audit D15: M9, P1). A field's text is kept on
// this device until it is saved: across a screen change, a reload, a dropped
// connection or a save that failed. Kept in localStorage (per device, per
// field), removed the moment the save goes through.
const PREFIX = 'hq.draft.';
const memory = new Map(); // when storage is unavailable (private mode)

function store() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readDraft(key) {
  const s = store();
  try { return s ? s.getItem(PREFIX + key) : (memory.get(key) ?? null); } catch { return memory.get(key) ?? null; }
}

export function writeDraft(key, value) {
  const s = store();
  const text = String(value ?? '');
  try {
    if (!text) { s ? s.removeItem(PREFIX + key) : memory.delete(key); return; }
    if (s) s.setItem(PREFIX + key, text); else memory.set(key, text);
  } catch { memory.set(key, text); }
}

export const clearDraft = (key) => writeDraft(key, '');

/** Every key with text not yet saved (for « leave anyway? »). */
export function pendingDrafts() {
  const s = store();
  const keys = new Set(memory.keys());
  try {
    if (s) for (let i = 0; i < s.length; i += 1) { const k = s.key(i); if (k?.startsWith(PREFIX)) keys.add(k.slice(PREFIX.length)); }
  } catch { /* none readable */ }
  return [...keys];
}

/**
 * Ties a field to its draft: what was left unsaved comes back into it (when
 * it differs from what the server holds), and every keystroke is kept.
 * Returns { restored, saved() } — call saved() once the save went through.
 */
export function keepDraft(control, key, { serverValue = '' } = {}) {
  const left = readDraft(key);
  let restored = false;
  if (left && left !== String(serverValue ?? '')) {
    control.value = left;
    restored = true;
  } else if (left) {
    clearDraft(key);
  }
  control.addEventListener('input', () => {
    if (control.value === String(serverValue ?? '')) clearDraft(key);
    else writeDraft(key, control.value);
  });
  return {
    restored,
    saved(next = control.value) { serverValue = next; clearDraft(key); },
  };
}
