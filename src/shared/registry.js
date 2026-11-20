// What a project IS to the business. `prospect` is Archivio: a scrape and rebuild
// made to win the work, so it is a potential client, not a tool.
const KINDS = ['business', 'client', 'prospect'];
// Which business a project belongs to. Optional, so every committed entry
// stays valid without being touched, but real enough that the separation the
// owner keeps in his head has a field to live in.
const BRANDS = ['realis', 'andyssarchives'];
const PROBES = ['http', 'local', 'none'];
const STAGES = ['not_started', 'active'];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ABSOLUTE_URL = /^https?:\/\//;
const HTTPS_URL = /^https:\/\//;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A probe reads. It never writes. Two rules enforce that here, so a registry
// edit cannot turn a liveness check into an action:
//   1. only GET and HEAD are spellable;
//   2. no probe URL may point into an /api/ path — those are the endpoints
//      that publish, upload, save, translate or revoke on the other side.
const PROBE_METHODS = ['GET', 'HEAD'];

// The whole link vocabulary. Anything else is a typo, and a typo that renders
// as nothing is exactly the silence this registry exists to prevent.
const LINK_KEYS = ['live', 'admin', 'local', 'tools', 'reference', 'repo'];
const SIMPLE_LINK_KEYS = ['live', 'reference', 'repo'];
const SIMPLE_LINK_FIELDS = ['url', 'label'];
const ADMIN_FIELDS = ['url', 'label', 'how', 'auth', 'local_only', 'note', 'restart'];
const RESTART_FIELDS = ['command', 'note'];
const LOCAL_FIELDS = ['url', 'command', 'service', 'cwd', 'note'];
const LAB_FIELDS = ['label', 'path'];
const TOOL_FIELDS = ['name', 'url', 'command', 'purpose'];
const PROBE_FIELDS = ['probe', 'worker', 'url', 'method', 'expect', 'extra'];
const EXTRA_PROBE_FIELDS = ['id', 'label', 'probe', 'url', 'method', 'expect'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** Port a URL addresses, taking the scheme default when none is written. */
export function urlPort(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** The path a URL addresses, lowercased, or null when it does not parse. */
function urlPath(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True for any path that reaches an API surface: `/api/login`, `/API/login`,
 * or a bare `/api`. Those endpoints act — publish, upload, save, translate,
 * revoke — and a probe must never land on one.
 */
export function touchesApi(url) {
  const path = urlPath(url);
  if (!path) return false;
  return path.includes('/api/') || path === '/api' || path.endsWith('/api');
}

function checkKeys(errors, at, value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${at}.${key} is not a known key (expected: ${allowed.join(', ')})`);
    }
  }
}

function checkUrl(errors, at, value, { https = false, allowInternal = false } = {}) {
  if (typeof value !== 'string' || value === '') {
    errors.push(`${at} must be a URL string`);
    return;
  }
  if (allowInternal && value.startsWith('/') && !value.startsWith('//')) return;
  if (https ? !HTTPS_URL.test(value) : !ABSOLUTE_URL.test(value)) {
    errors.push(`${at} must be an absolute ${https ? 'https' : 'http(s)'} URL${allowInternal ? ' or a path starting with /' : ''}`);
  }
}

/**
 * A probe spec: where to read, how, and which status codes still count as
 * "something answered". Shared by `status` itself and every `status.extra`.
 */
function checkProbeSpec(errors, at, spec, { requireUrl = false } = {}) {
  if (spec.url !== undefined) {
    checkUrl(errors, `${at}.url`, spec.url);
    if (touchesApi(spec.url)) {
      errors.push(`${at}.url must not probe an /api/ path — probes read, endpoints act`);
    }
  } else if (requireUrl) {
    errors.push(`${at}.url is required`);
  }

  if (spec.method !== undefined && !PROBE_METHODS.includes(spec.method)) {
    errors.push(`${at}.method must be one of ${PROBE_METHODS.join(', ')} — a probe never writes`);
  }

  if (spec.expect !== undefined) {
    if (!Array.isArray(spec.expect) || spec.expect.length === 0
        || !spec.expect.every((c) => Number.isInteger(c) && c >= 100 && c <= 599)) {
      errors.push(`${at}.expect must be a non-empty array of HTTP status codes`);
    }
  }
}

function checkLinks(errors, at, project) {
  const links = project.links;
  if (links === undefined) return;
  if (!isObject(links)) {
    errors.push(`${at}.links must be an object`);
    return;
  }
  checkKeys(errors, `${at}.links`, links, LINK_KEYS);

  for (const key of SIMPLE_LINK_KEYS) {
    const value = links[key];
    if (value === undefined) continue;
    const kat = `${at}.links.${key}`;
    if (!isObject(value)) {
      errors.push(`${kat} must be an object with a url`);
      continue;
    }
    checkKeys(errors, kat, value, SIMPLE_LINK_FIELDS);
    checkUrl(errors, `${kat}.url`, value.url, { https: true });
    if (value.label !== undefined && !isText(value.label)) {
      errors.push(`${kat}.label must be a non-empty string`);
    }
  }

  if (links.admin !== undefined) {
    const admins = Array.isArray(links.admin) ? links.admin : [links.admin];
    if (Array.isArray(links.admin) && links.admin.length === 0) {
      errors.push(`${at}.links.admin must not be an empty array`);
    }
    admins.forEach((admin, i) => {
      const aat = Array.isArray(links.admin) ? `${at}.links.admin[${i}]` : `${at}.links.admin`;
      if (!isObject(admin)) {
        errors.push(`${aat} must be an object`);
        return;
      }
      checkKeys(errors, aat, admin, ADMIN_FIELDS);
      checkUrl(errors, `${aat}.url`, admin.url, { allowInternal: true });
      // `how` and `auth` are not decoration. Without them the page can show a
      // door but not say who may open it, which is the question being asked.
      if (!isText(admin.how)) errors.push(`${aat}.how is required — say how it is reached`);
      if (!isText(admin.auth)) errors.push(`${aat}.auth is required — say what guards it`);
      if (admin.local_only !== undefined && typeof admin.local_only !== 'boolean') {
        errors.push(`${aat}.local_only must be a boolean`);
      }
      for (const key of ['label', 'note']) {
        if (admin[key] !== undefined && !isText(admin[key])) {
          errors.push(`${aat}.${key} must be a non-empty string`);
        }
      }
      // What to run when the door is shut. The page shows it only then.
      if (admin.restart !== undefined) {
        if (!isObject(admin.restart)) {
          errors.push(`${aat}.restart must be an object`);
        } else {
          checkKeys(errors, `${aat}.restart`, admin.restart, RESTART_FIELDS);
          if (!isText(admin.restart.command)) {
            errors.push(`${aat}.restart.command is required — say what brings it back`);
          }
          if (admin.restart.note !== undefined && !isText(admin.restart.note)) {
            errors.push(`${aat}.restart.note must be a non-empty string`);
          }
        }
      }
    });
  }

  if (links.local !== undefined) {
    const local = links.local;
    const lat = `${at}.links.local`;
    if (!isObject(local)) {
      errors.push(`${lat} must be an object`);
    } else {
      checkKeys(errors, lat, local, LOCAL_FIELDS);
      checkUrl(errors, `${lat}.url`, local.url);

      // One source of truth per port: either the command lives in
      // local.services and this names it, or there is no services block and
      // the command lives here. Never both.
      const hasService = local.service !== undefined;
      const hasCommand = local.command !== undefined;
      if (hasService && hasCommand) {
        errors.push(`${lat} must carry either service or command, not both — the service already has the command`);
      } else if (!hasService && !hasCommand) {
        errors.push(`${lat} needs a service name or a command — otherwise nobody can start it`);
      }
      if (hasCommand && !isText(local.command)) {
        errors.push(`${lat}.command must be a non-empty string`);
      }
      if (hasService) {
        const services = project.local?.services;
        const service = Array.isArray(services)
          ? services.find((s) => s?.id === local.service)
          : undefined;
        if (!service) {
          errors.push(`${lat}.service "${local.service}" matches no local.services entry`);
        } else if (Number.isInteger(service.port) && urlPort(local.url) !== service.port) {
          errors.push(`${lat}.url port does not match local.services "${local.service}" port ${service.port}`);
        }
      }
      if (local.cwd !== undefined && (typeof local.cwd !== 'string' || !local.cwd.startsWith('/'))) {
        errors.push(`${lat}.cwd must be absolute`);
      }
      if (local.note !== undefined && !isText(local.note)) {
        errors.push(`${lat}.note must be a non-empty string`);
      }
    }
  }

  if (links.tools !== undefined) {
    if (!Array.isArray(links.tools) || links.tools.length === 0) {
      errors.push(`${at}.links.tools must be a non-empty array`);
    } else {
      links.tools.forEach((tool, i) => {
        const tat = `${at}.links.tools[${i}]`;
        if (!isObject(tool)) {
          errors.push(`${tat} must be an object`);
          return;
        }
        checkKeys(errors, tat, tool, TOOL_FIELDS);
        if (!isText(tool.name)) errors.push(`${tat}.name is required`);
        // A tool with no purpose is a name nobody can act on.
        if (!isText(tool.purpose)) errors.push(`${tat}.purpose is required`);
        if (tool.url !== undefined) checkUrl(errors, `${tat}.url`, tool.url, { allowInternal: true });
        if (tool.command !== undefined && !isText(tool.command)) {
          errors.push(`${tat}.command must be a non-empty string`);
        }
      });
    }
  }
}

/**
 * Validate the project registry.
 * @param {unknown} data
 * @returns {string[]} error strings; empty means valid
 */
export function validateRegistry(data) {
  if (!Array.isArray(data)) return ['registry must be an array'];

  const errors = [];
  const seen = new Set();
  const parents = [];
  const ports = new Map(); // port -> "slug/service", across every project

  data.forEach((project, index) => {
    for (const service of Array.isArray(project?.local?.services) ? project.local.services : []) {
      if (!Number.isInteger(service?.port)) continue;
      const owner = `${project.slug}/${service.id}`;
      if (ports.has(service.port)) {
        errors.push(`projects[${index}].local.services "${service.id}" uses port ${service.port}, already ${ports.get(service.port)}'s`);
      } else {
        ports.set(service.port, owner);
      }
    }
  });

  data.forEach((project, index) => {
    const at = `projects[${index}]`;
    const p = project ?? {};

    if (typeof p.slug !== 'string' || !SLUG.test(p.slug)) {
      errors.push(`${at}.slug must be kebab-case`);
    } else if (seen.has(p.slug)) {
      errors.push(`${at}.slug duplicates "${p.slug}"`);
    } else {
      seen.add(p.slug);
    }

    if (!p.name) errors.push(`${at}.name is required`);
    if (!p.description) errors.push(`${at}.description is required`);
    if (!KINDS.includes(p.kind)) {
      errors.push(`${at}.kind must be one of ${KINDS.join(', ')}`);
    }
    if (p.stage !== undefined && !STAGES.includes(p.stage)) {
      errors.push(`${at}.stage must be one of ${STAGES.join(', ')}`);
    }
    if (p.brand !== undefined && !BRANDS.includes(p.brand)) {
      errors.push(`${at}.brand must be one of ${BRANDS.join(', ')}`);
    }
    // A not-started project that lives inside another one says so, by slug,
    // so the page can link there instead of showing four empty rows.
    if (p.parent !== undefined) {
      if (typeof p.parent !== 'string' || !SLUG.test(p.parent)) {
        errors.push(`${at}.parent must be kebab-case`);
      } else if (p.parent === p.slug) {
        errors.push(`${at}.parent cannot be itself`);
      } else {
        parents.push([at, p.parent]);
      }
    }

    const status = isObject(p.status) ? p.status : {};
    const probe = status.probe;
    if (!PROBES.includes(probe)) {
      errors.push(`${at}.status.probe must be one of ${PROBES.join(', ')}`);
    }
    if (isObject(p.status)) {
      checkKeys(errors, `${at}.status`, status, PROBE_FIELDS);
      checkProbeSpec(errors, `${at}.status`, status);
      if (status.extra !== undefined) {
        if (!Array.isArray(status.extra) || status.extra.length === 0) {
          errors.push(`${at}.status.extra must be a non-empty array`);
        } else {
          const ids = new Set();
          status.extra.forEach((extra, i) => {
            const eat = `${at}.status.extra[${i}]`;
            if (!isObject(extra)) {
              errors.push(`${eat} must be an object`);
              return;
            }
            checkKeys(errors, eat, extra, EXTRA_PROBE_FIELDS);
            if (typeof extra.id !== 'string' || !SLUG.test(extra.id)) {
              errors.push(`${eat}.id must be kebab-case`);
            } else if (ids.has(extra.id)) {
              errors.push(`${eat}.id duplicates "${extra.id}"`);
            } else {
              ids.add(extra.id);
            }
            if (!isText(extra.label)) errors.push(`${eat}.label is required`);
            if (extra.probe !== 'http') errors.push(`${eat}.probe must be "http"`);
            checkProbeSpec(errors, eat, extra, { requireUrl: true });
          });
        }
      }
    }
    if (probe === 'http' && !p.links?.live?.url && !status.url) {
      errors.push(`${at} uses probe "http" but has no links.live.url`);
    }
    // With no status.url, links.live.url IS what gets probed, so it carries
    // the probe rule too.
    if (probe === 'http' && !status.url && p.links?.live?.url && touchesApi(p.links.live.url)) {
      errors.push(`${at}.links.live.url is probed, so it must not be an /api/ path`);
    }
    if (probe === 'local' && !p.local) {
      errors.push(`${at} uses probe "local" but has no local block`);
    }

    if (p.local) {
      if (typeof p.local.path !== 'string' || !p.local.path.startsWith('/')) {
        errors.push(`${at}.local.path must be absolute`);
      }
      if (!Array.isArray(p.local.services) || p.local.services.length === 0) {
        errors.push(`${at}.local.services must be a non-empty array`);
      } else {
        const ids = new Set();
        p.local.services.forEach((service, serviceIndex) => {
          const sat = `${at}.local.services[${serviceIndex}]`;
          const s = service ?? {};
          if (typeof s.id !== 'string' || !SLUG.test(s.id)) {
            errors.push(`${sat}.id must be kebab-case`);
          } else if (ids.has(s.id)) {
            errors.push(`${sat}.id duplicates "${s.id}"`);
          } else {
            ids.add(s.id);
          }
          if (!s.label) errors.push(`${sat}.label is required`);
          if (!Array.isArray(s.run) || s.run.length === 0
              || !s.run.every((a) => typeof a === 'string')) {
            errors.push(`${sat}.run must be a non-empty argv array`);
          }
          if (!Number.isInteger(s.port)) errors.push(`${sat}.port must be an integer`);
          // Some services exist on the card but must never be started from
          // HQ: launchd owns them, or a human does. `manual` says so, and the
          // Mac bridge refuses to run them.
          if (s.manual !== undefined && typeof s.manual !== 'boolean') {
            errors.push(`${sat}.manual must be a boolean`);
          }
          // Kept running by the keeper (tools/office), restarted when it stops.
          if (s.keep !== undefined && typeof s.keep !== 'boolean') {
            errors.push(`${sat}.keep must be a boolean`);
          }
          if (s.keep === true && s.manual === true) {
            errors.push(`${sat} cannot be both kept and manual: launchd or a human runs a manual service`);
          }
          // Listens on the Wi-Fi too (started with --host), so HQ shows a phone link.
          if (s.lan !== undefined && typeof s.lan !== 'boolean') {
            errors.push(`${sat}.lan must be a boolean`);
          }
          // Its own folder (a worktree, a tool inside the project), when not the project's.
          if (s.cwd !== undefined && (typeof s.cwd !== 'string' || !s.cwd.startsWith('/'))) {
            errors.push(`${sat}.cwd must be an absolute path`);
          }
          // Lab versions are paths on this same server: /lab/v1/, /lab/v2/.
          if (s.lab !== undefined) {
            if (!Array.isArray(s.lab) || s.lab.length === 0) {
              errors.push(`${sat}.lab must be a non-empty array`);
            } else {
              s.lab.forEach((lab, i) => {
                const labAt = `${sat}.lab[${i}]`;
                if (!isObject(lab)) { errors.push(`${labAt} must be an object`); return; }
                checkKeys(errors, labAt, lab, LAB_FIELDS);
                if (!isText(lab.label)) errors.push(`${labAt}.label must be a non-empty string`);
                if (typeof lab.path !== 'string' || !/^\/[\w./?=&-]*$/.test(lab.path)) {
                  errors.push(`${labAt}.path must be a path on the same server, like /lab/v1/`);
                }
              });
            }
          }
          if (s.env !== undefined) {
            if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) {
              errors.push(`${sat}.env must be an object`);
            } else if (!Object.values(s.env).every((v) => typeof v === 'string')) {
              errors.push(`${sat}.env values must all be strings`);
            }
          }
        });
      }
    }

    if (p.notes !== undefined) {
      if (!Array.isArray(p.notes) || p.notes.length === 0) {
        errors.push(`${at}.notes must be a non-empty array`);
      } else {
        p.notes.forEach((note, i) => {
          const nat = `${at}.notes[${i}]`;
          if (!isObject(note)) {
            errors.push(`${nat} must be an object`);
            return;
          }
          checkKeys(errors, nat, note, ['date', 'text']);
          // Undated state rots silently. A date lets the page say how old it is.
          if (typeof note.date !== 'string' || !DATE.test(note.date)) {
            errors.push(`${nat}.date must be YYYY-MM-DD`);
          }
          if (!isText(note.text)) errors.push(`${nat}.text is required`);
        });
      }
    }

    checkLinks(errors, at, p);
  });

  for (const [at, parent] of parents) {
    if (!seen.has(parent)) errors.push(`${at}.parent "${parent}" is not a project in this registry`);
  }

  return errors;
}

