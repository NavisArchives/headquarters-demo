// An explicit weekday 09:00–17:00 calendar; holidays are not assumed.
export function responseDeadline(received, zone = 'America/Lima', hours = 4) {
  let ms = Date.parse(received);
  if (!Number.isFinite(ms)) return null;
  ms = Math.ceil(ms / 60000) * 60000;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let remaining = hours * 60;
  for (let n = 0; remaining > 0 && n < 30 * 1440; n += 1) {
    const p = Object.fromEntries(format.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    if (!['Sat', 'Sun'].includes(p.weekday) && Number(p.hour) >= 9 && Number(p.hour) < 17) remaining -= 1;
    ms += 60000;
  }
  return new Date(ms).toISOString();
}
