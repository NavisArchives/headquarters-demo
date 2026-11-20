// Approved lead batches land in HQ by themselves (lead-batches.js on the
// Worker). This side only says so, in a toast (Andy's rule: never text beside
// a control), and offers « Import now ». While HQ is open it looks every few
// minutes; a batch NIRMATA approved while HQ was closed is announced on the
// next start.
import { apiFetch, clearApiCache } from './api.js';
import { toast } from './leads-ui.js';

const SEEN_KEY = 'hq.leadBatches.seen';
const EVERY_MS = 5 * 60_000;
let timer = null;

const lastSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const remember = (id) => { try { localStorage.setItem(SEEN_KEY, String(id)); } catch { /* private window */ } };

/** One line for what landed: « Imported web-wave-r4-fr-be: 23 leads », or the sum. */
export function importMessage(batches) {
  const ok = batches.filter((b) => b.result === 'imported');
  const failed = batches.filter((b) => b.result === 'failed');
  const parts = [];
  if (ok.length === 1) parts.push(`Imported ${ok[0].key}: ${ok[0].rows} leads`);
  if (ok.length > 1) parts.push(`Imported ${ok.length} batches: ${ok.reduce((n, b) => n + b.rows, 0)} leads`);
  if (failed.length) parts.push(`Not imported: ${failed.map((b) => b.key).join(', ')} (${failed[0].error || 'see the log'})`);
  return parts.join(' · ');
}

/** Imports what is approved and waiting, then announces anything new since the last look. */
export async function checkLeadBatches({ run = false } = {}) {
  if (run) await apiFetch('/api/leads/batches/run', { method: 'POST' });
  const { batches = [] } = await apiFetch('/api/leads/batches');
  const seen = lastSeen();
  const fresh = batches.filter((b) => b.id > seen && b.result);
  if (fresh.length) {
    remember(Math.max(...fresh.map((b) => b.id)));
    clearApiCache(); // the leads list has new rows
    toast(importMessage(fresh));
  }
  return fresh;
}

/** On start, then every few minutes while HQ is open. */
export function watchLeadBatches() {
  if (timer) return;
  const look = () => checkLeadBatches().catch(() => {});
  look();
  timer = setInterval(look, EVERY_MS);
}
