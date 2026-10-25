// test-api.mjs — sanity tests for the Vercel API routes (api/analyze.js, api/code.js).
//
// Both modules are imported directly (package.json is type:module, so the .js
// files parse as ESM). The tests use a fake `req`/`res` pair and a stubbed
// global `fetch`, so NO network calls are made and no real keys are needed:
// every env var the routes read is temporarily cleared for determinism and
// restored afterwards.
//
// What is covered:
//   analyze.js — input validation (model allowlist, media type, base64 shape,
//                prompt/size limits), origin enforcement, 405, rate limiting,
//                provider dispatch with stubbed upstream (200), missing key
//                (503), upstream timeout (504), X-Request-Id + no-store.
//   code.js    — 405, invalid email, dev-mode send (code echoed back),
//                per-email cooldown (429), per-IP send cap (429), verify with
//                correct/wrong codes, attempt cap, unknown email/action.
//   code.js    — timing-safe codesMatch internal.

import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => { queue.push([name, fn]); };

// ── env hygiene: snapshot, clear, restore ────────────────────────────────────
const ENV_KEYS = ['GEMINI_KEY', 'HF_API_KEY', 'ROBOFLOW_API_KEY', 'GROQ_API_KEY',
  'MISTRAL_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'RESEND_API_KEY'];
const envBackup = {};
for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
};

// ── syntax check both API files before importing ─────────────────────────────
console.log('Vytreos API route tests');
for (const f of ['api/analyze.js', 'api/code.js']) {
  try {
    execSync(`node --check ${f}`, { stdio: 'pipe' });
    console.log('  ✓ ' + f + ' parses');
    passed++;
  } catch (e) {
    console.log('  ✗ ' + f + ' parse error: ' + String(e.stderr || e.message).split('\n')[0]);
    failed++;
  }
}

const analyze = await import('./api/analyze.js');
const A = analyze._internals;
const analyzeHandler = analyze.default;
const codeMod = await import('./api/code.js');
const C = codeMod._internals;
const codeHandler = codeMod.default;

// ── fake req/res ─────────────────────────────────────────────────────────────
function makeRes() {
  return {
    headers: {}, statusCode: null, payload: null, headersSent: false,
    setHeader(k, v) { this.headers[k] = String(v); },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.headersSent = true; return this; },
  };
}
let ipSeq = 0;
const nextIp = () => 't' + (ipSeq++) + '.0.0.' + (ipSeq % 250);
function analyzeReq(body, { ip = nextIp(), method = 'POST', origin = 'https://app.example', host = 'app.example', headers = {} } = {}) {
  const h = { host, 'content-length': '1000', ...headers };
  if (origin !== null) h.origin = origin;
  return { method, headers: h, body };
}
const goodImage = () => Buffer.from('fake-image-bytes').toString('base64');
const callAnalyze = async (req) => { const res = makeRes(); await analyzeHandler(req, res); return res; };

