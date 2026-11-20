// A review session in Quick personalization (Andy, 13 Nov: « I want people to be
// fast to work really, really fast »): talk while you click. The laptop records
// the voice, HQ notes the second each site was opened, and the transcription
// later puts each part of the recording on the card that was open then.
//
// Nothing goes over the network while recording: the audio is saved on this
// computer every few seconds (IndexedDB), so a Wi-Fi drop loses nothing and a
// closed tab can still be recovered. « Finish » downloads one file, which the
// reviewer sends to Andy; scripts/transcribe-review.mjs reads it on his Mac.

const DB_NAME = 'hq-review';
const SAY_KEY = 'hq.cull.sayCodes';
const OPENED_KEY = 'hq.cull.opened';
const SLICE_MS = 5000;

/* ------------------------------------------------------------- pure parts --- */

/** mm:ss, or h:mm:ss past an hour. */
export function clockText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** « B9 » is said « B 9 », letter by letter, so the recording names the card. */
export const spokenCode = (code) => String(code ?? '').toUpperCase().split('').join(' ');

/** The session file: one JSON, the click times and the audio, nothing else about the leads. */
export function sessionFile({ startedAt, endedAt, reviewer = '', events = [], mime, audioBase64 }) {
  return {
    kind: 'hq-review', version: 1, startedAt, endedAt, reviewer,
    events: events.map((e) => ({ code: e.code, uid: e.uid, name: e.name, atMs: e.atMs })),
    audio: { mime, base64: audioBase64 },
  };
}

export function sessionFileName(startedAt, events = []) {
  const d = new Date(startedAt);
  const two = (n) => String(n).padStart(2, '0');
  const codes = events.length ? ` ${events[0].code}-${events.at(-1).code}` : '';
  return `Review ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}h${two(d.getMinutes())}${codes}.json`;
}

/* ------------------------------------------------------------ local store --- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('chunks', { autoIncrement: true });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode);
  const out = fn(t.objectStore(store));
  t.oncomplete = () => resolve(out?.result ?? out);
  t.onerror = () => reject(t.error);
});
const all = (db, store) => new Promise((resolve, reject) => {
  const req = db.transaction(store).objectStore(store).getAll();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const getMeta = (db) => new Promise((resolve) => {
  const req = db.transaction('meta').objectStore('meta').get('session');
  req.onsuccess = () => resolve(req.result ?? null);
  req.onerror = () => resolve(null);
});

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* --------------------------------------------------------------- session --- */

/**
 * One session per page: `opened(lead, code)` is called by « Open site »;
 * `onChange()` repaints the bar. `reviewer` names the person, for the file.
 */
export function createSession({ onChange = () => {}, reviewer = '', toast = () => {} } = {}) {
  const s = {
    recording: false, startedAt: null, firstOpenAt: null, events: [], recorder: null, stream: null, mime: '',
    sayCodes: (() => { try { return localStorage.getItem(SAY_KEY) === '1'; } catch { return false; } })(),
    openedUids: (() => { try { return new Set(JSON.parse(localStorage.getItem(OPENED_KEY) || '[]')); } catch { return new Set(); } })(),
    unfinished: null,
  };

  const saveOpened = () => { try { localStorage.setItem(OPENED_KEY, JSON.stringify([...s.openedUids].slice(-2000))); } catch { /* private window */ } };

  /** The clock: recording time while recording, else time since the first site opened. */
  s.elapsedMs = () => {
    const from = s.recording ? s.startedAt : s.firstOpenAt;
    return from ? Date.now() - from : 0;
  };

  s.setSayCodes = (on) => {
    s.sayCodes = Boolean(on);
    try { localStorage.setItem(SAY_KEY, on ? '1' : '0'); } catch { /* private window */ }
    onChange();
  };

  s.opened = (lead, code) => {
    s.firstOpenAt ??= Date.now();
    s.openedUids.add(lead.uid);
    saveOpened();
    if (s.recording) {
      const event = { code, uid: lead.uid, name: lead.name || lead.business || '', atMs: Date.now() - s.startedAt };
      s.events.push(event);
      openDb().then((db) => tx(db, 'meta', 'readwrite', (st) => st.put({ startedAt: s.startedAt, events: s.events, mime: s.mime, reviewer }, 'session'))).catch(() => {});
    }
    if (s.sayCodes && typeof speechSynthesis !== 'undefined') {
      const u = new SpeechSynthesisUtterance(spokenCode(code));
      u.lang = 'en-US'; u.rate = 1.1;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    }
    onChange();
  };

  s.start = async () => {
    if (s.recording) return;
    if (s.unfinished) { toast('Download the unfinished recording first'); return; }
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('The microphone is blocked: allow it for this page, then press Record again');
      return;
    }
    s.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const db = await openDb();
    await tx(db, 'chunks', 'readwrite', (st) => st.clear());
    s.startedAt = Date.now();
    s.events = [];
    await tx(db, 'meta', 'readwrite', (st) => st.put({ startedAt: s.startedAt, events: [], mime: s.mime, reviewer }, 'session'));
    s.recorder = new MediaRecorder(s.stream, s.mime ? { mimeType: s.mime } : undefined);
    // Every few seconds a slice is saved on this computer: nothing waits for Wi-Fi.
    s.recorder.ondataavailable = (e) => { if (e.data?.size) tx(db, 'chunks', 'readwrite', (st) => st.add(e.data)).catch(() => {}); };
    s.recorder.start(SLICE_MS);
    s.recording = true;
    onChange();
  };

  /** Stops, waits for the last slice, and downloads the session file. */
  s.finish = async () => {
    if (!s.recording) return;
    await new Promise((resolve) => { s.recorder.onstop = resolve; s.recorder.stop(); });
    s.stream.getTracks().forEach((t) => t.stop());
    s.recording = false;
    await new Promise((r) => setTimeout(r, 300)); // the last slice's write
    await s.saveFile(Date.now());
    onChange();
  };

  /** Builds the file from what is stored on this computer, then forgets it. */
  s.saveFile = async (endedAt) => {
    const db = await openDb();
    const stored = await getMeta(db);
    const chunks = await all(db, 'chunks');
    if (!stored || !chunks.length) { toast('Nothing was recorded'); return; }
    // This page's own list of clicks is the complete one; the stored copy is for
    // recovering a recording after a closed tab.
    const meta = stored.startedAt === s.startedAt ? { ...stored, events: [...s.events] } : stored;
    const audio = new Blob(chunks, { type: meta.mime || 'audio/webm' });
    const file = sessionFile({ ...meta, endedAt, audioBase64: await toBase64(audio) });
    download(sessionFileName(meta.startedAt, meta.events), JSON.stringify(file));
    await tx(db, 'chunks', 'readwrite', (st) => st.clear());
    await tx(db, 'meta', 'readwrite', (st) => st.delete('session'));
    s.unfinished = null;
    toast(`Saved: ${meta.events.length} sites, ${clockText(endedAt - meta.startedAt)}. Send the file to Andy.`);
  };

  /** A recording left by a closed tab or a crash: offered for download on the next open. */
  s.checkUnfinished = async () => {
    try {
      const db = await openDb();
      const meta = await getMeta(db);
      const chunks = await all(db, 'chunks');
      s.unfinished = meta && chunks.length ? meta : null;
    } catch { s.unfinished = null; }
    onChange();
  };

  s.clearOpened = () => { s.openedUids.clear(); saveOpened(); s.firstOpenAt = null; onChange(); };
  return s;
}

