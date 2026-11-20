// Pure helpers for the HQ frontend — no DOM, no fetch, no globals.
// Keeping this file DOM-free is what lets test/frontend-lib.test.js run under
// plain Node with no jsdom: every function here is a straight data transform.

const DEFAULT_STATE = Object.freeze({ kind: 'unknown', label: 'Unknown' });

/**
 * Attach a `state` to each registry project from the /api/status payload's
 * `projects` map (`{ [slug]: { kind, label, detail?, deployed? } }`).
 *
 * `statusProjects` may be missing entirely — the status fetch failed, or the
 * caller hasn't loaded it yet — or simply lack an entry for a given slug (a
 * probe that hasn't produced a result). Both default the same way, so the
 * rest of the app never has to check for a project without a `state`.
 */
export function merge(projects, statusProjects) {
  const states = statusProjects && typeof statusProjects === 'object' ? statusProjects : {};
  return (projects ?? []).map((project) => ({
    ...project,
    state: states[project.slug] ?? DEFAULT_STATE,
  }));
}

const ATTENTION_KINDS = new Set(['failed', 'down']);

/**
 * Roll a merged project list up into the counts a one-line summary needs.
 * `attention` mirrors what Headquarters treats as "needs attention": a
 * project that is down or has failed outright.
 */
export function summarise(merged) {
  const summary = { live: 0, running: 0, pending: 0, attention: 0 };
  for (const project of merged ?? []) {
    const kind = project?.state?.kind;
    if (kind === 'up') summary.live += 1;
    else if (kind === 'running') summary.running += 1;
    else if (kind === 'starting' || kind === 'stopping') summary.pending += 1;
    if (ATTENTION_KINDS.has(kind)) summary.attention += 1;
  }
  return summary;
}

// The registry's groups live with the screen that renders them:
// `kindOrder()` in screens/projects.js. There is no "Tools" group.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function ago(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * A short, human relative time string. `now` is injectable (a timestamp or
 * a Date) so this is deterministic under test rather than reading the clock.
 */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';

  const nowMs = now instanceof Date ? now.getTime() : now;
  const diff = Math.max(0, nowMs - then);

  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return ago(Math.floor(diff / MINUTE_MS), 'minute');
  if (diff < DAY_MS) return ago(Math.floor(diff / HOUR_MS), 'hour');
  return ago(Math.floor(diff / DAY_MS), 'day');
}

const RUNNABLE_KINDS = new Set(['running', 'stopped', 'failed', 'starting']);

/**
 * True only for a project HQ could plausibly start or stop from here: the
 * registry must declare `local.services` for it, AND its current state must
 * be one of the kinds that implies a local process HQ is tracking.
 *
 * Realis Studio and andyssarchives are Workers deployments — the registry
 * gives them a `deploy` command, not a `local` block — so they fail the
 * first check and are never runnable here, regardless of what a dev script
 * in their own package.json happens to do.
 */
export function isRunnable(project) {
  const services = project?.local?.services;
  if (!Array.isArray(services) || services.length === 0) return false;
  return RUNNABLE_KINDS.has(project?.state?.kind);
}

/**
 * Whether the "Mac" chip in the header should read online or offline: only
 * offline when every local-probe project is reporting the Mac unreachable.
 * A registry with no local-probe projects at all has no signal either way,
 * so it reads online.
 */
export function macOnline(merged) {
  const locals = (merged ?? []).filter((project) => project?.status?.probe === 'local');
  if (locals.length === 0) return true;
  return !locals.every((project) => project?.state?.label === 'Mac offline');
}
