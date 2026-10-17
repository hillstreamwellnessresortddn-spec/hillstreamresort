/* Hill Stream — the single rate source. The PMS writes it; the booking engine
   and the public website read it. Loaded as a classic script in <helmet> so
   rates are available on first paint.

   Reading is open to everyone. Writing is not: set() and reset() ask
   HSAuth.can() for a signed-in operator first, and a page that never loaded
   auth.js — which is every page of the public website — can never satisfy
   that. So prices, inventory and stop-sell move in one direction only, out of
   the PMS, and the site is a reader of this record and nothing more.

   GOING LIVE: GET /api/rates is public and cacheable; PUT /api/rates is
   staff-only and re-validates every field server-side. */
(function () {
  var KEY = 'hs_rates_v1';
  var STAFF = ['owner', 'manager', 'desk'];

  function staff() {
    var A = window.HSAuth;
    return !!(A && A.can && A.can('pms', STAFF));
  }

  var DEFAULTS = {
    categories: [
      { id: 'deluxe-view', name: 'Deluxe View Room', rooms: 8, size: '', base: 5500, weekend: 5500, minStay: 1, stopSell: false },
      { id: 'premium-valley', name: 'Premium Valley View Room', rooms: 8, size: '', base: 6000, weekend: 6000, minStay: 1, stopSell: false },
      { id: 'deluxe-suite', name: 'Deluxe Suite Room', rooms: 6, size: '', base: 6700, weekend: 6700, minStay: 1, stopSell: false },
      { id: 'jungle-view', name: 'Jungle View Room', rooms: 6, size: '', base: 6700, weekend: 6700, minStay: 1, stopSell: false },
      { id: 'premium-suite', name: 'Premium Suite Room', rooms: 6, size: '', base: 7300, weekend: 7300, minStay: 1, stopSell: false },
      { id: 'stream-view', name: 'Stream View Room', rooms: 6, size: '', base: 8600, weekend: 8600, minStay: 1, stopSell: false },
      { id: 'signature', name: 'Hill Stream Signature Room', rooms: 4, size: '', base: 9100, weekend: 9100, minStay: 1, stopSell: false }
    ],
    seasons: [
      { id: 'peak', name: 'Peak — autumn', from: '10-01', to: '11-15', adjust: 25 },
      { id: 'shoulder', name: 'Shoulder — spring', from: '03-01', to: '04-30', adjust: 10 },
      { id: 'monsoon', name: 'Monsoon', from: '07-01', to: '08-31', adjust: -20 }
    ],
    /* Meal plans are priced per guest per night; 'none' is the zero-rated
       plan the booking engine falls back to. */
    meals: [
      { id: 'none', name: 'Room only', note: 'No meals included', pp: 0 },
      { id: 'bb', name: 'Breakfast', note: 'Himalayan breakfast at the stream pavilion', pp: 900 },
      { id: 'hb', name: 'Half board', note: 'Breakfast and a set dinner each evening', pp: 2200 },
      { id: 'fb', name: 'Full board', note: 'All meals, Ayurvedic menu on request', pp: 3400 }
    ],
    /* per: 'stay' charges once, 'night' multiplies by the length of stay. */
    extras: [
      { id: 'spa1', name: 'Himalayan oil ritual', note: '90 minutes, per guest', price: 4500, per: 'stay' },
      { id: 'spa2', name: 'Stream stone therapy', note: '75 minutes, per guest', price: 5200, per: 'stay' },
      { id: 'pkg', name: 'Three-day reset', note: 'Consultation, daily yoga, two treatments', price: 12000, per: 'stay' },
      { id: 'transfer', name: 'Dehradun airport transfer', note: 'Private car, both ways', price: 3500, per: 'stay' },
      { id: 'bed', name: 'Extra bed', note: 'Per night', price: 1800, per: 'night' },
      { id: 'early', name: 'Early check-in', note: 'From 09:00, subject to availability', price: 2000, per: 'stay' },
      { id: 'late', name: 'Late check-out', note: 'Until 18:00', price: 2000, per: 'stay' }
    ],
    /* GST: rooms are taxed at the low rate up to the threshold ADR and the
       high rate above it; services carry their own rate. */
    tax: { roomLow: 12, roomHigh: 18, threshold: 7500, services: 18, deposit: 25 }
  };

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  /* One-time repair: category inventory moved to forty-four rooms. A stored
     rate plan shadows DEFAULTS, so carry the new counts across without
     touching prices an operator may have edited. Runs once. */
  try {
    var MIG_44 = 'hs_rates_mig_rooms_44';
    if (!localStorage.getItem(MIG_44)) {
      var rawM = localStorage.getItem(KEY);
      if (rawM) {
        var recM = JSON.parse(rawM);
        if (recM && recM.categories) {
          DEFAULTS.categories.forEach(function (d) {
            recM.categories.forEach(function (c) { if (c.id === d.id) c.rooms = d.rooms; });
          });
          localStorage.setItem(KEY, JSON.stringify(recM));
        }
      }
      localStorage.setItem(MIG_44, '1');
    }
  } catch (e) {}

  /* One-time repair: the four placeholder categories were replaced by the
     resort's real seven rooms. Rates stored against the old ids describe
     rooms that do not exist, so the category list is swapped for the new
     defaults; meals, extras, seasons and tax an operator set are kept. */
  try {
    var MIG_REAL = 'hs_rates_mig_real_rooms_v1';
    if (!localStorage.getItem(MIG_REAL)) {
      var rawR = localStorage.getItem(KEY);
      if (rawR) {
        var recR = JSON.parse(rawR);
        if (recR) {
          recR.categories = clone(DEFAULTS.categories);
          localStorage.setItem(KEY, JSON.stringify(recR));
        }
      }
      localStorage.setItem(MIG_REAL, '1');
    }
  } catch (e) {}

  /* A record written by an older build can be missing whole sections, so
     anything absent falls back to the shipped defaults rather than leaving
     the booking engine with no meal plans or no tax rates. */
  function get() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.categories && p.categories.length) {
          if (!p.meals || !p.meals.length) p.meals = clone(DEFAULTS.meals);
          if (!p.extras || !p.extras.length) p.extras = clone(DEFAULTS.extras);
          p.tax = Object.assign(clone(DEFAULTS.tax), p.tax || {});
          return p;
        }
      }
    } catch (e) {}
    return clone(DEFAULTS);
  }

  function meals(state) { return (state || get()).meals || clone(DEFAULTS.meals); }

  function extras(state) { return (state || get()).extras || clone(DEFAULTS.extras); }

  function tax(state) {
    return Object.assign(clone(DEFAULTS.tax), (state || get()).tax || {});
  }

  /* Room tax follows the achieved nightly rate; services are flat. */
  function taxFor(roomTotal, serviceTotal, adr, state) {
    var t = tax(state);
    var roomRate = (adr > t.threshold ? t.roomHigh : t.roomLow) / 100;
    return {
      roomRate: roomRate,
      serviceRate: t.services / 100,
      amount: roomTotal * roomRate + serviceTotal * (t.services / 100)
    };
  }

  /* Numbers a rate plan may hold. Inventory is the important one — it is what
     bookings.js measures availability against, so a negative or fractional
     room count would quietly corrupt every count on the site. */
  function sanitise(next) {
    var s = clone(next || {});
    s.categories = (s.categories || []).map(function (c) {
      return Object.assign({}, c, {
        rooms: Math.max(0, Math.min(999, Math.round(+c.rooms || 0))),
        base: Math.max(0, Math.round(+c.base || 0)),
        weekend: Math.max(0, Math.round(+c.weekend || 0)),
        minStay: Math.max(1, Math.min(30, Math.round(+c.minStay || 1))),
        stopSell: !!c.stopSell
      });
    });
    s.meals = (s.meals || []).map(function (m) {
      return Object.assign({}, m, { pp: Math.max(0, Math.round(+m.pp || 0)) });
    });
    s.extras = (s.extras || []).map(function (x) {
      return Object.assign({}, x, {
        price: Math.max(0, Math.round(+x.price || 0)),
        per: x.per === 'night' ? 'night' : 'stay'
      });
    });
    s.seasons = (s.seasons || []).map(function (w) {
      return Object.assign({}, w, { adjust: Math.max(-90, Math.min(300, Math.round(+w.adjust || 0))) });
    });
    var t = Object.assign(clone(DEFAULTS.tax), s.tax || {});
    s.tax = {
      roomLow: Math.max(0, Math.min(50, +t.roomLow || 0)),
      roomHigh: Math.max(0, Math.min(50, +t.roomHigh || 0)),
      threshold: Math.max(0, Math.round(+t.threshold || 0)),
      services: Math.max(0, Math.min(50, +t.services || 0)),
      deposit: Math.max(0, Math.min(100, Math.round(+t.deposit || 0)))
    };
    return s;
  }

  function set(next) {
    if (!staff()) {
      try {
        console.warn('[HSRates] write refused: no signed-in operator. ' +
          'Rates and inventory are written from the PMS.');
      } catch (e) {}
      return get();
    }
    var clean = sanitise(next);
    try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('hs-rates', { detail: clean })); } catch (e) {}
    return clean;
  }

  function reset() { return set(clone(DEFAULTS)); }

  function subscribe(fn) {
    var onLocal = function () { fn(get()); };
    var onStore = function (e) { if (!e.key || e.key === KEY) fn(get()); };
    window.addEventListener('hs-rates', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-rates', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  function cat(id, state) {
    var s = state || get();
    for (var i = 0; i < s.categories.length; i++) if (s.categories[i].id === id) return s.categories[i];
    return null;
  }

  function md(d) {
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* Season windows are month-day, so they repeat every year. A window whose
     end falls before its start wraps across the new year. */
  function seasonFor(date, state) {
    var s = state || get(), key = md(date);
    for (var i = 0; i < s.seasons.length; i++) {
      var w = s.seasons[i];
      var inside = w.from <= w.to ? (key >= w.from && key <= w.to) : (key >= w.from || key <= w.to);
      if (inside) return w;
    }
    return null;
  }

  /* The rate a single night sells at: weekday or weekend base, then the
     season adjustment, rounded to the nearest hundred. */
  function rateFor(catId, date, state) {
    var s = state || get(), c = cat(catId, s);
    if (!c) return 0;
    var day = date.getDay();
    var raw = (day === 5 || day === 6) ? c.weekend : c.base;
    var season = seasonFor(date, s);
    if (season) raw = raw * (1 + season.adjust / 100);
    return Math.round(raw / 100) * 100;
  }

  function stayTotal(catId, checkIn, nights, rooms, state) {
    var s = state || get(), total = 0;
    for (var i = 0; i < nights; i++) {
      var d = new Date(checkIn);
      d.setDate(d.getDate() + i);
      total += rateFor(catId, d, s);
    }
    return total * (rooms || 1);
  }

  function lowestBase(state) {
    var s = state || get();
    return s.categories.filter(function (c) { return !c.stopSell; })
      .reduce(function (m, c) { return Math.min(m, c.base); }, Infinity);
  }

  function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

  window.HSRates = {
    KEY: KEY, DEFAULTS: DEFAULTS,
    get: get, set: set, reset: reset, subscribe: subscribe,
    cat: cat, seasonFor: seasonFor, rateFor: rateFor,
    stayTotal: stayTotal, lowestBase: lowestBase, inr: inr,
    meals: meals, extras: extras, tax: tax, taxFor: taxFor
  };
})();
