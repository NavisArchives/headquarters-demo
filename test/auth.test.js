import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAccessJwt = vi.fn();
vi.mock('../src/shared/access-jwt.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, verifyAccessJwt: (...args) => verifyAccessJwt(...args) };
});

const { default: worker } = await import('../src/worker/index.js');
const { authMode, authenticate, handleLoginRoutes } = await import('../src/worker/auth.js');
const { AccessError } = await import('../src/shared/access-jwt.js');

const ctx = { waitUntil: () => {} };
const ORIGIN = 'https://hq.example.com';

function accessEnv(overrides = {}) {
  return {
    ACCESS_TEAM: 'example.cloudflareaccess.com',
    ACCESS_AUD: 'aud-abc123',
    STATUS: {
      get: async () => ({ checkedAt: null, projects: {}, leads: null }),
      put: async () => {},
      delete: async () => {},
    },
    ASSETS: { fetch: async () => new Response('<h1>HQ</h1>', { headers: { 'Content-Type': 'text/html' } }) },
    ...overrides,
  };
}

function passwordEnv(overrides = {}) {
  return {
    HQ_PASSWORD: 'correct horse battery staple',
    STATUS: {
      get: async () => ({ checkedAt: null, projects: {}, leads: null }),
      put: async () => {},
      delete: async () => {},
    },
    ASSETS: { fetch: async () => new Response('<h1>HQ</h1>', { headers: { 'Content-Type': 'text/html' } }) },
    ...overrides,
  };
}

function noneEnv() {
  return {
    ASSETS: { fetch: async () => new Response('<h1>HQ</h1>', { headers: { 'Content-Type': 'text/html' } }) },
  };
}