/** Every probe a registry would issue, flattened: `{ slug, id, url, method, expect }`. */
export function probeTargets(registry) {
  const targets = [];
  for (const project of registry ?? []) {
    const status = project?.status ?? {};
    if (status.probe === 'http') {
      const url = status.url ?? project.links?.live?.url;
      if (url) {
        targets.push({
          slug: project.slug, id: 'live', url, method: status.method ?? 'HEAD', expect: status.expect,
        });
      }
    }
    for (const extra of status.extra ?? []) {
      targets.push({
        slug: project.slug, id: extra.id, url: extra.url, method: extra.method ?? 'HEAD', expect: extra.expect,
      });
    }
  }
  return targets;
}

/**
 * Every service HQ could address, flattened: `{ slug, name, port, url, manual }`.
 * The same flattening the Mac bridge does over the same file — this side uses
 * it to refuse an unknown slug/name pair before any request leaves the Worker.
 */
export function localServices(registry) {
  const out = [];
  for (const project of registry ?? []) {
    const services = project?.local?.services;
    if (!Array.isArray(services)) continue;
    const link = project.links?.local ?? {};
    for (const service of services) {
      if (!service?.id || !Number.isInteger(service.port)) continue;
      out.push({
        slug: project.slug,
        name: service.id,
        label: service.label ?? service.id,
        port: service.port,
        url: link.service === service.id && link.url ? link.url : `http://localhost:${service.port}`,
        manual: service.manual === true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The overlay: two layers, one identity key.
 *
 * projects.json is the committed DEFAULTS layer. D1 holds rows the owner
 * made: a complete entry he created (origin 'db'), or a sparse patch over a
 * committed entry he edited (origin 'override'). What the app sees is the
 * merge of the two, computed per request.
 *
 * The load-bearing property, asserted by a test and by scripts/validate.mjs:
 *   mergeRegistry(file, []).registry  deep-equals  file
 * With no rows, nothing about HQ changes. That is what makes this safe to
 * ship two days before a client push, and what makes `DELETE FROM projects`
 * a complete rollback with no code change.
 * ------------------------------------------------------------------ */

// Keys a user may never write, whichever origin. `local` is argv the Mac
// bridge executes; `status.extra`, `status.method` and `status.expect` steer
// what the Worker fetches and how it reads the answer. All four stay
// file-only, so the dangerous dimensions of a registry entry remain behind
// the gated deploy even though the rest no longer is.
export const UNWRITABLE_KEYS = Object.freeze(['local']);
export const UNWRITABLE_STATUS_FIELDS = Object.freeze(['extra', 'method', 'expect']);

// A slug that would collide with a route, an install path or the shell.
export const RESERVED_SLUGS = Object.freeze([
  'new', 'api', 'p', 'assets', 'login', 'logout', 'admin', 'finance',
  'projects', 'missions', 'leads', 'install', 'cdn-cgi', 'favicon',
]);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One level of key-wise merge, used for `links` and `status`. */
function mergeShallow(base, patch) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) { delete out[key]; continue; }
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? { ...out[key], ...value } : value;
  }
  return out;
}

/** The file's word is final on everything a user may not write. */
function restoreFileOnly(entry, fileEntry) {
  for (const key of UNWRITABLE_KEYS) {
    if (fileEntry && key in fileEntry) entry[key] = fileEntry[key];
    else delete entry[key];
  }
  if (isPlainObject(entry.status)) {
    for (const field of UNWRITABLE_STATUS_FIELDS) {
      const fromFile = isPlainObject(fileEntry?.status) ? fileEntry.status[field] : undefined;
      if (fromFile === undefined) delete entry.status[field];
      else entry.status[field] = fromFile;
    }
  }
  return entry;
}

/**
 * The effective registry: the committed file, with the owner's rows merged
 * over it. Pure — no DOM, no D1, no clock — so it tests under plain Node.
 *
 * A row that cannot be used is SKIPPED AND COUNTED, never fatal: a project
 * the owner cannot see is a bug he can be told about, but a registry that
 * refuses to load is a dashboard that will not open.
 *
 * @returns {{ registry: object[], skipped: {slug: string, why: string}[] }}
 */
export function mergeRegistry(file, rows) {
  const base = Array.isArray(file) ? file : [];
  const list = Array.isArray(rows) ? rows : [];
  const skipped = [];

  const overrides = new Map();
  const created = [];
  for (const row of list) {
    if (!row || typeof row.slug !== 'string') { skipped.push({ slug: '?', why: 'no slug' }); continue; }
    let entry;
    try {
      entry = typeof row.entry === 'string' ? JSON.parse(row.entry) : row.entry;
    } catch {
      skipped.push({ slug: row.slug, why: 'its saved JSON could not be read' });
      continue;
    }
    if (!isPlainObject(entry)) { skipped.push({ slug: row.slug, why: 'its saved entry is not an object' }); continue; }
    if (row.origin === 'override') overrides.set(row.slug, { row, entry });
    else if (row.origin === 'db') created.push({ row, entry });
    else skipped.push({ slug: row.slug, why: `unknown origin "${row.origin}"` });
  }

  const registry = base.map((fileEntry) => {
    const found = overrides.get(fileEntry.slug);
    if (!found) return { ...fileEntry, origin: 'file' };
    const { row, entry } = found;
    const merged = { ...fileEntry };
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'slug') continue;
      if (key === 'links' || key === 'status') merged[key] = mergeShallow(fileEntry[key], value);
      else if (value === null) delete merged[key];
      else merged[key] = value;
    }
    restoreFileOnly(merged, fileEntry);
    merged.origin = 'override';
    if (row.archived_at) merged.archived = true;
    if (row.brand && merged.brand === undefined) merged.brand = row.brand;
    return merged;
  });

  // An override whose committed entry has since been renamed or removed has
  // nothing to sit on. Report it rather than resurrecting a half-entry.
  const fileSlugs = new Set(base.map((p) => p.slug));
  for (const [slug] of overrides) {
    if (!fileSlugs.has(slug)) skipped.push({ slug, why: 'it edits a project that is no longer in the repository' });
  }

  created
    .filter(({ row }) => {
      if (!fileSlugs.has(row.slug)) return true;
      skipped.push({ slug: row.slug, why: 'a project with this slug is already in the repository' });
      return false;
    })
    .sort((a, b) => (a.row.position ?? 0) - (b.row.position ?? 0)
      || String(a.row.created_at ?? '').localeCompare(String(b.row.created_at ?? '')))
    .forEach(({ row, entry }) => {
      const made = { ...entry, slug: row.slug, origin: 'db' };
      restoreFileOnly(made, null);
      if (row.archived_at) made.archived = true;
      if (row.brand && made.brand === undefined) made.brand = row.brand;
      registry.push(made);
    });

  return { registry, skipped };
}

