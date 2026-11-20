import { verifyAccessJwt } from '../shared/access-jwt.js';

const COOKIE_NAME = 'hq_session';
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SEC = SESSION_DAYS * 86400;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SEC * 1000;

// Mirrors the LEADS worker's login lockout: 5 wrong passwords from the same
// IP within 15 minutes, then a 429 until the window lapses.
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_TTL_SEC = 900;

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirect(location, status = 302) {
  return new Response(null, {
    status,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

/**
 * Which authentication mode this deployment is running in. Access wins
 * whenever it is configured, even if a password is also set, so a password
 * left behind in a secret store can never quietly downgrade an
 * Access-protected deployment.
 * @param {Record<string, unknown>} env
 * @returns {'access' | 'password' | 'none'}
 */
export function authMode(env) {
  if (env.ACCESS_TEAM && env.ACCESS_AUD) return 'access';
  if (env.HQ_PASSWORD) return 'password';
  return 'none';
}

/* ---------- constant-time comparison ---------- */

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/**
 * Compare two strings for equality without leaking timing information about
 * where they first differ. Both are hashed first so the comparison always
 * runs over two fixed-length (32-byte) SHA-256 digests — this also removes
 * the length of the secret as a side channel, not just its content.
 */
export async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/* ---------- session cookie ---------- */

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signExpiry(secret, expiry) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(expiry));
  return base64url(new Uint8Array(mac));
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/** Recompute the cookie's signature, constant-time compare it, and check expiry. */
async function verifySessionCookie(value, password) {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  const expiry = value.slice(0, dot);
  const hmac = value.slice(dot + 1);

  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;

  const expected = await signExpiry(password, expiry);
  return constantTimeEqual(hmac, expected);
}

function setCookieHeader(value, maxAgeSec, request) {
  const url = new URL(request.url);
  // `wrangler dev` rewrites the URL to the route's host (http://hq.example.com),
  // so the loopback client IP is the local signal. Cloudflare always sets it to the
  // visitor's real IP in production. Safari/WebKit (the desktop app) drops a Secure
  // cookie on http, where Chrome forgave it on localhost.
  const loopback = ['::1', '127.0.0.1'].includes(request.headers.get('CF-Connecting-IP') || '');
  const localHttp = url.protocol === 'http:' && (loopback || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly;${localHttp ? '' : ' Secure;'} SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/* ---------- login rate limiting ---------- */

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// Set once so a KV-less environment (tests, local `wrangler dev` without a
// bound namespace) doesn't spam the log on every login attempt.
let warnedNoStatusKv = false;

/**
 * Absent KV means "no counter, not no protection": a request with no
 * `env.STATUS` binding at all (tests, local dev without KV configured) is
 * let through as if it had never failed before, rather than the Worker
 * throwing or every login attempt being silently 429'd. In a real
 * deployment the binding always exists (it's declared in wrangler.jsonc and
 * already used by status.js), so this path only matters off-platform.
 */
async function loginFailCount(env, ip) {
  if (!env.STATUS) {
    if (!warnedNoStatusKv) {
      warnedNoStatusKv = true;
      console.warn('auth: STATUS KV binding is not available — login rate limiting is disabled');
    }
    return 0;
  }
  const raw = await env.STATUS.get(`login-fail:${ip}`);
  const count = Number(raw);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function recordLoginFailure(env, ip) {
  if (!env.STATUS) return;
  const count = await loginFailCount(env, ip);
  await env.STATUS.put(`login-fail:${ip}`, String(count + 1), { expirationTtl: LOGIN_FAIL_TTL_SEC });
}

async function resetLoginFailures(env, ip) {
  if (!env.STATUS) return;
  await env.STATUS.delete(`login-fail:${ip}`);
}

/* ---------- login page ---------- */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loginPage(error, status = error ? 401 : 200) {
  const page = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HQ</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<style>
/* The same one palette the app uses — HQ is dark, always, with no
   prefers-color-scheme branch and no toggle. */
:root{
  color-scheme:dark;
  --ground:#101613;--card:#18211C;--ink:#E6EEE8;--muted:#8A9C90;--line:#27332B;
  --green:#6FBF8F;--green-deep:#A7DBBB;--on-green:#0E1611;--red:#E08A84;--red-soft:#2F1918;
  --sans:'Instrument Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--ground);color:var(--ink);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:36px 32px;box-shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8)}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 20px}
h1{font-size:26px;line-height:1.1;margin:0 0 24px;font-weight:600}
label{display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
input{width:100%;min-height:48px;padding:12px 13px;font:15px/1.4 var(--sans);color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:10px;margin-bottom:18px}
input:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 18%,transparent)}
button{width:100%;min-height:48px;padding:13px 16px;font:600 14px/1 var(--sans);color:var(--on-green);background:var(--green);border:0;border-radius:10px;cursor:pointer}
button:hover{background:var(--green-deep)}
.err{margin:0 0 18px;padding:10px 12px;border-radius:8px;background:var(--red-soft);color:var(--red);font-size:13.5px}
</style></head>
<body>
<main class="card">
  <p class="eyebrow">HQ</p>
  <h1>Sign in</h1>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="POST" action="/login">
    <label for="u">Username</label>
    <!-- Prefilled, read-only username so password managers file this gate as
         its own login ("Andy Nirmata" @ HQ) instead of offering the saved
         entry for another localhost app. The server ignores this field. -->
    <input id="u" name="username" type="text" value="Andy Nirmata" autocomplete="username" readonly>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body></html>`;
  return new Response(page, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The page has no script and one same-origin form; this is a hard
      // deny on being framed or on any other origin acting for it. Its fonts
      // are HQ's own (/assets/fonts, public like the install icons, 13 Nov).
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; form-action 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/* ---------- routes ---------- */

/**
 * Handle `/login` and `/logout`. Returns `null` for every other path, or when
 * this deployment is not in password mode (Access mode has no login route of
 * its own, and an unconfigured deployment must fail closed on `/login` too —
 * both fall through so `authenticate()` can return its usual response).
 * @returns {Promise<Response|null>}
 */
/** Only the local demo: DEMO on, and a localhost address. */
export function demoAutoSignIn(env, url) {
  return env?.DEMO === 'on' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export async function handleLoginRoutes(request, env, url) {
  if (url.pathname !== '/login' && url.pathname !== '/logout') return null;

  const mode = authMode(env);

  if (mode === 'access') {
    // Access manages its own session; hand /logout off to Cloudflare's own
    // logout endpoint instead of leaving it as a dead route under Access.
    // /login has no meaning under Access and falls through to
    // authenticate()'s ordinary JWT check, same as any other path.
    if (url.pathname === '/logout') return redirect('/cdn-cgi/access/logout');
    return null;
  }

  // mode 'none' falls through too, so authenticate() can 503 /login and
  // /logout exactly like every other route — an unconfigured deployment
  // must fail closed everywhere, not just on the routes it doesn't special-case.
  if (mode !== 'password') return null;

  if (url.pathname === '/logout') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/login',
        'Set-Cookie': setCookieHeader('', 0, request),
        'Cache-Control': 'no-store',
      },
    });
  }

  // The demo (npm run demo: DEMO on, fictional data, its own throwaway password in
  // demo.vars) opens signed in, on this Mac only: nobody types a password for a demo.
  // Live HQ never sets DEMO, and the host must be the local one.
  if (request.method === 'GET' && demoAutoSignIn(env, url)) {
    const expiry = String(Date.now() + SESSION_MAX_AGE_MS);
    const hmac = await signExpiry(env.HQ_PASSWORD, expiry);
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': setCookieHeader(`${expiry}.${hmac}`, SESSION_MAX_AGE_SEC, request), 'Cache-Control': 'no-store' },
    });
  }

  if (request.method === 'POST') {
    const ip = clientIp(request);

    if ((await loginFailCount(env, ip)) >= LOGIN_FAIL_LIMIT) {
      // Locked out: don't even look at the password, so a correct one
      // submitted mid-lockout gains nothing.
      return loginPage('Too many attempts — try again in 15 minutes', 429);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      // A malformed body is indistinguishable from a wrong password to the
      // caller — same page, same status, no 500.
      return loginPage('Wrong password.');
    }

    const password = String(form.get('password') || '');
    const correct = await constantTimeEqual(password, env.HQ_PASSWORD);
    if (!correct) {
      await recordLoginFailure(env, ip);
      return loginPage('Wrong password.');
    }
    await resetLoginFailures(env, ip);

    const expiry = String(Date.now() + SESSION_MAX_AGE_MS);
    const hmac = await signExpiry(env.HQ_PASSWORD, expiry);
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': setCookieHeader(`${expiry}.${hmac}`, SESSION_MAX_AGE_SEC, request),
        'Cache-Control': 'no-store',
      },
    });
  }

  return loginPage(null);
}

/**
 * The one gate every other route passes through. Resolves to `{ ok: true,
 * identity }` when the request may proceed, or `{ ok: false, response }`
 * with the response to return instead.
 * @returns {Promise<{ok: true, identity: {email: string|null, mode: string}} | {ok: false, response: Response}>}
 */
export async function authenticate(request, env, keyCache) {
  const mode = authMode(env);

  if (mode === 'none') {
    return { ok: false, response: text('HQ is not configured', 503) };
  }

  if (mode === 'access') {
    // Access mode ignores cookies entirely: a password cookie grants nothing
    // here, so a deployment cannot be quietly downgraded by whatever is left
    // in a browser from before Access was configured.
    try {
      const payload = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), {
        teamDomain: env.ACCESS_TEAM,
        aud: env.ACCESS_AUD,
        keyCache,
      });
      return { ok: true, identity: { email: payload.email ?? null, mode: 'access' } };
    } catch {
      // Deliberately uninformative: the reason is for the logs, not the caller.
      return { ok: false, response: text('Forbidden', 403) };
    }
  }

  // mode === 'password'
  const cookie = readCookie(request, COOKIE_NAME);
  const valid = await verifySessionCookie(cookie, env.HQ_PASSWORD);
  if (!valid) {
    const wantsPage = (request.headers.get('Accept') || '').includes('text/html');
    if (wantsPage) return { ok: false, response: redirect('/login') };
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'not signed in' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }),
    };
  }
  return { ok: true, identity: { email: null, mode: 'password' } };
}
