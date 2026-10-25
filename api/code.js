// Vytreos /api/code — sends + verifies 6-digit email confirmation codes (OTP).
//
// One function handles both actions so the in-memory code store lives in a
// single module scope (shared across requests within an instance):
//   POST /api/sendcode    { action:'send',   email }
//   POST /api/verifycode  { action:'verify', email, code }
//
// Delivery, first configured wins:
//   1. Gmail SMTP via App Password — GMAIL_USER + GMAIL_APP_PASSWORD. Free,
//      no domain needed; set up Gmail 2-Step Verification → App passwords.
//   2. Resend — RESEND_API_KEY (needs a verified domain for real users).
//   3. Dev mode — no service configured; the code is returned in the response
//      so the flow is fully testable in preview before credentials are added.
//
// NOTE: codes live in an in-memory Map with a 10-minute expiry. That is
// reliable in the Freebuff preview (single process) and fine for an early
// app; on multi-instance serverless deploys a user must hit the same
// instance within the window. Swap for a durable store (Firestore/Redis)
// when the app grows.

import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

const COOLDOWN_MS = 60_000;      // min time between sends per email
const TTL_MS = 10 * 60_000;      // code lifetime
const MAX_ATTEMPTS = 5;          // wrong guesses before the code is voided

// Abuse limits: the per-email cooldown alone still allows email-bombing many
// different addresses (or brute-forcing codes across requests). These cap both.
const SEND_PER_IP_MAX = 6;       // sends per IP per hour
const SEND_GLOBAL_MAX = 60;      // sends per hour across all IPs (protects the mailbox quota)
const VERIFY_PER_IP_MAX = 30;    // verify attempts per IP per hour
const HOUR_MS = 60 * 60_000;

// email -> { code, exp, attempts, sentAt }
const CODES = new Map();

// ip -> { sendWindowStart, sendCount, verifyWindowStart, verifyCount }
const IP_HITS = new Map();
let globalSendWindowStart = Date.now();
let globalSendCount = 0;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return 'local';
}

function ipHit(ip, kind, max, now = Date.now()) {
  let e = IP_HITS.get(ip);
  if (!e) { e = {}; IP_HITS.set(ip, e); }
  const startKey = kind + 'WindowStart';
  const countKey = kind + 'Count';
  if (!e[startKey] || now - e[startKey] > HOUR_MS) { e[startKey] = now; e[countKey] = 0; }
  e[countKey] = (e[countKey] || 0) + 1;
  return e[countKey] <= max;
}

function globalSendOk(now = Date.now()) {
  if (!globalSendWindowStart || now - globalSendWindowStart > HOUR_MS) {
    globalSendWindowStart = now;
    globalSendCount = 0;
  }
  globalSendCount += 1;
  return globalSendCount <= SEND_GLOBAL_MAX;
}

// Constant-time code comparison: hash both sides to a fixed length first so
// timingSafeEqual never sees unequal buffers (which would throw/leak length).
function codesMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a) === String(b);
}

// Lazy Gmail SMTP transporter — created only when GMAIL creds are configured.
let gmailTransporter = null;
function getGmailTransporter() {
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        // Gmail shows app passwords with spaces ("abcd efgh ijkl mnop");
        // the spaces are not part of the password, so strip them defensively.
        pass: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
      },
    });
  }
  return gmailTransporter;
}

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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  cleanup();
  const ip = clientIp(req);

  // ── SEND ───────────────────────────────────────────────────────────────────
  if (body.action === 'send') {
    if (!ipHit(ip, 'send', SEND_PER_IP_MAX) || !globalSendOk()) {
      console.warn(`[code] send limit hit ip=${ip}`);
      return res.status(429).json({ error: 'Too many codes requested — please try again later.' });
    }
    const prev = CODES.get(email);
    if (prev && Date.now() - prev.sentAt < COOLDOWN_MS) {
      const waitMs = COOLDOWN_MS - (Date.now() - prev.sentAt);
      return res.status(429).json({ error: 'Please wait before requesting another code.', cooldownMs: waitMs });
    }

    const code = newCode();
    CODES.set(email, { code, exp: Date.now() + TTL_MS, attempts: 0, sentAt: Date.now() });

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const resendKey = process.env.RESEND_API_KEY;

    if (!gmailUser && !resendKey) {
      // Dev mode: no email service configured yet — surface the code so the
      // flow works in preview. Configure Gmail (GMAIL_USER + GMAIL_APP_PASSWORD)
      // or Resend (RESEND_API_KEY) to deliver real emails.
      console.log(`[code] dev-mode code for ${email}: ${code}`);
      return res.status(200).json({ ok: true, dev: true, code, cooldownMs: COOLDOWN_MS });
    }

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
  <div style="font-size:22px;font-weight:700;color:#0b0e11;margin-bottom:12px;">Vytreos</div>
  <h2 style="color:#0b0e11;font-size:18px;margin:0 0 8px;">Your confirmation code</h2>
  <p style="color:#444;font-size:14px;line-height:1.6;">Use the code below to finish signing in. It expires in 10 minutes.</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#00b074;background:#f2f4f7;border-radius:12px;padding:18px 24px;text-align:center;margin:16px 0;">${code}</div>
  <p style="color:#888;font-size:12px;line-height:1.6;">If you did not request this code, you can safely ignore this email.</p>
</div>`;

    try {
      if (gmailUser && gmailPass) {
        const from = process.env.VYTREOS_EMAIL_FROM || `Vytreos <${gmailUser}>`;
        await getGmailTransporter().sendMail({ from, to: email, subject: 'Your Vytreos confirmation code', html });
        console.log(`[code] sent to ${email} via Gmail SMTP`);
      } else {
        const from = process.env.VYTREOS_EMAIL_FROM || 'Vytreos <onboarding@resend.dev>';
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
          body: JSON.stringify({ from, to: [email], subject: 'Your Vytreos confirmation code', html })
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          console.warn(`[code] Resend ${r.status}:`, err?.message);
          return res.status(502).json({ error: 'Could not send the email right now. Please try again in a moment.' });
        }
        console.log(`[code] sent to ${email} via Resend`);
      }
    } catch (e) {
      console.warn('[code] send exception:', e.message);
      return res.status(502).json({ error: 'Could not send the email right now. Please try again in a moment.' });
    }

    return res.status(200).json({ ok: true, dev: false, cooldownMs: COOLDOWN_MS });
  }

  // ── VERIFY ─────────────────────────────────────────────────────────────────
  if (body.action === 'verify') {
    if (!ipHit(ip, 'verify', VERIFY_PER_IP_MAX)) {
      return res.status(429).json({ error: 'Too many attempts — please try again later.' });
    }
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
    if (!codesMatch(entry.code, code)) {
      entry.attempts += 1;
      return res.status(400).json({ error: 'That code did not match.', attemptsLeft: MAX_ATTEMPTS - entry.attempts });
    }

    CODES.delete(email);
    console.log(`[code] verified ${email}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}

// Test-only exports (Vercel only routes the default export).
export const _internals = { codesMatch, ipHit, globalSendOk, clientIp, SEND_PER_IP_MAX, SEND_GLOBAL_MAX, VERIFY_PER_IP_MAX };
