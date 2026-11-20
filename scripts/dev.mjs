// `npm run dev`: what the Headquarters Dock app runs. Starts the local HQ on
// 8787 exactly as before and, beside it, the assistant helper on 8789
// (assistant/helper.mjs), which alone reads Andy's key on this Mac.
//
//   - The helper starts only when its dependency is installed AND the key file
//     exists. Nothing is ever downloaded here: the one-time install of the
//     helper's pinned SDK is done by hand, with Andy's yes (NIRMATA, 19 Nov).
//   - Whatever the helper does (missing, crashing, 8789 taken), HQ on 8787
//     starts and runs as before. The helper is a child: it stops when HQ stops.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY_FILE = join(homedir(), '.config', 'headquarters', 'anthropic-key');

/** Whether to start the helper, and why not. Pure, for tests. */
export function helperPlan({ installed, keyPresent }) {
  if (!installed) return { start: false, reason: 'not installed' };
  if (!keyPresent) return { start: false, reason: 'no key file' };
  return { start: true, reason: 'ok' };
}

/** Starts HQ, and the helper when the plan says so. Returns both children. */
export function startDev({ root, spawn = nodeSpawn, exists = existsSync, keyFile = KEY_FILE, log = console.error, env = process.env } = {}) {
  const assistant = join(root, 'assistant');
  const plan = helperPlan({ installed: exists(join(assistant, 'node_modules', '@anthropic-ai', 'sdk')), keyPresent: exists(keyFile) });
  const hq = spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
    cwd: root, stdio: 'inherit', env: { ...env, X_LOCAL_OBSERVABILITY: 'false' },
  });
  let helper = null;
  if (plan.start) {
    try {
      helper = spawn(process.execPath, [join(assistant, 'helper.mjs')], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
      helper.on?.('error', (error) => log('assistant: helper did not start:', error.message));
      helper.on?.('exit', (code) => { if (code) log(`assistant: helper stopped (${code}); HQ keeps running`); });
    } catch (error) {
      log('assistant: helper did not start:', error.message);
      helper = null;
    }
  } else {
    log(`assistant: helper not started (${plan.reason}); HQ starts as usual`);
  }
  return { hq, helper, plan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { hq, helper } = startDev({ root });
  hq.on('exit', (code) => { helper?.kill(); process.exit(code ?? 0); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { hq.kill(signal); helper?.kill(); });
}
