/* Hill Stream — what the shared modules refuse, and what they allow.
 *
 * These are the rules the prototype leans on, exercised outside a browser so
 * a change that quietly opens one of them fails here rather than in front of
 * a guest:
 *
 *   - the public website cannot write rates, content or moderation decisions;
 *   - taking a booking is the one write a visitor may make;
 *   - inventory is the rate plan's, availability is counted from the book,
 *     and neither can be oversold;
 *   - the site changes on publish and at no other moment;
 *   - every booking opens or updates a record in the guest book, and that
 *     book is staff-only to read.
 *
 * Run it with:  node enforcement.test.js
 *
 * localStorage, sessionStorage and the event bus are shimmed below; every
 * module under test is the real file, loaded unmodified.
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
const R = window.HSRates, C = window.HSContent, Bk = window.HSBookings, G = window.HSGuestReviews, GB = window.HSGuests;
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

(async () => {
function ymd(d) {
  const x = new Date(); x.setDate(x.getDate() + d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
const withCat = (id, patch) => Object.assign({}, R.get(), {
  categories: R.get().categories.map(c => c.id === id ? Object.assign({}, c, patch) : c)
});

console.log('\n-- signed out: the website cannot write --');
const base = R.get().categories.find(c => c.id === 'deluxe-view').base;
R.set(withCat('deluxe-view', { base: 99999 }));
t('rates.set refused', R.get().categories.find(c => c.id === 'deluxe-view').base, base);
R.reset();
t('rates.reset refused', R.get().categories.find(c => c.id === 'deluxe-view').base, base);
C.saveDraft(Object.assign({}, C.draft(), { home: Object.assign({}, C.draft().home, { heroTitle: 'HACKED' }) }));
t('content.saveDraft refused', C.draft().home.heroTitle, C.DEFAULTS.home.heroTitle);
t('content.publish refused', C.publish().home.heroTitle, C.DEFAULTS.home.heroTitle);
t('published() is frozen', Object.isFrozen(C.published()), true);
G.setStatus('g-1001', 'rejected');
t('review moderation refused', G.all().find(r => r.id === 'g-1001').status, 'approved');

console.log('\n-- booking is the one public write --');
t('deluxe-view inventory', Bk.inventory('deluxe-view'), 8);
t('all 8 free', Bk.availability('deluxe-view', ymd(10), 2).left, 8);
const r1 = Bk.add({ guest: 'Test One', category: 'deluxe-view', checkIn: ymd(10), nights: 2, roomCount: 3, total: 1000, paid: 1000 });
t('public booking accepted', r1.ok, true);
t('three rooms gone', Bk.availability('deluxe-view', ymd(10), 2).left, 5);
t('other dates untouched', Bk.availability('deluxe-view', ymd(40), 2).left, 8);
t('an overlapping night counts', Bk.availability('deluxe-view', ymd(11), 2).left, 5);
t('the night after is clear', Bk.availability('deluxe-view', ymd(12), 2).left, 8);

console.log('\n-- overselling is refused --');
const b2 = Bk.add({ guest: 'Test Two', category: 'deluxe-view', checkIn: ymd(10), nights: 2, roomCount: 2 });
t('two more accepted, three left', b2.ok && Bk.availability('deluxe-view', ymd(10), 2).left, 3);
const over = Bk.add({ guest: 'Test Three', category: 'deluxe-view', checkIn: ymd(10), nights: 2, roomCount: 5 });
t('asking for more than is left is refused', over.ok, false);
t('the refusal names what is left', /Only 3 rooms/.test(over.error), true);
t('nothing was written', Bk.all().length, 2);
const fill2 = Bk.add({ guest: 'Test Four', category: 'deluxe-view', checkIn: ymd(10), nights: 2, roomCount: 3 });
t('the exact remainder is accepted', fill2.ok, true);
t('sold out', Bk.availability('deluxe-view', ymd(10), 2).left, 0);
t('one more refused', /fully booked/i.test(Bk.add({ guest: 'Five', category: 'deluxe-view', checkIn: ymd(10), nights: 1 }).error), true);

console.log('\n-- add() validates like an endpoint --');
t('no guest name', Bk.add({ category: 'deluxe-view', checkIn: ymd(5), nights: 1 }).ok, false);
t('past check-in', Bk.add({ guest: 'X', category: 'deluxe-view', checkIn: ymd(-1), nights: 1 }).ok, false);
t('malformed date', Bk.add({ guest: 'X', category: 'deluxe-view', checkIn: 'soon', nights: 1 }).ok, false);
t('unknown category', Bk.add({ guest: 'X', category: 'nope', checkIn: ymd(5), nights: 1 }).ok, false);
t('an absurd roomCount cannot pass', Bk.add({ guest: 'X', category: 'signature', checkIn: ymd(5), nights: 2, roomCount: 99 }).ok, false);
const inj = Bk.add({ guest: 'X', category: 'signature', checkIn: ymd(5), nights: 2, status: 'departed', paid: -500, roomCount: 2, createdAt: 0, ref: 'HS-INJECTED' });
t('status cannot be set by the caller', inj.booking.status, 'confirmed');
t('negative paid clamped', inj.booking.paid, 0);
t('createdAt is set by the store, not the caller', inj.booking.createdAt > 0, true);
t('nightsBilled starts at the full stay', inj.booking.nightsBilled, 2);
t('room starts unassigned', inj.booking.room, null);

console.log('\n-- signed out: reservations cannot be worked --');
const ref = r1.ref;
Bk.assignRoom(ref, '011');
t('assignRoom refused', Bk.all().find(b => b.ref === ref).room, null);
Bk.update(ref, { checkedIn: true });
t('update refused', Bk.all().find(b => b.ref === ref).checkedIn, undefined);
const before = Bk.all().length;
Bk.remove(ref);
t('remove refused', Bk.all().length, before);
Bk.clear();
t('clear refused', Bk.all().length, before);

console.log('\n-- signed in as the front desk --');
t('sign in', signIn('desk'), true);
Bk.assignRoom(ref, '011');
t('assignRoom works', Bk.all().find(b => b.ref === ref).room, '011');
Bk.assignRoom(b2.ref, '011');
t('one room, one guest', Bk.all().find(b => b.ref === b2.ref).room, null);
Bk.update(ref, { checkedIn: true, ref: 'HS-FAKE', createdAt: 0 });
t('checkedIn applied', Bk.all().find(b => b.ref === ref).checkedIn, true);
t('a patch cannot rewrite the reference', !!Bk.all().find(b => b.ref === ref), true);

C.saveDraft(Object.assign({}, C.draft(), { home: Object.assign({}, C.draft().home, { heroTitle: 'A new headline' }) }));
t('draft written', C.draft().home.heroTitle, 'A new headline');
t('site still on the old copy', C.published().home.heroTitle, C.DEFAULTS.home.heroTitle);
t('isDirty', C.isDirty(), true);
let woke = 0;
const un = C.subscribe(() => { woke++; });
C.saveDraft(Object.assign({}, C.draft(), { home: Object.assign({}, C.draft().home, { heroLede: 'typing...' }) }));
t('draft keystrokes do not wake the site', woke, 0);
C.publish();
t('publish wakes the site', woke, 1);
t('site now serves it', C.published().home.heroTitle, 'A new headline');
un();

t('rates.set works', R.set(withCat('deluxe-view', { base: 7000 })).categories.find(c => c.id === 'deluxe-view').base, 7000);
t('rates sanitised', R.set(withCat('deluxe-view', { rooms: -5 })).categories.find(c => c.id === 'deluxe-view').rooms, 0);
t('inventory follows the rate plan', Bk.inventory('deluxe-view'), 0);
R.set(withCat('jungle-view', { minStay: 2 }));
t('min-stay enforced', /2-night minimum/.test(Bk.add({ guest: 'X', category: 'jungle-view', checkIn: ymd(5), nights: 1 }).error), true);
G.setStatus('g-1001', 'rejected');
t('review moderation works', G.all().find(r => r.id === 'g-1001').status, 'rejected');

console.log('\n-- nights come back when a stay ends --');
R.set(withCat('deluxe-view', { rooms: 8 }));
t('back to 8 rooms', Bk.availability('deluxe-view', ymd(10), 2).left, 0);
Bk.departEarly(ref, 1);
t('the unused night is released', Bk.availability('deluxe-view', ymd(11), 1).left, 3);
Bk.cancel(b2.ref);
t('cancelling releases the whole stay', Bk.availability('deluxe-view', ymd(10), 2).left, 2);

console.log('\n-- signing out closes the door again --');
signOut();
Bk.update(ref, { notes: 'after sign out' });
t('update refused again', Bk.all().find(b => b.ref === ref).notes, '');
t('rates refused again', R.set(withCat('deluxe-view', { base: 1 })).categories.find(c => c.id === 'deluxe-view').base, 7000);
t('publish refused again', (C.saveDraft(Object.assign({}, C.draft(), { home: Object.assign({}, C.draft().home, { heroTitle: 'NOPE' }) })), C.publish().home.heroTitle), 'A new headline');

console.log('\n-- the guest book is staff-only --');
t('all() returns nothing signed out', GB.all(), []);
t('search() returns nothing signed out', GB.search('test'), []);
t('stats() gives nothing away', GB.stats().total, 0);
t('setNotes refused', GB.setNotes('hg-1001', 'x'), false);
t('remove refused', GB.remove('hg-1001'), false);

console.log('\n-- a booking writes the person, not just the reservation --');
signIn('manager');
GB.clear();
Bk.clear();
R.set(withCat('deluxe-view', { rooms: 8 }));
signOut();

const w1 = Bk.add({ guest: 'Meera Iyer', email: 'Meera.Iyer@example.com ', phone: '+91 98200 11122',
  country: 'India', category: 'deluxe-view', checkIn: ymd(20), nights: 2, roomCount: 1,
  total: 24000, paid: 24000, source: 'Website' });
t('website booking accepted', w1.ok, true);
t('the reservation carries a profile id', !!w1.booking.profileId, true);
signIn('manager');
t('one person in the book', GB.all().length, 1);
t('their name', GB.all()[0].name, 'Meera Iyer');
t('first stay', GB.all()[0].ordinal, 'First stay');
t('not yet returning', GB.all()[0].returning, false);
/* A website booking is priced here, from the rate plan — the 24,000 above is
   what an untrusted caller asked for, not what it costs. See attack.test.js. */
