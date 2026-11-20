// The assistant's spending counter: what the key has cost today and this month.
// Andy, 20 Nov: the key must never pass $100. NIRMATA's review (H2–H4) asked that it
// fail CLOSED, never lose a write, and hold under two callers at once:
//   - two copies, in two folders; the higher month total wins;
//   - every write goes to a temp file, then a rename (a crash never leaves half a file);
//   - a copy that exists but cannot be read or parsed stops the assistant (CounterError);
//   - a write that fails stops the assistant (CounterError);
//   - read + check + change + write happen under one exclusive lock file.
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, renameSync, unlinkSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export class CounterError extends Error {
  constructor(message) { super(message); this.name = 'CounterError'; }
}

export const COUNTER_FILES = Object.freeze([
  join(homedir(), '.config', 'headquarters', 'assistant-usage.json'),
  join(homedir(), 'Library', 'Application Support', 'Headquarters', 'assistant-usage.json'),
]);
export const LOCK_FILE = join(homedir(), '.config', 'headquarters', 'assistant-usage.lock');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readOne(file) {
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new CounterError(`cannot read ${file}`); }
  let u;
  try { u = JSON.parse(text); } catch { throw new CounterError(`cannot parse ${file}`); }
  if (!u || typeof u !== 'object' || Array.isArray(u)) throw new CounterError(`not a counter: ${file}`);
  for (const k of ['count', 'cost', 'month_cost']) {
    if (u[k] !== undefined && !(typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0)) throw new CounterError(`bad ${k} in ${file}`);
  }
  return u;
}

/** Both copies merged: the later month, and within it the higher total (same for the day). */
export function merge(copies) {
  const all = copies.filter(Boolean);
  if (!all.length) return { day: '', count: 0, cost: 0, month: '', month_cost: 0 };
  const month = all.map((u) => u.month || '').sort().at(-1);
  const day = all.map((u) => u.day || '').sort().at(-1);
  const sameMonth = all.filter((u) => (u.month || '') === month);
  const sameDay = all.filter((u) => (u.day || '') === day);
  return {
    day, month,
    count: Math.max(0, ...sameDay.map((u) => u.count || 0)),
    cost: Math.max(0, ...sameDay.map((u) => u.cost || 0)),
    month_cost: Math.max(0, ...sameMonth.map((u) => u.month_cost || 0)),
  };
}

function writeOne(file, u) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(u)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to tidy */ }
    throw new CounterError(`cannot write ${file}`);
  }
}

/** The file store. `transact(fn)` runs fn on the merged counter under the lock and writes
 *  both copies before releasing it; fn's return value is returned. Any failure throws CounterError. */
export function fileStore({ files = COUNTER_FILES, lock = LOCK_FILE, waitMs = 5_000, staleMs = 15_000 } = {}) {
  function acquire() {
    const until = Date.now() + waitMs;
    try { mkdirSync(dirname(lock), { recursive: true, mode: 0o700 }); } catch { /* the open below says why */ }
    for (;;) {
      try { const fd = openSync(lock, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd); return; } catch (e) {
        if (e.code !== 'EEXIST') throw new CounterError('cannot take the counter lock');
      }
      // A lock left by a process that died mid-write is older than any real hold.
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new CounterError('the counter is busy');
      sleep(10);
    }
  }
  const release = () => { try { unlinkSync(lock); } catch { /* already gone */ } };
  return {
    transact(fn) {
      acquire();
      try {
        const u = merge(files.map(readOne));
        const result = fn(u);
        for (const f of files) writeOne(f, u);
        return result;
      } finally { release(); }
    },
    read() { return merge(files.map(readOne)); },
  };
}

/** In memory (tests): the same contract, one object. */
export function memoryStore(usage, save = () => {}) {
  return { transact(fn) { const r = fn(usage); save(usage); return r; }, read: () => usage };
}
