const KEY_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;
// How long an unknown kid must wait before it can force a second network
// fetch of the JWKS for its team. Without this, a pre-auth attacker can send
// well-formed RS256 tokens with random kids (no valid signature required —
// the kid lookup happens before signature verification) and drive one or two
// outbound fetches per request, exhausting Worker subrequests and JWKS
// endpoint egress. With the cooldown, an unknown kid is answered from cache
// once the JWKS was checked recently, and only forces a real refetch when
// enough time has passed that a legitimate key rotation could explain it.
const KID_REFETCH_COOLDOWN_MS = 60 * 1000;

export class AccessError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
  }
}

export function createKeyCache() {
  return { keys: null, fetchedAt: 0 };
}

function b64urlToBytes(value) {
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToJson(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

// The key cache is shared across every team domain a caller might verify
// against, so keys are kept per-domain rather than as one flat list — two
// domains must never be able to authenticate each other's tokens.
function getTeamEntry(cache, teamDomain) {
  if (!cache.byTeam) cache.byTeam = Object.create(null);
  let entry = cache.byTeam[teamDomain];
  if (!entry) {
    // `fetchedAt` is when `keys` was last successfully populated (used for
    // the normal TTL). `lastAttemptAt` is when a fetch was last *attempted*,
    // successful or not — it's what gates the kid-miss cooldown, so that an
    // endpoint returning an empty set (never populating `keys`/`fetchedAt`)
    // still can't be used to force unlimited refetches.
    entry = { keys: null, fetchedAt: 0, lastAttemptAt: 0 };
    cache.byTeam[teamDomain] = entry;
  }
  return entry;
}

async function fetchKeys(teamDomain, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  } catch (cause) {
    throw new AccessError(`could not reach the Access key endpoint: ${cause.message}`, 'jwks_unavailable');
  }
  if (!response.ok) {
    throw new AccessError(`Access key endpoint returned ${response.status}`, 'jwks_unavailable');
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new AccessError(`Access key endpoint did not return valid JSON: ${cause.message}`, 'jwks_unavailable');
  }

  return Array.isArray(body?.keys) ? body.keys : [];
}

async function getKeys(teamDomain, cache, fetchImpl, now, forceRefetch = false) {
  const entry = getTeamEntry(cache, teamDomain);
  const isFresh = entry.keys && entry.keys.length > 0 && now - entry.fetchedAt < KEY_TTL_MS;

  if (isFresh && !forceRefetch) return entry.keys;

  if (forceRefetch) {
    // Bound the amplification an unknown kid can cause: only bypass the
    // cache when the cooldown has elapsed since the last fetch *attempt* for
    // this team. This also means a fetch that just ran (e.g. because the
    // cache was cold for this same verification) always counts as "within
    // cooldown", so a single verification call can never cost more than one
    // network fetch even if its kid is never found.
    if (now - entry.lastAttemptAt < KID_REFETCH_COOLDOWN_MS) {
      return entry.keys ?? [];
    }
  }

  entry.lastAttemptAt = now;
  const keys = await fetchKeys(teamDomain, fetchImpl);
  // Never cache an empty key set: a one-second blip on the JWKS endpoint
  // would otherwise pin "no keys" in place for the full TTL and lock every
  // legitimate user out.
  if (keys.length > 0) {
    entry.keys = keys;
    entry.fetchedAt = now;
  }
  return keys;
}

/**
 * Verify a Cloudflare Access JWT.
 * @param {string|null|undefined} token the Cf-Access-Jwt-Assertion header
 * @param {{teamDomain: string, aud: string, now?: number, fetchImpl?: typeof fetch, keyCache: object}} options
 * @returns {Promise<Record<string, unknown>>} the decoded payload
 * @throws {AccessError}
 */
export async function verifyAccessJwt(token, options) {
  const { teamDomain, aud, now = Date.now(), fetchImpl = fetch, keyCache } = options ?? {};

  // Fail closed on a configuration mistake instead of silently authenticating
  // everyone: an absent `aud` here previously made an absent `aud` claim on
  // the token pass by accident (`[undefined].includes(undefined)`).
  if (typeof teamDomain !== 'string' || teamDomain.length === 0) {
    throw new AccessError('teamDomain option must be a non-empty string', 'config');
  }
  if (typeof aud !== 'string' || aud.length === 0) {
    throw new AccessError('aud option must be a non-empty string', 'config');
  }

  if (typeof token !== 'string' || token.length === 0) {
    throw new AccessError('no Access token on the request', 'missing');
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError('token is not a JWT', 'malformed');

  let header;
  let payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    throw new AccessError('token header or payload is not valid JSON', 'malformed');
  }

  if (header.alg !== 'RS256') {
    throw new AccessError(`unsupported signing algorithm ${header.alg}`, 'alg');
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    // Also closes off `keys.find(k => k.kid === header.kid)` matching a JWK
    // that itself has no `kid` via `undefined === undefined`.
    throw new AccessError('token is missing a key id', 'kid');
  }

  let keys = await getKeys(teamDomain, keyCache, fetchImpl, now);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Cloudflare rotates its Access signing keys; an unrecognised kid might
    // just be new. Ask for a refetch that bypasses the TTL — but getKeys only
    // honours it once the KID_REFETCH_COOLDOWN_MS cooldown has elapsed since
    // the last fetch attempt, so an unauthenticated flood of random kids
    // (the kid lookup happens before signature verification, so no valid
    // credentials are needed) can force at most one extra network fetch per
    // cooldown window, not one per request.
    keys = await getKeys(teamDomain, keyCache, fetchImpl, now, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessError('token was signed with an unknown key', 'kid');

  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (cause) {
    throw new AccessError(`token key could not be imported: ${cause.message}`, 'kid');
  }

  let signatureBytes;
  try {
    signatureBytes = b64urlToBytes(parts[2]);
  } catch (cause) {
    throw new AccessError(`token signature is not valid base64url: ${cause.message}`, 'signature');
  }

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signatureBytes,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AccessError('token signature does not verify', 'signature');

  if (payload.aud === undefined || payload.aud === null) {
    throw new AccessError('token has no audience claim', 'aud');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) {
    throw new AccessError('token was issued for a different application', 'aud');
  }
  if (payload.iss !== `https://${teamDomain}`) {
    throw new AccessError('token was issued by a different team', 'iss');
  }

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new AccessError('token has expired', 'expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + CLOCK_SKEW_SEC) {
    throw new AccessError('token is not valid yet', 'nbf');
  }

  return payload;
}
