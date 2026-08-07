/* ============================================================
   public/premium.js
   Premium entitlement module for Vytreos.

   Loaded as a classic <script> (mirrors family.js / accuracy.js).
   Exposes `window.PREMIUM` so the rest of the SPA can ask
   "is this user on Premium?" and read the tier limits without
   rewriting every gate.

   Entitlement model
   ─────────────────
   • Free (default)      — 10-scan visible history · 1 profile · fast-lane models
   • Premium             — unlimited history · up to 6 profiles · full-model consensus

   Where the flag lives
   ────────────────────
   • Signed-in: `users/{uid}/premium.active` (Firestore, authoritative)
     + a localStorage cache so the UI is instant on reload.
   • Guest: localStorage only (demo/preview mode — no server writes).
   • `PREMIUM.setPremium(true|false)` is a self-serve preview toggle
     (used until real billing is wired). It persists to Firestore when
     a user is signed in, and always writes the local cache.

   UX hooks (host index.html wires the UI onto these)
   ─────────────────────────────────────────────────────
   • `PREMIUM.init()`             — resolve entitlement (called from enterApp)
   • `PREMIUM.isPremium()`        — sync boolean
   • `PREMIUM.historyLimit()`     — max scans shown in lists (10 | ∞)
   • `PREMIUM.familyLimit()`      — max family profiles (1 | 6)
   • `PREMIUM.fullBoard()`        — true when premium model consensus is allowed
   • `PREMIUM.setPremium(bool)`   — preview toggle (demo until billing)
   • `PREMIUM.subscribe(fn)`      — re-render hooks when status changes
   ───────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  var LS_KEY = 'vytreos.premium.v1';
  var FREE_HISTORY = 10;
  var PREMIUM_HISTORY = Infinity;
  var FREE_FAMILY = 1;
  var PREMIUM_FAMILY = 6;

  var state = {
    uid: null,
    premium: false,
    source: 'default' // 'firestore' | 'cache' | 'default'
  };

  var listeners = [];
  function emit(evt, payload) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](evt, payload); } catch (e) { /* listener fault-tolerance */ }
    }
  }
  function subscribe(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /* ── Persistence ─────────────────────────────────────────── */
  function lsKeyFor(uid) {
    return LS_KEY + ':' + (uid || 'guest');
  }
  function lsRead(uid) {
    try {
      var raw = localStorage.getItem(lsKeyFor(uid));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function lsWrite(uid, data) {
    try { localStorage.setItem(lsKeyFor(uid), JSON.stringify(data)); } catch (e) { /* quota */ }
  }
  function lsClear(uid) {
    try { localStorage.removeItem(lsKeyFor(uid)); } catch (e) { /* ignore */ }
  }

  /* ── Firebase helpers (resolved from host globals) ───────── */
  function fb() {
    return {
      db: (typeof window !== 'undefined') ? window.db : null,
      currentUser: (typeof window !== 'undefined') ? window.currentUser : null,
      doc: (typeof window !== 'undefined') ? window._fbDoc : null,
      getDoc: (typeof window !== 'undefined') ? window._fbGetDoc : null,
      setDoc: (typeof window !== 'undefined') ? window._fbSetDoc : null
    };
  }

  /* ─────────────────────────────────────────────────────────
     INIT — call once from enterApp after the user identity is
     resolved. Idempotent-ish: re-resolves from cache + Firestore.
     ───────────────────────────────────────────────────────── */
  async function init() {
    var f = fb();
    state.uid = (f.currentUser && f.currentUser.uid) || null;

    // 1) Instant cache read for signed-in + guest alike.
    var cached = lsRead(state.uid);
    if (cached && typeof cached.premium === 'boolean') {
      state.premium = cached.premium;
      state.source = 'cache';
    } else {
      state.premium = false;
      state.source = 'default';
    }

    // 2) Firestore is authoritative when signed in.
    if (state.uid && f.db && f.doc && f.getDoc) {
      try {
        var snap = await f.getDoc(f.doc(f.db, 'users', state.uid));
        if (snap.exists()) {
          var d = snap.data() || {};
          var prem = !!(d.premium && d.premium.active);
          state.premium = prem;
          state.source = 'firestore';
          // Re-cache so the next load is instant.
          lsWrite(state.uid, { premium: prem, uid: state.uid });
        }
      } catch (e) {
        console.warn('[premium] init error:', e);
      }
    }

    emit('ready', { premium: state.premium, source: state.source });
    return state.premium;
  }

  function isPremium() { return !!state.premium; }
  function historyLimit() { return isPremium() ? PREMIUM_HISTORY : FREE_HISTORY; }
  function familyLimit() { return isPremium() ? PREMIUM_FAMILY : FREE_FAMILY; }
  function fullBoard() { return isPremium(); }

  /* ─────────────────────────────────────────────────────────
     SET PREMIUM — self-serve preview toggle.
     • Persists to localStorage always (works for guests).
     • Persists to Firestore when signed in (merge, never wipes
       other user fields).
     ───────────────────────────────────────────────────────── */
  async function setPremium(value, opts) {
    var v = !!value;
    state.premium = v;
    opts = opts || {};
    state.source = opts.source || (v ? 'preview' : 'preview-off');

    lsWrite(state.uid, { premium: v, uid: state.uid || null });

    var f = fb();
    if (state.uid && f.db && f.doc && f.setDoc) {
      try {
        await f.setDoc(
          f.doc(f.db, 'users', state.uid),
          { premium: { active: v, source: state.source, updatedAt: Date.now() } },
          { merge: true }
        );
      } catch (e) {
        console.warn('[premium] setPremium error:', e);
      }
    }

    emit('changed', { premium: v, source: state.source });
    return v;
  }

  /* ─────────────────────────────────────────────────────────
     Public API
     ───────────────────────────────────────────────────────── */
  var api = {
    FREE_HISTORY: FREE_HISTORY,
    PREMIUM_HISTORY: PREMIUM_HISTORY,
    FREE_FAMILY: FREE_FAMILY,
    PREMIUM_FAMILY: PREMIUM_FAMILY,
    init: init,
    isPremium: isPremium,
    historyLimit: historyLimit,
    familyLimit: familyLimit,
    fullBoard: fullBoard,
    setPremium: setPremium,
    subscribe: subscribe,
    lsClear: lsClear
  };
  if (typeof window !== 'undefined') window.PREMIUM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