/** Everything still being worked on. Archiving takes a project off the
 *  boards and out of the probe list; it never touches its money. */
export function liveOnly(registry) {
  return (registry ?? []).filter((p) => !p.archived);
}

/**
 * Validate ONE candidate entry against the registry it would join, using the
 * same `validateRegistry` the committed file is held to. One rulebook: there
 * is no second, laxer set of rules for things made in the interface.
 *
 * Errors are returned already stripped of their `projects[n].` prefix, so a
 * pop-up can show them as they are.
 */
export function validateEntry(candidate, others) {
  const rest = (others ?? []).filter((p) => p && p.slug !== candidate?.slug);
  const index = rest.length;
  const all = validateRegistry([...rest, candidate]);
  const mine = `projects[${index}].`;
  const out = [];
  for (const error of all) {
    if (error.startsWith(mine)) out.push(error.slice(mine.length));
    else if (error.startsWith(`projects[${index}] `)) out.push(error.slice(`projects[${index}] `.length));
    else if (error.includes(`"${candidate?.slug}"`)) out.push(error.replace(/^projects\[\d+]\./, ''));
  }
  return out;
}

/* ---- where a probe may point ----------------------------------------- *
 * This is the first time a URL the owner typed reaches `fetch`. The probe
 * was already forbidden from writing (GET/HEAD only, never an /api/ path);
 * now it must also be forbidden from reaching somewhere only this machine
 * can see. That matters more locally than at the edge: `wrangler dev` binds
 * the live database and sits on the same network as everything else here.
 * Deny by default: anything not plainly a public https host is refused.
 * ---------------------------------------------------------------------- */
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

