/* Hill Stream — the attacks, run against the shared modules.
 *
 * Every case here is something a visitor can literally type into the console
 * on a page of the public website, where all of these modules are loaded and
 * none of them can be assumed friendly. The suite exists so that a change
 * which re-opens one of them fails here rather than in the folio.
 *
 * Run it with:  node attack.test.js
 */
const fs = require('fs');
const mkStore = () => ({ _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });
global.localStorage = mkStore();
global.sessionStorage = mkStore();
global.unescape = require('querystring').unescape;
const listeners = {};
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
global.window = {
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
  dispatchEvent(e) { (listeners[e.type] || []).forEach(f => f(e)); return true; }
};
global.console.warn = () => {};
const P = require('path').join(__dirname, '/');
for (const f of ['rates.js', 'content.js', 'profiles.js', 'bookings.js', 'guests.js']) {
  new Function('window', 'localStorage', 'sessionStorage', 'CustomEvent', 'unescape', 'console',
    fs.readFileSync(P + f, 'utf8'))(window, localStorage, sessionStorage, CustomEvent, unescape, console);
}
const R = window.HSRates, C = window.HSContent, Bk = window.HSBookings,
      G = window.HSGuestReviews, GB = window.HSGuests;
/* The session, as the modules see it. On the server this is filled from the
   cookie; here a test says who is signed in. What is being tested is what the
   modules do about it — the cookie itself is api.test.js's business. */
let ROLE = null;
window.HSAuth = {
  STAFF: ['owner', 'manager', 'desk'],
  can(app, roles) {
    if (!ROLE) return false;
    if (!roles || !roles.length) return true;
    return roles.indexOf(ROLE) > -1;
  },
  current() { return ROLE ? { email: 'operator@example.com', role: ROLE } : null; }
};
const A = window.HSAuth;
const signIn = (role) => { ROLE = role || 'owner'; return true; };
const signOut = () => { ROLE = null; };


let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

const ymd = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

