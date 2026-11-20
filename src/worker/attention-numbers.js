// Stable numbers for « needs your attention » items (migration 0041).
// The first time a key (reply:25, follow:<uid>, deal:2 …) shows up it gets the next
// number, and keeps it for good, whatever else is resolved.

const CHUNK = 90; // under D1's 100 bound parameters per statement

/** Adds `number` (« N-14 ») to each item, in place; returns the items. */
export async function numberItems(db, items, at) {
  const keys = [...new Set(items.map((i) => i.key).filter(Boolean))];
  if (!keys.length) return items;
  await db.batch(keys.map((k) => db.prepare('INSERT OR IGNORE INTO attention_numbers (key, created_at) VALUES (?, ?)').bind(k, at)));
  const map = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    const { results } = await db.prepare(`SELECT n, key FROM attention_numbers WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results || []) map.set(r.key, r.n);
  }
  for (const item of items) if (map.has(item.key)) item.number = `N-${map.get(item.key)}`;
  return items;
}
