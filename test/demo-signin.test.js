import { describe, it, expect } from 'vitest';
import { handleLoginRoutes, demoAutoSignIn } from '../src/worker/auth.js';

// The demo (npm run demo) opens signed in, on this Mac only, with its own throwaway
// password (demo.vars); live HQ never sets DEMO and never signs anyone in this way.
const get = (url) => handleLoginRoutes(new Request(url), { HQ_PASSWORD: 'demo-only-not-a-secret', DEMO: 'on' }, new URL(url));

describe('demo sign-in', () => {
  it('signs in by itself on localhost when DEMO is on', async () => {
    const res = await get('http://localhost:8790/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    expect(res.headers.get('Set-Cookie')).toMatch(/^hq_session=\d+\.[^;]+;/);
  });
  it('never on another host, even with DEMO on', async () => {
    expect(demoAutoSignIn({ DEMO: 'on' }, new URL('https://hq.example.com/login'))).toBe(false);
    const res = await get('https://hq.example.com/login');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
  it('never without DEMO (live HQ), even on localhost', async () => {
    const url = 'http://localhost:8787/login';
    expect(demoAutoSignIn({}, new URL(url))).toBe(false);
    const res = await handleLoginRoutes(new Request(url), { HQ_PASSWORD: 'live' }, new URL(url));
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
  it('the demo config never carries the live password: it loads demo.vars, not .dev.vars', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.demo).toMatch(/--env-file demo\.vars/);
    expect(readFileSync(new URL('../demo.vars', import.meta.url), 'utf8')).toMatch(/^HQ_PASSWORD=demo-only-not-a-secret$/m);
  });
});
