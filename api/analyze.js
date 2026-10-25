// Vytreos /api/analyze
// Hardening:
//   - Same-origin enforcement for browser requests (blocks cross-site quota theft)
//   - Per-IP sliding-window rate limit (protects the paid AI quotas behind this proxy)
//   - 405 envelope for non-POST requests
//   - 413 if Content-Length > 5 MB, or the decoded image exceeds 5 MB
//   - 400 for missing fields, unknown model, disallowed mediaType, malformed
//     base64, or an oversized prompt
//   - 60s timeout on every upstream provider call (a hung provider can no
//     longer hang the user's analysis spinner forever)
//   - X-Request-Id on every response, structured console logs keyed to it
//   - Cache-Control: no-store on every response
//   - Top-level catch so anything that escapes a provider block returns 500 cleanly
//
// NOTE: this endpoint spends real money (AI provider quotas). It is protected by
// origin checks + per-IP rate limiting rather than user auth so that signed-out
// visitors can still run the free tier; revisit if abuse appears.

const MAX_BYTES = 5_000_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
const UPSTREAM_TIMEOUT_MS = 60_000;

const ALLOWED_MODELS = new Set([
  'mistral-vision',
  'hf-biomed',
  'roboflow',
  'groq-llava',
]);

// Exact Gemini models the client uses — no prefix wildcard, so a discovered
// endpoint cannot be steered onto expensive/deprecated models.
const ALLOWED_GEMINI_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
]);

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const isAllowedModel = (m) =>
  typeof m === 'string' && (ALLOWED_GEMINI_MODELS.has(m) || ALLOWED_MODELS.has(m));

const isAllowedMediaType = (m) =>
  typeof m === 'string' && ALLOWED_MEDIA_TYPES.has(m);

// Strict base64 check: correct alphabet, no whitespace, sane length, and the
// standard 4n padding shape. Returns false for anything questionable.
const isValidBase64 = (b) => {
  if (typeof b !== 'string' || b.length === 0) return false;
  if (b.length > MAX_BASE64_CHARS) return false;
  if (b.length % 4 !== 0) return false;
  return BASE64_RE.test(b);
};

const newReqId = () =>
  Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);

const getClientIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return 'local';
};

// Browser requests send Origin (or Referer) on POSTs. If one is present it must
// match this app's host, otherwise some other website is driving our quota.
// Requests with neither header (curl, server-to-server) pass the origin check —
// they are still bounded by the rate limit.
const isSameOrigin = (req) => {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const src = origin || referer;
  if (!src) return true;
  if (src === 'null') return false;
  try {
    return new URL(src).host.toLowerCase() === host && host.length > 0;
  } catch {
    return false;
  }
};

