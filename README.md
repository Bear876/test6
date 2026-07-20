# Vytreos

**Vytreos** is a Progressive Web App that lets a user upload or webcam-capture a retinal photo, runs it through one of several vision AI providers, and surfaces ~20 nutrient signals as a personal wellness dashboard with trend charts, comparison views, and a printable PDF report. Ships as a static site + a single serverless API endpoint.

> ⚠️ **Vytreos is a wellness-exploration tool, not a medical device.**
> Its outputs do not constitute a diagnosis and are not a substitute for an in-person consultation with a qualified ophthalmologist or optometrist. Always see a licensed clinician for any medical concern.

## Architecture

```
┌─────────────────────────────────────────────┐
│  public/index.html  (single-page app)      │  ← SPA: landing, auth, dashboard, analyzer, history, profile, modals, PDF export
│  public/sw.js       (service worker)        │  ← PWA, chart.js cache, network-first for everything else
│  public/manifest.json                       │  ← PWA install metadata
│  public/{privacy,terms}.html                │  ← standalone legal pages
│  public/robots.txt, sitemap.xml             │  ← SEO basics
└──────────────┬──────────────────────────────┘
               │  POST /api/analyze  (JSON: { model, base64, mediaType, prompt })
               ▼
┌─────────────────────────────────────────────┐
│  api/analyze.js (Vercel serverless fn)      │  ← routes by `model` to one of:
│                                             │      • mistral-vision   (Mistral Pixtral 12B)
│                                             │      • hf-biomed        (HuggingFace BLIP)
│                                             │      • roboflow         (Roboflow hosted detection)
│                                             │      • groq-llava       (Groq Llama-4-Scout)
│                                             │      • gemini-*         (Google Gemini default)
│                                             │  ← body-size cap + model allowlist + request id logging
└─────────────────────────────────────────────┘
```

The whole frontend is one self-contained HTML file to keep the prototype fast to ship; the SPA router relies on `vercel.json` rewriting any path to `/public/index.html`.

## Run locally (preview)

```bash
npm install   # creates lock file; no runtime deps
npm start     # listens on 0.0.0.0:$PORT (default 3000)
```

`server.js` is a tiny zero-dependency Node HTTP server that:

- Serves `public/` as static with SPA fallback (so any client route returns `index.html`).
- Proxies `/api/analyze` to `api/analyze.js` via dynamic `import`, with a Vercel-style req/res adapter so the existing handler runs unmodified on Node too.

If you have Freebuff installed, preview commands are pre-configured:

```bash
freebuff-preview start              # build + start, returns logs on failure
```

Don't forget to add your provider keys in **API keys** (project settings) so unfilled slots get the corresponding 503 from the UI.

## Deploy

`vercel.json` is the only deploy config required — push to GitHub and connect the repo in Vercel, or run `vercel --prod`. All provider keys are read from Vercel project environment variables.

## Environment variables

See [`.env.example`](./.env.example). Every key is optional; an un-set provider returns a 503 with `{ error: "<Provider> not configured" }` and the UI shows it gracefully.

| Variable             | Provider routed when `model` is one of…         |
|----------------------|--------------------------------------------------|
| `GEMINI_KEY`         | `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.0-flash`, `gemini-2.5-*` (default fallback) |
| `MISTRAL_API_KEY`    | `mistral-vision`                                  |
| `HF_API_KEY`         | `hf-biomed`                                       |
| `ROBOFLOW_API_KEY`   | `roboflow`                                        |
| `GROQ_API_KEY`       | `groq-llava`                                      |

`PLAUSIBLE_DOMAIN` and `SENTRY_DSN` (optional) are documented in the same file — add them when wiring those services.

## Security headers

`vercel.json` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy` on every response. `/api/*` responses are sent `Cache-Control: no-store`. `/public/index.html` is `no-cache` to make rollouts immediate.

## API hardening

`api/analyze.js` rejects requests with:

- **Method ≠ POST** → `405`
- **Body > 5 MB** → `413`
- **Unknown `model`** → `400` with `allowed: [...]`
- **Missing `base64` / `mediaType`** → `400`

Every successful invocation gets an `X-Request-Id` header for debugging through logs.

## Project layout

```
.
├── api/
│   └── analyze.js          # Vercel-style serverless handler
├── public/
│   ├── index.html          # single-page app (wellness UI)
│   ├── sw.js               # PWA service worker
│   ├── manifest.json
│   ├── robots.txt
│   ├── sitemap.xml
│   ├── favicon.svg
│   ├── apple-touch-icon.png
│   ├── privacy.html        # standalone privacy policy
│   └── terms.html          # standalone terms of service
├── server.js               # local preview server (Node, no deps)
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
├── PRIVACY.md              # privacy policy (Markdown source)
├── TERMS.md                # terms of service (Markdown source)
└── README.md
```

## License

This is experimental wellness software — **all rights reserved**. You're welcome to fork for personal use; please don't redistribute the brand or claim clinical validity.

## Medical disclaimer

Vytreos is **not a medical device**:

- The AI vision models used here (`mistral-vision`, `hf-biomed`, `roboflow`, `groq-llava`, `gemini-*`) are general-purpose and were not trained or validated for clinical-grade ocular assessment.
- Outputs should be treated as **personal wellness exploration**, never as a diagnosis.
- If you have any concerns about your eyes or vision — pain, sudden changes, floaters, flashes, blurry central vision — consult a licensed ophthalmologist or visit an emergency department immediately. Do not rely on Vytreos to triage urgent symptoms.
- The exported PDF already carries this disclaimer; the SPA surfaces it before any scan.

## Privacy in one sentence

We don't currently store your retinal photos on a server — the image is held in your browser's memory, sent to whichever AI provider you choose (subject to that provider's own privacy policy), then discarded. If you sign up for an account later, scan metadata may be persisted; see [PRIVACY.md](./PRIVACY.md).