t('spend counted', GB.all()[0].spend, w1.booking.total);

console.log('\n-- the desk books the same person again --');
const d1 = Bk.add({ guest: 'Meera Iyer', email: 'meera.iyer@example.com',
  category: 'premium-valley', checkIn: ymd(60), nights: 3, roomCount: 1,
  total: 41000, paid: 10250, source: 'Desk' });
t('desk booking accepted', d1.ok, true);
t('still one person, not two', GB.all().length, 1);
t('recognised as returning', GB.all()[0].returning, true);
t('second stay', GB.all()[0].ordinal, 'Second stay');
t('both stays on the record', GB.all()[0].staysCount, 2);
t('lifetime value adds up', GB.all()[0].spend, w1.booking.total + 41000);
t('balance outstanding surfaces', GB.all()[0].outstanding, 30750);
t('room-nights across both stays', GB.all()[0].nights, 5);
t('the desk stay is attributed', GB.all()[0].stays.some(s => s.source === 'Desk'), true);

console.log('\n-- matched on a phone number when there is no email --');
const walkIn = Bk.add({ guest: 'Meera Iyer', phone: '098200 11122',
  category: 'jungle-view', checkIn: ymd(90), nights: 2, total: 30000, paid: 30000, source: 'Walk-in' });
t('walk-in accepted', walkIn.ok, true);
t('same person, three stays', GB.all().length === 1 && GB.all()[0].staysCount, 3);
t('third stay', GB.all()[0].ordinal, 'Third stay');

