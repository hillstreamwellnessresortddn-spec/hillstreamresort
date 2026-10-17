/* Hill Stream — the server.
 *
 * Static files, and the API the property actually runs on. Start it with:
 *
 *   node server.js [port]        default 8080, on 127.0.0.1
 *
 * WHAT CHANGED, AND WHY IT MATTERS. Until now every rule lived in the
 * browser, which meant every rule was advisory: the signing key was in a file
 * anyone could read, the password digest with it, and a console could call
 * straight past any guard. The fix was never a better guard — it was moving
 * the guard somewhere the caller does not control.
 *
 *   - the JWT signing key and the authorisation code are generated on first
 *     run and stored in the database. They are never served to a browser.
 *   - the session cookie is HttpOnly and SameSite=Lax, so page script cannot
 *     read it, and the session id is recorded server-side so it can be
 *     revoked — which a stateless token cannot be.
 *   - every write arrives here, is re-checked here against the session, and
 *     is applied here. The browser's copy of a rule is now only there to grey
 *     out a button.
 *
 * HOW IT REUSES THE DOMAIN. rates.js, content.js, bookings.js, guests.js and
 * profiles.js are loaded below into a small sandbox whose localStorage is the
 * SQLite table in db.js and whose HSAuth answers for the current request. The
 * rules they already contained — inventory cannot be oversold, a submission
 * lands pending, a visitor's price is recomputed — therefore run here, on the
 * real record, unchanged. One statement of each rule, enforced where it
 * counts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;
const HOME = '/index.html';

/* ---- Secrets, made once and kept out of every served file --------------- */
const SECRET = store.secret('jwt', () => crypto.randomBytes(32).toString('hex'));
const RESET_SALT = store.secret('reset_salt', () => crypto.randomBytes(16).toString('hex'));
const RESET_HASH = store.secret('reset_hash', () =>
  crypto.pbkdf2Sync(process.env.HS_RESET_CODE || '9917492603',
    Buffer.from(RESET_SALT, 'hex'), 310000, 32, 'sha256').toString('hex'));

const ITERATIONS = 310000;
const TTL_IDLE = 30 * 60 * 1000;
const TTL_ABS = 8 * 60 * 60 * 1000;
const FREE_TRIES = 4;
const LOCK_BASE = 15 * 1000;
const LOCK_MAX = 15 * 60 * 1000;
const STAFF = ['owner', 'manager', 'desk'];

/* First run seeds the account from the credential the prototype shipped with,
   so nothing changes for whoever is already using it. Both can be overridden
   by environment, and the password can be changed from Settings after. */
if (!store.q.anyAccount.get()) {
  const email = (process.env.HS_EMAIL || 'hillstreamwellnessresortddn@gmail.com').toLowerCase();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(process.env.HS_PASSWORD || 'Hillstream123#',
    Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256').toString('hex');
  store.q.addAccount.run(email, 'Hill Stream', 'owner', 'Owner', salt, hash, ITERATIONS, null);
  console.log('Seeded the operator account: ' + email);
}

/* ---- Tokens ------------------------------------------------------------- */
const b64 = b => Buffer.from(b).toString('base64url');

function sign(claims) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const mac = crypto.createHmac('sha256', Buffer.from(SECRET, 'hex'))
    .update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + mac;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const want = crypto.createHmac('sha256', Buffer.from(SECRET, 'hex'))
    .update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let head, claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch (e) { return null; }
  if (!head || head.alg !== 'HS256' || head.typ !== 'JWT') return null;
  if (!claims || claims.iss !== 'hillstream' || !claims.sid) return null;
  return claims;
}

/* ---- Backoff, recorded in the database ---------------------------------- */
function lockedFor(subject) {
  const row = store.q.attempt.get(subject);
  return row ? Math.max(0, row.until - Date.now()) : 0;
}

