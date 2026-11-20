import { describe, it, expect, beforeAll } from 'vitest';
import { verifyAccessJwt, createKeyCache, AccessError } from '../src/shared/access-jwt.js';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-abc123';

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encode = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let keyPair, jwks, otherPair;

beforeAll(async () => {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  keyPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  otherPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = { keys: [{ kid: 'k1', kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' }] };
});

async function makeToken(overrides = {}, signWith) {
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT', ...(overrides.header ?? {}) };
  const payload = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'owner@example.com',
    ...(overrides.payload ?? {}),
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    (signWith ?? keyPair).privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(signature)}`;
}

function fetchJwks() {
  return async () => new Response(JSON.stringify(jwks), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const opts = () => ({ teamDomain: TEAM, aud: AUD, fetchImpl: fetchJwks(), keyCache: createKeyCache() });

async function codeOf(promise) {
  try { await promise; return null; } catch (err) { return err.code; }
}

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns its payload', async () => {
    const payload = await verifyAccessJwt(await makeToken(), opts());
    expect(payload.email).toBe('owner@example.com');
  });

  it('rejects a missing token', async () => {
    expect(await codeOf(verifyAccessJwt(null, opts()))).toBe('missing');
  });

  it('rejects a malformed token', async () => {
    expect(await codeOf(verifyAccessJwt('not.a.jwt', opts()))).toBe('malformed');
  });

  it('rejects an unexpected algorithm', async () => {
    const token = await makeToken({ header: { alg: 'none' } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('alg');
  });

  it('rejects an unknown key id', async () => {
    const token = await makeToken({ header: { kid: 'nope' } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('kid');
  });

  it('rejects a token signed by a different key', async () => {
    const token = await makeToken({}, otherPair);
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('signature');
  });

  it('rejects a token for a different application', async () => {
    const token = await makeToken({ payload: { aud: ['someone-elses-app'] } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('aud');
  });

  it('rejects a token from a different team', async () => {
    const token = await makeToken({ payload: { iss: 'https://evil.cloudflareaccess.com' } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('iss');
  });

  it('rejects an expired token', async () => {
    const token = await makeToken({ payload: { exp: Math.floor(Date.now() / 1000) - 10 } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('expired');
  });

  it('reuses cached keys instead of refetching', async () => {
    let calls = 0;
    const counting = async () => { calls++; return new Response(JSON.stringify(jwks)); };
    const shared = { teamDomain: TEAM, aud: AUD, fetchImpl: counting, keyCache: createKeyCache() };
    await verifyAccessJwt(await makeToken(), shared);
    await verifyAccessJwt(await makeToken(), shared);
    expect(calls).toBe(1);
  });

  it('surfaces a JWKS outage as its own error code', async () => {
    const failing = { teamDomain: TEAM, aud: AUD, keyCache: createKeyCache(),
      fetchImpl: async () => new Response('nope', { status: 500 }) };
    expect(await codeOf(verifyAccessJwt(await makeToken(), failing))).toBe('jwks_unavailable');
  });

  it('rejects a token with only two segments', async () => {
    expect(await codeOf(verifyAccessJwt('abc.def', opts()))).toBe('malformed');
  });

  it('rejects a token whose signature segment is not valid base64url, as AccessError', async () => {
    const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
    const payload = {
      aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const token = `${signingInput}.@@@@`;

    let error;
    try {
      await verifyAccessJwt(token, opts());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AccessError);
    expect(error.code).toBe('signature');
  });

  it('rejects alg:HS256 with an HMAC signature over the public key (algorithm confusion)', async () => {
    const header = { alg: 'HS256', kid: 'k1', typ: 'JWT' };
    const payload = {
      aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    // An attacker who knows the RSA public key (it's public) tries to use it
    // as an HMAC secret, hoping a naive verifier treats `alg` as trusted input.
    const secretBytes = new TextEncoder().encode(jwks.keys[0].n);
    const hmacKey = await crypto.subtle.importKey(
      'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signingInput));
    const token = `${signingInput}.${b64url(mac)}`;
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('alg');
  });

  it('rejects alg:none with an empty signature segment', async () => {
    const header = { alg: 'none', typ: 'JWT' };
    const payload = {
      aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = `${encode(header)}.${encode(payload)}.`;
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('alg');
  });

  it('accepts an aud claim given as a bare string rather than an array', async () => {
    const token = await makeToken({ payload: { aud: AUD } });
    const payload = await verifyAccessJwt(token, opts());
    expect(payload.aud).toBe(AUD);
  });

  it('rejects a token with no aud claim even when the aud option is also undefined', async () => {
    const token = await makeToken({ payload: { aud: undefined } });
    const brokenOpts = { teamDomain: TEAM, aud: undefined, fetchImpl: fetchJwks(), keyCache: createKeyCache() };
    expect(await codeOf(verifyAccessJwt(token, brokenOpts))).not.toBeNull();
  });

  it('rejects a token with no aud claim with code "aud" when the aud option is present and valid', async () => {
    // Distinct from the test above: here `aud` is a valid, non-empty option,
    // so this must fail past the config guard and be caught by the
    // aud-claim-absence check itself, not by the option validation.
    const token = await makeToken({ payload: { aud: undefined } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('aud');
  });

  it('rejects a token with no exp claim', async () => {
    const token = await makeToken({ payload: { exp: undefined } });
    expect(await codeOf(verifyAccessJwt(token, opts()))).toBe('expired');
  });

  it('rejects a JWKS response that is 200 but not JSON', async () => {
    const badBody = { teamDomain: TEAM, aud: AUD, keyCache: createKeyCache(),
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }) };
    expect(await codeOf(verifyAccessJwt(await makeToken(), badBody))).toBe('jwks_unavailable');
  });

  async function makeRotatedKeySetup() {
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
    const rotatedPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const rotatedJwk = await crypto.subtle.exportKey('jwk', rotatedPair.publicKey);

    let currentJwks = jwks; // starts out with only kid "k1"
    let calls = 0;
    const keyCache = createKeyCache();
    const rotatingFetch = async () => { calls++; return new Response(JSON.stringify(currentJwks)); };
    const t0 = 1_000_000_000_000; // arbitrary fixed instant, injected rather than wall-clock
    const sharedOpts = (now) => ({ teamDomain: TEAM, aud: AUD, fetchImpl: rotatingFetch, keyCache, now });

    // Prime the cache with the original key at t0.
    await verifyAccessJwt(await makeToken(), sharedOpts(t0));
    expect(calls).toBe(1);

    // Rotate: the endpoint now also serves a new key under kid "k2", but the
    // cache still only knows about "k1" until a kid miss forces a refetch.
    currentJwks = {
      keys: [...jwks.keys, { kid: 'k2', kty: rotatedJwk.kty, n: rotatedJwk.n, e: rotatedJwk.e, alg: 'RS256', use: 'sig' }],
    };
    const rotatedToken = await makeToken({ header: { kid: 'k2' } }, rotatedPair);

    return { t0, rotatedToken, sharedOpts, getCalls: () => calls };
  }

  it('rejects a rotated-key token inside the cooldown window, with code "kid", and does not refetch', async () => {
    const { t0, rotatedToken, sharedOpts, getCalls } = await makeRotatedKeySetup();

    // Still inside the 60s cooldown: the kid miss must fail closed from
    // cache, not trigger a second fetch — recovery is bounded, deliberately.
    const stillCoolingDown = t0 + 30_000;
    expect(await codeOf(verifyAccessJwt(rotatedToken, sharedOpts(stillCoolingDown)))).toBe('kid');
    expect(getCalls()).toBe(1);
  });

  it('refetches once the cooldown has elapsed and accepts a token signed with the rotated key', async () => {
    const { t0, rotatedToken, sharedOpts, getCalls } = await makeRotatedKeySetup();

    // Past the 60s cooldown: the kid miss may now force a real refetch, and
    // the newly rotated key must verify.
    const afterCooldown = t0 + 61_000;
    const payload = await verifyAccessJwt(rotatedToken, sharedOpts(afterCooldown));
    expect(payload.email).toBe('owner@example.com');
    expect(getCalls()).toBe(2);
  });

  it('bounds unauthenticated kid-miss amplification: many unknown kids within the cooldown cause at most one JWKS fetch', async () => {
    // No valid credentials are needed for this attack — the kid lookup
    // happens before signature verification, so any well-formed RS256 token
    // with a random kid drives a lookup. Without the cooldown this would be
    // one or two outbound fetches per request; with it, at most one total.
    let calls = 0;
    const counting = async () => { calls++; return new Response(JSON.stringify(jwks)); };
    const keyCache = createKeyCache();
    const t0 = 2_000_000_000_000;

    for (let i = 0; i < 25; i++) {
      const header = { alg: 'RS256', kid: `unknown-${i}`, typ: 'JWT' };
      const payload = { aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600 };
      const token = `${encode(header)}.${encode(payload)}.AAAA`;
      const code = await codeOf(verifyAccessJwt(token, {
        teamDomain: TEAM, aud: AUD, fetchImpl: counting, keyCache, now: t0 + i,
      }));
      expect(code).toBe('kid');
    }

    expect(calls).toBeLessThanOrEqual(1);
  });

  it('costs exactly one fetch, not two, when a cold cache also misses on an unknown kid', async () => {
    let calls = 0;
    const counting = async () => { calls++; return new Response(JSON.stringify(jwks)); };
    const keyCache = createKeyCache();
    const header = { alg: 'RS256', kid: 'totally-unknown', typ: 'JWT' };
    const payload = { aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${encode(header)}.${encode(payload)}.AAAA`;

    expect(await codeOf(verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchImpl: counting, keyCache }))).toBe('kid');
    expect(calls).toBe(1);
  });
});
