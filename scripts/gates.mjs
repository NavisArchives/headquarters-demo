// The two browser gates, against the demo HQ and nothing else: starts
// `npm run demo` (port 8790, fictional data, a local throwaway database) when
// it is not already up, runs the overlap check, the visual sweep, the phone frame check and axe, and stops
// only what it started. Each gate also refuses to run unless the server says
// it is the demo (see gate-target.mjs). Dev-time only.
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function up() {
  try { return (await fetch(`${DEMO_BASE}/login`)).status < 500; } catch { return false; }
}

let demo = null;
if (!(await up())) {
  console.log('gates: starting the demo HQ (npm run demo) …');
  demo = spawn('npm', ['run', 'demo'], { cwd: root, detached: true, stdio: 'ignore' });
  for (let i = 0; i < 180 && !(await up()); i += 1) await sleep(1000);
}

const stop = () => { if (demo) { try { process.kill(-demo.pid, 'SIGTERM'); } catch { /* already gone */ } } };
const run = (script) => new Promise((done) => {
  spawn('node', [script], { cwd: root, stdio: 'inherit' }).on('exit', (code) => done(code ?? 1));
});

let code = 1;
try {
  if (!(await up())) throw new Error(`the demo HQ did not come up on ${DEMO_BASE}`);
  code = await run('scripts/overlap-check.mjs');
  if (code === 0) code = await run('scripts/visual-sweep.mjs');
  if (code === 0) code = await run('scripts/phone-frame-check.mjs');
  if (code === 0) code = await run('scripts/axe-check.mjs');
} catch (error) {
  console.error(`gates: ${error.message}`);
} finally {
  stop();
}
process.exit(code);