function noteFail(subject) {
  const row = store.q.attempt.get(subject) || { count: 0 };
  const count = row.count + 1;
  const until = count > FREE_TRIES
    ? Date.now() + Math.min(LOCK_MAX, LOCK_BASE * Math.pow(2, count - FREE_TRIES - 1))
    : 0;
  store.q.noteAttempt.run(subject, count, until);
  return count;
}

const pbkdf2 = (pw, saltHex, iterations) =>
  crypto.pbkdf2Sync(String(pw), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');

const sameHex = (a, b) => {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---- The domain, running here ------------------------------------------
   One sandbox, shared across requests: these modules keep no per-request
   state, and every handler below is synchronous, so the session installed
   before a call is still the session in force during it. */
const docs = store.documentStore();
const listeners = {};
const sandbox = {
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
  dispatchEvent(e) { (listeners[e.type] || []).forEach(f => f(e)); return true; }
};

/* What the modules' guards ask. Set per request, from the cookie. */
let SESSION = null;
sandbox.HSAuth = {
  can(app, roles) {
    if (!SESSION) return false;
    if (!roles || !roles.length) return true;
    return roles.indexOf(SESSION.role) > -1;
  },
  current() { return SESSION; },
  STAFF
};

global.CustomEvent = global.CustomEvent || class {
  constructor(t, o) { this.type = t; Object.assign(this, o || {}); }
};

for (const f of ['rates.js', 'content.js', 'profiles.js', 'bookings.js', 'guests.js']) {
  new Function('window', 'localStorage', 'sessionStorage', 'CustomEvent', 'unescape', 'console',
    fs.readFileSync(path.join(ROOT, f), 'utf8'))(
    sandbox, docs, docs, global.CustomEvent, require('querystring').unescape, console);
}

const RATES = sandbox.HSRates, CONTENT = sandbox.HSContent,
      BOOKINGS = sandbox.HSBookings, REVIEWS = sandbox.HSGuestReviews,
      GUESTS = sandbox.HSGuests;

/* ---- The operations a request may ask for ------------------------------
   A whitelist, not a bridge: a method that is not named here does not exist
   as far as the network is concerned. `staff` is what the server checks
   before dispatch; the module then checks again on its own account, so a
   mistake in this table cannot by itself open a write. */
/* The website needs the book to count what is free tonight, and needs
   nothing else from it. An anonymous caller gets the shape of each stay and
   none of the person: no name, no email, no phone, no money. Availability is
   computed from exactly these fields, so nothing the site draws is lost. */
function publicBookings() {
  return BOOKINGS.all().map(b => ({
    ref: null,
    category: b.category,
    checkIn: b.checkIn,
    nights: b.nights,
    nightsBilled: b.nightsBilled,
    roomCount: b.roomCount,
    status: b.status
  }));
}

const OPS = {
  'rates.get':            { staff: false, run: () => RATES.get() },
  'rates.set':            { staff: true,  run: a => RATES.set(a[0]) },
  'rates.reset':          { staff: true,  run: () => RATES.reset() },

  'content.published':    { staff: false, run: () => CONTENT.published() },
  'content.draft':        { staff: true,  run: () => CONTENT.draft() },
  'content.saveDraft':    { staff: true,  run: a => CONTENT.saveDraft(a[0]) },
  'content.publish':      { staff: true,  run: () => CONTENT.publish() },
  'content.discard':      { staff: true,  run: () => CONTENT.discard() },
  'content.reset':        { staff: true,  run: () => CONTENT.reset() },

  /* Staff see the reservations; everyone else sees only their shape. */
  'bookings.all':         { staff: false, run: () => (SESSION ? BOOKINGS.all() : publicBookings()) },
  'bookings.availability': { staff: false, run: a => BOOKINGS.availability(a[0], a[1], a[2], a[3]) },
  'bookings.availabilityAll': { staff: false, run: a => BOOKINGS.availabilityAll(a[0], a[1]) },
  'bookings.inventory':   { staff: false, run: a => BOOKINGS.inventory(a[0]) },
  /* The one public write. Everything about what it costs is decided inside
     bookings.js, here, against the rate plan in this database. */
  'bookings.add':         { staff: false, run: a => BOOKINGS.add(a[0]) },
  'bookings.update':      { staff: true,  run: a => BOOKINGS.update(a[0], a[1]) },
  'bookings.assignRoom':  { staff: true,  run: a => BOOKINGS.assignRoom(a[0], a[1]) },
  'bookings.departEarly': { staff: true,  run: a => BOOKINGS.departEarly(a[0], a[1]) },
  'bookings.cancel':      { staff: true,  run: a => BOOKINGS.cancel(a[0]) },
  'bookings.remove':      { staff: true,  run: a => BOOKINGS.remove(a[0]) },
  'bookings.clear':       { staff: true,  run: () => BOOKINGS.clear() },

  'reviews.approved':     { staff: false, run: () => REVIEWS.approved() },
  'reviews.average':      { staff: false, run: () => REVIEWS.average() },
  'reviews.submit':       { staff: false, run: a => REVIEWS.submit(a[0]) },
  'reviews.all':          { staff: true,  run: () => REVIEWS.all() },
  'reviews.counts':       { staff: true,  run: () => REVIEWS.counts() },
  'reviews.setStatus':    { staff: true,  run: a => REVIEWS.setStatus(a[0], a[1]) },
  'reviews.setReply':     { staff: true,  run: a => REVIEWS.setReply(a[0], a[1]) },
  'reviews.setPhotoStatus': { staff: true, run: a => REVIEWS.setPhotoStatus(a[0], a[1], a[2]) },
  'reviews.remove':       { staff: true,  run: a => REVIEWS.remove(a[0]) },

  'guests.all':           { staff: true,  run: () => GUESTS.all() },
  'guests.stats':         { staff: true,  run: () => GUESTS.stats() },
  'guests.search':        { staff: true,  run: a => GUESTS.search(a[0]) },
  'guests.setNotes':      { staff: true,  run: a => GUESTS.setNotes(a[0], a[1]) },
  'guests.setTags':       { staff: true,  run: a => GUESTS.setTags(a[0], a[1]) },
  'guests.remove':        { staff: true,  run: a => GUESTS.remove(a[0]) }
};

/* Documents a page may read in one go at boot, and who may read each. */
const SNAPSHOT = [
  ['rates', false, () => RATES.get()],
  ['content', false, () => CONTENT.published()],
  ['contentDraft', true, () => CONTENT.draft()],
  ['bookings', false, () => (SESSION ? BOOKINGS.all() : publicBookings())],
  ['reviews', false, () => REVIEWS.approved()],
  ['reviewsAll', true, () => REVIEWS.all()],
  ['guests', true, () => GUESTS.all()]
];

/* ---- HTTP --------------------------------------------------------------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2'
};

/* Files that live here but are not the web's business: the server, the
   database layer, anything that ends in .db, and every test — the tests carry
   fixture credentials and descriptions of exactly what to try. */
const NEVER_SERVE = new Set(['server.js', 'db.js', 'serve.js', 'package.json', 'package-lock.json']);

function servable(base) {
  const name = String(base).toLowerCase();
  if (NEVER_SERVE.has(name)) return false;
  if (name.endsWith('.test.js')) return false;
  if (/\.db($|-wal$|-shm$|-journal$)/.test(name)) return false;
  if (name.startsWith('.')) return false;
  return true;
}

const COOKIE = 'hs_session';

function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function json(res, code, body, headers) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    /* This API is for this origin's own pages. */
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 8 * 1024 * 1024)) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* Establishes who is asking, from the cookie, and keeps the clocks honest.
   Both the token and the row have to agree: revoking a session deletes the
   row, and the still-valid cookie then buys nothing. */