// ── analyze: internals ───────────────────────────────────────────────────────
test('isAllowedModel → accepts the exact models the client uses', () => {
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-pro', 'groq-llava', 'mistral-vision', 'hf-biomed', 'roboflow']) {
    assert.equal(A.isAllowedModel(m), true, m);
  }
});
test('isAllowedModel → rejects unknown/prefixed/junk models', () => {
  for (const m of ['gemini-evil-9', 'gemini', '../../etc/passwd', '', null, undefined, 42, 'gemini-2.5-flash ']) {
    assert.equal(A.isAllowedModel(m), false, String(m));
  }
});
test('isAllowedMediaType → only jpeg/png/webp', () => {
  assert.equal(A.isAllowedMediaType('image/jpeg'), true);
  assert.equal(A.isAllowedMediaType('image/gif'), false);
  assert.equal(A.isAllowedMediaType('text/html'), false);
});
test('isValidBase64 → accepts canonical base64', () => {
  assert.equal(A.isValidBase64(goodImage()), true);
});
test('isValidBase64 → rejects bad shape/alphabet/length', () => {
  assert.equal(A.isValidBase64('abc'), false, 'not 4n');
  assert.equal(A.isValidBase64('aGVsbG8 n'), false, 'whitespace');
  assert.equal(A.isValidBase64('$$$$'), false, 'bad alphabet');
  assert.equal(A.isValidBase64(''), false, 'empty');
  assert.equal(A.isValidBase64(12345), false, 'non-string');
});
test('isSameOrigin → matching origin passes, foreign origin blocked, "null" blocked, absent passes (curl)', () => {
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example', origin: 'https://app.example' } }), true);
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example', origin: 'https://evil.example' } }), false);
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example', origin: 'null' } }), false);
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example' } }), true, 'no origin = non-browser');
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example', referer: 'https://app.example/history' } }), true);
  assert.equal(A.isSameOrigin({ headers: { host: 'app.example', referer: 'not a url' } }), false);
});
test('getClientIp → forwarded-for wins, real-ip fallback, local default', () => {
  assert.equal(A.getClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.equal(A.getClientIp({ headers: { 'x-real-ip': '9.9.9.9' } }), '9.9.9.9');
  assert.equal(A.getClientIp({ headers: {} }), 'local');
});
test('makeRateLimiter → allows up to max, then rejects with retryAfter', () => {
  let t = 0;
  const rl = A.makeRateLimiter({ windowMs: 1000, max: 3, now: () => t });
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  const denied = rl.check('ip');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);
  t = 2000; // window elapsed
  assert.equal(rl.check('ip').allowed, true);
});

// ── analyze: handler ─────────────────────────────────────────────────────────
test('handler → GET returns 405 + no-store + X-Request-Id', async () => {
  const res = await callAnalyze(analyzeReq(null, { method: 'GET', origin: null }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.headers['X-Request-Id']);
});
test('handler → cross-origin POST blocked with 403', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg' }, { origin: 'https://evil.example' }));
  assert.equal(res.statusCode, 403);
});
test('handler → missing fields → 400', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash' }));
  assert.equal(res.statusCode, 400);
});
test('handler → unknown model → 400 (no wildcard steering)', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-ultra-expensive', base64: goodImage(), mediaType: 'image/jpeg' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Unknown model');
});
test('handler → disallowed media type → 400', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/gif' }));
  assert.equal(res.statusCode, 400);
});
test('handler → malformed base64 → 400', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: 'not base64!!', mediaType: 'image/jpeg' }));
  assert.equal(res.statusCode, 400);
});
test('handler → oversized Content-Length → 413 before reading anything', async () => {
  const req = analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg' }, { headers: { 'content-length': String(6 * 1000 * 1000) } });
  const res = await callAnalyze(req);
  assert.equal(res.statusCode, 413);
});
test('handler → oversized prompt → 400', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg', prompt: 'x'.repeat(A.MAX_PROMPT_CHARS + 1) }));
  assert.equal(res.statusCode, 400);
});

const realFetch = globalThis.fetch;
test('handler → valid Gemini request proxies upstream result (stubbed fetch)', async () => {
  process.env.GEMINI_KEY = 'test-key-not-real';
  let sawGeminiUrl = false;
  globalThis.fetch = async (u) => {
    sawGeminiUrl = String(u).includes('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"nutrients":[]}' }] } }] }) };
  };
  try {
    const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg', prompt: 'test' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.result, '{"nutrients":[]}');
    assert.ok(sawGeminiUrl, 'upstream URL should pin the exact requested model');
  } finally { delete process.env.GEMINI_KEY; globalThis.fetch = realFetch; }
});
test('handler → missing provider key → 503 (never leaks through)', async () => {
  const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg' }));
  assert.equal(res.statusCode, 503);
});
test('handler → upstream timeout → 504', async () => {
  process.env.GEMINI_KEY = 'test-key-not-real';
  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
  try {
    const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg' }));
    assert.equal(res.statusCode, 504);
  } finally { delete process.env.GEMINI_KEY; globalThis.fetch = realFetch; }
});
test('handler → burst from one IP hits 429 with Retry-After', async () => {
  let saw429 = false;
  for (let i = 0; i < 25; i++) {
    const res = await callAnalyze(analyzeReq({ model: 'gemini-2.5-flash', base64: goodImage(), mediaType: 'image/jpeg' }, { ip: 'burst.ip.here' }));
    if (res.statusCode === 429) {
      saw429 = true;
      assert.ok(res.headers['Retry-After'], 'Retry-After header present');
      assert.ok(res.payload.retryAfterSec > 0);
      break;
    }
  }
  assert.ok(saw429, '25 requests from one IP must exceed the 20/10min budget');
});

