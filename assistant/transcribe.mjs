// Dictation for the HQ assistant (Andy, 20 Nov): the panel records, this turns the sound
// into text ON THIS MAC with whisper.cpp — the same engine as Pasito and the Studio app.
// Nothing leaves the Mac: no network, no key, no model API. French, Dutch and English
// are detected by whisper itself.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

export const TRANSCRIBE_LIMITS = Object.freeze({ bytes: 3_000_000, seconds: 60, timeoutMs: 90_000 });
export const WHISPER = Object.freeze({
  bin: process.env.HQ_WHISPER_BIN || '/opt/homebrew/bin/whisper-cli',
  model: process.env.HQ_WHISPER_MODEL || join(homedir(), 'models', 'whisper', 'ggml-small.bin'),
  ffmpeg: process.env.HQ_FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg',
});

const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 4_000_000 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));
});

/** Whether this Mac can transcribe at all (the two programs and the model are there). */
export function canTranscribe(w = WHISPER) {
  return existsSync(w.bin) && existsSync(w.model) && existsSync(w.ffmpeg);
}

/** Text from whisper's plain output: its own markers (« [BLANK_AUDIO] », « (music) ») out, one line. */
export function cleanTranscript(raw) {
  return String(raw)
    .replace(/\[[^\]]*\]|\((?:music|musique|muziek|applause|silence)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Audio (any format the browser records: webm/opus, mp4/aac, wav) → text. */
export async function transcribeAudio(audio, { w = WHISPER, runner = run } = {}) {
  if (!Buffer.isBuffer(audio) || !audio.length) throw new Error('no sound');
  if (audio.length > TRANSCRIBE_LIMITS.bytes) throw new Error('too long');
  const dir = mkdtempSync(join(tmpdir(), 'hq-dictation-'));
  try {
    const input = join(dir, 'in.audio'); const wav = join(dir, 'in.wav');
    writeFileSync(input, audio, { mode: 0o600 });
    // 16 kHz mono, at most a minute: what whisper expects.
    await runner(w.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', String(TRANSCRIBE_LIMITS.seconds), '-ar', '16000', '-ac', '1', wav], TRANSCRIBE_LIMITS.timeoutMs);
    const out = await runner(w.bin, ['-m', w.model, '-f', wav, '-l', 'auto', '-nt', '-np', '-t', '4'], TRANSCRIBE_LIMITS.timeoutMs);
    return cleanTranscript(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