/** The record control (13 Nov, « slightly overwhelming »): idle it is one
 *  « ● Record » button; while recording, « ■ Finish », the clock and a small
 *  speaker toggle for « Say codes ». The sites-opened count lives in the progress line. */
export function sessionBar(session, { el }) {
  const bar = el('div', 'cull-session');
  const rec = el('button', 'chip-btn cull-rec');
  rec.type = 'button';
  const clock = el('b', 'cull-clock');
  const say = el('button', 'cull-say');
  say.type = 'button';
  const resume = el('button', 'chip-btn cull-recover', 'Download unfinished recording');
  resume.type = 'button';
  resume.addEventListener('click', () => session.saveFile(Date.now()));
  rec.addEventListener('click', () => (session.recording ? session.finish() : session.start()));
  say.addEventListener('click', () => session.setSayCodes(!session.sayCodes));
  bar.append(resume, clock, say, rec);

  const paint = () => {
    rec.textContent = session.recording ? '■ Finish' : '● Record';
    rec.classList.toggle('is-recording', session.recording);
    clock.hidden = !session.recording;
    say.hidden = !session.recording;
    clock.textContent = clockText(session.elapsedMs());
    say.textContent = session.sayCodes ? '🔊' : '🔈';
    say.classList.toggle('is-on', session.sayCodes);
    const sayLabel = session.sayCodes ? 'Say codes: on (says « B 9 » when a site opens)' : 'Say codes: off';
    say.title = sayLabel;
    say.setAttribute('aria-label', sayLabel);
    say.setAttribute('aria-pressed', session.sayCodes ? 'true' : 'false');
    resume.hidden = !session.unfinished;
  };
  bar.paint = paint;
  const tick = setInterval(() => { if (bar.isConnected) clock.textContent = clockText(session.elapsedMs()); else clearInterval(tick); }, 1000);
  paint();
  return bar;
}

/** Puts each piece of the transcript on the card that was open when it was said:
 *  a segment starting at or after a site's opening belongs to it until the next
 *  site opens. What was said before the first site is « before ». */
export function assignSegments(events = [], segments = []) {
  const order = [...events].sort((a, b) => a.atMs - b.atMs);
  const cards = order.map((e) => ({ code: e.code, uid: e.uid, name: e.name, atMs: e.atMs, text: [] }));
  const before = [];
  for (const seg of segments) {
    const start = Number(seg.fromMs ?? 0);
    let owner = null;
    for (const card of cards) if (card.atMs <= start) owner = card;
    const text = String(seg.text ?? '').trim();
    if (text) (owner ? owner.text : before).push(text);
  }
  // Word-level pieces join with spaces; the punctuation whisper attaches stays.
  // The codes said aloud (« B 9 ») are markers for the ear, not notes: they are dropped.
  const codes = new Set(order.map((e) => String(e.code).toUpperCase()));
  const dropCodes = (t) => t.replace(/\b([A-Z])\s?(\d{1,3})\b[.,]?/gi, (m, l, n) => (codes.has(`${l}${n}`.toUpperCase()) ? '' : m));
  const join = (parts) => dropCodes(parts.join(' ')).replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return {
    before: join(before),
    cards: cards.map((c) => ({ ...c, text: join(c.text) })),
  };
}