// Minimal in-memory sliding-window rate limiter. In serverless deployments each
// instance enforces its own window — still enough to stop runaway abuse.
function makeRateLimiter({ windowMs = 10 * 60_000, max = 20, now = Date.now } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  return {
    check(ip, ts = now()) {
      let list = hits.get(ip) || [];
      list = list.filter((t) => ts - t < windowMs);
      if (list.length >= max) {
        const retryAfterMs = list[0] + windowMs - ts;
        hits.set(ip, list);
        return { allowed: false, retryAfterMs: Math.max(1000, retryAfterMs) };
      }
      list.push(ts);
      hits.set(ip, list);
      if (hits.size > 5000) {
        for (const [k, v] of hits) {
          if (!v.length || ts - v[v.length - 1] >= windowMs) hits.delete(k);
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// One limiter per instance: ~20 requests / 10 min / IP. A single scan uses at
// most 6 requests (4 analysis models + HF + Roboflow), so a human has ~3 scans
// of headroom per window; a scripted abuser stops at the cap.
const limiter = makeRateLimiter({ windowMs: 10 * 60_000, max: 20 });

// Upstream fetch with a hard timeout. Returns {ok:false, timedOut:true} shape via throw.
function providerFetch(url, options) {
  const opts = { ...options };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    opts.signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  }
  return fetch(url, opts);
}

export default async function handler(req, res) {
  // Observability + caching headers FIRST, so every response — including the
  // cheap rejections below — carries them (idempotent if a downstream route
  // already set them).
  res.setHeader('Cache-Control', 'no-store');
  const reqId = newReqId();
  res.setHeader('X-Request-Id', reqId);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isSameOrigin(req)) {
    console.warn(`[${reqId}] reject cross-origin request origin=${req.headers.origin} referer=${req.headers.referer}`);
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }

  const ip = getClientIp(req);
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    const retrySec = Math.ceil(rl.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retrySec));
    console.warn(`[${reqId}] rate limited ip=${ip}`);
    return res.status(429).json({ error: `Too many requests — please wait ${retrySec}s and try again.`, retryAfterSec: retrySec });
  }

  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BYTES) {
    return res.status(413).json({ error: 'Payload too large', maxBytes: MAX_BYTES });
  }

  const { model, base64, mediaType, prompt } = req.body || {};
  console.log(`[${reqId}] analyze start model=${model || '(none)'} mime=${mediaType || '(none)'} bytes=${declared}`);

  try {
    if (!base64 || !mediaType) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (!isAllowedModel(model)) {
      console.warn(`[${reqId}] reject unknown model:`, model);
      return res.status(400).json({
        error: 'Unknown model',
        allowed: [...ALLOWED_GEMINI_MODELS, ...ALLOWED_MODELS],
      });
    }
    if (!isAllowedMediaType(mediaType)) {
      console.warn(`[${reqId}] reject media type:`, mediaType);
      return res.status(400).json({ error: 'Unsupported image type (use JPEG, PNG, or WebP)' });
    }
    if (!isValidBase64(base64)) {
      console.warn(`[${reqId}] reject malformed base64 len=${typeof base64 === 'string' ? base64.length : typeof base64}`);
      return res.status(400).json({ error: 'Malformed image data' });
    }
    // Decoded-size check applies to EVERY provider path (previously only HF).
    const decodedBytes = Buffer.byteLength(base64, 'base64');
    if (decodedBytes > MAX_BYTES) {
      return res.status(413).json({ error: 'Decoded image too large', maxBytes: MAX_BYTES });
    }
    if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: 'Prompt too long' });
    }

    // ── MISTRAL VISION (Pixtral) ─────────────────────────────────────────────
    if (model === 'mistral-vision') {
      const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
      if (!MISTRAL_KEY) return res.status(503).json({ error: 'Mistral not configured' });
      try {
        const mistralRes = await providerFetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_KEY}` },
          body: JSON.stringify({
            model: 'pixtral-12b-2409',
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
                { type: 'text', text: prompt }
              ]
            }],
            max_tokens: 4096,
            temperature: 0.05
          })
        });
        if (!mistralRes.ok) {
          const err = await mistralRes.json().catch(() => ({}));
          console.warn(`[${reqId}] Mistral ${mistralRes.status}:`, err?.message);
          return res.status(mistralRes.status).json({ error: err?.message || 'Mistral error' });
        }
        const data = await mistralRes.json();
        return res.status(200).json({ result: data.choices?.[0]?.message?.content || '' });
      } catch (e) {
        if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'Provider timed out' });
        return res.status(500).json({ error: e.message });
      }
    }

    // ── HUGGING FACE ─────────────────────────────────────────────────────────
    if (model === 'hf-biomed') {
      const HF_KEY = process.env.HF_API_KEY;
      if (!HF_KEY) return res.status(503).json({ error: 'HF not configured' });
      try {
        const imgBuffer = Buffer.from(base64, 'base64');
        if (imgBuffer.length > MAX_BYTES) return res.status(413).json({ error: 'Decoded image too large' });
        const hfRes = await providerFetch(
          'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
          { method: 'POST', headers: { 'Authorization': `Bearer ${HF_KEY}`, 'Content-Type': 'application/octet-stream' }, body: imgBuffer }
        );
        if (!hfRes.ok) return res.status(hfRes.status).json({ error: 'HF error: ' + hfRes.status });
        const data = await hfRes.json();
        return res.status(200).json({ result: JSON.stringify(data) });
      } catch (e) {
        if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'Provider timed out' });
        return res.status(500).json({ error: e.message });
      }
    }

    // ── ROBOFLOW ─────────────────────────────────────────────────────────────
    if (model === 'roboflow') {
      const RF_KEY = process.env.ROBOFLOW_API_KEY;
      if (!RF_KEY) return res.status(503).json({ error: 'Roboflow not configured' });
      try {
        const rfRes = await providerFetch(
          `https://detect.roboflow.com/eye-detection-4jkmm/1?api_key=${RF_KEY}&confidence=25`,
          { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: base64 }
        );
        if (!rfRes.ok) return res.status(rfRes.status).json({ error: 'Roboflow error: ' + rfRes.status });
        const data = await rfRes.json();
        return res.status(200).json({ result: JSON.stringify(data) });
      } catch (e) {
        if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'Provider timed out' });
        return res.status(500).json({ error: e.message });
      }
    }

    // ── GROQ ─────────────────────────────────────────────────────────────────
    if (model === 'groq-llava') {
      const GROQ_KEY = process.env.GROQ_API_KEY;
      if (!GROQ_KEY) return res.status(503).json({ error: 'Groq not configured' });
      try {
        const groqRes = await providerFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
              { type: 'text', text: prompt }
            ]}],
            max_tokens: 4096, temperature: 0.05
          })
        });
        if (!groqRes.ok) {
          const err = await groqRes.json().catch(() => ({}));
          return res.status(groqRes.status).json({ error: err?.error?.message || 'Groq error' });
        }
        const data = await groqRes.json();
        return res.status(200).json({ result: data.choices?.[0]?.message?.content || '' });
      } catch (e) {
        if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'Provider timed out' });
        return res.status(500).json({ error: e.message });
      }
    }

    // ── GEMINI ───────────────────────────────────────────────────────────────
    const GEMINI_KEY = process.env.GEMINI_KEY;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'Gemini not configured' });
    try {
      const gemRes = await providerFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: base64 } }, { text: prompt }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
          })
        }
      );
      if (!gemRes.ok) {
        const err = await gemRes.json().catch(() => ({}));
        return res.status(gemRes.status).json({ error: err?.error?.message || `HTTP ${gemRes.status}` });
      }
      const data = await gemRes.json();
      return res.status(200).json({ result: data.candidates?.[0]?.content?.parts?.[0]?.text || '' });
    } catch (e) {
      if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'Provider timed out' });
      return res.status(500).json({ error: e.message });
    }
  } catch (e) {
    console.error(`[${reqId}] unhandled:`, e);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
  }
}

// Test-only exports (Vercel only routes the default export).
export const _internals = {
  MAX_BYTES,
  MAX_PROMPT_CHARS,
  ALLOWED_GEMINI_MODELS,
  ALLOWED_MODELS,
  ALLOWED_MEDIA_TYPES,
  isAllowedModel,
  isAllowedMediaType,
  isValidBase64,
  getClientIp,
  isSameOrigin,
  makeRateLimiter,
};