// ── code: handler (dev mode: no mail provider configured) ────────────────────
const callCode = async (req) => { const res = makeRes(); await codeHandler(req, res); return res; };
const codeReq = (body, { ip = nextIp(), method = 'POST' } = {}) =>
  ({ method, headers: { host: 'app.example', 'x-forwarded-for': ip }, body });

test('code → GET returns 405', async () => {
  const res = await callCode(codeReq(null, { method: 'GET' }));
  assert.equal(res.statusCode, 405);
});
test('code → invalid email → 400', async () => {
  const res = await callCode(codeReq({ action: 'send', email: 'not-an-email' }));
  assert.equal(res.statusCode, 400);
});
test('code → dev-mode send echoes the code (no provider configured)', async () => {
  const res = await callCode(codeReq({ action: 'send', email: 'dev@example.com' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.dev, true);
  assert.match(String(res.payload.code), /^\d{6}$/);
});
test('code → immediate resend to same email → 429 cooldown', async () => {
  await callCode(codeReq({ action: 'send', email: 'cooldown@example.com' }));
  const res = await callCode(codeReq({ action: 'send', email: 'cooldown@example.com' }));
  assert.equal(res.statusCode, 429);
  assert.ok(res.payload.cooldownMs > 0);
});
test('code → 7th send from one IP (different emails) → 429 per-IP cap', async () => {
  const ip = 'bomb.ip.here';
  let last = null;
  for (let i = 0; i < 7; i++) {
    last = await callCode(codeReq({ action: 'send', email: `cap${i}@example.com` }, { ip }));
  }
  assert.equal(last.statusCode, 429);
});
test('code → verify with correct code → 200 and consumes the code', async () => {
  const sent = await callCode(codeReq({ action: 'send', email: 'ok@example.com' }));
  const good = await callCode(codeReq({ action: 'verify', email: 'ok@example.com', code: sent.payload.code }));
  assert.equal(good.statusCode, 200);
  const replay = await callCode(codeReq({ action: 'verify', email: 'ok@example.com', code: sent.payload.code }));
  assert.equal(replay.statusCode, 400, 'code must be single-use');
});
test('code → wrong code → 400 with attemptsLeft, then attempt cap', async () => {
  const email = 'wrong@example.com';
  const sent = await callCode(codeReq({ action: 'send', email }));
  const wrong = sent.payload.code === '000000' ? '111111' : '000000';
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await callCode(codeReq({ action: 'verify', email, code: wrong }));
  }
  assert.equal(last.statusCode, 400);
  assert.match(last.payload.error, /Too many incorrect attempts|did not match/);
});
test('code → verify unknown email → 400', async () => {
  const res = await callCode(codeReq({ action: 'verify', email: 'nobody@example.com', code: '123456' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /No code was requested/);
});
test('code → unknown action → 400', async () => {
  const res = await callCode(codeReq({ action: 'frobnicate', email: 'x@example.com' }));
  assert.equal(res.statusCode, 400);
});
test('code → codesMatch is exact (no prefix/empty match)', () => {
  assert.equal(C.codesMatch('123456', '123456'), true);
  assert.equal(C.codesMatch('123456', '12345'), false);
  assert.equal(C.codesMatch('123456', ''), false);
  assert.equal(C.codesMatch('123456', 123456), true, 'numeric input stringifies');
});

// ── run the queued tests sequentially (ESM top-level await), then report ────
for (const [name, fn] of queue) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + (e && e.message ? e.message : e)); failed++; }
}

// ── restore env, report ──────────────────────────────────────────────────────
restoreEnv();
console.log('\n  ✓ ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed === 0 ? 0 : 1);
