import { isPrivateTarget } from '../shared/registry.js';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The only two verbs a probe may ever use. Anything else — anything that could
 * publish, upload, save, translate or revoke on the far end — is coerced to
 * HEAD here, so no registry edit and no caller can turn a liveness check into
 * an action. andyssarchives' admin is one POST away from a 15-minute lockout;
 * Recall's /api/owner endpoints write. This is the guard for both.
 */
const SAFE_METHODS = ['GET', 'HEAD'];
export const safeMethod = (method) => (SAFE_METHODS.includes(method) ? method : 'HEAD');

/**
 * Probe a public URL. A 401 or 403 counts as up: it proves something answered.
 * `expect` adds codes a specific door is known to answer with — the
 * andyssarchives admin answers 401 when it is healthy and reachable.
 * Never throws — a failed probe is a result, not an error.
 */
export async function probeHttp(url, {
  fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'HEAD', expect = [],
} = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: safeMethod(method),
      redirect: 'follow',
      signal: controller.signal,
    });
    // When a door's answer is known, that answer is the whole test: the
    // andyssarchives admin says 401 when it is healthy, so a 200 there means
    // the password gate is gone — information worth surfacing as "down",
    // not a success to wave through.
    // A probe now follows a URL the owner typed, and it follows redirects.
    // The destination rules are checked at write time on the address as
    // written; this is the other half — where it actually landed. A public
    // host that redirects inward is the whole shape of the attack, so it is
    // reported as down rather than quietly fetched again.
    if (response.url && isPrivateTarget(response.url)) {
      return { kind: 'down', code: response.status, detail: 'that address redirects into a private network' };
    }
    const hasExpectation = Array.isArray(expect) && expect.length > 0;
    const answered = hasExpectation
      ? expect.includes(response.status)
      : (response.ok || response.status === 401 || response.status === 403);
    return {
      kind: answered ? 'up' : 'down',
      code: response.status,
      detail: `${response.status} in ${Date.now() - started} ms`,
    };
  } catch (error) {
    return {
      kind: 'unknown',
      detail: error.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call lists every Worker on the account with its modified_on.
 * Degrades to {} on any failure: deploy timestamps are a nice-to-have.
 */
export async function fetchDeployTimes(env, fetchImpl = fetch) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return {};

  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
    );
    if (!response.ok) return {};

    const body = await response.json();
    const times = {};
    for (const script of body.result ?? []) {
      if (script.id && script.modified_on) times[script.id] = script.modified_on;
    }
    return times;
  } catch {
    return {};
  }
}

/**
 * Counts only — the LEADS endpoint never returns lead records.
 * Degrades to null so the card simply loses its numbers.
 */
export async function fetchLeadsSummary(env, fetchImpl = fetch) {
  if (!env.LEADS_SUMMARY_URL || !env.LEADS_SUMMARY_SECRET) return null;

  try {
    const response = await fetchImpl(env.LEADS_SUMMARY_URL, {
      headers: { 'X-HQ-Secret': env.LEADS_SUMMARY_SECRET },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const CACHE_KEY = 'status:v1';
const CACHE_TTL_SEC = 300;

const HTTP_LABELS = { up: 'Live', down: 'Down', unknown: 'Unknown' };
const EXTRA_LABELS = { up: 'online', down: 'offline', unknown: 'unreachable' };

/**
 * Secondary probes — andyssarchives' admin tunnel, Recall's backend — carried
 * in the registry as `status.extra`. Each becomes its own pill so a project
 * can read "Live" and "Admin offline" at once, which is the truth on the card
 * the design brief calls the hard case.
 */
async function probeExtras(project, fetchImpl) {
  const extras = project.status?.extra ?? [];
  if (!extras.length) return undefined;
  return Promise.all(extras.map(async (extra) => {
    const result = await probeHttp(extra.url, {
      fetchImpl, method: extra.method, expect: extra.expect,
    });
    return {
      id: extra.id,
      name: extra.label,
      kind: result.kind,
      label: `${extra.label} ${EXTRA_LABELS[result.kind]}`,
      detail: result.detail,
    };
  }));
}

/**
 * Build the full status payload. Every probe runs concurrently and independently:
 * one failure never removes a project from the result.
 */
export async function buildStatus(registry, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const [deployTimes, leads] = await Promise.all([
    fetchDeployTimes(env, fetchImpl),
    fetchLeadsSummary(env, fetchImpl),
  ]);

  const entries = await Promise.all(registry.map(async (project) => {
    const probe = project.status.probe;
    // Secondary probes are independent of the main one — a local-only project
    // can still have a hosted door worth checking — so the two run together.
    const [extra, result] = await Promise.all([
      probeExtras(project, fetchImpl),
      probe === 'http'
        ? probeHttp(project.status.url ?? project.links.live.url, {
          fetchImpl, method: project.status.method, expect: project.status.expect,
        })
        : null,
    ]);
    const withExtra = (state) => (extra ? { ...state, extra } : state);

    if (probe === 'none') {
      return [project.slug, withExtra({ kind: 'none', label: 'Not set up' })];
    }
    if (probe === 'local') {
      // Plan 2 replaces this with a real reading from the agent.
      return [project.slug, withExtra({ kind: 'unknown', label: 'Local only' })];
    }

    const state = withExtra({
      kind: result.kind,
      label: HTTP_LABELS[result.kind],
      detail: result.detail,
    });
    const deployed = deployTimes[project.status.worker];
    if (deployed) state.deployed = deployed;
    return [project.slug, state];
  }));

  return {
    checkedAt: new Date(now).toISOString(),
    projects: Object.fromEntries(entries),
    leads,
  };
}

/**
 * Forget the cached status. Starting or stopping a local service changes what
 * a probe would find, and a five-minute-old "Local only" would contradict the
 * button the person just pressed.
 */
export async function invalidateStatus(env, ctx = null) {
  const drop = env?.STATUS?.delete?.(CACHE_KEY);
  if (!drop) return;
  if (ctx?.waitUntil) ctx.waitUntil(drop);
  else await drop;
}

/** buildStatus behind a five-minute KV cache. */
export async function getStatus(registry, env, ctx, deps = {}) {
  const cached = await env.STATUS.get(CACHE_KEY, 'json');
  if (cached) return cached;

  const status = await buildStatus(registry, env, deps);
  ctx.waitUntil(env.STATUS.put(CACHE_KEY, JSON.stringify(status), { expirationTtl: CACHE_TTL_SEC }));
  return status;
}
