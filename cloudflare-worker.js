/**
 * Timeblock calendar feed worker.
 *
 * Turns a public, unauthenticated Firestore document (written by the Timeblock
 * app at feeds/{token}) into a live .ics feed that Apple Calendar / Google
 * Calendar can "subscribe" to. Holds no secrets: the Firestore security rules
 * are what make feeds/{token} safely public-readable (see firestore.rules in
 * the repo) — this worker is just a public GET -> public GET -> reformat.
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker
 * -> Edit code -> paste this whole file, replacing the template -> Deploy.
 * Then paste the resulting *.workers.dev URL into Timeblock's Calendar feed
 * dialog.
 *
 * URL shape once deployed:  https://<your-worker>.workers.dev/feed/<token>
 */

const PROJECT_ID = 'timeblock-64912';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

    const m = url.pathname.match(/^\/feed\/([a-f0-9]{20,64})$/i);
    if (!m) {
      return withCors(new Response('Timeblock calendar feed.\nSubscribe using /feed/<token> (get your link from the app\'s Calendar feed dialog).', { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
    const token = m[1];

    let doc;
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/feeds/${token}`);
      if (r.status === 404) return withCors(new Response('This calendar feed link is no longer valid.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
      if (!r.ok) return withCors(new Response('Upstream error (' + r.status + ')', { status: 502 }));
      doc = await r.json();
    } catch (e) {
      return withCors(new Response('Could not reach Firestore.', { status: 502 }));
    }

    const data = decodeFirestoreDoc(doc);
    const ics = buildICS(data.days || {});
    return withCors(new Response(ics, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="timeblock.ics"',
        'cache-control': 'public, max-age=300',
      },
    }));
  },
};

function withCors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  return new Response(res.body, { status: res.status, headers: h });
}

// -- Firestore REST returns a verbose typed JSON shape; unwrap it into plain values. --
function decodeFirestoreDoc(doc) {
  return fsValue({ mapValue: { fields: doc.fields || {} } });
}
function fsValue(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; Object.keys(f).forEach(k => { o[k] = fsValue(f[k]); }); return o; }
  return null;
}

// -- Build a minimal, well-formed .ics from the trimmed {dateKey: [block, ...]} shape. --
function pad(n) { return String(n).padStart(2, '0'); }
function icsEsc(t) { return String(t == null ? '' : t).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); }
function fold(line) {
  // RFC 5545 line folding at 75 octets, continuation lines start with a space.
  if (line.length <= 75) return line;
  let out = line.slice(0, 75), rest = line.slice(75);
  while (rest.length) { out += '\r\n ' + rest.slice(0, 74); rest = rest.slice(74); }
  return out;
}
function buildICS(days) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const t = m => { m = Math.min(Math.max(m, 0), 1439); return `${pad(Math.floor(m / 60))}${pad(m % 60)}00`; };
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Timeblock//Feed//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Timeblock'];
  Object.keys(days).sort().forEach(k => {
    const dk = k.replace(/-/g, '');
    (days[k] || []).forEach((b, i) => {
      const start = Math.max(0, Math.min(1439, b.start | 0)), dur = Math.max(1, b.dur | 0), end = start + dur;
      const mark = b.skipped ? '⏭ ' : b.done ? '✓ ' : '';
      L.push(fold('BEGIN:VEVENT'));
      L.push(fold(`UID:${k}-${i}-${(b.title || '').length}@timeblock-feed`));
      L.push(fold(`DTSTAMP:${stamp}`));
      L.push(fold(`DTSTART:${dk}T${t(start)}`));
      L.push(fold(`DTEND:${dk}T${end >= 1440 ? '235900' : t(end)}`));
      L.push(fold(`SUMMARY:${icsEsc(mark + (b.title || 'Untitled'))}`));
      if (b.cat) L.push(fold(`CATEGORIES:${icsEsc(b.cat)}`));
      L.push(fold(`STATUS:${b.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`));
      L.push(fold(`DESCRIPTION:${icsEsc(b.skipped ? 'Skipped in Timeblock' : b.done ? 'Done' : '')}`));
      L.push('END:VEVENT');
    });
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}
