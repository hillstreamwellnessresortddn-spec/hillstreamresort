/* Hill Stream — guest-submitted reviews.
 *
 * Separate from reviews.js on purpose. reviews.js holds what GOOGLE returns:
 * five reviews maximum, chosen by Google, shown as written, under Google
 * attribution. This file holds reviews the resort collects itself, which it
 * may moderate, reply to, and publish with guest photographs.
 *
 * The two must never be merged or averaged into one rating — Google's terms
 * forbid presenting non-Google text under Google attribution.
 *
 * One record, three states:
 *
 *   hs_guest_reviews_v1 — every submission ever received.
 *     status: 'pending'  → sitting in the CMS queue, invisible to the site
 *             'approved' → published
 *             'rejected' → kept for the audit trail, never rendered
 *
 * Photographs carry their OWN status, so a moderator can publish a review and
 * keep two of its five pictures back. approved() returns only approved reviews
 * carrying only their approved photos, so a page can render it directly.
 *
 * Going live: replace load()/save() with calls to your own API. The shapes
 * below are what the endpoints should speak, so nothing else has to change.
 *
 *   GET  /api/guest-reviews             → approved only, public
 *   GET  /api/guest-reviews?status=pending  → the queue, staff auth required
 *   POST /api/guest-reviews             → a submission (signed stay token)
 *   PATCH /api/guest-reviews/:id        → { status, reply }
 *   PATCH /api/guest-reviews/:id/photos/:photoId → { status }
 *
 * Photographs here are downscaled data URLs in localStorage, which is a
 * prototype convenience and nothing more. In production they belong in object
 * storage behind signed upload URLs, with EXIF stripped server-side.
 */