(async () => {
  console.log('-- paying what you feel like --');
  /* The attack: the price is added up by a page the visitor controls, so they
     simply state a different one. */
  const cheap = Bk.add({
    guest: 'Bargain Hunter', category: 'signature', checkIn: ymd(30), nights: 2, roomCount: 1,
    adults: 2, meal: 'Full board', extras: ['Himalayan oil ritual'],
    total: 1, paid: 1, roomTotal: 1, serviceTotal: 0, source: 'Website'
  });
  t('the booking is taken', cheap.ok, true);
  t('but not at the stated price', cheap.booking.total > 1, true);
  const honest = R.stayTotal('signature', new Date(ymd(30)), 2, 1);
  t('the room is charged from the rate plan', cheap.booking.roomTotal, honest);
  t('the meal was charged too', cheap.booking.serviceTotal > 0, true);
  t('tax is on top', cheap.booking.total > cheap.booking.roomTotal + cheap.booking.serviceTotal, true);
  t('paid cannot exceed the stay', cheap.booking.paid <= cheap.booking.total, true);

  console.log('\n-- claiming to have paid more than the stay costs --');
  const over = Bk.add({
    guest: 'Refund Me', category: 'deluxe-view', checkIn: ymd(31), nights: 1,
    total: 999999, paid: 999999, source: 'Website'
  });
  t('paid is clamped to the total', over.booking.paid <= over.booking.total, true);
  t('no credit invented', over.booking.paid - over.booking.total <= 0, true);

  console.log('\n-- inventing a charge that is not in the rate plan --');
  const ghost = Bk.add({
    guest: 'Ghost Extras', category: 'deluxe-view', checkIn: ymd(32), nights: 1,
    meal: 'Caviar tasting', extras: ['Helicopter transfer', 'javascript:alert(1)'], source: 'Website'
  });
  t('an unknown meal is not charged', ghost.booking.meal, '');
  t('unknown extras are not charged', ghost.booking.extras, []);

  console.log('\n-- dressing a booking up as something it is not --');
  const fake = Bk.add({
    guest: 'Walk In', category: 'deluxe-view', checkIn: ymd(33), nights: 1,
    ref: 'HS-0001', source: 'Desk', method: 'cash', status: 'checked-out',
    createdAt: 0, profileId: 'hg-1001', checkedIn: true
  });
  t('a visitor cannot claim the desk took it', fake.booking.source, 'Website');
  t('nor choose the reference', fake.booking.ref !== 'HS-0001', true);
  t('nor set the status', fake.booking.status, 'confirmed');
  t('nor backdate it', fake.booking.createdAt > 0, true);
  t('nor check themselves in', fake.booking.checkedIn, undefined);

  console.log('\n-- writing to the record from a public page --');
  const before = Bk.all().length;
  /* A refused write hands back the untouched record rather than throwing, so
     what proves the refusal is the record, not a return value. */
  Bk.update(cheap.ref, { total: 1, notes: 'edited' });
  t('cannot edit a reservation', Bk.all().find(b => b.ref === cheap.ref).notes, '');
  t('the total held', Bk.all().find(b => b.ref === cheap.ref).total, cheap.booking.total);
  Bk.cancel(cheap.ref);
  t('cannot cancel someone else\'s stay', Bk.all().find(b => b.ref === cheap.ref).status, 'confirmed');
  t('cannot empty the book', (Bk.clear(), Bk.all().length), before);
  t('cannot move a price', R.set({ categories: [{ id: 'signature', rooms: 4, base: 1 }] })
    .categories.find(c => c.id === 'signature').base > 1, true);
  t('cannot open more rooms than exist', R.set({ categories: [{ id: 'signature', rooms: 999, base: 9100 }] })
    .categories.find(c => c.id === 'signature').rooms, 4);
  t('cannot rewrite the website', (C.saveDraft(Object.assign({}, C.draft(), {
    home: Object.assign({}, C.draft().home, { heroTitle: 'HACKED' })
  })), C.publish().home.heroTitle !== 'HACKED'), true);

  console.log('\n-- reading what is not yours --');
  t('the guest book is shut', GB.all(), []);
  t('search gives nothing', GB.search('a'), []);
  t('and the totals give nothing away', GB.stats().total, 0);

  console.log('\n-- publishing your own review --');
  const mine = G.submit({ author: 'Me', text: 'Five stars', rating: 9, status: 'approved', reply: 'Thank you!' });
  const rec = G.all().find(r => r.id === mine.id);
  t('it lands pending, whatever it asked for', rec.status, 'pending');
  t('the rating is clamped', rec.rating, 5);
  t('no reply is forged', rec.reply, '');
  t('and it is not on the site', G.approved().some(r => r.id === mine.id), false);
  t('nor can it be approved from here', (G.setStatus(mine.id, 'approved'),
    G.all().find(r => r.id === mine.id).status), 'pending');

  console.log('\n-- pointing the moderator at your server --');
  const bad = G.submit({
    author: 'Tracker', text: 'hi',
    photos: [
      { kind: 'image', url: 'https://evil.example/pixel.png' },
      { kind: 'image', url: 'javascript:alert(document.cookie)' },
      { kind: 'video', url: 'http://evil.example/x.mp4', poster: 'https://evil.example/p.jpg' },
      { kind: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }
    ]
  });
  const photos = G.all().find(r => r.id === bad.id).photos;
  t('an external image is dropped', photos[0].url, '');
  t('a javascript: URL is dropped', photos[1].url, '');
  t('an external clip and its poster are dropped', [photos[2].url, photos[2].poster], ['', '']);
  t('a genuine ingested image is kept', photos[3].url, 'data:image/png;base64,iVBORw0KGgo=');

  console.log('\n-- burying the moderation queue --');
  let refused = 0;
  for (let i = 0; i < 80; i++) if (!G.submit({ author: 'Flood ' + i, text: 'x' }).ok) refused++;
  t('the flood is refused', refused > 0, true);
  t('the queue stops growing', G.pending().length <= 60, true);
  t('approved reviews were not dropped for room', G.approved().length > 0, true);

  /* Forging a session, and weakening a stored credential, were attacks on a
     browser that held the secrets. It no longer does: see api.test.js, which
     attacks the cookie and the server that issues it. */

  console.log('\n-- and what an operator may legitimately do --');
  signIn('owner');
  const ota = Bk.add({
    guest: 'OTA Guest', category: 'deluxe-view', checkIn: ymd(34), nights: 1,
    total: 4000, paid: 4000, roomTotal: 4000, serviceTotal: 0, source: 'Booking.com', method: 'ota'
  });
  t('the desk may state an OTA price', ota.booking.total, 4000);
  t('and name the channel', ota.booking.source, 'Booking.com');
  t('rates move for an operator', R.set(Object.assign({}, R.get(), {
    categories: R.get().categories.map(c => c.id === 'signature' ? Object.assign({}, c, { base: 9900 }) : c)
  })).categories.find(c => c.id === 'signature').base, 9900);
  signOut();
  t('and shut again on sign-out', R.set(Object.assign({}, R.get(), {
    categories: R.get().categories.map(c => Object.assign({}, c, { base: 2 }))
  })).categories.find(c => c.id === 'signature').base, 9900);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
