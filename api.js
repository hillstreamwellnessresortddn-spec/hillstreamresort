/* Hill Stream — the browser's side of the server.
 *
 * Load this AFTER the domain modules. It does three things and then gets out
 * of the way:
 *
 *   1. HYDRATES. One request at boot fetches everything this page is allowed
 *      to see and writes it into the same localStorage keys the modules
 *      already read, then fires the same events they already subscribe to. So
 *      every page updates itself with no change to how it renders.
 *
 *   2. REDIRECTS WRITES. Each mutating method is wrapped so the change is
 *      made on the server, against the database, under the session in the
 *      cookie. The local call still runs first, so the screen responds at
 *      once — but if the server refuses, the local change is rolled back by
 *      re-reading the truth. The screen can be optimistic; the record cannot.
 *
 *   3. KEEPS THEM IN STEP. A poll picks up what another tab, the desk or the
 *      website did, so two screens open on the same property agree.
 *
 * WHAT LOCALSTORAGE IS NOW. A cache, and only a cache. It is what the page
 * draws before the first response arrives, and it is authoritative for
 * nothing. Staff-only documents are deliberately never written to it — a
 * guest book that outlived its session in some browser's storage is exactly
 * the sort of thing this migration was meant to end.
 */
(function () {
  var BASE = '/api';

  /* Documents that must never be cached to disk, because they are only ever
     served to a signed-in operator. They live in memory for the life of the
     page and leave with it. */
  var MEMORY_ONLY = { hs_content_draft_v1: 1, hs_guest_profiles_v1: 1, hs_guest_reviews_v1: 1 };
  var mem = {};

  /* The modules read localStorage directly, so the cache has to be
     localStorage — except for the keys above, which are answered from memory
     instead. Installed by shadowing the two methods the modules use. */
  var realGet = localStorage.getItem.bind(localStorage);
  var realSet = localStorage.setItem.bind(localStorage);
  var realRemove = localStorage.removeItem.bind(localStorage);

  localStorage.getItem = function (k) {
    if (MEMORY_ONLY[k]) return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    return realGet(k);
  };
  localStorage.setItem = function (k, v) {
    if (MEMORY_ONLY[k]) { mem[k] = String(v); return; }
    return realSet(k, v);
  };
  localStorage.removeItem = function (k) {
    if (MEMORY_ONLY[k]) { delete mem[k]; return; }
    return realRemove(k);
  };

  /* Anything staff-only that a previous build left on disk goes now. */
  try {
    Object.keys(MEMORY_ONLY).forEach(function (k) { realRemove(k); });
  } catch (e) {}

  function fire(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
  }

  function put(key, value, event) {
    if (value === undefined || value === null) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    if (event) fire(event, value);
  }

  function request(path, options) {
    return fetch(BASE + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {})).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        return { status: r.status, ok: r.ok, body: body };
      });
    });
  }

  /* Calls one of the operations the server is willing to run. Resolves to
     { ok, result } or { ok:false, error } — never throws for a refusal,
     because a refusal is an answer. */
  function call(op, args) {
    return request('/call', {
      method: 'POST',
      body: JSON.stringify({ op: op, args: args || [] })
    }).then(function (r) {
      if (r.status === 401) onSignedOut();
      return r.body || { ok: false, error: 'No answer from the server.' };
    }, function () {
      return { ok: false, error: 'The server is not reachable.', offline: true };
    });
  }

  var session = null;
  var listeners = [];

  function onSignedOut() {
    if (!session) return;
    session = null;
    mem = {};
    listeners.forEach(function (fn) { try { fn(null); } catch (e) {} });
  }

  /* Everything this page may see, in one request. Staff-only documents come
     back only when the cookie says they may. */
  function hydrate() {
    return request('/snapshot').then(function (r) {
      var s = r.body;
      if (!s) return null;
      var had = session;
      session = s.session || null;
      if (had && !session) onSignedOut();
      else if (!had && session) listeners.forEach(function (fn) { try { fn(session); } catch (e) {} });

      put('hs_rates_v1', s.rates, 'hs-rates');
      put('hs_content_pub_v1', s.content, 'hs-content-pub');
      put('hs_content_draft_v1', s.contentDraft, 'hs-content-draft');
      put('hs_bookings_v1', s.bookings, 'hs-bookings');
      put('hs_guest_reviews_v1', s.reviewsAll || s.reviews, 'hs-guest-reviews');
      put('hs_guest_profiles_v1', s.guests, 'hs-guests');
      window.HSApi.passwordChangedAt = s.passwordChangedAt || null;
      return s;
    }, function () { return null; });
  }

  /* ---- Making the writes land on the server -----------------------------
     Each of these runs locally first — which is what makes the screen feel
     immediate — and then asks the server to do the same thing for real. If
     the server says no, hydrate() puts the truth back and the optimistic
     change disappears. */
  var WRAP = [
    ['HSRates', 'set', 'rates.set'],
    ['HSRates', 'reset', 'rates.reset'],
    ['HSContent', 'saveDraft', 'content.saveDraft'],
    ['HSContent', 'publish', 'content.publish'],
    ['HSContent', 'discard', 'content.discard'],
    ['HSContent', 'reset', 'content.reset'],
    ['HSBookings', 'update', 'bookings.update'],
    ['HSBookings', 'assignRoom', 'bookings.assignRoom'],
    ['HSBookings', 'departEarly', 'bookings.departEarly'],
    ['HSBookings', 'cancel', 'bookings.cancel'],
    ['HSBookings', 'remove', 'bookings.remove'],
    ['HSBookings', 'clear', 'bookings.clear'],
    ['HSGuestReviews', 'setStatus', 'reviews.setStatus'],
    ['HSGuestReviews', 'setReply', 'reviews.setReply'],
    ['HSGuestReviews', 'setPhotoStatus', 'reviews.setPhotoStatus'],
    ['HSGuestReviews', 'remove', 'reviews.remove'],
    ['HSGuests', 'setNotes', 'guests.setNotes'],
    ['HSGuests', 'setTags', 'guests.setTags'],
    ['HSGuests', 'remove', 'guests.remove']
  ];

  WRAP.forEach(function (w) {
    var obj = window[w[0]];
    if (!obj || typeof obj[w[1]] !== 'function') return;
    var local = obj[w[1]];
    obj[w[1]] = function () {
      var args = Array.prototype.slice.call(arguments);
      var optimistic = local.apply(obj, args);
      call(w[2], args).then(function (r) {
        /* Either way the server now holds the truth; read it back. A refusal
           undoes the optimistic change, and a success settles any detail the
           server decided differently. */
        hydrate();
        if (!r.ok && r.error) {
          try { console.warn('[HSApi] ' + w[2] + ' refused: ' + r.error); } catch (e) {}
        }
      });
      return optimistic;
    };
  });

  /* Two writes are not optimistic, because the server decides something the
     browser cannot guess: the reservation's reference, and the review's id.
     Showing a guest a reference that the record does not have would be worse
     than making them wait for the answer. Both return a promise. */
  function serverAuthored(objName, method, op) {
    var obj = window[objName];
    if (!obj || typeof obj[method] !== 'function') return;
    obj[method] = function () {
      var args = Array.prototype.slice.call(arguments);
      return call(op, args).then(function (r) {
        if (!r.ok) return { ok: false, error: r.error || 'That could not be saved.' };
        return hydrate().then(function () { return r.result; });
      });
    };
  }
  serverAuthored('HSBookings', 'add', 'bookings.add');
  serverAuthored('HSGuestReviews', 'submit', 'reviews.submit');

  /* ---- Keeping two screens in agreement ---------------------------------
     A booking taken at the desk should appear on the dashboard without a
     reload. Polling is the honest tool here: no socket to keep alive, and the
     cost is one small request while a tab is actually being looked at. */
  var timer = null;
  function poll(ms) {
    stop();
    timer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      hydrate();
    }, ms || 8000);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') hydrate();
  });

  window.HSApi = {
    call: call,
    request: request,
    hydrate: hydrate,
    passwordChangedAt: null,
    session: function () { return session; },
    onSession: function (fn) { listeners.push(fn); return function () {
      listeners = listeners.filter(function (x) { return x !== fn; });
    }; },
    /* Resolves once the first snapshot has landed, for anything that would
       rather wait than draw a cached figure. */
    ready: null,
    poll: poll, stopPolling: stop
  };

  window.HSApi.ready = hydrate();
  poll(8000);
})();
