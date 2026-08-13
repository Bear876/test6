// Vytreos /api/code — sends + verifies 6-digit email confirmation codes (OTP).
//
// One function handles both actions so the in-memory code store lives in a
// single module scope (shared across requests within an instance):
//   POST /api/sendcode    { action:'send',   email }
//   POST /api/verifycode  { action:'verify', email, code }
//
// Delivery uses Resend (RESEND_API_KEY). When no key is configured the code
// is returned in the response as a dev-mode fallback so the flow is fully
// testable in preview before an email key is added.
//
// NOTE: codes live in an in-memory Map with a 10-minute expiry. That is
// reliable in the Freebuff preview (single process) and fine for an early
// app; on multi-instance serverless deploys a user must hit the same
// instance within the window. Swap for a durable store (Firestore/Redis)
// when the app grows.

const COOLDOWN_MS = 60_000;      // min time between sends per email
const TTL_MS = 10 * 60_000;      // code lifetime
const MAX_ATTEMPTS = 5;          // wrong guesses before the code is voided

// email -> { code, exp, attempts, sentAt }
const CODES = new Map();

function cleanup() {
  const now = Date.now();
  for (const [k, v] of CODES) if (v.exp < now) CODES.delete(k);
}

function newCode() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  cleanup();

  // ── SEND ───────────────────────────────────────────────────────────────────
  if (body.action === 'send') {
    const prev = CODES.get(email);
    if (prev && Date.now() - prev.sentAt < COOLDOWN_MS) {
      const waitMs = COOLDOWN_MS - (Date.now() - prev.sentAt);
      return res.status(429).json({ error: 'Please wait before requesting another code.', cooldownMs: waitMs });
    }

    const code = newCode();
    CODES.set(email, { code, exp: Date.now() + TTL_MS, attempts: 0, sentAt: Date.now() });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // Dev mode: no email service configured yet — surface the code so the
      // flow works in preview. Once RESEND_API_KEY is set, codes go by email.
      console.log(`[code] dev-mode code for ${email}: ${code}`);
      return res.status(200).json({ ok: true, dev: true, code, cooldownMs: COOLDOWN_MS });
    }

    try {
      const from = process.env.VYTREOS_EMAIL_FROM || 'Vytreos <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your Vytreos confirmation code',
          html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
  <div style="font-size:22px;font-weight:700;color:#0b0e11;margin-bottom:12px;">Vytreos</div>
  <h2 style="color:#0b0e11;font-size:18px;margin:0 0 8px;">Your confirmation code</h2>
  <p style="color:#444;font-size:14px;line-height:1.6;">Use the code below to finish signing in. It expires in 10 minutes.</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#00b074;background:#f2f4f7;border-radius:12px;padding:18px 24px;text-align:center;margin:16px 0;">${code}</div>
  <p style="color:#888;font-size:12px;line-height:1.6;">If you did not request this code, you can safely ignore this email.</p>
</div>`
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.warn(`[code] Resend ${r.status}:`, err?.message);
        return res.status(502).json({ error: 'Could not send the email right now. Please try again in a moment.' });
      }
    } catch (e) {
      console.warn('[code] Resend exception:', e.message);
      return res.status(502).json({ error: 'Could not send the email right now. Please try again in a moment.' });
    }

    console.log(`[code] sent to ${email}`);
    return res.status(200).json({ ok: true, dev: false, cooldownMs: COOLDOWN_MS });
  }

  // ── VERIFY ─────────────────────────────────────────────────────────────────
  if (body.action === 'verify') {
    const code = String(body.code || '').trim();
    const entry = CODES.get(email);

    if (!entry) {
      return res.status(400).json({ error: 'No code was requested for this email. Request a new one.' });
    }
    if (Date.now() > entry.exp) {
      CODES.delete(email);
      return res.status(400).json({ error: 'This code has expired. Request a new one.' });
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      CODES.delete(email);
      return res.status(400).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }
    if (entry.code !== code) {
      entry.attempts += 1;
      return res.status(400).json({ error: 'That code did not match.', attemptsLeft: MAX_ATTEMPTS - entry.attempts });
    }

    CODES.delete(email);
    console.log(`[code] verified ${email}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
