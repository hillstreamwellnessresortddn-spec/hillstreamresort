/* Hill Stream — does a change in the PMS reach the website's room cards?
 *
 * The website no longer keeps its own list of rooms: it draws a card per
 * category in the rate plan, prices it from the plan, and counts what is left
 * from the reservation book. This runs the same reads that render does,
 * against the same modules.
 *
 * Run it with:  node link.test.js
 */
const fs = require('fs');
const mk = () => ({ _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });
global.localStorage = mk(); global.sessionStorage = mk();
global.unescape = require('querystring').unescape;
const listeners = {};
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
global.window = {
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
  dispatchEvent(e) { (listeners[e.type] || []).forEach(f => f(e)); return true; }
};
global.console.warn = () => {};
for (const f of ['rates.js', 'bookings.js', 'profiles.js', 'guests.js']) {
  new Function('window', 'localStorage', 'sessionStorage', 'CustomEvent', 'unescape', 'console',
    fs.readFileSync('E:/git/hillstreamresort/' + f, 'utf8'))(window, localStorage, sessionStorage, CustomEvent, unescape, console);
}
const R = window.HSRates, B = window.HSBookings;
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
const t = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('PASS ' + n))
  : (fail++, console.log('FAIL ' + n + '  got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w))));

const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/* Exactly what the website's renderVals now does. */
function websiteCards() {
  const today = new Date(), st = R.get();
  const avail = B.availabilityAll(ymd(today), 1);
  const cards = st.categories.map(c => {
    const a = avail[c.id], closed = !!c.stopSell;
    return {
      id: c.id, name: c.name, size: c.size, rate: R.rateFor(c.id, today, st),
      closed, left: closed ? 0 : (a ? a.left : Math.max(0, +c.rooms || 0))
    };
  });
  const roomTotal = st.categories.reduce((a, c) => a + Math.max(0, +c.rooms || 0), 0);
  return { cards, roomTotal };
}

(async () => {
  console.log('-- the website reads the rate plan, not a copy --');
  let w = websiteCards();
  t('seven categories', w.cards.length, 7);
  t('forty-four rooms', w.roomTotal, 44);
  t('signature priced from the plan', w.cards.find(c => c.id === 'signature').rate,
    R.rateFor('signature', new Date()));

  signIn('owner');

  console.log('\n-- the PMS moves a price --');
  R.set(Object.assign({}, R.get(), { categories: R.get().categories.map(c =>
    c.id === 'signature' ? Object.assign({}, c, { base: 19000, weekend: 19000 }) : c) }));
  t('the website card follows', websiteCards().cards.find(c => c.id === 'signature').rate >= 19000, true);

  console.log('\n-- the PMS changes the room count --');
  R.set(Object.assign({}, R.get(), { categories: R.get().categories.map(c =>
    c.id === 'deluxe-view' ? Object.assign({}, c, { rooms: 20 }) : c) }));
  w = websiteCards();
  t('deluxe-view now shows twenty left', w.cards.find(c => c.id === 'deluxe-view').left, 20);
  t('and the headline total follows', w.roomTotal, 56);

  console.log('\n-- the PMS stops selling a category --');
  R.set(Object.assign({}, R.get(), { categories: R.get().categories.map(c =>
    c.id === 'stream-view' ? Object.assign({}, c, { stopSell: true }) : c) }));
  const v = websiteCards().cards.find(c => c.id === 'stream-view');
  t('closed on the website', [v.closed, v.left], [true, 0]);

  console.log('\n-- the PMS adds a category --');
  R.set(Object.assign({}, R.get(), { categories: R.get().categories.concat([
    { id: 'sarita', name: 'Sarita', rooms: 4, size: '60 sqm', base: 9000, weekend: 11000, minStay: 1, stopSell: false }
  ]) }));
  w = websiteCards();
  t('a new card appears with no edit to the page', !!w.cards.find(c => c.id === 'sarita'), true);
  t('with its size from the plan', w.cards.find(c => c.id === 'sarita').size, '60 sqm');
  t('and counted in the total', w.roomTotal, 60);

  console.log('\n-- a booking moves what is left tonight --');
  signOut();
  const today = new Date();
  const beforeLeft = websiteCards().cards.find(c => c.id === 'deluxe-view').left;
  const r = B.add({ guest: 'Tonight', category: 'deluxe-view', checkIn: ymd(today), nights: 1, roomCount: 2 });
  t('the booking is taken', r.ok, true);
  t('two fewer on the website', websiteCards().cards.find(c => c.id === 'deluxe-view').left, beforeLeft - 2);

  console.log('\n-- and the site still cannot write any of it --');
  const held = R.get().categories.find(c => c.id === 'signature').base;
  R.set(Object.assign({}, R.get(), { categories: R.get().categories.map(c =>
    Object.assign({}, c, { base: 1 })) }));
  t('rates unmoved from a public page', R.get().categories.find(c => c.id === 'signature').base, held);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
