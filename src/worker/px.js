// The one unauthenticated route in HQ: a recipient's mail client fetches this
// with no cookie and no Access header, so it must run before authenticate()
// in index.js. Reads nothing but the token, records nothing but a
// timestamp, returns nothing but the GIF.

const PATH = /^\/px\/([^/]+)\.gif$/;

// A minimal, valid 1x1 GIF89a. Every response — known token, unknown token,
// or no OPENS binding — is these exact bytes and headers, so a prober can
// never tell a valid token from an invalid one.
const GIF = Uint8Array.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 76, 0, 59,
]);
const GIF_HEADERS = { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private' };

/** Handle `GET /px/<token>.gif`. Returns null for every other path, so the
 *  Worker can carry on matching. */
export async function handlePixel(request, env, url) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const kv = env.OPENS;
  if (kv) {
    try {
      const record = await kv.get(`token:${match[1]}`, 'json');
      if (record?.uid) {
        const key = `opens:${record.uid}`;
        const hits = (await kv.get(key, 'json')) ?? [];
        const now = new Date().toISOString();
        const nowMs = Date.parse(now);

        // Only record if more than 5 seconds since the last hit
        const lastMs = hits.length > 0 ? Date.parse(hits[hits.length - 1]) : 0;
        if (nowMs - lastMs >= 5000) {
          hits.push(now);
        }

        // Keep only the 200 most recent hits
        if (hits.length > 200) {
          hits.splice(0, hits.length - 200);
        }

        await kv.put(key, JSON.stringify(hits));
      }
    } catch (error) {
      console.error('pixel:', error);
    }
  }

  return new Response(GIF, { headers: GIF_HEADERS });
}
