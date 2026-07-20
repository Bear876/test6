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

## Image quality pipeline

Phone-camera retinal photos are hard: motion blur, corneal glare, white-balance casts, and lens artifacts all degrade what reaches the vision model. Vytreos runs an on-device quality pipeline **before** any `/api/analyze` request — no backend round-trip, no extra cost, no new env vars.

The pipeline lives in `public/vq.js` (≈ 350 lines, zero dependencies; loadable as a classic `<script>` in the browser and via Node for testing). It exposes five independent metrics over a downscaled ImageData:

| Metric | What it catches | Algorithm |
|---|---|---|
| **Focus** | motion blur, out-of-focus camera | Laplacian variance over 3×3 luminance |
| **Exposure** | under/over-exposed frames | luminance percentile sampling (p10/p50/p90) |
| **Glare (specular peaks)** | corneal reflection, flash hot-spots | clustered bright+low-saturation pixels (≥4 px within 6 px = one hotspot) |
| **Color cast** | off-white balance, ISP tinting | gray-world assumption (deviation of mean R/G/B from neutral) |
| **Green-channel signal** | washed-out vessels vs. healthy vasculature | green-channel variance / luminance variance ratio |

A composite `overall` score weights focus strongly (0.45), with smaller weights on glare, exposure, color cast, and signal — every photo gets a `Good / Fair / Poor` tier before it is sent to the model.

### Preprocessing before the AI

Any image that flows through `window.runAnalysis` (whether from the webcam or a file upload) is first copied to an off-screen canvas, then run through three transforms:

1. **Gray-world normalization** — rescale R/G/B so the average pixel is neutral gray. Different phone ISPs lean warm or cool; this collapses the spread.
2. **CLAHE-lite** — clip 0.5% tails of the luminance histogram, linear remap. Pulls crushed shadows back without amplifying sensor noise.
3. **Hotspot attenuation** — for any detected glare cluster, replace with a mean of the surrounding ring (so the AI sees choroid pattern instead of a corneal flash).

The transformed canvas is then `toDataURL('image/jpeg', 0.92)`-encoded and only that URL is sent to `/api/analyze`.

### Quality hints → model prompt

The final composite summary also produces a short `qualityNotes(...)` string (e.g., "Image quality: Fair (62/100). Mildly blurry — discount fine vessel detail. Specular highlights present…"). It is stashed on `window.__vqLastNotes` after each analysis so the SPA can append it to provider-specific prompts if desired.

### What it does *not* do

- It never blocks a scan — even a totally-blurred photo is still sent and the model still returns a result (the SPA already displays API errors gracefully).
- It does **not** require any of the provider API keys — you can deploy with only `GEMINI_KEY` set and still get quality scoring on every scan.
- It does **not** call any external service. All scoring and preprocessing run on the user's device in <50 ms on a typical phone.

See `public/vq.js` for the algorithms and `test-vq.mjs` for the synthetic-fixture tests (run with `node test-vq.mjs`).

## Eye tracking (OD/OS)

Every scan is tagged with an eye selector — Left (OS), Right (OD), or Both. The selector lives in the analyzer panel before each scan. Features:

- **Eye badge** on each scan in history/dashboard (OD/OS pill).
- **Per-eye filter** — toggle between All / OS / OD to see trends for a single eye.
- **Eye stored in Firestore** — persists across sign-ins and devices.

## CSV data export

Export all your nutrient data as a spreadsheet-ready CSV file. Click the **📥 CSV** button in the history tab. The CSV includes:

- Date, Eye (OD/OS/both), Nutrient name, Level (0–100), Status, Confidence, and Image quality.
- UTF-8 BOM for Excel compatibility.
- One row per nutrient per scan — ready for pivot tables.

## Personalized food recommendations

After each scan, if any nutrient signal is borderline or low, Vytreos surfaces a personalized food plan with:

- **Specific foods, portions, and frequency** for each nutrient (e.g., "Chicken liver 85g, 2×/wk").
- **Absorption tips** (e.g., "Pair iron with vitamin C; avoid tea 1hr after meals").
- The food database covers all 20+ nutrients the AI assesses.

## Lifestyle experiment log

Track supplements, diet changes, or habits alongside your retinal scans. Lives in the **Trends** tab:

- **Add experiments** — "Fish oil 1000mg" or "No dairy since March 1st."
- **Timeline view** — see when you started each intervention.
- **Correlate with trends** — overlay experiment start dates on nutrient charts to spot causal patterns.
- **Stored in localStorage** — no backend required. Survives page reloads.

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
