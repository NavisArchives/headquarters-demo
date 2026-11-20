/* Who this Headquarters belongs to. Production sets nothing and gets the
   values below; the throwaway used for portfolio screenshots
   (wrangler.demo.jsonc) sets every one of them, so no real name, domain,
   brand or project ever appears in a public image. */

export const DEFAULT_IDENTITY = Object.freeze({
  domain: 'hq.example.com',
  owner: 'Andy',
  brandWeb: 'Realis Studio',
  brandUgc: 'andyssarchives',
});

/** The identity for this environment: the defaults, with any var that is set. */
export function identityFrom(env = {}) {
  const pick = (key, fallback) => {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    return value || fallback;
  };
  return {
    domain: pick('HQ_DOMAIN', DEFAULT_IDENTITY.domain),
    owner: pick('HQ_OWNER', DEFAULT_IDENTITY.owner),
    brandWeb: pick('HQ_BRAND_WEB', DEFAULT_IDENTITY.brandWeb),
    brandUgc: pick('HQ_BRAND_UGC', DEFAULT_IDENTITY.brandUgc),
  };
}

/** A status reading for a registry nobody should probe: everything answering,
 *  checked just now. Only ever used when DEMO is on. */
export function demoStatus(registry, now = Date.now()) {
  const projects = Object.fromEntries(registry.map((project) => {
    const probe = project.status?.probe;
    if (probe === 'local') return [project.slug, { kind: 'unknown', label: 'Local only' }];
    if (probe === 'none') return [project.slug, { kind: 'none', label: 'Not set up' }];
    const state = { kind: 'up', label: 'Live', detail: '200 in 96 ms' };
    const extra = (project.status?.extra ?? []).map((e) => ({
      id: e.id, name: e.label, kind: 'up', label: `${e.label} online`,
    }));
    return [project.slug, extra.length ? { ...state, extra } : state];
  }));
  return { checkedAt: new Date(now).toISOString(), projects, leads: null };
}