function req(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

function cookieHeaderFrom(response) {
  return response.headers.get('Set-Cookie') || '';
}

/** A minimal in-memory stand-in for the STATUS KV binding, so the login
 * rate limiter has somewhere real to count against across requests in a
 * test (the static `passwordEnv()`/`accessEnv()` mocks above never persist
 * anything, which is fine for tests that don't touch the counter). */
function makeFakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function signIn(env) {
  const body = new URLSearchParams({ password: env.HQ_PASSWORD });
  const response = await worker.fetch(
    req('/login', { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
    env,
    ctx
  );
  const setCookie = cookieHeaderFrom(response);
  const cookie = setCookie.split(';')[0];
  return { response, cookie };
}

beforeEach(() => {
  verifyAccessJwt.mockReset();
  verifyAccessJwt.mockResolvedValue({ email: 'owner@example.com' });
});

describe('authMode', () => {
  it('is access when both Access vars are set', () => {
    expect(authMode({ ACCESS_TEAM: 't', ACCESS_AUD: 'a' })).toBe('access');
  });

  it('is password when only HQ_PASSWORD is set', () => {
    expect(authMode({ HQ_PASSWORD: 'x' })).toBe('password');
  });

  it('is none when nothing is set', () => {
    expect(authMode({})).toBe('none');
  });

  it('prefers access when Access vars and HQ_PASSWORD are both set', () => {
    expect(authMode({ ACCESS_TEAM: 't', ACCESS_AUD: 'a', HQ_PASSWORD: 'x' })).toBe('access');
  });

  it('is none when HQ_PASSWORD is set but empty', () => {
    expect(authMode({ HQ_PASSWORD: '' })).toBe('none');
  });
});

describe('fail closed: mode none', () => {
  it.each(['/', '/login', '/api/status', '/api/projects', '/anything'])(
    '503s %s when neither Access nor a password is configured',
    async (path) => {
      const response = await worker.fetch(req(path), noneEnv(), ctx);
      expect(response.status).toBe(503);
    }
  );
});

describe('password mode: gate', () => {
  it('redirects to /login for an HTML request with no cookie', async () => {
    const response = await worker.fetch(req('/', { headers: { Accept: 'text/html' } }), passwordEnv(), ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });

  it('401s a JSON request with no cookie, with a JSON body', async () => {
    const response = await worker.fetch(
      req('/api/status', { headers: { Accept: 'application/json' } }),
      passwordEnv(),
      ctx
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'not signed in' });
  });
});

describe('login page', () => {
  it('GET /login in password mode: 200, no-store, and a locking-down CSP', async () => {
    const response = await worker.fetch(req('/login'), passwordEnv(), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('password mode: login', () => {
  it('wrong password: 401, page contains the error, no Set-Cookie', async () => {
    const env = passwordEnv();
    const body = new URLSearchParams({ password: 'nope' });
    const response = await worker.fetch(
      req('/login', { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Wrong password');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('right password: 302 to /, Set-Cookie with HttpOnly, Secure, SameSite=Lax', async () => {
    const env = passwordEnv();
    const { response, cookie } = await signIn(env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    const setCookie = cookieHeaderFrom(response);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(cookie).toMatch(/^hq_session=/);
  });

  it('wrangler dev (route host over http, loopback client): cookie without Secure, for the WebKit desktop app', async () => {
    const env = passwordEnv();
    const body = new URLSearchParams({ password: env.HQ_PASSWORD }).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '::1' };
    const local = await worker.fetch(new Request('http://hq.example.com/login', { method: 'POST', body, headers }), env, ctx);
    expect(local.status).toBe(302);
    expect(cookieHeaderFrom(local)).toMatch(/^hq_session=.+HttpOnly; SameSite=Lax/);
    expect(cookieHeaderFrom(local)).not.toContain('Secure');
  });

  it('production (https, real client IP): cookie keeps Secure', async () => {
    const env = passwordEnv();
    const body = new URLSearchParams({ password: env.HQ_PASSWORD }).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '81.82.83.84' };
    const prod = await worker.fetch(new Request('https://hq.example.com/login', { method: 'POST', body, headers }), env, ctx);
    expect(cookieHeaderFrom(prod)).toContain('Secure');
  });

  it('a malformed POST body renders the login page, not a 500', async () => {
    const env = passwordEnv({ STATUS: makeFakeKv() });
    const response = await worker.fetch(
      req('/login', {
        method: 'POST',
        // Declares multipart but the body isn't: formData() must throw, and
        // handleLoginRoutes must turn that into the ordinary 401 page.
        body: 'not actually multipart',
        headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });

  it('an expired cookie is treated as absent', async () => {
    const env = passwordEnv();
    const expiry = Date.now() - 1000;
    const { sha256, hmac } = await forgeHelpers();
    const mac = await hmac(env.HQ_PASSWORD, String(expiry));
    const response = await worker.fetch(
      req('/api/status', {
        headers: { Accept: 'application/json', Cookie: `hq_session=${expiry}.${mac}` },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it('a valid expiry with a forged signature is treated as absent', async () => {
    const env = passwordEnv();
    const expiry = Date.now() + 1000 * 60;
    const response = await worker.fetch(
      req('/api/status', {
        headers: { Accept: 'application/json', Cookie: `hq_session=${expiry}.not-a-real-signature` },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it('a cookie signed under a different password is treated as absent', async () => {
    const env = passwordEnv();
    const expiry = Date.now() + 1000 * 60;
    const { hmac } = await forgeHelpers();
    const mac = await hmac('a different password entirely', String(expiry));
    const response = await worker.fetch(
      req('/api/status', {
        headers: { Accept: 'application/json', Cookie: `hq_session=${expiry}.${mac}` },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it('a cookie with a non-numeric expiry is treated as absent', async () => {
    const env = passwordEnv();
    const response = await worker.fetch(
      req('/api/status', {
        headers: { Accept: 'application/json', Cookie: 'hq_session=not-a-number.somesignature' },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it('a cookie with a negative expiry is treated as absent', async () => {
    const env = passwordEnv();
    const expiry = -1000;
    const { hmac } = await forgeHelpers();
    const mac = await hmac(env.HQ_PASSWORD, String(expiry));
    const response = await worker.fetch(
      req('/api/status', {
        headers: { Accept: 'application/json', Cookie: `hq_session=${expiry}.${mac}` },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
  });

  it('logout clears the cookie with Max-Age=0 and redirects to /login', async () => {
    const env = passwordEnv();
    const response = await worker.fetch(req('/logout'), env, ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
    expect(cookieHeaderFrom(response)).toContain('Max-Age=0');
  });

  it('a valid cookie lets the existing routing run', async () => {
    const env = passwordEnv();
    const { cookie } = await signIn(env);
    const response = await worker.fetch(req('/api/status', { headers: { Cookie: cookie } }), env, ctx);
    expect(response.status).toBe(200);
  });

  it('/api/projects returns a null email in password mode', async () => {
    const env = passwordEnv();
    const { cookie } = await signIn(env);
    const response = await worker.fetch(req('/api/projects', { headers: { Cookie: cookie } }), env, ctx);
    const body = await response.json();
    expect(body.email).toBeNull();
  });
});

describe('Access mode is unaffected', () => {
  it('a resolving mock still serves /', async () => {
    const response = await worker.fetch(
      req('/', { headers: { 'Cf-Access-Jwt-Assertion': 'token' } }),
      accessEnv(),
      ctx
    );
    expect(response.status).toBe(200);
  });

  it('a rejecting mock still returns a bare 403 Forbidden', async () => {
    verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
    const response = await worker.fetch(req('/'), accessEnv(), ctx);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
  });

  it('a valid password cookie grants nothing in Access mode', async () => {
    const env = accessEnv({ HQ_PASSWORD: 'correct horse battery staple' });
    // Mint a cookie the way password mode would, then reject the Access JWT.
    verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
    const expiry = Date.now() + 1000 * 60;
    const mac = await (await forgeHelpers()).hmac(env.HQ_PASSWORD, String(expiry));
    const response = await worker.fetch(
      req('/', { headers: { Cookie: `hq_session=${expiry}.${mac}` } }),
      env,
      ctx
    );
    expect(response.status).toBe(403);
  });

  it('redirects /logout to the Access logout endpoint instead of the password flow', async () => {
    const response = await worker.fetch(req('/logout'), accessEnv(), ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/cdn-cgi/access/logout');
  });
});

describe('password mode: SPA shell routes', () => {
  it.each(['/', '/projects', '/missions', '/leads', '/finance', '/admin'])(
    'serves the app shell for %s with a valid password-mode cookie',
    async (path) => {
      const env = passwordEnv();
      const { cookie } = await signIn(env);
      const response = await worker.fetch(req(path, { headers: { Cookie: cookie } }), env, ctx);
      expect(response.status).toBe(200);
    }
  );
});

describe('login rate limiting', () => {
  function attempt(env, password, ip = '203.0.113.5') {
    const body = new URLSearchParams({ password });
    return worker.fetch(
      req('/login', {
        method: 'POST',
        body: body.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
      }),
      env,
      ctx
    );
  }

  it('locks out after 5 wrong passwords; the 6th is refused before the password is even checked', async () => {
    const env = passwordEnv({ STATUS: makeFakeKv() });
    for (let i = 0; i < 5; i++) {
      const response = await attempt(env, 'nope');
      expect(response.status).toBe(401);
    }
    // The password on this 6th attempt is correct — if it still gets a 429,
    // the lockout is being enforced before constantTimeEqual ever runs.
    const response = await attempt(env, env.HQ_PASSWORD);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('Too many attempts');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('a correct password mid-stream resets the counter', async () => {
    const env = passwordEnv({ STATUS: makeFakeKv() });
    expect((await attempt(env, 'nope')).status).toBe(401);
    expect((await attempt(env, 'nope')).status).toBe(401);
    expect((await attempt(env, env.HQ_PASSWORD)).status).toBe(302); // 3rd attempt: correct, resets to 0

    // Two more wrong guesses after the reset shouldn't be anywhere near the
    // 5-failure limit, so a correct password right after still gets through.
    expect((await attempt(env, 'nope')).status).toBe(401);
    expect((await attempt(env, 'nope')).status).toBe(401);
    expect((await attempt(env, env.HQ_PASSWORD)).status).toBe(302);
  });

  it('a different IP is unaffected by another IP being locked out', async () => {
    const env = passwordEnv({ STATUS: makeFakeKv() });
    for (let i = 0; i < 5; i++) await attempt(env, 'nope', '203.0.113.5');
    expect((await attempt(env, env.HQ_PASSWORD, '203.0.113.5')).status).toBe(429);

    const otherIp = await attempt(env, env.HQ_PASSWORD, '198.51.100.9');
    expect(otherIp.status).toBe(302);
  });

  it('falls open (no throw, no false lockout) when env.STATUS is absent', async () => {
    const env = passwordEnv({ STATUS: undefined });
    const response = await attempt(env, env.HQ_PASSWORD);
    expect(response.status).toBe(302);
  });
});

/** Small standalone helpers mirroring auth.js's signing scheme, used only to
 * forge cookies in tests without importing auth.js's private functions. */
async function forgeHelpers() {
  async function sha256(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  }
  async function hmac(secret, message) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const bytes = new Uint8Array(mac);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return { sha256, hmac };
}

describe('handleLoginRoutes', () => {
  it('returns null for a non-login path', async () => {
    const url = new URL('/api/status', ORIGIN);
    const result = await handleLoginRoutes(req('/api/status'), passwordEnv(), url);
    expect(result).toBeNull();
  });

  it('returns null (falls through to fail-closed 503) when mode is none', async () => {
    const url = new URL('/login', ORIGIN);
    const result = await handleLoginRoutes(req('/login'), noneEnv(), url);
    expect(result).toBeNull();
  });
});

describe('authenticate', () => {
  it('returns ok:false with a 503 response in none mode', async () => {
    const result = await authenticate(req('/'), noneEnv(), { keys: null, fetchedAt: 0 });
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(503);
  });
});
