/* Hill Stream — the guest book: who has stayed, not what was booked.
 *
 * bookings.js holds reservations. A reservation is an event — it starts, it
 * ends, and it is eventually history. A person is not: they come back, they
 * have a phone number that changed, a note about the steep path to the lower
 * rooms, and a count of nights the desk should know before they walk in.
 * That is what lives here, one record per person, built automatically from
 * every reservation the property takes.
 *
 * HOW A PROFILE IS MADE. Nobody types one. bookings.js calls record() on
 * every booking it accepts — website, desk, or OTA capture — and this file
 * decides whether that is somebody new or somebody already in the book:
 *
 *   email, lowercased        the identity if there is one
 *   else phone, digits only  the identity for a walk-in or a phone booking
 *   else the name            last resort, so nothing is dropped on the floor
 *
 * A returning guest's second reservation lands on their existing record, so
 * the desk sees "third stay" rather than three strangers with the same name.
 *
 * WHO MAY READ IT. This is the most personal record the property holds —
 * names, contact details, where people have slept and what they paid. Every
 * read of it is staff-only and goes through HSAuth.can(). The public website
 * never loads auth.js, so for the site the guest book does not exist, and a
 * page of it cannot enumerate the resort's guests.
 *
 * record() itself is open, because it is reached from the one public write
 * the property allows: a guest booking their own stay writes their own row.
 * It cannot read the book back — it matches internally and returns nothing.
 *
 * GOING LIVE. This is a table, and these are its endpoints. Note that the
 * guest-facing one only ever writes:
 *
 *   GET    /api/guests?q=          staff only, paginated
 *   GET    /api/guests/:id         staff only, with stay history
 *   PATCH  /api/guests/:id         staff only — notes and tags
 *   DELETE /api/guests/:id         staff only — erasure requests
 *
 * And the obligations that come with holding it: an erasure request has to
 * remove the person while leaving the reservations' financial record intact
 * (remove() below does exactly that), and the whole table belongs behind
 * encryption at rest with access logged.
 */
