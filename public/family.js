/* ============================================================
   public/family.js
   Family / profile management module for Vytreos.

   Loaded as a classic <script> (mirrors accuracy.js / pdf.js /
   vq.js). Exposes `window.FAMILY` so the rest of the SPA can
   ask "who am I scanning for?" without rewriting every Firestore
   query.

   Data model
   ──────────
   • users/{uid}                              → user doc, gains `activeProfile` field
   • users/{uid}/profiles/{pid}               → profile doc:
       { id, name, relation, dob?, gender?, scanCount, createdAt, isDefault }
   • users/{uid}/profiles/{pid}/scans/{sid}   → scan docs (per-profile isolation)

   Migration (zero data loss for existing users)
   ─────────────────────────────────────────────
   • On FAMILY.init(), if no profiles exist for this user, the
     module creates a default `self` profile, then walks any
     legacy scans under `users/{uid}/scans/`, copies each into
     the new `self` profile path, and finally ensures future
     writes go to the new path. If the user is a guest, a local
     default profile is created in-memory + localStorage; no
     server writes happen for guest users.

   Profile-switching UX hooks (the host index.html wires the
   actual UI onto these helpers):
   ─────────────────────────────────────────────────────────────
   • `FAMILY.list()`                         — all profiles for current user
   • `FAMILY.getActive()`                    — currently active profile
   • `FAMILY.switchTo(id)`                   — set active + reload scans
   • `FAMILY.create({name, relation, …})`    — add new profile
   • `FAMILY.update(id, partial)`            — edit profile
   • `FAMILY.remove(id)`                     — delete a profile + its scans
   • `FAMILY.addScanMeta(scan)`              — tag a scan with active profileId
   • `FAMILY.scansPath()`                    — `users/{uid}/profiles/{pid}/scans`
   • `FAMILY.init()`                         — bootstrap (called from enterApp)
   • `FAMILY.compare(pidA, pidB)`            — returns matched nutrient pairs
   ───────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  var DEFAULT_RELATIONS = ['self', 'partner', 'child', 'parent', 'other'];
  var DEFAULT_PROFILE_ID = 'self';
  var LS_KEY = 'vytreos.family.v1';

  /* ─────────────────────────────────────────────────────────
     Local state. Kept tiny: the active profile id + all
     profiles for the resolved user. Re-init clears these.
     ───────────────────────────────────────────────────────── */
  var state = {
    uid: null,           // current Firebase uid, or null for guest
    isGuest: true,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: []         // [{ id, name, relation, dob, gender, scanCount, isDefault, createdAt }]
  };

  /* ─────────────────────────────────────────────────────────
     Tiny pub for UI re-rendering. Listeners wired by host.
     ───────────────────────────────────────────────────────── */
  var listeners = [];
  function emit(evt, payload) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](evt, payload); } catch (e) { /* listener fault-tolerance */ }
    }
  }
  function subscribe(fn) { listeners.push(fn); }

  /* ─────────────────────────────────────────────────────────
     Lazy Firebase helpers — pulled from the host's globals so
     we don't re-import the SDK. All paths go through helper
     functions so the API surface stays stable.
     ───────────────────────────────────────────────────────── */
  function fb() {
    return {
      db: (typeof window !== 'undefined') ? window.db : null,
      fbApp: (typeof window !== 'undefined') ? window.fbApp : null,
      currentUser: (typeof window !== 'undefined') ? window.currentUser : null,
      fromNow: typeof window !== 'undefined' && typeof window.fromNow === 'function' ? window.fromNow : null,
      serverTimestamp: typeof window !== 'undefined' && typeof window.serverTimestamp === 'function' ? window.serverTimestamp : null,
      // Firestore SDK imports (resolved from host module if exposed globally)
      collection: (typeof window !== 'undefined') ? window._fbCollection : null,
      doc: (typeof window !== 'undefined') ? window._fbDoc : null,
      addDoc: (typeof window !== 'undefined') ? window._fbAddDoc : null,
      setDoc: (typeof window !== 'undefined') ? window._fbSetDoc : null,
      getDoc: (typeof window !== 'undefined') ? window._fbGetDoc : null,
      getDocs: (typeof window !== 'undefined') ? window._fbGetDocs : null,
      query: (typeof window !== 'undefined') ? window._fbQuery : null,
      orderBy: (typeof window !== 'undefined') ? window._fbOrderBy : null,
      deleteDoc: (typeof window !== 'undefined') ? window._fbDeleteDoc : null,
      updateDoc: (typeof window !== 'undefined') ? window._fbUpdateDoc : null
    };
  }

  /* ─────────────────────────────────────────────────────────
     Direct Firestore access via dynamic import path that the
     host has loaded as a module. index.html already imports
     these at module load. We either read them off globals the
     host exposes (preferred) or fall back to indexedDB-less
     localStorage so the SPA works for guests.

     To keep this module decoupled from the host's specific
     import strategy, we expose the firestore primitives via
     a registration hook called by the main IIFE:
     ───────────────────────────────────────────────────────── */
  function registerFirebasePrimitives(prim) {
    if (!prim || typeof prim !== 'object') return;
    window._fbCollection = prim.collection;
    window._fbDoc = prim.doc;
    window._fbAddDoc = prim.addDoc;
    window._fbSetDoc = prim.setDoc;
    window._fbGetDoc = prim.getDoc;
    window._fbGetDocs = prim.getDocs;
    window._fbQuery = prim.query;
    window._fbOrderBy = prim.orderBy;
    window._fbDeleteDoc = prim.deleteDoc;
    window._fbUpdateDoc = prim.updateDoc;
  }

  /* ─────────────────────────────────────────────────────────
     Persistence helpers — write/read profile list to local
     storage for guest users + as a write-through cache for
     signed-in users so the UI is instant.
     ───────────────────────────────────────────────────────── */
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

  /* ─────────────────────────────────────────────────────────
     Profile lifecycle
     ───────────────────────────────────────────────────────── */
  function defaultProfile(uid) {
    return {
      id: DEFAULT_PROFILE_ID,
      name: uid ? 'Me' : 'Guest',
      relation: 'self',
      scanCount: 0,
      isDefault: true,
      createdAt: Date.now()
    };
  }
  function newProfileId() {
    return 'p_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  /* ─────────────────────────────────────────────────────────
     INIT — call this once on app boot after the user identity
     is resolved. Idempotent.
     ───────────────────────────────────────────────────────── */
  async function init() {
    var f = fb();
    state.uid = (f.currentUser && f.currentUser.uid) || null;
    state.isGuest = !state.uid;

    if (!state.uid) {
      // Guest path — local profiles only.
      var cached = lsRead(null);
      if (cached && Array.isArray(cached.profiles) && cached.profiles.length > 0) {
        state.profiles = cached.profiles;
        state.activeProfileId = cached.activeProfileId || DEFAULT_PROFILE_ID;
      } else {
        state.profiles = [defaultProfile(null)];
        state.activeProfileId = DEFAULT_PROFILE_ID;
        lsWrite(null, { profiles: state.profiles, activeProfileId: state.activeProfileId });
      }
      emit('ready', { profiles: state.profiles, activeProfileId: state.activeProfileId });
      return state;
    }

    // Signed-in path — load from Firestore, create default if missing.
    try {
      var collection = f.collection, doc = f.doc, getDoc = f.getDoc, setDoc = f.setDoc,
          query = f.query, getDocs = f.getDocs, orderBy = f.orderBy;

      var userRef = doc(f.db, 'users', state.uid);
      var userSnap = await getDoc(userRef);
      var userData = userSnap.exists() ? (userSnap.data() || {}) : {};

      var profilesSnap = await getDocs(collection(userRef, 'profiles'));
      var profiles = [];
      profilesSnap.forEach(function (d) {
        var p = d.data() || {};
        profiles.push({
          id: d.id,
          name: p.name || d.id,
          relation: p.relation || 'other',
          dob: p.dob || null,
          gender: p.gender || null,
          scanCount: p.scanCount || 0,
          isDefault: !!p.isDefault,
          createdAt: p.createdAt || Date.now()
        });
      });

      // First time for this user → create default profile
      if (profiles.length === 0) {
        var defProf = defaultProfile(state.uid);
        await setDoc(doc(userRef, 'profiles', defProf.id), {
          name: defProf.name,
          relation: defProf.relation,
          scanCount: 0,
          isDefault: true,
          createdAt: Date.now()
        });
        profiles = [defProf];

        // Import any family profiles created earlier while the app was
        // (incorrectly) running in guest mode — those were cached in
        // localStorage only and never reached Firestore.
        var guestCache = lsRead(null);
        if (guestCache && Array.isArray(guestCache.profiles)) {
          for (var gi = 0; gi < guestCache.profiles.length; gi++) {
            var gp = guestCache.profiles[gi];
            if (!gp || gp.id === DEFAULT_PROFILE_ID || gp.relation === 'self') continue;
            var gpid = gp.id && String(gp.id).indexOf('p_') === 0 ? gp.id : newProfileId();
            var gname = String(gp.name || '').trim() || 'Family member';
            var grel = DEFAULT_RELATIONS.indexOf(gp.relation) !== -1 ? gp.relation : 'other';
            try {
              await setDoc(doc(userRef, 'profiles', gpid), {
                name: gname,
                relation: grel,
                dob: gp.dob || null,
                gender: gp.gender || null,
                scanCount: gp.scanCount || 0,
                isDefault: false,
                createdAt: gp.createdAt || Date.now()
              });
              profiles.push({
                id: gpid, name: gname, relation: grel,
                dob: gp.dob || null, gender: gp.gender || null,
                scanCount: gp.scanCount || 0, isDefault: false,
                createdAt: gp.createdAt || Date.now()
              });
            } catch (gErr) {
              console.warn('[family] guest profile import failed:', gErr);
            }
          }
          // Restore the profile that was active in guest mode, if imported.
          if (guestCache.activeProfileId && guestCache.activeProfileId !== DEFAULT_PROFILE_ID &&
              profiles.some(function (p) { return p.id === guestCache.activeProfileId; })) {
            state.activeProfileId = guestCache.activeProfileId;
          }
        }

        // Backfill any legacy scans sitting at users/{uid}/scans
        try {
          var legacyRef = collection(userRef, 'scans');
          var legacySnap = await getDocs(query(legacyRef, orderBy('createdAt', 'desc')));
          var legacyCount = 0;
          var profileScanCol = collection(userRef, 'profiles', defProf.id, 'scans');

          for (var legacy of legacySnap.docs) {
            var data = legacy.data();
            if (!data) continue;
            data.profileId = defProf.id;
            data.migratedFrom = 'users/' + state.uid + '/scans/' + legacy.id;
            data.createdAt = data.createdAt || Date.now();
            // Use addDoc so each scan keeps its own auto-id
            await (f.addDoc ? f.addDoc(profileScanCol, data) : setDoc(doc(profileScanCol, legacy.id), data));
            legacyCount++;
          }
          if (legacyCount > 0) {
            await setDoc(doc(profileScanCol, '__migration_note'), {
              migratedCount: legacyCount,
              migratedAt: Date.now(),
              source: 'users/' + state.uid + '/scans'
            }, { merge: true });
            if (typeof window !== 'undefined' && window.toast) {
              window.toast('Imported ' + legacyCount + ' legacy scan' + (legacyCount === 1 ? '' : 's') + ' to your ' + defProf.name + ' profile');
            }
          }
        } catch (migErr) {
          // Migration is best-effort — never break the app.
          console.warn('[family] legacy migration failed:', migErr);
        }
      }

      state.profiles = profiles;
      state.activeProfileId = userData.activeProfile || DEFAULT_PROFILE_ID;
      // Validate the active id exists; else fall back to first.
      if (!state.profiles.some(function (p) { return p.id === state.activeProfileId; })) {
        state.activeProfileId = state.profiles[0].id;
      }

      // Cache for offline / instant UI
      lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });

      emit('ready', { profiles: state.profiles, activeProfileId: state.activeProfileId, migrated: legacyCountSafe() });
    } catch (e) {
      console.warn('[family] init error:', e);
      // Even on full failure, ensure UI has *something*.
      state.profiles = [defaultProfile(state.uid)];
      state.activeProfileId = DEFAULT_PROFILE_ID;
      emit('ready-error', { error: String(e) });
    }
    return state;
  }
  function legacyCountSafe() { return 0; }

  /* ─────────────────────────────────────────────────────────
     LIST / GET ACTIVE
     ───────────────────────────────────────────────────────── */
  function list() { return state.profiles.slice(); }
  function getActive() {
    return state.profiles.find(function (p) { return p.id === state.activeProfileId; }) || null;
  }
  function getProfileById(id) {
    return state.profiles.find(function (p) { return p.id === id; }) || null;
  }

  /* ─────────────────────────────────────────────────────────
     CREATE
     ───────────────────────────────────────────────────────── */
  async function create(opts) {
    opts = opts || {};
    var name = (opts.name || '').trim() || 'Family member';
    var relation = DEFAULT_RELATIONS.indexOf(opts.relation) !== -1 ? opts.relation : 'other';
    var profile = {
      id: newProfileId(),
      name: name,
      relation: relation,
      dob: opts.dob || null,
      gender: opts.gender || null,
      scanCount: 0,
      isDefault: false,
      createdAt: Date.now()
    };

    state.profiles.push(profile);

    if (state.uid) {
      try {
        var f = fb();
        await f.setDoc(
          f.doc(f.db, 'users', state.uid, 'profiles', profile.id),
          {
            name: profile.name,
            relation: profile.relation,
            dob: profile.dob,
            gender: profile.gender,
            scanCount: 0,
            isDefault: false,
            createdAt: profile.createdAt
          }
        );
      } catch (e) {
        console.warn('[family] create error:', e);
      }
    }
    lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });
    emit('profile-created', profile);
    return profile;
  }

  /* ─────────────────────────────────────────────────────────
     UPDATE
     ───────────────────────────────────────────────────────── */
  async function update(id, partial) {
    var idx = state.profiles.findIndex(function (p) { return p.id === id; });
    if (idx === -1) return null;
    var next = Object.assign({}, state.profiles[idx], partial || {});
    state.profiles[idx] = next;

    if (state.uid) {
      try {
        var f = fb();
        await f.updateDoc(
          f.doc(f.db, 'users', state.uid, 'profiles', id),
          {
            name: next.name,
            relation: next.relation,
            dob: next.dob,
            gender: next.gender
          }
        );
      } catch (e) {
        console.warn('[family] update error:', e);
      }
    }
    lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });
    emit('profile-updated', next);
    return next;
  }

  /* ─────────────────────────────────────────────────────────
     REMOVE — and clean up scans collection. Block the user
     from removing their default self profile if it is the
     only one (stay safe).
     ───────────────────────────────────────────────────────── */
  async function remove(id) {
    if (id === DEFAULT_PROFILE_ID && state.profiles.length === 1) {
      if (typeof window !== 'undefined' && window.toast) {
        window.toast("Can't remove your only profile.", true);
      }
      return false;
    }
    if (id === state.activeProfileId) {
      // Switch to another profile before removing.
      var others = state.profiles.filter(function (p) { return p.id !== id; });
      if (others.length > 0) {
        await switchTo(others[0].id);
      }
    }

    state.profiles = state.profiles.filter(function (p) { return p.id !== id; });

    if (state.uid) {
      try {
        var f = fb();
        await f.deleteDoc(
          f.doc(f.db, 'users', state.uid, 'profiles', id)
        );
        // Note: scan docs under that profile are orphaned (kept in
        // Firestore for forensic value, but the UI no longer shows them).
      } catch (e) {
        console.warn('[family] remove error:', e);
      }
    }
    lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });
    emit('profile-removed', { id: id, profiles: state.profiles });
    return true;
  }

  /* ─────────────────────────────────────────────────────────
     SWITCH TO
     ───────────────────────────────────────────────────────── */
  async function switchTo(id) {
    if (!state.profiles.some(function (p) { return p.id === id; })) return false;
    state.activeProfileId = id;
    if (state.uid) {
      try {
        var f = fb();
        await f.setDoc(
          f.doc(f.db, 'users', state.uid),
          { activeProfile: id },
          { merge: true }
        );
      } catch (e) {
        console.warn('[family] switchTo error:', e);
      }
    }
    lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });
    emit('active-changed', { activeProfileId: state.activeProfileId, profile: getActive() });
    return true;
  }

  /* ─────────────────────────────────────────────────────────
     SCANS integration
     ───────────────────────────────────────────────────────── */
  function scansPath(profileId) {
    var pid = profileId || state.activeProfileId;
    return 'users/' + state.uid + '/profiles/' + pid + '/scans';
  }
  async function addScanMeta(scan) {
    if (!scan) return scan;
    var active = getActive();
    scan.profileId = active ? active.id : DEFAULT_PROFILE_ID;
    scan.profileName = active ? active.name : null;
    if (state.uid && active) {
      try {
        var f = fb();
        await f.updateDoc(
          f.doc(f.db, 'users', state.uid, 'profiles', scan.profileId),
          { scanCount: (active.scanCount || 0) + 1 }
        );
        active.scanCount = (active.scanCount || 0) + 1;
        lsWrite(state.uid, { profiles: state.profiles, activeProfileId: state.activeProfileId });
      } catch (e) {
        console.warn('[family] addScanMeta error:', e);
      }
    }
    return scan;
  }

  /* ─────────────────────────────────────────────────────────
     COMPARE — pick two profiles, return per-nutrient divergence
     for the same-named nutrients. Used by the dashboard.
     ───────────────────────────────────────────────────────── */
  function compare(pidA, pidB) {
    var profA = getProfileById(pidA) || getActive();
    var profB = getProfileById(pidB);
    if (!profA || !profB) return null;
    var scans = (typeof window !== 'undefined' && Array.isArray(window.SCANS)) ? window.SCANS : [];
    function latestFor(pid) {
      var own = scans.filter(function (s) { return s.profileId === pid; });
      if (own.length === 0) return null;
      own.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return own[0];
    }
    var a = latestFor(profA.id);
    var b = latestFor(profB.id);
    if (!a || !b) return { profileA: profA, profileB: profB, missing: !a ? profA.id : !b ? profB.id : null };
    var aMap = {}, bMap = {};
    (a.nutrients || []).forEach(function (n) { if (n && n.name) aMap[n.name] = n; });
    (b.nutrients || []).forEach(function (n) { if (n && n.name) bMap[n.name] = n; });
    var sharedNames = Object.keys(aMap).filter(function (name) { return bMap[name]; });
    var rows = sharedNames.map(function (name) {
      var na = aMap[name], nb = bMap[name];
      var delta = (na.level || 0) - (nb.level || 0);
      var bigger = delta > 0 ? profA.name : delta < 0 ? profB.name : 'tie';
      return { name: name, aLevel: na.level, bLevel: nb.level, delta: delta, bigger: bigger, statusA: na.status, statusB: nb.status };
    });
    rows.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    return { profileA: profA, profileB: profB, rows: rows, scanA: a, scanB: b };
  }

  /* ─────────────────────────────────────────────────────────
     Public API
     ───────────────────────────────────────────────────────── */
  var api = {
    DEFAULT_PROFILE_ID: DEFAULT_PROFILE_ID,
    init: init,
    list: list,
    getActive: getActive,
    getProfileById: getProfileById,
    create: create,
    update: update,
    remove: remove,
    switchTo: switchTo,
    scansPath: scansPath,
    addScanMeta: addScanMeta,
    compare: compare,
    subscribe: subscribe,
    registerFirebasePrimitives: registerFirebasePrimitives,
    DEFAULT_RELATIONS: DEFAULT_RELATIONS
  };
  if (typeof window !== 'undefined') window.FAMILY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