function isPrivateAddress(host) {
  if (/^\[?::1]?$/.test(host) || host === '0.0.0.0') return true;
  // Any IPv6 literal: link-local, unique-local and mapped forms are too easy
  // to spell around, so no IPv6 literal is allowed at all.
  if (host.includes(':')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if ([a, b].some((n) => n > 255)) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;   // cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Does this address resolve to somewhere only this machine or this network
 * can see? Narrower than `safeProbeTarget` on purpose: this one is applied to
 * where a probe LANDS after redirects, where an http hop or a path that looks
 * like an API is not by itself a reason to call a site down.
 */
export function isPrivateTarget(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname;
  return Boolean(host) && (PRIVATE_HOST.test(host) || isPrivateAddress(host));
}

/** @returns {string|null} why it is refused, or null when it is allowed. */
export function safeProbeTarget(url) {
  if (typeof url !== 'string' || !url.trim()) return 'a web address is required';
  let parsed;
  try { parsed = new URL(url); } catch { return 'that is not a web address'; }
  if (parsed.protocol !== 'https:') return 'the address must start with https://';
  const host = parsed.hostname;
  if (!host) return 'that address has no host';
  if (PRIVATE_HOST.test(host)) return 'that address points at this machine, not at the internet';
  if (isPrivateAddress(host)) return 'that address points inside a private network';
  if (!host.includes('.')) return 'that host has no domain';
  if (touchesApi(url)) return 'a checked address must not be an /api/ path';
  return null;
}

/** A name becomes a slug the same way everywhere: here. */
export function slugFrom(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}
