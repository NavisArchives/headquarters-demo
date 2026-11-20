import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAccessJwt = vi.fn();
vi.mock('../src/shared/access-jwt.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, verifyAccessJwt: (...args) => verifyAccessJwt(...args) };
});

const { default: worker } = await import('../src/worker/index.js');
const { AccessError } = await import('../src/shared/access-jwt.js');

const ctx = { waitUntil: () => {} };

function makeEnv() {
  return {
    ACCESS_TEAM: 'example.cloudflareaccess.com',
    ACCESS_AUD: 'aud-abc123',
    STATUS: {
      get: async () => ({ checkedAt: '2026-09-20T00:00:00Z', projects: {}, leads: null }),
      put: async () => {},
    },
    ASSETS: { fetch: async () => new Response('<h1>HQ</h1>', { headers: { 'Content-Type': 'text/html' } }) },
  };
}

const get = (path, headers = { 'Cf-Access-Jwt-Assertion': 'token' }) =>
  new Request(`https://hq.example.com${path}`, { headers });

beforeEach(() => {
  verifyAccessJwt.mockReset();
  verifyAccessJwt.mockResolvedValue({ email: 'owner@example.com' });
});

describe('worker', () => {
  it('serves the page to a verified request', async () => {
    const response = await worker.fetch(get('/'), makeEnv(), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('HQ');
  });

  it('refuses a request with no Access token', async () => {
    verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
    const response = await worker.fetch(get('/', {}), makeEnv(), ctx);
    expect(response.status).toBe(403);
  });

  it('refuses a request with a forged token', async () => {
    verifyAccessJwt.mockRejectedValue(new AccessError('bad signature', 'signature'));
    const response = await worker.fetch(get('/api/status'), makeEnv(), ctx);
    expect(response.status).toBe(403);
  });

  it('never leaks the reason a token was rejected', async () => {
    verifyAccessJwt.mockRejectedValue(new AccessError('token was issued for a different application', 'aud'));
    const response = await worker.fetch(get('/'), makeEnv(), ctx);
    expect(await response.text()).toBe('Forbidden');
  });

  it('returns the status payload as JSON', async () => {
    const response = await worker.fetch(get('/api/status'), makeEnv(), ctx);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ checkedAt: '2026-09-20T00:00:00Z' });
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('returns the registry and the signed-in email', async () => {
    const response = await worker.fetch(get('/api/projects'), makeEnv(), ctx);
    const body = await response.json();
    expect(body.email).toBe('owner@example.com');
    expect(body.projects.length).toBe(9); // LEADS is part of HQ itself, not a project; HQ is (for its assistant helper)
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('serves the page shell for a project detail route', async () => {
    const response = await worker.fetch(get('/p/realis-studio'), makeEnv(), ctx);
    expect(response.status).toBe(200);
  });

  it.each(['/', '/projects', '/missions', '/leads', '/finance', '/admin', '/ask'])(
    'serves the app shell for the %s route',
    async (path) => {
      const response = await worker.fetch(get(path), makeEnv(), ctx);
      expect(response.status).toBe(200);
    }
  );

  it.each(['/finance/1', '/finance/42'])(
    'serves the app shell for the printed invoice at %s',
    async (path) => {
      const response = await worker.fetch(get(path), makeEnv(), ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('HQ');
    }
  );

  it.each(['/finance/', '/finance/1/', '/finance/new', '/finance/1/edit', '/finance/abc'])(
    'does not treat %s as an invoice route',
    async (path) => {
      const response = await worker.fetch(get(path), makeEnv(), ctx);
      expect(response.status).toBe(302);
    }
  );

  it('404s an unknown project slug', async () => {
    const response = await worker.fetch(get('/p/nope'), makeEnv(), ctx);
    expect(response.status).toBe(404);
  });

  it('redirects an unknown path to the overview', async () => {
    const response = await worker.fetch(get('/whatever'), makeEnv(), ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://hq.example.com/');
  });

  it('never caches an authenticated response', async () => {
    const response = await worker.fetch(get('/api/status'), makeEnv(), ctx);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('passes the team domain and audience from env, never from the request', async () => {
    const env = makeEnv();
    const request = new Request(
      'https://hq.example.com/?ACCESS_TEAM=evil.cloudflareaccess.com&aud=evil',
      {
        headers: {
          'Cf-Access-Jwt-Assertion': 'token',
          ACCESS_TEAM: 'evil.cloudflareaccess.com',
          'X-Access-Team': 'evil.cloudflareaccess.com',
          'Cf-Access-Team': 'evil.cloudflareaccess.com',
        },
      }
    );

    await worker.fetch(request, env, ctx);

    expect(verifyAccessJwt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamDomain: env.ACCESS_TEAM, aud: env.ACCESS_AUD })
    );
    const serializedArgs = JSON.stringify(verifyAccessJwt.mock.calls[0]);
    expect(serializedArgs).not.toContain('evil');
  });

  it.each(['/', '/api/status', '/api/projects', '/api/missions', '/p/realis-studio', '/assets/app.js', '/anything-else'])(
    'refuses %s when Access verification fails',
    async (path) => {
      verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
      const response = await worker.fetch(get(path, {}), makeEnv(), ctx);
      expect(response.status).toBe(403);
    }
  );

  it('the rejection body is identical for every failure reason', async () => {
    const bodies = [];
    for (const code of ['expired', 'aud', 'signature']) {
      verifyAccessJwt.mockRejectedValue(new AccessError(`rejected: ${code}`, code));
      const response = await worker.fetch(get('/', {}), makeEnv(), ctx);
      bodies.push(await response.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  describe('install manifest', () => {
    it('serves the manifest and its icons without any credential', async () => {
      verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
      for (const path of ['/manifest.webmanifest', '/assets/icons/hq-192.png', '/assets/icons/hq-512.png']) {
        const response = await worker.fetch(get(path, {}), makeEnv(), ctx);
        expect(response.status, path).toBe(200);
      }
    });

    it('does not open any other asset or route by the same door', async () => {
      verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
      for (const path of ['/assets/app.js', '/assets/icons/../app.js', '/index.html', '/api/status']) {
        const response = await worker.fetch(get(path, {}), makeEnv(), ctx);
        expect(response.status, path).not.toBe(200);
      }
    });

    it('answers GET and HEAD only', async () => {
      verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
      const response = await worker.fetch(new Request('https://hq.example.com/manifest.webmanifest', { method: 'POST' }), makeEnv(), ctx);
      expect(response.status).not.toBe(200);
    });
  });
});

/* The registry became two layers on 2026-09-22, and the routing had to be
   rewritten for it. These guard the three things that rewrite could break
   and that nothing else would notice: a route hidden behind the wrong path
   guard, a project page 404ing for a project made in HQ, and the whole
   dashboard failing when D1 is absent rather than degrading to the file. */
describe('routing after the registry gained a second layer', () => {
  it('still answers /api/overview, which lives in the projects handler', async () => {
    const response = await worker.fetch(get('/api/overview'), makeEnv(), ctx);
    // 200 with a DB, 500 without one — never 404, which would mean the home
    // screen's first paint had been routed into nothing.
    expect(response.status).not.toBe(404);
  });

  it('serves /api/projects from the committed file when there is no database', async () => {
    const response = await worker.fetch(get('/api/projects'), makeEnv(), ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects.length).toBeGreaterThan(0);
    expect(body.degraded).toBe(true);
  });

  it('refuses a write while the project list cannot be read', async () => {
    const request = new Request('https://hq.example.com/api/projects', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', kind: 'client', description: 'd' }),
    });
    const response = await worker.fetch(request, makeEnv(), ctx);
    expect(response.status).toBe(503);
  });

  it('still 404s a project that is in neither layer', async () => {
    const response = await worker.fetch(get('/p/not-a-project'), makeEnv(), ctx);
    expect(response.status).toBe(404);
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('serves the shell for a project that is in the committed file', async () => {
    const response = await worker.fetch(get('/p/recall'), makeEnv(), ctx);
    expect(response.status).toBe(200);
  });
});

describe('which HQ this is, for the deploy gates', () => {
  it('says demo: false in production, which never sets DEMO', async () => {
    const response = await worker.fetch(get('/api/environment'), makeEnv(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ demo: false });
  });

  it('says demo: true on the throwaway demo HQ', async () => {
    const response = await worker.fetch(get('/api/environment'), { ...makeEnv(), DEMO: 'on' }, ctx);
    expect(await response.json()).toEqual({ demo: true });
  });

  it('answers nobody who is not signed in', async () => {
    verifyAccessJwt.mockRejectedValue(new AccessError('no token', 'missing'));
    const response = await worker.fetch(get('/api/environment', {}), makeEnv(), ctx);
    expect(response.status).toBe(403);
  });
});
