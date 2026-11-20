// `npm run dev` (what the Dock app runs) starts HQ on 8787 exactly as before,
// whatever the assistant helper does (NIRMATA conditions, 19 Nov).
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperPlan, startDev } from '../scripts/dev.mjs';

const ROOT = '/hq';
const KEY = '/home/.config/headquarters/anthropic-key';
const SDK = join(ROOT, 'assistant', 'node_modules', '@anthropic-ai', 'sdk');
const HQ_CALL = ['npx', ['wrangler', 'dev', '--port', '8787']];

function fakeSpawn({ helperThrows = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (helperThrows && args[0]?.endsWith('helper.mjs')) throw new Error('spawn EACCES');
    const child = new EventEmitter(); child.kill = () => {}; return child;
  };
  return { spawn, calls };
}
const run = (present, opts = {}) => {
  const f = fakeSpawn(opts); const logs = [];
  const out = startDev({ root: ROOT, spawn: f.spawn, exists: (p) => present.includes(p), keyFile: KEY, log: (...a) => logs.push(a.join(' ')), env: {} });
  return { ...out, calls: f.calls, logs };
};

describe('the Dock launcher', () => {
  it('decides plainly: no install or no key file means no helper', () => {
    expect(helperPlan({ installed: false, keyPresent: true })).toEqual({ start: false, reason: 'not installed' });
    expect(helperPlan({ installed: true, keyPresent: false })).toEqual({ start: false, reason: 'no key file' });
    expect(helperPlan({ installed: true, keyPresent: true })).toEqual({ start: true, reason: 'ok' });
  });

  it('starts HQ on 8787 exactly the same in every case', () => {
    for (const present of [[], [SDK], [KEY], [SDK, KEY]]) {
      const { calls } = run(present);
      expect([calls[0].cmd, calls[0].args]).toEqual(HQ_CALL);
      expect(calls[0].opts.env.X_LOCAL_OBSERVABILITY).toBe('false');
    }
  });

  it('never starts the helper without the key file, or without its install, and never downloads', () => {
    for (const present of [[], [SDK], [KEY]]) {
      const { calls, helper } = run(present);
      expect(helper).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls.some((c) => c.cmd === 'npm' || c.args.includes('ci') || c.args.includes('install'))).toBe(false);
    }
    const { calls } = run([SDK, KEY]);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0]).toBe(join(ROOT, 'assistant', 'helper.mjs'));
  });

  it('keeps HQ when the helper cannot be spawned or stops', () => {
    const failed = run([SDK, KEY], { helperThrows: true });
    expect(failed.hq).toBeTruthy();
    expect(failed.helper).toBeNull();
    expect(failed.logs.join('\n')).toMatch(/helper did not start/);
    const crashed = run([SDK, KEY]);
    crashed.helper.emit('exit', 1);
    expect(crashed.logs.join('\n')).toMatch(/helper stopped \(1\); HQ keeps running/);
  });

  it('the real helper exits on its own when 8789 (here: a busy port) is taken; nothing else is touched', async () => {
    const busy = createServer(); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const port = busy.address().port;
    const home = mkdtempSync(join(tmpdir(), 'hq-dev-')); mkdirSync(join(home, '.config', 'headquarters'), { recursive: true });
    writeFileSync(join(home, '.config', 'headquarters', 'anthropic-key'), 'sk-ant-fake-not-a-key');
    try {
      const child = realSpawn(process.execPath, ['assistant/helper.mjs'], { env: { ...process.env, HOME: home, HQ_ASSISTANT_PORT: String(port) }, stdio: 'ignore' });
      const code = await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill(); r('timeout'); }, 15000); });
      expect(code).not.toBe('timeout');
      expect(code).not.toBe(0);
    } finally { busy.close(); rmSync(home, { recursive: true, force: true }); }
  }, 20000);
});