(function () {
  var KEY = 'hs_guest_reviews_v1';
  var MAX_PHOTOS = 5;
  var MAX_EDGE = 1000;
  var QUALITY = 0.72;

  /* Clips. A guest's phone video is tens of megabytes, and localStorage holds
     about five in total — so the prototype accepts a clip, keeps a poster
     frame it can always persist, and stores the clip itself only if it fits.
     Anything larger stays playable for the session and degrades to its poster
     on reload. In production the file goes to object storage behind a signed
     upload and none of this applies; MAX_CLIP_BYTES is the real limit to
     enforce server-side. */
  var MAX_CLIP_BYTES = 40 * 1024 * 1024;
  var STORE_CLIP_BYTES = 2.4 * 1024 * 1024;
  var VIDEO_TYPES = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;
  var POSTER_EDGE = 900;

  var SEED = [
    {
      id: 'g-1001', author: 'Priya Menon', place: 'Kochi',
      stay: 'Stream View Room, February 2026', rating: 5,
      text: 'We came for three nights and left having done almost nothing, which was the point. The stove was lit before we got back from the walk each afternoon and nobody once asked how our stay was going — they just watched and got it right.',
      submitted: '2026-03-02T09:14:00.000Z', status: 'approved',
      reply: 'Thank you Priya — the stove is Devi\'s doing, and she will be pleased to hear it.',
      photos: []
    },
    {
      id: 'g-1002', author: 'Tobias Lang', place: 'Berlin',
      stay: 'Premium Valley View Room, January 2026', rating: 5,
      text: 'The window in the Premium Valley View Room faces east and I watched the light come up over the ridge four mornings running. Bring warmer clothes than you think you need in January. The yoga at half six is cold and worth it.',
      submitted: '2026-02-11T06:40:00.000Z', status: 'approved', reply: '',
      photos: []
    },
    {
      id: 'g-1003', author: 'Meera & Anand Iyer', place: 'Bengaluru',
      stay: 'Premium Suite Room, December 2025', rating: 4,
      text: 'Beautiful place, genuinely excellent kitchen, and the sun deck is worth the suite on its own. One honest note for anyone booking with older parents: the walk down to the lower rooms is steep and unlit after dark. We asked and were moved up the same evening.',
      submitted: '2026-01-08T17:02:00.000Z', status: 'approved',
      reply: 'Noted and fair — lighting along the lower path goes in before the monsoon.',
      photos: []
    },
    {
      id: 'g-1004', author: 'Nikhil Sharma', place: 'Gurugram',
      stay: 'Deluxe View Room, March 2026', rating: 5,
      text: 'Third time here. The ground floor room is the quiet one nobody books and I am not sure why I am telling you that. Breakfast at the stream pavilion until ten, which suits how I actually behave on holiday.',
      submitted: '2026-03-30T11:25:00.000Z', status: 'pending', reply: '',
      photos: []
    },
    {
      id: 'g-1005', author: 'Claire Beaumont', place: 'Lyon',
      stay: 'Stream View Room, March 2026', rating: 5,
      text: 'Five courses at one table with eight strangers and by the second night they were not strangers. The kafuli, twice. I have already sent this place to two friends.',
      submitted: '2026-04-02T14:48:00.000Z', status: 'pending', reply: '',
      photos: []
    }
  ];

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return clone(SEED);
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : clone(SEED);
    } catch (e) { return clone(SEED); }
  }

  function save(list) {
    var ok = true;
    try { localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (e) { ok = false; }
    try { window.dispatchEvent(new CustomEvent('hs-guest-reviews')); } catch (e) {}
    return ok;
  }

  function all() { return load(); }

  function byStatus(status) {
    return load().filter(function (r) { return r.status === status; });
  }

  /* What the public page renders: approved reviews, newest first, carrying
     only the photographs a moderator approved. */
  function approved() {
    return load()
      .filter(function (r) { return r.status === 'approved'; })
      .map(function (r) {
        var c = clone(r);
        c.photos = (r.photos || []).filter(function (p) { return p.status === 'approved'; });
        return c;
      })
      .sort(function (a, b) { return (b.submitted || '').localeCompare(a.submitted || ''); });
  }

  function pending() {
    return byStatus('pending').sort(function (a, b) {
      return (a.submitted || '').localeCompare(b.submitted || '');
    });
  }

  function counts() {
    var list = load();
    var n = { pending: 0, approved: 0, rejected: 0, photos: 0, total: list.length };
    list.forEach(function (r) {
      if (n[r.status] != null) n[r.status]++;
      (r.photos || []).forEach(function (p) { if (p.status === 'pending') n.photos++; });
    });
    return n;
  }

  /* The average of APPROVED guest ratings only. Kept deliberately separate
     from the Google figure — never blend the two. */
  function average() {
    var list = approved();
    if (!list.length) return null;
    var sum = list.reduce(function (t, r) { return t + (r.rating || 0); }, 0);
    return Math.round((sum / list.length) * 10) / 10;
  }

  /* How many undecided submissions the queue will hold. Without a ceiling a
     loop calling submit() fills localStorage and buries the moderator; the
     cap refuses the flood instead, and approved reviews already on the site
     are never dropped to make room. */
  var MAX_PENDING = 60;

  /* A submitted photo is meant to be a file this page ingested, which means a
     data: URL, or a blob: handle for a clip too large to keep. Anything else
     — an http URL to somebody's server, a javascript: string — was not
     produced here, so it is not stored. Otherwise a submission chooses what
     the moderator's browser fetches, and where their view of the queue calls
     out to. */
  function safeMedia(url) {
    var u = String(url || '');
    if (!u) return '';
    if (/^data:(image|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]*$/i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    return '';
  }

  /* A submission always lands as pending, whatever the client sends. Photos
     land pending too, one decision each. */
  function submit(payload) {
    var list = load();

    if (list.filter(function (r) { return r.status === 'pending'; }).length >= MAX_PENDING) {
      return { ok: false, id: '', error: 'The review queue is full just now — please try again later.' };
    }
    var id = 'g-' + Date.now().toString(36);
    var rec = {
      id: id,
      author: (payload.author || '').trim().slice(0, 80),
      place: (payload.place || '').trim().slice(0, 60),
      stay: (payload.stay || '').trim().slice(0, 80),
      rating: Math.max(1, Math.min(5, parseInt(payload.rating, 10) || 5)),
      text: (payload.text || '').trim().slice(0, 2000),
      submitted: new Date().toISOString(),
      status: 'pending',
      reply: '',
      consent: !!payload.consent,
      photos: (payload.photos || []).slice(0, MAX_PHOTOS).map(function (m, i) {
        var it = typeof m === 'string' ? { kind: 'image', url: m } : (m || {});
        return {
          id: id + '-p' + i,
          kind: it.kind === 'video' ? 'video' : 'image',
          url: safeMedia(it.url),
          poster: safeMedia(it.poster),
          bytes: Math.max(0, Math.min(MAX_CLIP_BYTES, Math.round(+it.bytes || 0))),
          duration: Math.max(0, Math.min(36000, +it.duration || 0)),
          status: 'pending',
          alt: ''
        };
      })
    };
    list.push(rec);
    var ok = save(list);
    /* Out of room: drop the clip payloads to their poster frames and keep the
       review rather than losing the submission. */
    if (!ok && rec.photos.some(function (p) { return p.kind === 'video' && p.url; })) {
      rec.photos = rec.photos.map(function (p) {
        return p.kind === 'video' ? Object.assign({}, p, { url: '', trimmed: true }) : p;
      });
      ok = save(list);
      if (ok) {
        return { ok: true, id: id, error: '', note: 'Your clip came through, but this demo browser could only keep its first frame. On the live site the video is stored in full.' };
      }
    }
    return { ok: ok, id: id, error: ok ? '' : 'That was too large to store locally — remove one file and try again.' };
  }

  /* Submitting is public — a guest writes their own review. Deciding what
     the site then shows is not: moderation asks HSAuth.can() for a signed-in
     operator, and the public pages never load auth.js, so a visitor cannot
     approve their own words onto the website. */
  var STAFF = ['owner', 'manager', 'desk'];

  function moderator() {
    var A = window.HSAuth;
    return !!(A && A.can && A.can('pms', STAFF));
  }

  function refuse(what) {
    try {
      console.warn('[HSGuestReviews] ' + what + ' refused: no signed-in operator. ' +
        'Reviews are moderated from the PMS.');
    } catch (e) {}
    return load();
  }

  function patch(id, fields) {
    var list = load().map(function (r) {
      return r.id === id ? Object.assign({}, r, fields) : r;
    });
    save(list);
    return list;
  }

  function setStatus(id, status) {
    if (!moderator()) return refuse('setStatus');
    if (['pending', 'approved', 'rejected'].indexOf(status) === -1) return load();
    return patch(id, { status: status, decided: new Date().toISOString() });
  }

  function setReply(id, reply) {
    if (!moderator()) return refuse('setReply');
    return patch(id, { reply: String(reply || '').slice(0, 2000) });
  }

  function setPhotoStatus(id, photoId, status) {
    if (!moderator()) return refuse('setPhotoStatus');
    if (['pending', 'approved', 'rejected'].indexOf(status) === -1) return load();
    var list = load().map(function (r) {
      if (r.id !== id) return r;
      var c = Object.assign({}, r);
      c.photos = (r.photos || []).map(function (p) {
        return p.id === photoId ? Object.assign({}, p, { status: status }) : p;
      });
      return c;
    });
    save(list);
    return list;
  }

  function remove(id) {
    if (!moderator()) return refuse('remove');
    save(load().filter(function (r) { return r.id !== id; }));
  }

  function reset() {
    if (!moderator()) return refuse('reset');
    save(clone(SEED));
  }

  function subscribe(fn) {
    var onLocal = function () { fn(load()); };
    var onStore = function (e) { if (!e.key || e.key === KEY) fn(load()); };
    window.addEventListener('hs-guest-reviews', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-guest-reviews', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  /* Client-side downscale so a phone photograph does not arrive at 8 MB. In
     production this is a convenience only — the server must re-encode and
     strip EXIF regardless, since nothing from a browser can be trusted. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Not an image'));
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that file')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not read that image')); };
        img.onload = function () {
          var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* A poster frame, so a clip has something to show before it plays and
     something to fall back to if the video itself cannot be kept. */
  function posterFrame(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      var done = false;
      var fail = function (msg) {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        reject(new Error(msg || 'Could not read that clip'));
      };
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.onerror = function () { fail(); };
      v.onloadeddata = function () {
        var t = Math.min(0.8, (v.duration || 2) / 3);
        if (isFinite(t) && t > 0) { try { v.currentTime = t; } catch (e) {} } else { draw(); }
      };
      v.onseeked = draw;
      setTimeout(function () { if (!done) draw(); }, 4000);
      function draw() {
        if (done) return;
        var w0 = v.videoWidth, h0 = v.videoHeight;
        if (!w0 || !h0) return fail();
        done = true;
        var scale = Math.min(1, POSTER_EDGE / Math.max(w0, h0));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w0 * scale));
        cv.height = Math.max(1, Math.round(h0 * scale));
        try {
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
          var poster = cv.toDataURL('image/jpeg', QUALITY);
          URL.revokeObjectURL(url);
          resolve({ poster: poster, duration: v.duration || 0, width: w0, height: h0 });
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(new Error('Could not read that clip'));
        }
      }
      v.src = url;
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onerror = function () { reject(new Error('Could not read that file')); };
      r.onload = function () { resolve(r.result); };
      r.readAsDataURL(file);
    });
  }

  /* One entry point for both kinds. Returns the shape submit() expects:
     { kind, url, poster, bytes, duration }. */
  function ingest(file) {
    if (!file) return Promise.reject(new Error('No file'));
    if (/^image\//.test(file.type)) {
      return shrink(file).then(function (url) {
        return { kind: 'image', url: url, poster: '', bytes: file.size || 0, duration: 0 };
      });
    }
    if (VIDEO_TYPES.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name || '')) {
      if (file.size > MAX_CLIP_BYTES) {
        return Promise.reject(new Error('That clip is over 40 MB — please send a shorter one.'));
      }
      return posterFrame(file).then(function (meta) {
        var out = {
          kind: 'video', url: '', poster: meta.poster,
          bytes: file.size || 0, duration: meta.duration
        };
        if (file.size <= STORE_CLIP_BYTES) {
          return readAsDataURL(file).then(function (url) { out.url = url; return out; });
        }
        /* Too big to persist: playable now, poster after a reload. */
        out.url = URL.createObjectURL(file);
        out.session = true;
        return out;
      });
    }
    return Promise.reject(new Error('Send a JPEG, PNG, or an MP4 clip.'));
  }

  window.HSGuestReviews = {
    KEY: KEY, MAX_PHOTOS: MAX_PHOTOS,
    MAX_CLIP_BYTES: MAX_CLIP_BYTES, ingest: ingest, posterFrame: posterFrame,
    all: all, approved: approved, pending: pending, byStatus: byStatus,
    counts: counts, average: average,
    submit: submit, setStatus: setStatus, setReply: setReply,
    setPhotoStatus: setPhotoStatus, remove: remove, reset: reset,
    subscribe: subscribe, shrink: shrink
  };
})();
