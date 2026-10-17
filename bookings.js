/* Hill Stream — reservations created by the booking engine, read and worked
   by the PMS. Prototype-grade: one localStorage record, broadcast in-tab with
   an event and across tabs by the storage event, so a booking taken on the
   guest site shows on the dashboard without a reload.

   This file is also the property's availability authority. A room is not
   "free" because a page says so — it is free because no reservation in this
   record holds it on those nights. The count of rooms in a category comes
   from the rate plan, which only the PMS can write. So:

     inventory  — set in the PMS (rates.js), nowhere else
     sold       — derived from the reservations below, nowhere else
     left       — inventory minus sold, computed, never stored

   which is what makes availability move when, and only when, somebody books.

   Writing is split deliberately:

     add()      public. The one thing a guest may do, and the single funnel
                every booking goes through — website, desk, or OTA capture —
                so the oversell check cannot be walked around.
     everything else is staff-only and asks HSAuth.can() first. On a public
     page HSAuth is not loaded at all, so those calls fail closed.

   GOING LIVE. These become your endpoints, and the oversell check moves
   inside a transaction on the server — a client can always lie about what it
   thinks is free:

     GET   /api/availability?category&checkIn&nights  -> { total, sold, left }
     POST  /api/bookings        { ...record }         -> 201 | 409 sold out
     PATCH /api/bookings/:ref   { room, ... }         -> staff auth required
*/
(function () {
  var KEY = 'hs_bookings_v1';
  var STAFF = ['owner', 'manager', 'desk'];

  /* Every staff-only write asks this first. No HSAuth on the page means the
     page is not an operator tool, and the answer is no. */
  function staff() {
    var A = window.HSAuth;
    return !!(A && A.can && A.can('pms', STAFF));
  }

  function deny(what) {
    try {
      console.warn('[HSBookings] ' + what + ' refused: no signed-in operator. ' +
        'Reservations are worked from the PMS.');
    } catch (e) {}
    return all();
  }

  function all() {
    try {
      var raw = localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('hs-bookings', { detail: list })); } catch (e) {}
    return list;
  }

  /* ---- Dates -----------------------------------------------------------
     Whole local days, counted from the epoch. Parsed by hand because
     new Date('2026-04-07') is UTC midnight, which is the previous day for
     anyone east of London and would shift every stay by one night. */
  function dayNum(ymd) {
    var p = String(ymd || '').split('-');
    if (p.length !== 3) return NaN;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setHours(0, 0, 0, 0);
    return Math.round(d.getTime() / 86400000);
  }

  function todayNum() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.round(d.getTime() / 86400000);
  }

  function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  /* The nights a reservation actually holds. A stay shortened at check-out
     gives its remaining nights back to the calendar, which is why this reads
     nightsBilled and not nights. */
  function heldNights(b) {
    return Math.max(1, +(b.nightsBilled || b.nights) || 1);
  }

  /* Reservations that still hold rooms. A cancelled booking holds nothing. */
  function holding(b) { return b && b.status !== 'cancelled'; }

  /* ---- Availability ----------------------------------------------------
     How many rooms of a category are spoken for at the busiest night of a
     span. The peak is what matters: a room has to be free on every night of
     the stay, so one full night is enough to refuse the whole booking. */
  function soldFor(catId, checkIn, nights, exceptRef) {
    var from = dayNum(checkIn);
    if (isNaN(from)) return 0;
    var to = from + Math.max(1, +nights || 1);
    var list = all().filter(function (b) {
      return holding(b) && b.category === catId && b.ref !== exceptRef && isYmd(b.checkIn);
    });
    var peak = 0;
    for (var d = from; d < to; d++) {
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        var b = list[i], bf = dayNum(b.checkIn);
        if (d >= bf && d < bf + heldNights(b)) n += Math.max(1, +b.roomCount || 1);
      }
      if (n > peak) peak = n;
    }
    return peak;
  }

  /* The rate plan owns the room count. No rate plan loaded means no inventory
     to sell — better to show nothing available than to invent rooms. */
  function inventory(catId) {
    var R = window.HSRates;
    var c = R && R.cat ? R.cat(catId) : null;
    return c ? Math.max(0, +c.rooms || 0) : 0;
  }

  /* Payment methods a record may name. Anything else becomes 'online'. */
  var METHODS = { online: 1, card: 1, cash: 1, upi: 1, transfer: 1, ota: 1 };

  /* ---- Pricing a stay ---------------------------------------------------
     The same arithmetic the booking engine shows the guest, done again here
     where the caller cannot reach it. Meals and extras arrive as names — what
     the guest saw — so they are matched back to the rate plan and anything
     unrecognised is simply not charged.

     Kept deliberately in step with the booking engine's totals(): room nights
     at the plan's rate, meals per guest per night (children at half), extras
     once or per night, then tax on both at the rate the achieved nightly rate
     falls into. */
  function priceStay(cat, rec, nights, rooms) {
    var R = window.HSRates;
    if (!R || !R.stayTotal) return { room: 0, services: 0, total: 0, meal: '', extras: [] };

    var state = R.get ? R.get() : null;
    var room = Math.round(R.stayTotal(cat.id, new Date(rec.checkIn), nights, rooms, state));

    var adults = Math.max(1, Math.min(20, Math.round(+rec.adults || 2)));
    var children = Math.max(0, Math.min(20, Math.round(+rec.children || 0)));
    var guests = adults + children * 0.5;

    var wanted = String(rec.meal || '');
    var meal = (R.meals ? R.meals(state) : []).filter(function (m) {
      return m.name === wanted || m.id === wanted;
    })[0] || null;
    var services = meal ? meal.pp * guests * nights * rooms : 0;

    var asked = Array.isArray(rec.extras) ? rec.extras.map(String).slice(0, 20) : [];
    var chosen = (R.extras ? R.extras(state) : []).filter(function (x) {
      return asked.indexOf(x.name) > -1 || asked.indexOf(x.id) > -1;
    });
    chosen.forEach(function (x) {
      services += x.per === 'night' ? x.price * nights : x.price;
    });

    /* Tax is taken on the unrounded figures and only the stored numbers are
       rounded, so this lands on the same rupee the guest was shown. */
    var adr = nights && rooms ? room / (nights * rooms) : 0;
    var t = R.taxFor ? R.taxFor(room, services, adr, state) : { amount: 0 };

    return {
      room: room, services: Math.round(services),
      total: Math.round(room + services + t.amount),
      meal: meal ? meal.name : '',
      extras: chosen.map(function (x) { return x.name; })
    };
  }

  function availability(catId, checkIn, nights, exceptRef) {
    var total = inventory(catId);
    var sold = soldFor(catId, checkIn, nights, exceptRef);
    return { total: total, sold: sold, left: Math.max(0, total - sold) };
  }

  /* Every category at once, for a page drawing a list of rooms. */
  function availabilityAll(checkIn, nights) {
    var R = window.HSRates;
    var cats = (R && R.get ? R.get().categories : []) || [];
    var out = {};
    cats.forEach(function (c) { out[c.id] = availability(c.id, checkIn, nights); });
    return out;
  }

  /* ---- Creating a reservation ------------------------------------------
     The one public write, so it validates like an endpoint would: shape,
     dates, sane numbers, and a last-moment oversell check against the record
     as it stands right now — not against whatever the page was showing when
     the guest started filling the form.

     Returns { ok:true, ref, booking, list } or { ok:false, error }. */
  function add(rec) {
    rec = rec || {};

    var guest = String(rec.guest || '').trim();
    if (!guest) return { ok: false, error: 'A reservation needs a guest name.' };

    if (!isYmd(rec.checkIn)) return { ok: false, error: 'Check-in must be a date.' };
    if (dayNum(rec.checkIn) < todayNum()) return { ok: false, error: 'Check-in cannot be in the past.' };

    var nights = Math.max(1, Math.min(60, Math.round(+rec.nights || 1)));
    var rooms = Math.max(1, Math.min(10, Math.round(+rec.roomCount || 1)));
    var category = String(rec.category || '');
    if (!category) return { ok: false, error: 'Choose a room category.' };

    var cat = window.HSRates && window.HSRates.cat ? window.HSRates.cat(category) : null;
    if (!cat) return { ok: false, error: 'That room category is not in the rate plan.' };
    if (cat.stopSell) return { ok: false, error: cat.name + ' is not on sale for those dates.' };
    if (nights < Math.max(1, +cat.minStay || 1)) {
      return { ok: false, error: cat.name + ' has a ' + cat.minStay + '-night minimum.' };
    }

    /* The check that makes inventory mean something. */
    var av = availability(category, rec.checkIn, nights);
    if (rooms > av.left) {
      return {
        ok: false,
        error: av.left === 0
          ? cat.name + ' is fully booked for those nights.'
          : 'Only ' + av.left + (av.left === 1 ? ' room' : ' rooms') + ' of ' + cat.name + ' left for those nights.',
        available: av.left
      };
    }

    /* ---- What the stay costs -------------------------------------------
       The caller sends what its own screen added up. For a visitor that is a
       number from a page they control, so it is recomputed here from the rate
       plan and the passed figures are discarded — otherwise a console call
       books the top suite for a rupee and the folio believes it.

       An operator may still state the money: a booking captured from an OTA
       was priced by the OTA, not by this rate plan, and staff() has already
       been established by a signed token. */
    var priced = staff() ? {
      room: Math.max(0, Math.round(+rec.roomTotal || 0)),
      services: Math.max(0, Math.round(+rec.serviceTotal || 0)),
      total: Math.max(0, Math.round(+rec.total || 0))
    } : priceStay(cat, rec, nights, rooms);

    /* Paid is what a gateway reported; with no gateway to ask, the one claim
       worth refusing is one larger than the stay itself. */
    var paid = Math.min(priced.total, Math.max(0, Math.round(+rec.paid || 0)));

    var list = all();
    /* A visitor does not choose their own reference. */
    var ref = (staff() ? String(rec.ref || '').trim() : '') || nextRef();
    if (list.some(function (b) { return b.ref === ref; })) ref = nextRef();

    var now = Date.now();
    /* Built field by field on purpose: nothing a caller passes can set
       status, createdAt, or anything else the record did not ask for. */
    var booking = {
      ref: ref,
      guest: guest,
      email: String(rec.email || ''),
      phone: String(rec.phone || ''),
      country: String(rec.country || ''),
      category: category,
      categoryName: String(rec.categoryName || cat.name || ''),
      /* Stays null until the desk assigns a physical room. */
      room: null,
      checkIn: rec.checkIn,
      nights: nights,
      /* Tracks an early departure so the folio can shorten without losing
         what was originally booked. */
      nightsBilled: nights,
      /* Kept so an early departure can rebuild the folio: room charge, the
         services on top, and how many rooms the rate covered. */
      roomTotal: priced.room,
      serviceTotal: priced.services,
      roomCount: rooms,
      refund: 0,
      adults: Math.max(1, Math.min(20, Math.round(+rec.adults || 2))),
      children: Math.max(0, Math.min(20, Math.round(+rec.children || 0))),
      /* Named from the rate plan, not from the caller, so the folio lines say
         what was actually charged. */
      meal: priced.meal,
      extras: priced.extras,
      total: priced.total,
      paid: paid,
      method: METHODS[String(rec.method || '')] ? String(rec.method) : 'online',
      /* Only an operator can say a booking came from anywhere but the site. */
      source: staff() ? String(rec.source || 'Desk') : 'Website',
      status: 'confirmed',
      notes: String(rec.notes || '').slice(0, 2000),
      createdAt: now
    };

    /* The person, as distinct from the reservation. profiles.js matches them
       against the guest book and either opens a record or adds this stay to
       the one they already have — so a returning guest is recognised whether
       they booked on the website, at the desk, or through an OTA. Written
       before the reservation, so the reservation can carry the profile id.
       Optional: a page that has not loaded profiles.js still takes bookings. */
    try {
      if (window.HSGuests && window.HSGuests.record) {
        booking.profileId = window.HSGuests.record(booking) || null;
      }
    } catch (e) {}

    list.unshift(booking);
    return { ok: true, ref: ref, booking: booking, list: write(list.slice(0, 200)) };
  }

  /* ---- Working a reservation: operators only ---------------------------- */

  /* Fields the desk may change. A patch cannot rewrite the money that was
     taken, the dates that were sold, or the reference. */
  var PATCHABLE = {
    room: 1, notes: 1, checkedIn: 1, nightsBilled: 1, status: 1,
    total: 1, refund: 1, earlyOut: 1, departedAt: 1, meal: 1, phone: 1, email: 1
  };

  function update(ref, patch) {
    if (!staff()) return deny('update');
    var clean = {};
    Object.keys(patch || {}).forEach(function (k) { if (PATCHABLE[k]) clean[k] = patch[k]; });
    var next = write(all().map(function (b) {
      return b.ref === ref ? Object.assign({}, b, clean) : b;
    }));
    /* Keep the guest's history telling the truth: a stay that was shortened,
       settled or cancelled reads that way in the guest book too. */
    try {
      if (window.HSGuests && window.HSGuests.touch) window.HSGuests.touch(ref, clean);
    } catch (e) {}
    return next;
  }

  /* Assigning a physical room is the desk's call, and it will not hand the
     same room to two guests whose stays overlap. */
  function assignRoom(ref, room) {
    if (!staff()) return deny('assignRoom');
    if (!room) return update(ref, { room: null });
    var list = all();
    var b = list.filter(function (x) { return x.ref === ref; })[0];
    if (!b) return list;
    var from = dayNum(b.checkIn), to = from + heldNights(b);
    var clash = list.some(function (o) {
      if (o.ref === ref || o.room !== room || !holding(o) || o.status === 'departed') return false;
      var of = dayNum(o.checkIn);
      return of < to && of + heldNights(o) > from;
    });
    if (clash) {
      try { console.warn('[HSBookings] room ' + room + ' is already held for those nights.'); } catch (e) {}
      return list;
    }
    return update(ref, { room: room });
  }

  /* An early departure shortens the billed stay to the nights actually used
     and rebuilds the folio from the rate plan: the room charge is re-run for
     those nights, services are taken pro rata, tax is recomputed, and
     anything already paid above the new total becomes a refund. */
  function refold(b, n) {
    var R = window.HSRates;
    var rooms = b.roomCount || 1;
    var room = (R && b.category && b.checkIn)
      ? R.stayTotal(b.category, new Date(b.checkIn), n, rooms)
      : Math.round((b.roomTotal || 0) * (n / (b.nights || 1)));
    var services = Math.round((b.serviceTotal || 0) * (n / (b.nights || 1)));
    var adr = n && rooms ? room / (n * rooms) : 0;
    var tax = R ? R.taxFor(room, services, adr).amount : (room + services) * 0.18;
    return Math.round(room + services + tax);
  }

  /* What the folio would become for n nights, without committing it — the
     desk previews the new total and the refund before checking the guest out.
     Always rebuilt from the original roomTotal/nights, so it is idempotent
     even on a record that has already been shortened. */
  function quote(ref, nightsUsed) {
    var rec = all().filter(function (x) { return x.ref === ref; })[0];
    if (!rec) return null;
    var n = Math.max(1, Math.min(rec.nights, nightsUsed));
    var total = n < rec.nights ? refold(rec, n) : (rec.earlyOut ? refold(rec, n) : rec.total);
    var paid = rec.paid || 0;
    return {
      nights: n, total: total, short: n < rec.nights,
      refund: Math.max(0, paid - total), due: Math.max(0, total - paid)
    };
  }

  function departEarly(ref, nightsUsed) {
    if (!staff()) return deny('departEarly');
    var q = quote(ref, nightsUsed);
    if (!q) return all();
    return update(ref, {
      nightsBilled: q.nights,
      total: q.total,
      refund: q.refund,
      status: 'departed',
      earlyOut: q.short,
      departedAt: Date.now()
    });
  }

  /* Cancelling releases the rooms back to the calendar but keeps the record,
     so the night audit can still see what was taken and given back. */
  function cancel(ref) {
    if (!staff()) return deny('cancel');
    return update(ref, { status: 'cancelled' });
  }

  function remove(ref) {
    if (!staff()) return deny('remove');
    return write(all().filter(function (b) { return b.ref !== ref; }));
  }

  function clear() {
    if (!staff()) return deny('clear');
    return write([]);
  }

  function subscribe(fn) {
    var onLocal = function () { fn(all()); };
    var onStore = function (e) { if (!e.key || e.key === KEY) fn(all()); };
    window.addEventListener('hs-bookings', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-bookings', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  function nextRef() {
    return 'HS-26-' + String(5100 + all().length) + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  }

  window.HSBookings = {
    KEY: KEY, all: all, add: add, update: update, assignRoom: assignRoom,
    departEarly: departEarly, quote: quote, cancel: cancel, remove: remove, clear: clear,
    subscribe: subscribe, nextRef: nextRef,
    soldFor: soldFor, inventory: inventory, availability: availability,
    availabilityAll: availabilityAll, dayNum: dayNum, todayNum: todayNum
  };
})();
