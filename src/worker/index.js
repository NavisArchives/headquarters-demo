import { scrubForDemo } from './demo-scrub.js';
import { handleServiceWorker } from './sw.js';
import fileRegistry from '../../projects.json';
import demoRegistry from '../../demo/registry.json';
import { identityFrom, demoStatus } from '../shared/identity.js';
import { createKeyCache } from '../shared/access-jwt.js';
import { authenticate, handleLoginRoutes } from './auth.js';
import { getStatus } from './status.js';
import { handleMissions } from './api/missions.js';
import { handleTodos } from './api/todos.js';
import { handlePlatforms } from './api/platforms.js';
import { handleProspects } from './api/prospects.js';
import { handleBriefing } from './briefing.js';
import { handleOutreach } from './api/outreach.js';
import { handleReports } from './api/reports.js';
import { handleIntake } from './intake.js';
import { handleLeads } from './api/leads.js';
import { handleGmail } from './api/gmail.js';
import { handleServices } from './api/services.js';
import { handleReplies } from './api/replies.js';
import { handleWorkspace } from './api/workspace.js';
import { handleFinance } from './api/finance.js';
import { handleAccept, isAcceptPath } from './api/accept.js';
import { handleProjects } from './api/projects.js';
import { handleRegistry } from './api/registry.js';
import { effectiveRegistry } from './registry-store.js';
import { liveOnly } from '../shared/registry.js';
import { handlePixel } from './px.js';
import { handleBrevoHook } from './brevo-hook.js';
import { handleCalendarFeed } from './calendar.js';
import { handleLive, handleLiveHost } from './live.js';
import { setHqTimeZone } from './db.js';
import { isReadLimit, readLimitResponse } from './d1-limit.js';

const keyCache = createKeyCache();

