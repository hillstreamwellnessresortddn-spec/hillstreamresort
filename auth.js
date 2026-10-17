/* Hill Stream — the browser's view of who is signed in.
 *
 * WHAT THIS FILE NO LONGER IS. It used to hold the account, a PBKDF2 digest
 * of the password, and the key that signed the session token — all of it
 * served to anyone who asked for auth.js. Every rule it enforced ran in the
 * caller's own browser, which is to say it enforced nothing: a console could
 * mint its own token, because it had the key.
 *
 * All of that now lives on the server (server.js) and in the database. There
 * is no secret in this file, and nothing here decides anything. What is left:
 *
 *   - signIn() posts the credentials and lets the server answer. The session
 *     comes back as an HttpOnly cookie, which page script cannot read, cannot
 *     copy, and cannot forge.
 *   - current() and can() report what the server last said, so the interface
 *     knows whether to draw the dashboard or the sign-in screen.
 *   - the clocks are the server's. This file only notices when a request
 *     comes back unauthorised and drops to signed-out.
 *
 * So can() is now a hint for the interface, not a gate. The gate is that
 * every write goes to the server and the server checks the cookie. A page
 * that lies to itself about being signed in simply gets refused.
 */
(function () {
  var STAFF = ['owner', 'manager', 'desk'];

  /* What the server last told us, per app. The PMS and the guest flow keep
     separate views of it so one signing out does not blank the other's
     interface, though both ride the same cookie. */
  var user = null;
  var watchers = [];

  function api() { return window.HSApi || null; }

  function announce() {
    watchers.forEach(function (w) {
      try { if (!user) w(); } catch (e) {}
    });
  }

  /* HSApi hydrates at boot and on every poll; this follows it, so a session
     that ended on the server ends here within a few seconds rather than
     leaving a dashboard sitting open on stale figures. */
  function bind() {
    var A = api();
    if (!A) { setTimeout(bind, 50); return; }
    A.onSession(function (s) {
      var had = user;
      user = s || null;
      if (had && !user) announce();
    });
    if (A.ready && A.ready.then) A.ready.then(function () { user = A.session(); });
    user = A.session();
  }
  bind();

  /* Resolves to { ok:true, user } or { ok:false, error }. The password is
     sent once, over the wire, and is never kept here. */
  function signIn(app, email, pw) {
    var A = api();
    if (!A) return Promise.resolve({ ok: false, error: 'Still starting up — try again in a moment.' });
    return A.request('/session', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: pw })
    }).then(function (r) {
      var b = r.body || {};
      if (!r.ok || !b.ok) return { ok: false, error: b.error || 'Those details do not match an account.', retryIn: b.retryIn };
      user = b.user;
      /* Pick up everything this session may now see. */
      return A.hydrate().then(function () { return { ok: true, user: user }; });
    }, function () {
      return { ok: false, error: 'The server is not reachable.' };
    });
  }

  function signOut(app) {
    var A = api();
    user = null;
    if (!A) return Promise.resolve();
    return A.request('/session', { method: 'DELETE' })
      .then(function () { return A.hydrate(); })
      .catch(function () {});
  }

  /* Changing the password is the server's business: it holds the
     authorisation code and the digest, and it ends every other session for
     the account when the password moves. */
  function changePassword(app, code, next, confirm) {
    var A = api();
    if (!A) return Promise.resolve({ ok: false, error: 'Still starting up — try again in a moment.' });
    return A.request('/password', {
      method: 'POST',
      body: JSON.stringify({ code: code, next: next, confirm: confirm })
    }).then(function (r) {
      var b = r.body || {};
      if (r.status === 401) { user = null; announce(); }
      if (!r.ok || !b.ok) return { ok: false, error: b.error || 'That could not be changed.' };
      return A.hydrate().then(function () { return { ok: true }; });
    }, function () {
      return { ok: false, error: 'The server is not reachable.' };
    });
  }

  /* The live answer, not a cached one. `user` above is kept in step through
     the HSApi.onSession channel, but the order of that channel's listeners is
     not ours to choose: auth.js defers bind() until HSApi exists, so a page
     that subscribes earlier is called BEFORE the line that refreshes `user`,
     and asking current() from inside such a listener returned the previous
     answer — which is how a dashboard could drop back to its sign-in screen a
     poll after signing in, with the session still perfectly good on the
     server. HSApi.session() is already the value that listener volley is
     announcing, so read it and the ordering stops mattering. */
  function current(app) {
    var A = api();
    if (A && typeof A.session === 'function') return A.session() || null;
    return user;
  }
  function touch(app) { return user; }

  /* True when the interface should show operator tools. The server decides
     whether they actually work. */
  function can(app, roles) {
    var u = current(app);
    if (!u) return false;
    if (!roles || !roles.length) return true;
    return roles.indexOf(u.role) > -1;
  }

  function passwordChangedAt() {
    var A = api();
    return A ? A.passwordChangedAt : null;
  }

  function initials(u) {
    if (!u || !u.name) return '';
    return u.name.split(/\s+/).slice(0, 2).map(function (p) { return p[0]; }).join('').toUpperCase();
  }

  /* Calls back when the session ends — because it timed out on the server, or
     because somebody changed the password and ended it. */
  function watch(app, onExpire) {
    if (onExpire) watchers.push(onExpire);
    return function () {
      watchers = watchers.filter(function (w) { return w !== onExpire; });
    };
  }

  window.HSAuth = {
    STAFF: STAFF,
    current: current, touch: touch, signIn: signIn, signOut: signOut,
    changePassword: changePassword, passwordChangedAt: passwordChangedAt,
    can: can, initials: initials, watch: watch
  };
})();