function sessionOf(req) {
  const token = cookies(req)[COOKIE];
  const claims = verify(token);
  if (!claims) return null;
  const row = store.q.session.get(claims.sid);
  if (!row) return null;
  const now = Date.now();
  if (now > row.expires || now - row.issued > TTL_ABS) {
    store.q.dropSession.run(row.id);
    return null;
  }
  if (now - row.seen > TTL_IDLE) {
    store.q.dropSession.run(row.id);
    return null;
  }
  if (now - row.seen > 15000) {
    store.q.touchSession.run(now, Math.min(now + TTL_IDLE, row.issued + TTL_ABS), row.id);
  }
  const acct = store.q.account.get(row.email);
  if (!acct) return null;
  return { sid: row.id, email: acct.email, name: acct.name, role: acct.role, title: acct.title };
}

function setCookie(res, token, maxAgeMs) {
  res.setHeader('Set-Cookie',
    COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(maxAgeMs / 1000));
}

async function api(req, res, url) {
  const route = url.pathname.replace(/^\/api\/?/, '');
  SESSION = sessionOf(req);

  /* ---- Session ---------------------------------------------------------- */
  if (route === 'session') {
    if (req.method === 'GET') {
      return json(res, 200, SESSION
        ? { email: SESSION.email, name: SESSION.name, role: SESSION.role, title: SESSION.title }
        : null);
    }

    if (req.method === 'DELETE') {
      if (SESSION) store.q.dropSession.run(SESSION.sid);
      SESSION = null;
      res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const email = String(body.email || '').trim().toLowerCase();
      const pw = String(body.password || '');
      if (!email || !pw) return json(res, 400, { ok: false, error: 'Enter your email and password.' });

      const wait = lockedFor('signin:' + email);
      if (wait > 0) {
        return json(res, 429, {
          ok: false, retryIn: wait,
          error: 'Too many attempts. Try again in ' + Math.ceil(wait / 1000) + 's.'
        });
      }

      const acct = store.q.account.get(email);
      /* The same work either way, so a wrong email and a wrong password take
         the same time and give the same answer. */
      const probe = acct || { salt: RESET_SALT, hash: '', iterations: ITERATIONS };
      const got = pbkdf2(pw, probe.salt, probe.iterations);
      if (!acct || !sameHex(got, probe.hash)) {
        const n = noteFail('signin:' + email);
        const left = FREE_TRIES - n;
        return json(res, 401, {
          ok: false,
          error: 'Those details do not match an account.' +
            (left > 0 && left <= 2 ? ' ' + left + ' attempts left.' : '')
        });
      }
      if (STAFF.indexOf(acct.role) === -1) {
        return json(res, 403, { ok: false, error: 'This account has no access here.' });
      }

      store.q.clearAttempt.run('signin:' + email);
      store.q.sweepSessions.run(Date.now());
      const sid = crypto.randomUUID();
      const now = Date.now();
      store.q.addSession.run(sid, acct.email, now, now,
        Math.min(now + TTL_IDLE, now + TTL_ABS), String(req.headers['user-agent'] || '').slice(0, 200));
      setCookie(res, sign({ iss: 'hillstream', sid, iat: now }), TTL_ABS);
      return json(res, 200, {
        ok: true,
        user: { email: acct.email, name: acct.name, role: acct.role, title: acct.title }
      });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Changing the password ------------------------------------------- */
  if (route === 'password' && req.method === 'POST') {
    if (!SESSION) return json(res, 401, { ok: false, error: 'Your session has ended. Sign in again.' });
    const body = await readBody(req, 8 * 1024);
    const code = String(body.code || '');
    const next = String(body.next || '');
    if (!code) return json(res, 400, { ok: false, error: 'Enter the authorisation code.' });
    if (!next) return json(res, 400, { ok: false, error: 'Enter a new password.' });
    if (next.length < 8) return json(res, 400, { ok: false, error: 'Use at least 8 characters.' });
    if (next !== String(body.confirm || '')) {
      return json(res, 400, { ok: false, error: 'The two passwords do not match.' });
    }

    const wait = lockedFor('reset:' + SESSION.email);
    if (wait > 0) {
      return json(res, 429, {
        ok: false, retryIn: wait,
        error: 'Too many attempts. Try again in ' + Math.ceil(wait / 1000) + 's.'
      });
    }
    if (!sameHex(pbkdf2(code, RESET_SALT, ITERATIONS), RESET_HASH)) {
      noteFail('reset:' + SESSION.email);
      return json(res, 403, { ok: false, error: 'That authorisation code is not right.' });
    }

    store.q.clearAttempt.run('reset:' + SESSION.email);
    store.q.clearAttempt.run('signin:' + SESSION.email);
    const salt = crypto.randomBytes(16).toString('hex');
    store.q.setPassword.run(salt, pbkdf2(next, salt, ITERATIONS), ITERATIONS, Date.now(), SESSION.email);
    /* A new password ends every other session for that account — the point of
       changing it is usually that somebody else should stop being signed in.
       This one survives, so the operator is not thrown out of their own
       Settings page. */
    const keep = SESSION.sid;
    const mine = store.q.session.get(keep);
    store.q.dropSessionsFor.run(SESSION.email);
    if (mine) store.q.addSession.run(mine.id, mine.email, mine.issued, mine.seen, mine.expires, mine.agent);
    return json(res, 200, { ok: true });
  }

  /* ---- Everything a page needs at boot, in one request ------------------ */
  if (route === 'snapshot' && req.method === 'GET') {
    const out = { session: SESSION ? { email: SESSION.email, name: SESSION.name, role: SESSION.role, title: SESSION.title } : null };
    for (const [name, staffOnly, get] of SNAPSHOT) {
      if (staffOnly && !SESSION) continue;
      try { out[name] = get(); } catch (e) { out[name] = null; }
    }
    if (SESSION) {
      const acct = store.q.account.get(SESSION.email);
      out.passwordChangedAt = acct ? acct.changed_at : null;
    }
    return json(res, 200, out);
  }

  /* ---- Calling the domain ---------------------------------------------- */
  if (route === 'call' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.op || '');
    const op = Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name] : null;
    if (!op) return json(res, 404, { ok: false, error: 'No such operation.' });
    if (op.staff && !(SESSION && STAFF.indexOf(SESSION.role) > -1)) {
      return json(res, 401, { ok: false, error: 'That needs a signed-in operator.' });
    }
    const args = Array.isArray(body.args) ? body.args : [];
    docs.setActor(SESSION ? SESSION.email : null);
    let result;
    try { result = op.run(args); }
    catch (e) { return json(res, 400, { ok: false, error: String((e && e.message) || e) }); }
    finally { docs.setActor(null); }
    return json(res, 200, { ok: true, result });
  }

  /* ---- What a document used to look like -------------------------------- */
  if (route === 'history' && req.method === 'GET') {
    if (!SESSION) return json(res, 401, { ok: false, error: 'That needs a signed-in operator.' });
    return json(res, 200, {
      ok: true,
      revisions: store.history(url.searchParams.get('key'), +url.searchParams.get('limit') || 10)
    });
  }

  return json(res, 404, { ok: false, error: 'No such endpoint.' });
}

function serveFile(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = url.pathname; }
  if (rel === '/') rel = HOME;

  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  /* The server's own files sit in the same directory as the pages, and none
     of them are web content. server.js in particular names the authorisation
     code it seeds with, so serving it would hand that over to anyone who
     asked for the URL. The pages need rates.js and its siblings; they never
     need these. */
  if (!servable(path.basename(file))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  /* '/api/' and '/api' are the API; '/api.js' is a file the pages load, and
     a prefix test alone would swallow it. */
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => {
      try { json(res, 400, { ok: false, error: String((e && e.message) || e) }); } catch (x) {}
    });
    return;
  }
  serveFile(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Hill Stream on http://127.0.0.1:' + PORT + '/');
    console.log('Database: ' + store.FILE);
  });
}

module.exports = { server, OPS };