// Every top-level route the single-page app answers to. Each one gets the
// same shell (index.html) — the app's own router takes it from there.
const INSTALL_PATHS = new Set(['/manifest.webmanifest', '/assets/icons/hq-192.png', '/assets/icons/hq-512.png', '/assets/icons/apple-touch-icon.png']);
const SHELL_PATHS = new Set(['/', '/projects', '/missions', '/pipeline', '/leads', '/finance', '/admin', '/reports', '/outreach', '/ask']);
// One shell route is not a fixed path: /finance/<id> is a printed invoice, and
// the app's router reads the id out of the URL. Only digits — /finance/new is
// not a route, and an id is never anything else.
const SHELL_PREFIXES = [/^\/finance\/\d+$/, /^\/pipeline\/\d+$/, /^\/onboarding\/\d+$/];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const hq = {
  async fetch(request, env, ctx) {
    setHqTimeZone(env.HQ_TIME_ZONE);
    const url = new URL(request.url);

    // onboarding.example.com serves a Realis client's page and nothing
    // else: not the pixel, not the login, not HQ (handleLiveHost 404s the rest).
    const liveHost = await handleLiveHost(request, env, url);
    if (liveHost) return liveHost;

    // The one route that runs before authentication, by necessity: a
    // recipient's mail client fetches this pixel with no cookie and no
    // Access header at all.
    const pixel = await handlePixel(request, env, url);
    if (pixel) return pixel;

    // Brevo's webhook, for the same reason: Brevo calls in with no session.
    // A secret in the path is its only gate (see brevo-hook.js).
    const brevo = await handleBrevoHook(request, env, url);
    if (brevo) return brevo;

    // The to-do calendar, for the same reason: Google Calendar fetches it with
    // no session. A secret in the path is its only gate (see calendar.js).
    const calendar = await handleCalendarFeed(request, env, url);
    if (calendar) return calendar;

    // The live mirror of a questionnaire, for the same reason: the client
    // follows it with no session. A secret in the path is its only gate (live.js).
    const live = await handleLive(request, env, url);
    if (live) return live;

    // The intake door: NIRMATA, the iOS Shortcut and the email worker file
    // missions with a bearer token of their own (intake.js). Only
    // POST /api/intake, and GET /api/missions when a bearer token is sent.
    const intake = await handleIntake(request, env, url);
    if (intake) return intake;

    // The service worker script is public: the kill switch must reach a phone
    // that is signed out, and it holds code and file names only (src/worker/sw.js).
    const serviceWorker = await handleServiceWorker(request, env, url);
    if (serviceWorker) return serviceWorker;

    // The install manifest and its icons are public by design: Chrome fetches
    // them without cookies when it offers "Install Headquarters". They carry
    // a name and two pictures, nothing else. GET/HEAD only.
    // The fonts too: the sign-in page needs them before anyone is signed in.
    // They are public typefaces (SIL OFL), nothing about Andy or his clients.
    const isFont = url.pathname.startsWith('/assets/fonts/') && !url.pathname.includes('..');
    if ((INSTALL_PATHS.has(url.pathname) || isFont) && (request.method === 'GET' || request.method === 'HEAD')) {
      return env.ASSETS.fetch(request);
    }

    // /login and /logout, only when the deployment is in password mode.
    const loginResponse = await handleLoginRoutes(request, env, url);
    if (loginResponse) return loginResponse;

    // Nothing else is served before this succeeds. Cloudflare Access (or the
    // password-cookie fallback while Access isn't configured yet) protects
    // the hostname; this protects the Worker.
    const auth = await authenticate(request, env, keyCache);
    if (!auth.ok) return auth.response;
    const { identity } = auth;

    // The throwaway used for portfolio screenshots serves a fictional
    // registry and a status nobody had to probe. Production never sets DEMO.
    const demo = env.DEMO === 'on';

    // Which HQ this is, for the deploy gates: they click through every
    // screen, so they may only ever run against the demo's own throwaway
    // database, and they ask first.
    if (url.pathname === '/api/environment' && request.method === 'GET') return json({ demo });

    // The effective registry: the committed file with the owner's rows
    // merged over it. Read at most once per request and never cached across
    // requests, so a project created at 10:04 is visible at 10:04 — and
    // `/assets/*`, which reaches the Worker because run_worker_first is on,
    // never pays for the query at all.
    let regPromise = null;
    // The demo merges its own throwaway database's projects over the demo
    // file, as live does over projects.json: a project made by Accept quote
    // there used to vanish (« No such project », audit A6/M4; live unaffected).
    const getReg = () => (regPromise ??= effectiveRegistry(env, demo ? demoRegistry : fileRegistry));

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403);
    }
    const workspace = await handleWorkspace(request, env, url);
    if (workspace) return workspace;
    // The registry goes in so finance can say which project an invoice is
    // for — the project page and the invoice are the same job in two places.
    // Accept quote writes to the registry as well as finance, so it gets the
    // registry and the caller; it answers before finance sees the path.
    if (isAcceptPath(url.pathname)) {
      const { registry, degraded } = await getReg();
      return handleAccept(request, env, url, { registry, degraded, identity, ctx });
    }
    if (url.pathname.startsWith('/api/finance/')) {
      // Finance gets the FULL list, archived included. A finished client's
      // money page must keep opening, and every edit of its old invoices must
      // keep passing the slug check; only the boards hide an archived project.
      const finance = await handleFinance(request, env, url, () => getReg().then((r) => r.registry), { file: demo ? demoRegistry : fileRegistry });
      if (finance) return finance;
    }

    // `/api/overview` lives in handleProjects too — the home screen's whole
    // first paint comes from it — so the guard has to admit both paths.
    if (url.pathname.startsWith('/api/projects') || url.pathname === '/api/overview') {
      const { registry, file, degraded } = { ...(await getReg()), file: demo ? demoRegistry : fileRegistry };
      // Making and changing a project. Mounted first so it claims the
      // mutating verbs while /api/projects/<slug>/meta stays where it was.
      const made = await handleRegistry(request, env, url, { registry, file, degraded, identity, ctx });
      if (made) return made;
      const projects = await handleProjects(request, env, url, new Set(registry.map((p) => p.slug)));
      if (projects) return projects;

      // The shape here is unchanged — app.js and lib.js merge() keep working
      // untouched — except that a project can now carry `origin` and
      // `archived`, which the screens use to say where it came from.
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        return json({
          email: identity.email ?? null,
          projects: registry,
          identity: identityFrom(env),
          ...(degraded ? { degraded: true } : {}),
        });
      }
    }

    const missions = await handleMissions(request, env, url);
    if (missions) return missions;

    const todos = await handleTodos(request, env, url, { demo });
    if (todos) return todos;

    const platforms = await handlePlatforms(request, env, url);
    if (platforms) return platforms;

    const briefing = await handleBriefing(request, env, url);
    if (briefing) return briefing;

    const outreach = await handleOutreach(request, env, url, identity);
    if (outreach) return outreach;

    const reports = await handleReports(request, env, url);
    if (reports) return reports;

    const prospects = await handleProspects(request, env, url);
    if (prospects) return prospects;

    const leads = await handleLeads(request, env, url);
    if (leads) return leads;

    // The reply funnel. It sits before the Gmail proxy because it uses it:
    // /api/replies/scan reads through handleGmail and nowhere else.
    const replies = await handleReplies(request, env, url);
    if (replies) return replies;

    // Gmail, forwarded to the local server on the Mac (GMAIL_BRIDGE). Behind
    // authenticate() like everything else: the bridge trusts whatever reaches
    // it, so nothing may reach it unauthenticated.
    const gmail = await handleGmail(request, env, url);
    if (gmail) return gmail;

    // Starting and stopping the dev servers on the Mac, through the same
    // bridge. The registry goes in because an unknown slug/service pair is
    // refused here, before anything is forwarded.
    // `local` is file-only, so this sees exactly the services it always did.
    // Only /api/services pays for the registry here. Before (found 3 Nov), every
    // asset and every unknown path waited for its D1 query first: ~0.5 s each
    // from Lima, for each of the app's script files.
    if (url.pathname === '/api/services' || url.pathname.startsWith('/api/services/')) {
      const services = await handleServices(request, env, url, (await getReg()).registry, { ctx });
      if (services) return services;
    }

    if (url.pathname === '/api/status') {
      const { registry } = await getReg();
      // An archived project is off the boards, so it is never probed either.
      return json(demo ? demoStatus(registry) : await getStatus(liveOnly(registry), env, ctx));
    }

    if (url.pathname.startsWith('/p/')) {
      const slug = url.pathname.slice(3);
      // An archived project stays reachable at its own URL. That is what
      // makes archiving safe rather than a soft delete with extra steps.
      if (!new Set((await getReg()).registry.map((p) => p.slug)).has(slug)) return text('No such project', 404);
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }

    if (SHELL_PATHS.has(url.pathname) || SHELL_PREFIXES.some((re) => re.test(url.pathname))) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }

    if (url.pathname.startsWith('/assets/')) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return Response.redirect(new URL('/', url).toString(), 302);
  },
};

// The demo (wrangler.demo.jsonc, DEMO=on) serves no real identity: every text
// response is rewritten to the demo's (audit F19). Production: untouched.
export default {
  ...hq,
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await hq.fetch(request, env, ctx);
    } catch (error) {
      // Anything that threw past its own handler: D1's daily limit gets words, not a 1101.
      if (!isReadLimit(error)) throw error;
      response = readLimitResponse();
    }
    return env.DEMO === 'on' ? scrubForDemo(response, env) : response;
  },
};