(function () {
  var KEY = 'hs_guest_profiles_v1';
  var STAFF = ['owner', 'manager', 'desk'];

  function staff() {
    var A = window.HSAuth;
    return !!(A && A.can && A.can('pms', STAFF));
  }

  function refuse(what, fallback) {
    try {
      console.warn('[HSGuests] ' + what + ' refused: no signed-in operator. ' +
        'The guest book is staff-only.');
    } catch (e) {}
    return fallback;
  }

  /* Ungated on purpose — record() has to match a returning guest against the
     book without being able to hand the book to anyone. Everything exported
     for reading goes through the gate above. */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('hs-guests', { detail: list.length })); } catch (e) {}
    return list;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* ---- Identity --------------------------------------------------------
     Which of the three keys a booking gives us, in order of how much we can
     trust it. Two people at one address is rarer than one person with two
     phones, and both are rarer than two guests called Sharma. */
  function emailKey(v) {
    var e = String(v || '').trim().toLowerCase();
    return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e) ? 'email:' + e : '';
  }

  function phoneKey(v) {
    var d = String(v || '').replace(/\D/g, '');
    /* Shorter than this is a extension or a typo, not a reachable number. */
    return d.length >= 7 ? 'phone:' + d.slice(-10) : '';
  }

  function nameKey(v) {
    var n = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return n ? 'name:' + n : '';
  }

  /* Every key a booking could be matched on, best first. */
  function keysFor(rec) {
    return [emailKey(rec.email), phoneKey(rec.phone), nameKey(rec.guest || rec.name)]
      .filter(Boolean);
  }

  /* A profile answers to every key it has ever been seen under, so a guest
     who booked by phone in March and by email in June is one person. */
  function matchIn(list, keys) {
    for (var i = 0; i < keys.length; i++) {
      for (var j = 0; j < list.length; j++) {
        if ((list[j].keys || []).indexOf(keys[i]) > -1) return list[j];
      }
    }
    return null;
  }

  function newId(list) {
    var n = 1;
    var used = list.map(function (p) { return p.id; });
    while (used.indexOf('hg-' + String(1000 + n)) > -1) n++;
    return 'hg-' + String(1000 + n);
  }

  /* Never overwrite something we know with something we do not. A walk-in
     with no email should not blank the address they gave last year. */
  function better(existing, incoming) {
    var v = String(incoming || '').trim();
    return v || existing || '';
  }

  /* ---- Writing ---------------------------------------------------------
     Called by bookings.js for every reservation it accepts. Idempotent on
     the booking reference: re-recording the same reservation updates that
     stay rather than adding a second one, so a booking that is amended does
     not inflate somebody's history. Returns the profile id, nothing more. */
  function record(b) {
    if (!b || !(b.guest || b.email || b.phone)) return null;
    var list = load();
    var keys = keysFor(b);
    if (!keys.length) return null;

    var p = matchIn(list, keys);
    var now = Date.now();

    if (!p) {
      p = {
        id: newId(list),
        keys: [],
        name: String(b.guest || '').trim(),
        email: '', phone: '', country: '',
        firstSeen: now, lastSeen: now,
        stays: [], notes: '', tags: []
      };
      list.push(p);
    }

    /* Learn every new way of reaching them. */
    keys.forEach(function (k) { if (p.keys.indexOf(k) === -1) p.keys.push(k); });
    p.name = better(p.name, b.guest);
    p.email = better(p.email, b.email);
    p.phone = better(p.phone, b.phone);
    p.country = better(p.country, b.country);
    p.lastSeen = now;

    var stay = {
      ref: b.ref,
      checkIn: b.checkIn,
      nights: b.nights,
      nightsBilled: b.nightsBilled || b.nights,
      category: b.category,
      categoryName: b.categoryName || '',
      roomCount: b.roomCount || 1,
      adults: b.adults || 0,
      children: b.children || 0,
      meal: b.meal || '',
      total: b.total || 0,
      paid: b.paid || 0,
      source: b.source || '',
      status: b.status || 'confirmed',
      at: now
    };
    var at = -1;
    for (var i = 0; i < p.stays.length; i++) if (p.stays[i].ref === b.ref) at = i;
    if (at > -1) stay.at = p.stays[at].at;
    if (at > -1) p.stays[at] = stay; else p.stays.push(stay);

    save(list);
    return p.id;
  }

  /* A reservation that moved on — checked out, shortened, cancelled — so the
     history reads as what happened rather than what was sold. Called by
     bookings.js whenever a record changes; silent if nobody matches. */
  function touch(ref, patch) {
    var list = load(), hit = false;
    list.forEach(function (p) {
      (p.stays || []).forEach(function (s) {
        if (s.ref !== ref) return;
        hit = true;
        ['status', 'nightsBilled', 'total', 'paid', 'refund'].forEach(function (f) {
          if (patch && patch[f] !== undefined) s[f] = patch[f];
        });
      });
    });
    if (hit) save(list);
    return hit;
  }

  /* ---- Derived figures -------------------------------------------------
     Computed on read, never stored, so they cannot drift from the stays they
     come from. A cancelled stay counts for nothing. */
  function held(s) { return s.status !== 'cancelled'; }

  function enrich(p) {
    var kept = (p.stays || []).filter(held);
    var nights = kept.reduce(function (t, s) {
      return t + Math.max(1, s.nightsBilled || s.nights || 1) * Math.max(1, s.roomCount || 1);
    }, 0);
    var spend = kept.reduce(function (t, s) { return t + (s.total || 0); }, 0);
    var paid = kept.reduce(function (t, s) { return t + (s.paid || 0); }, 0);
    var sorted = kept.slice().sort(function (a, b) {
      return String(a.checkIn || '').localeCompare(String(b.checkIn || ''));
    });
    var c = clone(p);
    c.stays = sorted.reverse();
    c.cancelled = (p.stays || []).length - kept.length;
    c.staysCount = kept.length;
    c.nights = nights;
    c.spend = spend;
    c.paid = paid;
    c.outstanding = Math.max(0, spend - paid);
    c.returning = kept.length > 1;
    c.firstStay = sorted.length ? sorted[sorted.length - 1].checkIn : '';
    c.lastStay = sorted.length ? sorted[0].checkIn : '';
    /* Ordinal the desk actually says out loud: "their third stay". */
    c.ordinal = kept.length === 1 ? 'First stay'
      : kept.length === 2 ? 'Second stay'
      : kept.length === 3 ? 'Third stay'
      : kept.length + ' stays';
    return c;
  }

  /* ---- Reading: operators only ----------------------------------------- */

  function all() {
    if (!staff()) return refuse('all', []);
    return load().map(enrich).sort(function (a, b) { return b.lastSeen - a.lastSeen; });
  }

  function get(id) {
    if (!staff()) return refuse('get', null);
    var p = load().filter(function (x) { return x.id === id; })[0];
    return p ? enrich(p) : null;
  }

  /* The desk's lookup: who is this, before they reach the counter. */
  function find(rec) {
    if (!staff()) return refuse('find', null);
    var p = matchIn(load(), keysFor(rec || {}));
    return p ? enrich(p) : null;
  }

  /* How many stays this reservation's guest has had, counting this one.
     Used on the reservations list, where the answer is a badge and not a
     reason to open a profile. */
  function historyFor(rec) {
    if (!staff()) return null;
    var p = matchIn(load(), keysFor(rec || {}));
    return p ? enrich(p) : null;
  }

  function search(q) {
    if (!staff()) return refuse('search', []);
    var t = String(q || '').trim().toLowerCase();
    var list = all();
    if (!t) return list;
    return list.filter(function (p) {
      return [p.name, p.email, p.phone, p.country, p.notes]
        .concat((p.tags || []), (p.stays || []).map(function (s) { return s.ref; }))
        .join(' ').toLowerCase().indexOf(t) > -1;
    });
  }

  function stats() {
    if (!staff()) return refuse('stats', { total: 0, returning: 0, nights: 0, spend: 0 });
    var list = all();
    return {
      total: list.length,
      returning: list.filter(function (p) { return p.returning; }).length,
      nights: list.reduce(function (t, p) { return t + p.nights; }, 0),
      spend: list.reduce(function (t, p) { return t + p.spend; }, 0),
      outstanding: list.reduce(function (t, p) { return t + p.outstanding; }, 0)
    };
  }

  /* ---- Editing: operators only ----------------------------------------- */

  function patch(id, fields) {
    var list = load(), hit = false;
    list.forEach(function (p) {
      if (p.id !== id) return;
      hit = true;
      Object.keys(fields).forEach(function (k) { p[k] = fields[k]; });
    });
    if (hit) save(list);
    return hit;
  }

  function setNotes(id, text) {
    if (!staff()) return refuse('setNotes', false);
    return patch(id, { notes: String(text || '').slice(0, 2000) });
  }

  /* Short flags the desk works from — a dietary note, a mobility note, a
     preference. Free text, because every property's list is different. */
  function setTags(id, tags) {
    if (!staff()) return refuse('setTags', false);
    var clean = (Array.isArray(tags) ? tags : String(tags || '').split(','))
      .map(function (t) { return String(t).trim().slice(0, 40); })
      .filter(Boolean).slice(0, 12);
    return patch(id, { tags: clean });
  }

  /* An erasure request. The person goes; the reservations stay, because the
     property has to be able to account for money it took. What is left is a
     reservation with a name on it and nobody to tie it to. */
  function remove(id) {
    if (!staff()) return refuse('remove', false);
    var list = load();
    var next = list.filter(function (p) { return p.id !== id; });
    if (next.length === list.length) return false;
    save(next);
    return true;
  }

  function clear() {
    if (!staff()) return refuse('clear', false);
    save([]);
    return true;
  }

  function subscribe(fn) {
    var onLocal = function () { fn(); };
    var onStore = function (e) { if (!e.key || e.key === KEY) fn(); };
    window.addEventListener('hs-guests', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-guests', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  window.HSGuests = {
    KEY: KEY,
    record: record, touch: touch,
    all: all, get: get, find: find, historyFor: historyFor, search: search, stats: stats,
    setNotes: setNotes, setTags: setTags, remove: remove, clear: clear,
    subscribe: subscribe
  };
})();
