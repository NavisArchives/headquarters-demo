// One click on a local address: start it if it is not running, wait for the
// port, open it. Andy, 16 Oct: "pressing on localhost should launch it."
//
// The port and the command come from projects.json (local.services), the one
// source every session uses. Starting goes through /api/services, which only
// the HQ on the Mac can reach; elsewhere the address simply opens.
//
// A browser opens a new tab only in direct answer to a click, so the tab is
// opened at once, empty, and pointed at the address once the port answers.

import { apiFetch } from './api.js';
import { toast } from './leads-ui.js';

/** The registry service that serves this address: the one the Local link
 *  names, else the one on the same port. Null when HQ cannot start it. */
export function serviceFor(project, url) {
  const services = project?.local?.services ?? [];
  let port = null;
  try { port = Number(new URL(url).port) || null; } catch { return null; }
  const named = project?.links?.local?.service;
  const byName = services.find((s) => s.id === named && s.port === port);
  return byName ?? services.find((s) => s.port === port) ?? null;
}

/**
 * The lab versions, as full addresses: each service lists its own, as paths
 * on its own port. A lab of a service other than the one the Local link
 * names carries that service's name too.
 */
export function labLinks(project) {
  const link = project?.links?.local ?? {};
  const out = [];
  for (const service of project?.local?.services ?? []) {
    if (!Array.isArray(service.lab)) continue;
    const main = link.service === service.id && link.url;
    const origin = main ? new URL(link.url).origin : `http://localhost:${service.port}`;
    for (const lab of service.lab) {
      out.push({
        label: main ? lab.label : `${service.label} · ${lab.label}`,
        url: new URL(lab.path, `${origin}/`).toString(),
      });
    }
  }
  return out;
}

/** What the bridge says about one service: running, stopped, or unknown. */
export function serviceState(project, service, live) {
  if (!service) return 'none';
  if (!live?.bridge) return 'unknown';
  const row = (live.services ?? []).find((s) => s.slug === project.slug && s.name === service.id);
  return row?.running ? 'running' : 'stopped';
}

function waitingPage(win, label) {
  try {
    win.document.title = 'Starting…';
    const p = win.document.createElement('p');
    p.textContent = `Starting ${label}… this tab opens it as soon as it answers.`;
    p.style.cssText = 'font: 16px -apple-system, system-ui, sans-serif; color: #444; padding: 32px;';
    win.document.body.appendChild(p);
  } catch { /* a tab we cannot write into still gets the address */ }
}

/**
 * Open a local address, starting its service first when it is not running.
 * `api` and `opener` are injected for the tests.
 */
export async function openLocal(project, url, { api = apiFetch, opener = (u) => window.open(u, '_blank') } = {}) {
  const service = serviceFor(project, url);
  if (!service || service.manual) {
    const plain = opener(url);
    if (plain) { try { plain.opener = null; } catch { /* already cut */ } }
    return 'opened';
  }

  // The tab, now, while this is still the click.
  const win = opener('about:blank');
  const label = `${project.name} · ${service.label}`;
  const go = () => {
    if (!win) { toast(`${label} is ready: allow pop-ups for HQ to open it from here`); return; }
    try { win.opener = null; } catch { /* already cut */ }
    win.location.href = url;
  };

  let list;
  try {
    list = await api('/api/services');
  } catch {
    // Not the HQ on the Mac: nothing here can start it, so open what is there.
    go();
    toast('Starting a local server needs HQ on the Mac. Opened the address as it is.');
    return 'opened-without-bridge';
  }
  const row = (list?.services ?? []).find((s) => s.slug === project.slug && s.name === service.id);
  if (row?.running) { go(); return 'opened'; }

  if (win) waitingPage(win, label);
  toast(`Starting ${label}… (waits for the port)`);
  try {
    const path = `/api/services/${encodeURIComponent(project.slug)}/${encodeURIComponent(service.id)}/start`;
    const result = await api(path, { method: 'POST' });
    if (!result?.running) throw new Error(`${label} started, but the port never answered. Open Logs on the project page.`);
  } catch (error) {
    try { win?.close(); } catch { /* the user closed it */ }
    toast(error?.message || `${label} could not be started`);
    return 'failed';
  }
  toast(`${label} is running`);
  go();
  return 'started';
}

/** The phone address (same Wi-Fi) of the service serving `url`, keeping its path; null when none. */
export function lanUrl(project, url, live) {
  const service = serviceFor(project, url);
  if (!service?.lan || !live?.bridge) return null;
  const row = (live.services ?? []).find((s) => s.slug === project.slug && s.name === service.id);
  if (!row?.lan_url) return null;
  const at = new URL(url);
  return `${row.lan_url}${at.pathname === '/' ? '/' : at.pathname}${at.search}`;
}
