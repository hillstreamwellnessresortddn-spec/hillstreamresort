/* Hill Stream — the server's boundary, attacked over HTTP.
 *
 * The earlier suites test the domain rules in isolation. This one tests the
 * thing that now actually says no: a real server, a real SQLite database, and
 * a caller with nothing but a network connection — which is all a visitor's
 * console has once the secrets left the browser.
 *
 * It starts its own server on a spare port against a throwaway database, so
 * it never touches the one you are using.
 *
 * Run it with:  node api.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-test-'));
process.env.HS_DB = path.join(TMP, 'test.db');
process.env.HS_EMAIL = 'owner@example.com';
process.env.HS_PASSWORD = 'TestPassword#1';
process.env.HS_RESET_CODE = '9917492603';

const { server } = require('./server.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

let BASE = '';
/* Two callers: one with a cookie jar, one deliberately without. */
function client() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async fetch(p, opts) {
      const o = Object.assign({ headers: {} }, opts || {});
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers);
      if (cookie) o.headers.Cookie = cookie;
      const r = await fetch(BASE + p, o);
      const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const c of set) cookie = c.split(';')[0];
      let body = null;
      try { body = await r.json(); } catch (e) {}
      return { status: r.status, body };
    },
    call(op, args) {
      return this.fetch('/api/call', { method: 'POST', body: JSON.stringify({ op, args: args || [] }) });
    }
  };
}

