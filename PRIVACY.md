# Privacy Policy

_Last updated: today._

Vytreos ("we", "us") operates a retinal-eye-health exploration web app. This policy explains what we collect, what we don't, and your choices.

## What Vytreos does today

- The web app loads in your browser; no account is required to use it.
- When you start an analysis, **your retinal photograph leaves your device** so it can be processed by the AI provider matching the model you selected (or the default Gemini fallback).
- We currently do **not** persist your retinal photo on a Vytreos-owned server: it is buffered in browser memory, forwarded to the chosen AI provider, then we discard it on the server side.

## What we collect

| Data | When | Where it's stored |
|---|---|---|
| Retinal photo (base64) | When you click "Analyze" | In-memory only; forwarded to the selected AI provider; discarded server-side after the call. |
| Scan metadata (date, nutrient list, narrative) | If you sign in and save a scan | Would be stored in a future backend; today it lives only in your browser's localStorage. |
| Provider API response | When you ask for an analysis | Held briefly server-side, then discarded. |
| Standard server logs | Every request | Aggregated counts, response status, request ID, byte length. Not matched to a person. |

If you sign up for an account in the future, we may store scan metadata keyed to your account so you can see trends across visits. We will never sell or rent that data.

## Third-party AI providers

When you click "Analyze", the photo is sent to whichever provider matches the model you selected:

- **Google Gemini** (`gemini-1.5-*`, `gemini-2.0-*`, `gemini-2.5-*`) — governed by [Google's API terms](https://ai.google.dev/terms).
- **Mistral AI** (Pixtral 12B) — governed by Mistral's terms of service.
- **HuggingFace Inference API** (BLIP captioner) — governed by HuggingFace's terms.
- **Roboflow** (`eye-detection-4jkmm`) — governed by Roboflow's terms.
- **Groq** (Llama-4-Scout) — governed by Groq's terms.

Each of these providers has its own data retention policy. By using Vytreos you accept that your photo is processed under their terms at the moment of analysis.

## Cookies and local storage

Vytreos uses your browser's `localStorage` to remember your UI theme, scan draft state, and (if applicable) a session token. We do not use cross-site tracking cookies. The PWA service worker (`public/sw.js`) caches static assets locally so the app loads fast on repeat visits.

## Your rights

Depending on where you live (GDPR, CCPA, LGPD, etc.) you have rights to access, correct, export, or delete the personal data we hold about you.

- **Access / export:** `Settings → Export my data` (when shipped) or simply copy from your browser's localStorage in DevTools.
- **Delete:** "Sign out and clear site data" in your browser removes everything Vytreos has stored locally. If you have an account, request deletion by emailing the address below and we will purge server-side records within 30 days.

## Children

Vytreos is not intended for users under 16. We do not knowingly collect data from children.

## Security

We transport everything over HTTPS, set strict response headers via `vercel.json` (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, no-store on the API), cap upload body size, and validate the AI provider list server-side. No system is perfectly secure — if you find a vulnerability, please email security@vytreos.app instead of disclosing publicly.

## Contact

For privacy questions or data requests: **privacy@vytreos.app**.

## Changes

We may update this policy. Material changes are noted by date above. Continued use after a change constitutes acceptance.