console.log('\n-- a different person is a different record --');
Bk.add({ guest: 'Tobias Lang', email: 'tobias@example.de', category: 'signature',
  checkIn: ymd(20), nights: 2, total: 40000, paid: 40000, source: 'Website' });
t('two people now', GB.all().length, 2);
t('one of them returning', GB.stats().returning, 1);

console.log('\n-- history follows what actually happened --');
const meera = GB.all().find(p => p.name === 'Meera Iyer');
Bk.cancel(walkIn.ref);
const after = GB.all().find(p => p.id === meera.id);
t('a cancelled stay stops counting', after.staysCount, 2);
t('and is noted as cancelled', after.cancelled, 1);
t('its value comes out of the total', after.spend, w1.booking.total + 41000);
Bk.departEarly(d1.ref, 1);
t('an early departure shows in the history', GB.get(meera.id).stays.find(s => s.ref === d1.ref).status, 'departed');

console.log('\n-- the desk can annotate, and erase on request --');
t('notes saved', GB.setNotes(meera.id, 'Prefers the ground floor room.'), true);
t('notes read back', GB.get(meera.id).notes, 'Prefers the ground floor room.');
t('flags saved', GB.setTags(meera.id, 'no dairy, quiet room'), true);
t('flags parsed', GB.get(meera.id).tags, ['no dairy', 'quiet room']);
t('found by name', GB.search('meera').length, 1);
t('found by email', GB.search('tobias@example.de').length, 1);
t('found by a flag', GB.search('dairy').length, 1);
t('found by reference', GB.search(d1.ref).length, 1);
t('erasure removes the person', GB.remove(meera.id), true);
t('one left in the book', GB.all().length, 1);
t('the reservations survive it', Bk.all().filter(b => b.guest === 'Meera Iyer').length, 3);

console.log('\n-- and it closes with the session --');
signOut();
t('the book is gone again', GB.all(), []);
t('notes refused again', GB.setNotes('hg-1001', 'x'), false);


/* Forging a session used to be testable here, because the browser held the
   key that signed it. It no longer holds anything: the session is a cookie
   the server issues and checks, and api.test.js is where that is attacked. */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
