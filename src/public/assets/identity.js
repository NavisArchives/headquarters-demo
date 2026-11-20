// Who this Headquarters belongs to, as the browser sees it. Set once at boot
// from /api/projects; the defaults mirror src/shared/identity.js so a screen
// rendered before the fetch lands still says something true.
import { DEFAULT_IDENTITY } from './identity-data.js';

let current = { ...DEFAULT_IDENTITY };

export function setIdentity(partial) {
  if (partial && typeof partial === 'object') current = { ...current, ...partial };
  return current;
}

export function identity() { return current; }