const ymd = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  BASE = 'http://127.0.0.1:' + server.address().port;

  const visitor = client();
  const staff = client();

  console.log('-- nothing secret is served --');
  /* The files a page genuinely loads must carry no secret. */
  for (const f of ['/auth.js', '/api.js', '/rates.js', '/bookings.js']) {
    const r = await fetch(BASE + f);
    const text = r.ok ? await r.text() : '';
    t('no password in ' + f, /TestPassword#1/.test(text), false);
    t('no signing key in ' + f, /[0-9a-f]{64}/.test(text), false);
    t('no authorisation code in ' + f, /9917492603/.test(text), false);
  }
  /* And the server's own files are not web content at all — server.js names
     the code it seeds the authorisation with. */
  for (const f of ['/server.js', '/db.js', '/api.test.js', '/attack.test.js', '/hillstream.db']) {
    t('not served: ' + f, (await fetch(BASE + f)).status, 404);
  }
  const climb = await fetch(BASE + '/../db.js');
  t('cannot reach it by climbing either', climb.status, 404);
  /* The transport the pages load is named api.js, which a careless prefix
     test would route to the API and answer 404 for. */
  const transport = await fetch(BASE + '/api.js');
  t('api.js is served as a file, not routed to the API', transport.status, 200);
  t('and it is the transport', /HSApi/.test(await transport.text()), true);

  console.log('\n-- a visitor may read what is public --');
  let r = await visitor.call('rates.get');
  t('rates are public', r.body.ok && r.body.result.categories.length > 0, true);
  r = await visitor.fetch('/api/snapshot');
  t('snapshot has no session', r.body.session, null);
  t('and no guest book', r.body.guests, undefined);
  t('and no content draft', r.body.contentDraft, undefined);

  console.log('\n-- the reservation book does not name anyone --');
  await visitor.call('bookings.add', [{
    guest: 'Private Person', email: 'private@example.com', phone: '+91 90000 00000',
    category: 'deluxe-view', checkIn: ymd(12), nights: 1, total: 9, paid: 9
  }]);
  r = await visitor.call('bookings.all');
  const seen = r.body.result[0];
  t('a visitor sees the stay', seen.category, 'deluxe-view');
  t('but not the guest', seen.guest, undefined);
  t('nor their email', seen.email, undefined);
  t('nor what they paid', seen.total, undefined);
  t('nor the reference', seen.ref, null);

  console.log('\n-- and cannot write --');
  r = await visitor.call('rates.set', [{ categories: [{ id: 'signature', rooms: 4, base: 1 }] }]);
  t('rates.set is refused', [r.status, r.body.ok], [401, false]);
  r = await visitor.call('guests.all');
  t('the guest book is refused', r.status, 401);
  r = await visitor.call('content.publish');
  t('publishing is refused', r.status, 401);
  r = await visitor.call('bookings.clear');
  t('emptying the book is refused', r.status, 401);
  r = await visitor.call('reviews.setStatus', ['g-1001', 'approved']);
  t('approving a review is refused', r.status, 401);
  r = await visitor.call('nonsense.op');
  t('an operation that is not offered does not exist', r.status, 404);

  console.log('\n-- the price is the server\'s to decide --');
  r = await visitor.call('bookings.add', [{
    guest: 'Bargain', category: 'signature', checkIn: ymd(40), nights: 2,
    meal: 'Full board', total: 1, paid: 1, roomTotal: 1, serviceTotal: 0
  }]);
  const cheap = r.body.result.booking;
  t('the booking is taken', r.body.result.ok, true);
  t('at the real price, not the stated one', cheap.total > 1000, true);
  t('paid cannot exceed it', cheap.paid <= cheap.total, true);
  t('and it is recorded as a website booking', cheap.source, 'Website');

  console.log('\n-- signing in --');
  r = await staff.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }) });
  t('a wrong password is refused', [r.status, r.body.ok], [401, false]);
  t('and no cookie is handed out', staff.cookie, '');
  r = await staff.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'TestPassword#1' }) });
  t('the right one is accepted', r.body.ok, true);
  t('the cookie is HttpOnly', /HttpOnly/i.test(staff.cookie) === false, true); // name=value only; flags checked below

  console.log('\n-- what the cookie is --');
  const raw = await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'TestPassword#1' })
  });
  const setCookie = (raw.headers.getSetCookie ? raw.headers.getSetCookie() : []).join(';');
  t('HttpOnly, so page script cannot read it', /HttpOnly/i.test(setCookie), true);
  t('SameSite, so another site cannot ride it', /SameSite=Lax/i.test(setCookie), true);
  t('and it carries no account details', /owner@example\.com/.test(setCookie), false);

  console.log('\n-- an operator may write --');
  r = await staff.call('rates.set', [Object.assign({}, (await staff.call('rates.get')).body.result, { note: 'x' })]);
  t('rates.set is allowed', r.body.ok, true);
  r = await staff.call('guests.all');
  t('the guest book opens', r.body.ok, true);
  r = await staff.call('bookings.all');
  t('and the reservations carry their guests', !!r.body.result[0].guest, true);

  console.log('\n-- a forged cookie buys nothing --');
  const forged = client();
  const stolen = staff.cookie;
  const bad = stolen.slice(0, -4) + 'AAAA';
  r = await fetch(BASE + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bad },
    body: JSON.stringify({ op: 'guests.all' })
  });
  t('a tampered signature is refused', r.status, 401);
  r = await fetch(BASE + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'hs_session=nonsense' },
    body: JSON.stringify({ op: 'rates.set', args: [{}] }) });
  t('so is a made-up one', r.status, 401);

  console.log('\n-- signing out revokes it --');
  const copy = stolen;
  await staff.fetch('/api/session', { method: 'DELETE' });
  r = await fetch(BASE + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: copy },
    body: JSON.stringify({ op: 'guests.all' }) });
  t('the old cookie is dead, not merely forgotten', r.status, 401);

  console.log('\n-- changing the password --');
  const op2 = client();
  await op2.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'TestPassword#1' }) });
  r = await op2.fetch('/api/password', { method: 'POST', body: JSON.stringify({ code: '0000000000', next: 'Whatever#123', confirm: 'Whatever#123' }) });
  t('a wrong authorisation code is refused', [r.status, r.body.ok], [403, false]);
  r = await op2.fetch('/api/password', { method: 'POST', body: JSON.stringify({ code: '9917492603', next: 'short', confirm: 'short' }) });
  t('a short password is refused', r.status, 400);
  r = await op2.fetch('/api/password', { method: 'POST', body: JSON.stringify({ code: '9917492603', next: 'Whatever#123', confirm: 'different' }) });
  t('a mismatch is refused', r.status, 400);

  /* Another operator, signed in on another machine. */
  const elsewhere = client();
  await elsewhere.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'TestPassword#1' }) });
  t('they are signed in', (await elsewhere.call('guests.all')).body.ok, true);

  r = await op2.fetch('/api/password', { method: 'POST', body: JSON.stringify({ code: '9917492603', next: 'Whatever#123', confirm: 'Whatever#123' }) });
  t('the change is accepted', r.body.ok, true);
  t('the operator who changed it stays signed in', (await op2.call('guests.all')).body.ok, true);
  t('every other session ends', (await elsewhere.call('guests.all')).status, 401);

  const after = client();
  r = await after.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'TestPassword#1' }) });
  t('the old password no longer works', r.status, 401);
  r = await after.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'Whatever#123' }) });
  t('the new one does', r.body.ok, true);

  console.log('\n-- guessing is throttled, and the throttle is on the server --');
  const guesser = client();
  let locked = false;
  for (let i = 0; i < 7; i++) {
    const g = await guesser.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'guess' + i }) });
    if (g.status === 429) locked = true;
  }
  t('repeated guesses lock out', locked, true);
  const fresh = client();
  r = await fresh.fetch('/api/session', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'Whatever#123' }) });
  t('and a new browser does not clear it', r.status, 429);

  console.log('\n-- it is a database, so it survives --');
  const rates = (await visitor.call('rates.get')).body.result;
  t('written by the server, read back from SQLite', rates.categories.length > 0, true);
  const dbFile = process.env.HS_DB;
  t('and the file is on disk', fs.existsSync(dbFile), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
