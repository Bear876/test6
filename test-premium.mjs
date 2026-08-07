// test-premium.mjs — Sanity tests for public/premium.js entitlement logic.
//
// Loads public/premium.js via Node's `vm` module (same pattern as
// test-accuracy.mjs / test-vq.mjs) with a fake `window` + `localStorage`
// so the module boots in a browser-like sandbox.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, 'public', 'premium.js'), 'utf8');

// Minimal browser-ish sandbox.
const store = {};
const fakeLocalStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
const fakeWindow = { localStorage: fakeLocalStorage };
const sandbox = {
  window: fakeWindow,
  localStorage: fakeLocalStorage,
  module: { exports: {} },
  exports: {}
};
fakeWindow.window = fakeWindow;
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'public/premium.js' });
const PREMIUM = sandbox.module.exports;

if (!PREMIUM || typeof PREMIUM.isPremium !== 'function') {
  console.error('premium.js failed to expose its API via vm context.');
  process.exit(1);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + (e && e.message ? e.message : e)); failed++; }
}

console.log('Vytreos premium module tests');

// --- defaults ----------------------------------------------------------------
test('fresh state → not premium', () => {
  assert.equal(PREMIUM.isPremium(), false);
});

test('free limits → 10-scan history, 1 family profile, no full board', async () => {
  await PREMIUM.init();
  assert.equal(PREMIUM.historyLimit(), 10);
  assert.equal(PREMIUM.familyLimit(), 1);
  assert.equal(PREMIUM.fullBoard(), false);
});

// --- setPremium (preview toggle) ---------------------------------------------
test('setPremium(true) → premium limits apply', async () => {
  await PREMIUM.setPremium(true);
  assert.equal(PREMIUM.isPremium(), true);
  assert.equal(PREMIUM.historyLimit(), Infinity);
  assert.equal(PREMIUM.familyLimit(), 6);
  assert.equal(PREMIUM.fullBoard(), true);
});

test('setPremium(false) → back to free', async () => {
  await PREMIUM.setPremium(false);
  assert.equal(PREMIUM.isPremium(), false);
  assert.equal(PREMIUM.historyLimit(), 10);
  assert.equal(PREMIUM.familyLimit(), 1);
});

// --- persistence across "reloads" -------------------------------------------
test('cached entitlement survives re-init (localStorage)', async () => {
  await PREMIUM.setPremium(true);
  const fresh = { module: { exports: {} }, exports: {} };
  const sandbox2 = { window: { localStorage: fakeLocalStorage }, localStorage: fakeLocalStorage, module: fresh.module, exports: fresh.exports };
  sandbox2.window.window = sandbox2.window;
  fresh.module.exports = fresh.exports;
  vm.createContext(sandbox2);
  vm.runInContext(code, sandbox2, { filename: 'public/premium.js' });
  await fresh.module.exports.init();
  assert.equal(fresh.module.exports.isPremium(), true, 'premium flag should restore from cache');
  await PREMIUM.setPremium(false); // clean up
});

// --- subscribe ----------------------------------------------------------------
test('subscribe fires on change', async () => {
  let events = 0;
  PREMIUM.subscribe(() => events++);
  await PREMIUM.setPremium(true);
  await PREMIUM.setPremium(false);
  assert.ok(events >= 2, 'expected >=2 events, got ' + events);
});

// --- constants ----------------------------------------------------------------
test('constants exposed', () => {
  assert.equal(PREMIUM.FREE_HISTORY, 10);
  assert.equal(PREMIUM.PREMIUM_HISTORY, Infinity);
  assert.equal(PREMIUM.FREE_FAMILY, 1);
  assert.equal(PREMIUM.PREMIUM_FAMILY, 6);
});

console.log('\n  ✓ ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed === 0 ? 0 : 1);
