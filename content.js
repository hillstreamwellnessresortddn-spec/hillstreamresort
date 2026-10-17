/* Hill Stream — the single content source, alongside rates.js.
   The PMS Content tab writes it; the public website reads it.

   Two records, not one:
     hs_content_draft_v1  — what the editor is working on. Nothing reads it
                            except the CMS and its own preview.
     hs_content_pub_v1    — what the website serves. Only Publish writes here.

   Loaded as a classic script in <helmet> so copy is available on first paint.
   Pages that read it fall back to DEFAULTS, so an unpublished site still
   renders the copy it shipped with.

   Two rules hold the one-way street open:

     1. Every write asks HSAuth.can() for a signed-in operator. The public
        pages never load auth.js, so for them the answer is always no — a page
        of the website cannot edit the website.
     2. subscribe() is the SITE's channel and fires on publish only. Typing in
        the CMS moves the draft and wakes nothing public; the live pages
        change at the moment Publish is pressed, and at no other moment.

   The CMS watches subscribeDraft() instead, which is its own business.

   GOING LIVE: GET /api/content is public and serves the published record;
   PUT /api/content/draft and POST /api/content/publish are staff-only. */
(function () {
  var DRAFT = 'hs_content_draft_v1';
  var PUB = 'hs_content_pub_v1';
  var STAFF = ['owner', 'manager', 'desk'];

  function staff() {
    var A = window.HSAuth;
    return !!(A && A.can && A.can('pms', STAFF));
  }

  function refuse(what) {
    try {
      console.warn('[HSContent] ' + what + ' refused: no signed-in operator. ' +
        'Website copy is written and published from the PMS.');
    } catch (e) {}
  }

  var DEFAULTS = {
    home: {
      heroKicker: 'Est. 2019 · Near Rishikesh, Uttarakhand',
      heroTitle: 'A wellness resort in the lower Himalaya',
      heroLede: 'Forty-four rooms above a stream, three hours from Dehradun.',
      heroCta: 'Check availability',
      introKicker: 'The place',
      introTitle: 'The water is the loudest thing here.',
      introBody: 'Everything else is arranged around it. The rooms step down the slope to meet it, the treatment pavilion sits where the sound is steadiest, and dinner is served at one long table at eight, whoever is staying.'
    },
    rooms: {
      kicker: 'Rooms',
      title: 'Forty-four rooms, seven ways to stay',
      lede: "Every room looks out on the hills, the valley, the forest or the stream. Rates below are tonight's, taken from the resort's own rate plan."
    },
    wellness: {
      kicker: 'Wellness',
      title: 'The pavilion',
      lede: 'Two therapists, four treatment rooms, and a consultation before anything is booked. Yoga runs every morning at half past six, included in every stay.'
    },
    dining: {
      kicker: 'Dining',
      title: "One kitchen, one menu, eight o'clock",
      lede: 'Dinner is set, not chosen: five courses from the terraces below the kitchen and whatever the valley has that week. There is no à la carte, and there never has been.'
    },
    gallery: {
      kicker: 'Gallery',
      title: 'The grounds',
      lede: 'Eighteen frames, taken across a year. The monsoon ones are the honest ones.',
      groups: ['Grounds', 'Rooms', 'Wellness', 'Kitchen', 'Leisure'],
      frames: [
        { id: 'g01', caption: 'The stream, below the rooms', group: 'Grounds', season: 'July', ratio: '4 / 3', featured: true, src: 'uploads/photos/g01.jpg' },
        { id: 'g02', caption: 'The resort from the air', group: 'Grounds', season: 'October', ratio: '4 / 3', featured: true, src: 'uploads/photos/g02.jpg' },
        { id: 'g03', caption: 'Treatment pavilion', group: 'Wellness', season: 'March', ratio: '4 / 3', featured: true, src: 'uploads/photos/g03.jpg' },
        { id: 'g04', caption: 'The rooms, from the lawn', group: 'Rooms', season: 'August', ratio: '4 / 3', featured: false, src: 'uploads/photos/g04.jpg' },
        { id: 'g05', caption: 'The games room', group: 'Leisure', season: 'November', ratio: '4 / 3', featured: false, src: 'uploads/photos/g05.jpg' },
        { id: 'g06', caption: 'The deck, after rain', group: 'Grounds', season: 'August', ratio: '4 / 3', featured: true, src: 'uploads/photos/g06.jpg' },
        { id: 'g07', caption: 'Cloud in the valley', group: 'Grounds', season: 'July', ratio: '4 / 3', featured: false, src: 'uploads/photos/g07.jpg' },
        { id: 'g08', caption: 'Tables on the upper lawn', group: 'Kitchen', season: 'May', ratio: '4 / 3', featured: false, src: 'uploads/photos/g08.jpg' },
        { id: 'g09', caption: 'A twin room', group: 'Rooms', season: 'February', ratio: '4 / 3', featured: false, src: 'uploads/photos/g09.jpg' },
        { id: 'g10', caption: 'The gym, morning light', group: 'Wellness', season: 'January', ratio: '4 / 3', featured: false, src: 'uploads/photos/g10.jpg' },
        { id: 'g11', caption: 'Garden side', group: 'Rooms', season: 'June', ratio: '4 / 3', featured: false, src: 'uploads/photos/g11.jpg' },
        { id: 'g12', caption: 'Yoga, half past six', group: 'Wellness', season: 'June', ratio: '4 / 3', featured: true, src: 'uploads/photos/g12.jpg' },
        { id: 'g13', caption: 'The pool, after dark', group: 'Wellness', season: 'November', ratio: '4 / 3', featured: true, src: 'uploads/photos/g13.jpg' },
        { id: 'g14', caption: 'The rooms at dusk', group: 'Rooms', season: 'October', ratio: '4 / 3', featured: false, src: 'uploads/photos/g14.jpg' },
        { id: 'g15', caption: 'Terraces below the road', group: 'Grounds', season: 'March', ratio: '4 / 3', featured: false, src: 'uploads/photos/g15.jpg' },
        { id: 'g16', caption: 'The dining hall', group: 'Kitchen', season: 'December', ratio: '4 / 3', featured: false, src: 'uploads/photos/g16.jpg' },
        { id: 'g17', caption: 'The billiard table', group: 'Leisure', season: 'January', ratio: '4 / 3', featured: false, src: 'uploads/photos/g17.jpg' },
        { id: 'g18', caption: 'From the valley path', group: 'Rooms', season: 'September', ratio: '4 / 3', featured: false, src: 'uploads/photos/g18.jpg' }
      ]
    },
    /* The promotion that opens over the home page. It shows only when it is
       switched on AND has an image; with no image there is nothing to show.
       image is a site path, a URL, or a data: URL uploaded from the PMS. */
    banner: {
      on: true,
      image: '',
      kicker: 'Special offer',
      title: '',
      text: '',
      ctaLabel: 'Book now',
      ctaHref: 'Booking%20Engine.dc.html'
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Shallow-merge each section over DEFAULTS so a record written by an older
     build never drops a field a newer page reads. */
  function hydrate(p) {
    var out = clone(DEFAULTS);
    if (!p) return out;
    Object.keys(out).forEach(function (k) {
      if (!p[k]) return;
      Object.keys(p[k]).forEach(function (f) { out[k][f] = p[k][f]; });
    });
    return out;
  }

  function read(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? hydrate(JSON.parse(raw)) : clone(DEFAULTS);
    } catch (e) { return clone(DEFAULTS); }
  }

  /* Each record has its own event, so a subscriber chooses what wakes it. */
  function write(key, next) {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent(key === PUB ? 'hs-content-pub' : 'hs-content-draft', {
        detail: { key: key }
      }));
    } catch (e) {}
    return next;
  }

  /* Frozen on the way out: what the site is handed is a reading of the
     published record, not a handle on it. A page that tries to edit its own
     copy finds nothing happens, which is the point. */
  function freeze(o) {
    if (o && typeof o === 'object') {
      Object.keys(o).forEach(function (k) { freeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }

  function published() { return freeze(read(PUB)); }
  function draft() { return read(DRAFT); }

  function saveDraft(next) {
    if (!staff()) { refuse('saveDraft'); return draft(); }
    return write(DRAFT, next);
  }

  /* Publish copies the draft over the live record. The draft stays as it is,
     so the two now match and isDirty() goes false. This is the only call in
     the codebase that changes what a visitor sees. */
  function publish() {
    if (!staff()) { refuse('publish'); return published(); }
    var d = draft();
    write(PUB, d);
    return d;
  }

  function discard() {
    if (!staff()) { refuse('discard'); return published(); }
    var live = read(PUB);
    write(DRAFT, live);
    return live;
  }

  function reset() {
    if (!staff()) { refuse('reset'); return published(); }
    write(DRAFT, clone(DEFAULTS));
    write(PUB, clone(DEFAULTS));
    return published();
  }

  function isDirty() {
    return JSON.stringify(draft()) !== JSON.stringify(published());
  }

  /* The website's channel: publish only. Draft keystrokes are not the site's
     business and must never reach it. */
  function subscribe(fn) {
    var onLocal = function () { fn(published()); };
    var onStore = function (e) { if (!e.key || e.key === PUB) fn(published()); };
    window.addEventListener('hs-content-pub', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-content-pub', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  /* The CMS's channel: the draft as it is being written, in this tab or
     another one the same operator has open. */
  function subscribeDraft(fn) {
    var onLocal = function () { fn(draft()); };
    var onStore = function (e) { if (!e.key || e.key === DRAFT) fn(draft()); };
    window.addEventListener('hs-content-draft', onLocal);
    window.addEventListener('storage', onStore);
    return function () {
      window.removeEventListener('hs-content-draft', onLocal);
      window.removeEventListener('storage', onStore);
    };
  }

  /* Frames the site shows, in author order. Featured frames are the subset the
     home page pulls for its strip. */
  function frames(state) { return (state || published()).gallery.frames; }
  function featured(state) { return frames(state).filter(function (f) { return f.featured; }); }
  function slotFor(frame) { return 'hs-gal-' + frame.id; }

  function newFrameId(state) {
    var used = frames(state).map(function (f) { return f.id; });
    var n = 1;
    while (used.indexOf('g' + String(n).padStart(2, '0')) > -1) n++;
    return 'g' + String(n).padStart(2, '0');
  }

  /* One-time repair: the resort has forty-two rooms, not twelve. Stored
     records shadow DEFAULTS, so copy published before the count changed would
     otherwise keep contradicting the rest of the site. Runs once. */
  var MIG = 'hs_content_mig_rooms_42';
  try {
    if (!localStorage.getItem(MIG)) {
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var next = raw.split('Twelve rooms').join('Forty-two rooms');
        if (next !== raw) localStorage.setItem(k, next);
      });
      localStorage.setItem(MIG, '1');
    }
  } catch (e) {}

  /* One-time repair: the gallery captions were rewritten to match the
     photographs actually mounted in each frame. Stored records shadow
     DEFAULTS, so a copy published before the rewrite would keep the old
     captions on the live site. Runs once. */
  var MIG_G = 'hs_content_mig_gallery_captions_1';
  try {
    if (!localStorage.getItem(MIG_G)) {
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var rec;
        try { rec = JSON.parse(raw); } catch (e) { return; }
        if (!rec || !rec.gallery) return;
        rec.gallery.groups = clone(DEFAULTS.gallery.groups);
        rec.gallery.frames = clone(DEFAULTS.gallery.frames);
        localStorage.setItem(k, JSON.stringify(rec));
      });
      localStorage.setItem(MIG_G, '1');
    }
  } catch (e) {}

  /* One-time repair: frames gained a `src` so a photograph shipped with the
     build shows without a manual drop. A record published before that keeps
     frames with no src, so carry the shipped sources across without touching
     captions the user may have edited. Runs once. */
  var MIG_S = 'hs_content_mig_frame_src_1';
  try {
    if (!localStorage.getItem(MIG_S)) {
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var rec;
        try { rec = JSON.parse(raw); } catch (e) { return; }
        if (!rec || !rec.gallery || !rec.gallery.frames) return;
        DEFAULTS.gallery.frames.forEach(function (d) {
          if (!d.src) return;
          var f = rec.gallery.frames.filter(function (x) { return x.id === d.id; })[0];
          if (f && !f.src) f.src = d.src;
        });
        localStorage.setItem(k, JSON.stringify(rec));
      });
      localStorage.setItem(MIG_S, '1');
    }
  } catch (e) {}

  /* One-time repair: the room count moved to forty-four. Stored records shadow
     DEFAULTS, so copy published before the change would keep contradicting the
     rest of the site. Runs once. */
  var MIG_44 = 'hs_content_mig_rooms_44';
  try {
    if (!localStorage.getItem(MIG_44)) {
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var next = raw.split('Forty-two rooms').join('Forty-four rooms');
        if (next !== raw) localStorage.setItem(k, next);
      });
      localStorage.setItem(MIG_44, '1');
    }
  } catch (e) {}

  /* One-time repair: the four placeholder room names gave way to the
     resort's seven real rooms. Copy saved before that still names rooms that
     do not exist, so swap those phrases for the shipped ones. Runs once. */
  var MIG_REAL = 'hs_content_mig_real_rooms_1';
  try {
    if (!localStorage.getItem(MIG_REAL)) {
      var SWAP = [
        ['four ways to stay', 'seven ways to stay'],
        ['The stream, below Vahati', 'The stream, below the rooms'],
        ['Himavat, from the lawn', 'The rooms, from the lawn'],
        ['Moksha, twin room', 'A twin room'],
        ['Anukrah, garden side', 'Garden side'],
        ['Vahati at dusk', 'The rooms at dusk'],
        ['Himavat from the valley path', 'From the valley path'],
        ['Every room faces the valley or the water. None share a wall with a corridor.',
          'Every room looks out on the hills, the valley, the forest or the stream.']
      ];
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var next = raw;
        SWAP.forEach(function (p) { next = next.split(p[0]).join(p[1]); });
        if (next !== raw) localStorage.setItem(k, next);
      });
      localStorage.setItem(MIG_REAL, '1');
    }
  } catch (e) {}

  /* One-time repair: every frame now ships with a photograph in
     uploads/photos, so the gallery is filled whether or not the drop sidecar
     is readable — it is not, once the site is served by server.js, which
     refuses dot-files. A record published before that carries the old srcs (or
     none), so carry the shipped source across for every frame. Captions the
     user may have edited are untouched. Runs once. */
  var MIG_P = 'hs_content_mig_frame_photos_1';
  try {
    if (!localStorage.getItem(MIG_P)) {
      [DRAFT, PUB].forEach(function (k) {
        var raw = localStorage.getItem(k);
        if (!raw) return;
        var rec;
        try { rec = JSON.parse(raw); } catch (e) { return; }
        if (!rec || !rec.gallery || !rec.gallery.frames) return;
        DEFAULTS.gallery.frames.forEach(function (d) {
          var f = rec.gallery.frames.filter(function (x) { return x.id === d.id; })[0];
          if (f) f.src = d.src;
        });
        localStorage.setItem(k, JSON.stringify(rec));
      });
      localStorage.setItem(MIG_P, '1');
    }
  } catch (e) {}

  window.HSContent = {
    DRAFT_KEY: DRAFT, PUB_KEY: PUB, DEFAULTS: DEFAULTS,
    published: published, draft: draft, saveDraft: saveDraft,
    publish: publish, discard: discard, reset: reset,
    isDirty: isDirty, subscribe: subscribe, subscribeDraft: subscribeDraft,
    frames: frames, featured: featured, slotFor: slotFor,
    newFrameId: newFrameId, clone: clone
  };
})();
