#!/usr/bin/env node
// Turns a review session file (Quick personalization, « ● Record ») into notes per
// card, on this Mac: ffmpeg + whisper-cpp, no internet, no paid service.
//
//   node scripts/transcribe-review.mjs "<Review 2026-11-13 15h20 B1-B40.json>" [--lang fr|en|nl|auto]
//
// Writes « … notes.md » and « … notes.json »: each card's code, name and what was
// said while its site was open. Then the session file and both notes move to
// their Drive home, *OFFICE/REALIS-STUDIO/03_SALES/review-sessions/<date>/ in the
// Drive app's folder (copied, compared byte for byte, then the local copy goes to
// the Trash), so recordings never pile up on the Mac. --keep leaves them where they are.
//
// Model: whisper « small » multilingual (French, Dutch, English), from ~/models/whisper
// or ~/.cache/whisper, else « base » with a warning.
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assignSegments } from '../src/public/assets/cull-session.js';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/transcribe-review.mjs <session file> [--lang auto]'); process.exit(1); }
const lang = rest.includes('--lang') ? rest[rest.indexOf('--lang') + 1] : 'auto';
const keep = rest.includes('--keep');
const DRIVE = process.env.REVIEW_DRIVE
  || join(homedir(), 'Library/CloudStorage/GoogleDrive-owner@example.com/My Drive/*OFFICE/REALIS-STUDIO/03_SALES/review-sessions');
const uniqueTrashPath = (name) => {
  const trash = join(homedir(), '.Trash');
  let p = join(trash, name);
  for (let n = 2; existsSync(p); n += 1) p = join(trash, name.replace(/(\.[^.]+)?$/, ` ${n}$1`));
  return p;
};
const session = JSON.parse(readFileSync(file, 'utf8'));
if (session.kind !== 'hq-review') { console.error('not a review session file'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'hq-review-'));
const ext = /mp4/.test(session.audio.mime) ? 'm4a' : 'webm';
writeFileSync(join(dir, `audio.${ext}`), Buffer.from(session.audio.base64, 'base64'));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr.slice(-800)}`); process.exit(1); }
};
run('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, `audio.${ext}`), '-ar', '16000', '-ac', '1', join(dir, 'audio.wav')]);
const models = join(homedir(), '.cache', 'whisper');
const model = [join(homedir(), 'models', 'whisper', 'ggml-small.bin'), join(models, 'ggml-small.bin'), join(models, 'ggml-base.bin')]
  .find((m) => existsSync(m));
if (!model) { console.error('no whisper model in ~/.cache/whisper'); process.exit(1); }
if (!model.endsWith('ggml-small.bin')) console.warn('note: using whisper « base »; « small » is better for French and Dutch');
const t0 = Date.now();
// Word by word (-ml 1 -sow): a sentence started just before a click is split at the click.
run('whisper-cli', ['-m', model, '-l', lang, '-ml', '1', '-sow', '-oj', '-of', join(dir, 'out'), '-f', join(dir, 'audio.wav')]);

const raw = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
const segments = (raw.transcription ?? []).map((s) => ({ fromMs: s.offsets?.from ?? 0, toMs: s.offsets?.to ?? 0, text: s.text }));
const { before, cards } = assignSegments(session.events, segments);

const base = file.replace(/\.json$/i, '');
const md = [
  `# ${base.split('/').pop()}`,
  `${session.events.length} sites · reviewer ${session.reviewer || '—'}`,
  '',
  ...(before ? [`Before the first site: ${before}`, ''] : []),
  ...cards.map((c) => `- **${c.code}** ${c.name}: ${c.text || '(nothing said)'}`),
].join('\n');
writeFileSync(`${base} notes.md`, `${md}\n`);
writeFileSync(`${base} notes.json`, JSON.stringify({ before, cards }, null, 2));
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`${cards.length} cards, ${cards.filter((c) => c.text).length} with notes · transcribed in ${secs}s with ${model.split('/').pop()}`);
console.log(md);

// Home on Drive, never left in Downloads (Andy, 12 Nov: « Should be in the drive »).
// Through the Drive app's folder, not rclone: rclone's gdrive: can't see the real
// *OFFICE and would make a second one (12 Nov). Copy, compare byte for byte, then
// the local copy goes to the Trash.
if (!keep) {
  const day = new Date(session.startedAt || Date.now());
  const two = (n) => String(n).padStart(2, '0');
  const home = join(DRIVE, `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`);
  if (!existsSync(dirname(DRIVE))) {
    console.error(`the Drive app folder is not there (${DRIVE}); files kept here`);
  } else {
    mkdirSync(home, { recursive: true });
    for (const local of [file, `${base} notes.md`, `${base} notes.json`]) {
      const target = join(home, basename(local));
      copyFileSync(local, target);
      if (Buffer.compare(readFileSync(local), readFileSync(target)) !== 0) {
        console.error(`copy differs, kept here: ${local}`);
        continue;
      }
      renameSync(local, uniqueTrashPath(basename(local)));
      console.log(`on Drive: ${target}`);
    }
  }
}
