// public/vq.js — Image-quality pipeline for Vytreos.
//
// Loaded as <script src="/vq.js"> from public/index.html AFTER the main IIFE
// has finished executing, then VQ.install({ glareIndicator, runAnalysisName,
// scoreFrameName }) wraps the existing globals so the route we already drive
// (runAnalysis → /api/analyze) now also sees a gray-world + CLAHE-lite
// preprocessed image and a richer per-frame score.
//
// Dual-loadable:
//   • Browser: window.VQ = { … }
//   • Node  : module.exports = VQ   (used by test-vq.mjs)
// No external dependencies. Designed to be defensive: any failure in one of
// the new layers falls back to the previous behavior rather than throwing.

(function (root) {
  'use strict';

  // ─── tiny math helpers ──────────────────────────────────────────────────
  function clamp01to100(v) { v = +v; return Math.max(0, Math.min(100, Math.round(v))); }
  function clampMap(v, lo, hi, range) {
    if (range <= 0) return 0;
    return Math.max(0, Math.min(255, Math.round((v - lo) * 255 / range)));
  }
  function medianU8(arr) {
    const s = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) s[i] = arr[i];
    s.sort();
    return s[Math.floor(s.length / 2)];
  }

  // ─── pure algorithms (operate on { data, width, height }, RGBA bytes) ───

  function scoreFocus(imageData) {
    // Laplacian variance — classic blur detector. Higher = sharper.
    const { data, width: w, height: h } = imageData;
    let sum = 0, sumSq = 0, count = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = (row + x) * 4;
        const c = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const u = data[(row + x + w) * 4] * 0.299 + data[(row + x + w) * 4 + 1] * 0.587 + data[(row + x + w) * 4 + 2] * 0.114;
        const d = data[(row + x - w) * 4] * 0.299 + data[(row + x - w) * 4 + 1] * 0.587 + data[(row + x - w) * 4 + 2] * 0.114;
        const l = data[(row + x - 1) * 4] * 0.299 + data[(row + x - 1) * 4 + 1] * 0.587 + data[(row + x - 1) * 4 + 2] * 0.114;
        const r = data[(row + x + 1) * 4] * 0.299 + data[(row + x + 1) * 4 + 1] * 0.587 + data[(row + x + 1) * 4 + 2] * 0.114;
        const v = 4 * c - l - r - u - d;
        sum += v; sumSq += v * v; count++;
      }
    }
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    // Empirically: var≈50 ⇒ very blurry; var≈400 ⇒ crisp; var≥1200 ⇒ over-sharpened.
    const score = clamp01to100(30 + variance * 0.18);
    return { variance, score };
  }

  function scoreExposure(imageData) {
    // Subsample by 4× and read luminance percentiles.
    const { data, width: w, height: h } = imageData;
    const samples = new Uint8Array(Math.max(64, Math.floor((w * h) / 16)));
    let k = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const i = (y * w + x) * 4;
        samples[k++] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      }
    }
    const png = samples.subarray(0, k);
    png.sort();
    const median = png[Math.floor(png.length * 0.50)];
    const p10 = png[Math.floor(png.length * 0.10)];
    const p90 = png[Math.floor(png.length * 0.90)];
    const shade = clamp01to100(100 - Math.abs(median - 130) * 1.4);
    const loOk = p10 >= 25, hiOk = p90 <= 235;
    const range = (loOk && hiOk) ? 100 : (loOk || hiOk) ? 65 : 30;
    const score = clamp01to100(0.65 * shade + 0.35 * range);
    return { median, p10, p90, shadeScore: shade, rangeScore: range, score };
  }

  function scoreGlareDOD(imageData) {
    // Specular-peak detector. Find pixels that are bright AND low-saturation
    // (R≈G≈B AND sum > 690) across the whole image; cluster them within a 6-px
    // radius; each cluster of ≥4 px counts as a glare point. We deliberately
    // do NOT carve out a "dark disk" first — that path was brittle on images
    // where the only interesting region IS the bright cluster (the algorithm
    // picked an off-center dark region and missed the glare entirely).
    //
    // We still keep the API name for call-site stability; the "DOD" reference
    // now means "Detect glares, score them" rather than "Dark-of-Disk".
    const { data, width: w, height: h } = imageData;
    const bright = [];
    for (let i = 0; i < data.length; i += 4) {
      const r0 = data[i], g0 = data[i + 1], b0 = data[i + 2];
      if (r0 + g0 + b0 > 690 && Math.abs(r0 - g0) < 12 && Math.abs(g0 - b0) < 12) {
        const idx = i >> 2;
        bright.push([idx % w, (idx / w) | 0]);
      }
    }
    // Cluster within radius 6 px.
    const r2 = 36;
    const pts = bright.slice();
    let clusterCount = 0;
    let largestSize = 0;
    while (pts.length) {
      const seed = pts.pop();
      let clusterSize = 1;
      const stack = [seed];
      while (stack.length) {
        const p = stack.pop();
        for (let i = pts.length - 1; i >= 0; i--) {
          const q = pts[i];
          const dx = p[0] - q[0], dy = p[1] - q[1];
          if (dx * dx + dy * dy <= r2) {
            clusterSize++; stack.push(q); pts.splice(i, 1);
          }
        }
      }
      if (clusterSize > largestSize) largestSize = clusterSize;
      if (clusterSize >= 4) clusterCount++;
    }
    const score = clamp01to100(100 - 30 * clusterCount);
    return { clusterCount, largestClusterSize: largestSize, brightPixelCount: bright.length, score };
  }

  function scoreColorCast(imageData) {
    // Gray-world: the average pixel *should* be neutral. Penalty for deviation.
    const { data, width: w, height: h } = imageData;
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) {
      rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; n++;
    }
    const rMean = rSum / n, gMean = gSum / n, bMean = bSum / n;
    const gray = (rMean + gMean + bMean) / 3 || 1;
    const rR = rMean / gray, gR = gMean / gray, bR = bMean / gray;
    const dev = (Math.abs(rR - 1) + Math.abs(gR - 1) + Math.abs(bR - 1)) / 3;
    const score = clamp01to100(Math.max(0, 100 - dev * 250));
    return { rRatio: rR, gRatio: gR, bRatio: bR, deviation: dev, score };
  }

  function scoreGreenChannel(imageData) {
    // Green-channel variance ratio: retinal vessels contribute more to G.
    const { data, width: w, height: h } = imageData;
    let gSum = 0, ySum = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) {
      const g = data[i + 1];
      const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      gSum += g; ySum += y; n++;
    }
    const gM = gSum / n, yM = ySum / n;
    let gVar = 0, yVar = 0;
    for (let i = 0; i < data.length; i += 16) {
      const g = data[i + 1] - gM;
      const y = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) - yM;
      gVar += g * g; yVar += y * y;
    }
    gVar /= n; yVar /= n;
    const ratio = yVar > 0 ? gVar / yVar : 0;
    let score;
    if (ratio >= 0.30 && ratio <= 0.65) score = 95;
    else if (ratio >= 0.20 && ratio <= 0.75) score = 70;
    else score = 40;
    return { greenToLumaRatio: ratio, score };
  }

  function score(imageData) {
    const focus = scoreFocus(imageData);
    const exposure = scoreExposure(imageData);
    const glare = scoreGlareDOD(imageData);
    const colorCast = scoreColorCast(imageData);
    const greenCh = scoreGreenChannel(imageData);
    const overall = clamp01to100(
      0.45 * focus.score +
      0.18 * exposure.score +
      0.20 * glare.score +
      0.10 * colorCast.score +
      0.07 * greenCh.score
    );
    const tier = overall >= 75 ? 'Good' : overall >= 55 ? 'Fair' : 'Poor';
    return { focus, exposure, glare, colorCast, greenCh, overall, tier };
  }

  function rankSum(scores) {
    // For each frame, count how many other frames have a LOWER score in each axis.
    // Best = max sum-of-rank.
    const N = scores.length;
    if (N === 0) return -1;
    if (N === 1) return 0;
    const axes = ['focus', 'exposure', 'glare', 'colorCast', 'greenCh'];
    let bestIdx = 0, bestSum = -Infinity;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const ax of axes) {
        for (let j = 0; j < N; j++) {
          if (i !== j && scores[j][ax].score < scores[i][ax].score) s++;
        }
      }
      if (s > bestSum) { bestSum = s; bestIdx = i; }
    }
    return bestIdx;
  }

  // ─── DOM adapters (browser-only; Node tests skip these) ─────────────────

  function readCanvas(canvas, maxDim) {
    const target = maxDim || 256;
    const ratio = Math.min(target / canvas.width, target / canvas.height, 1);
    const w = Math.max(1, Math.round(canvas.width * ratio));
    const h = Math.max(1, Math.round(canvas.height * ratio));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(canvas, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function scoreCanvas(canvas) { return score(readCanvas(canvas)); }

  function fromDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c);
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // Gray-world: rescale R/G/B channels so the average pixel is neutral gray.
  function grayWorld(canvas) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {
      rSum += d[i]; gSum += d[i + 1]; bSum += d[i + 2]; n++;
    }
    const rM = rSum / n, gM = gSum / n, bM = bSum / n;
    const gray = (rM + gM + bM) / 3 || 1;
    const rs = gray / rM, gs = gray / gM, bs = gray / bM;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = Math.min(255, (d[i] * rs) | 0);
      d[i + 1] = Math.min(255, (d[i + 1] * gs) | 0);
      d[i + 2] = Math.min(255, (d[i + 2] * bs) | 0);
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  // CLAHE-lite: clip 0.5% tails of luminance histogram, linear remap.
  function claheLite(canvas, lowPct, highPct) {
    lowPct = lowPct || 0.005;
    highPct = highPct || 0.005;
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    // Build luminance histogram per byte to keep memory tiny.
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
    }
    const total = canvas.width * canvas.height;
    const lowCut = total * lowPct, highCut = total * highPct;
    let lo = 0, hi = 255, c = 0;
    for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= lowCut) { lo = i; break; } }
    c = 0;
    for (let i = 255; i >= 0; i--) { c += hist[i]; if (c >= highCut) { hi = i; break; } }
    if (hi <= lo) hi = lo + 1;
    const range = hi - lo;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = clampMap(d[i],     lo, hi, range);
      d[i + 1] = clampMap(d[i + 1], lo, hi, range);
      d[i + 2] = clampMap(d[i + 2], lo, hi, range);
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  // Hotspot attenuation: for every bright+low-sat pixel, replace with the mean
  // of a sampled ring of neighbors (so the AI sees choroid pattern instead of
  // a corneal flash). Operates on the WHOLE image now (no disk pre-filter).
  function attenuateHotspots(canvas, summary) {
    if (!summary || !summary.glare || summary.glare.clusterCount === 0) return canvas;
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    const w = canvas.width, h = canvas.height;
    const inner = 4, outer = 10;
    for (let y = inner; y < h - inner; y++) {
      for (let x = inner; x < w - inner; x++) {
        const i = (y * w + x) * 4;
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        if (r0 + g0 + b0 > 690 && Math.abs(r0 - g0) < 12 && Math.abs(g0 - b0) < 12) {
          let rs = 0, gs = 0, bs = 0, nn = 0;
          for (let dy = -outer; dy <= outer; dy += 2) {
            for (let dx = -outer; dx <= outer; dx += 2) {
              if (Math.abs(dx) < inner && Math.abs(dy) < inner) continue;
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const j = (yy * w + xx) * 4;
              rs += d[j]; gs += d[j + 1]; bs += d[j + 2]; nn++;
            }
          }
          if (nn > 0) {
            d[i]     = rs / nn | 0;
            d[i + 1] = gs / nn | 0;
            d[i + 2] = bs / nn | 0;
          }
        }
      }
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  function greenEmphasis(srcCanvas) {
    // Returns a NEW canvas emphasizing green channel contrast (vessel map).
    const out = document.createElement('canvas');
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    const sCtx = srcCanvas.getContext('2d');
    const dCtx = out.getContext('2d');
    const id = sCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = (d[i] * 0.45) | 0;
      d[i + 1] = Math.min(255, (d[i + 1] * 1.10) | 0);
      d[i + 2] = (d[i + 2] * 0.70) | 0;
    }
    dCtx.putImageData(id, 0, 0);
    return out;
  }

  function preprocess(canvas, opts) {
    opts = opts || {};
    let work = canvas;
    if (opts.copy) {
      const cpy = document.createElement('canvas');
      cpy.width = canvas.width; cpy.height = canvas.height;
      cpy.getContext('2d').drawImage(canvas, 0, 0);
      work = cpy;
    }
    const summary = scoreCanvas(work);
    grayWorld(work);
    claheLite(work);
    attenuateHotspots(work, summary);
    return opts.greenEmphasis ? greenEmphasis(work) : work;
  }

  function medianMerge(canvases) {
    if (!canvases || !canvases.length) return null;
    const w = canvases[0].width, h = canvases[0].height;
    if (canvases.length === 1) return canvases[0];
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const oCtx = out.getContext('2d');
    const pixels = new Uint8Array(w * h);
    const channel = new Uint8Array(canvases.length);
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let i = 0; i < canvases.length; i++) {
            const id = canvases[i].getContext('2d').getImageData(x, y, 1, 1).data;
            channel[i] = id[ch];
          }
          pixels[y * w + x] = medianU8(channel);
        }
      }
      // Now write one channel into out.
      const id = oCtx.getImageData(0, 0, w, h);
      const d = id.data;
      const off = ch;
      for (let i = 0; i < pixels.length; i++) {
        d[i * 4 + off] = pixels[i];
      }
      oCtx.putImageData(id, 0, 0);
    }
    // Set alpha to 255.
    const id = oCtx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    oCtx.putImageData(id, 0, 0);
    return out;
  }

  function bestOf(canvases) {
    const scores = canvases.map(scoreCanvas);
    const idx = rankSum(scores);
    return { index: idx, scores, overall: scores[idx] ? scores[idx].overall : 0, tier: scores[idx] ? scores[idx].tier : 'Poor' };
  }

  function qualityNotes(summary) {
    if (!summary) return '';
    const parts = [];
    parts.push('Image quality: ' + summary.tier + ' (' + summary.overall + '/100).');
    if (summary.focus.score < 50)  parts.push('Mildly blurry — discount fine vessel detail.');
    if (summary.focus.score < 25)  parts.push('Strongly blurry — focus only on gross morphology.');
    if (summary.exposure.score < 50) parts.push('Exposure non-ideal — high-contrast details may be crushed or blown.');
    if (summary.glare.score < 60) parts.push('Specular highlights present — likely corneal reflection; ignore those zones.');
    if (summary.glare.clusterCount >= 3) parts.push('Multiple glare artifacts detected.');
    if (summary.colorCast.score < 50) parts.push('Strong color cast — white/gray structures may not be true-gray.');
    if (summary.greenCh.score < 60)  parts.push('Green channel weak — vessels hard to discern.');
    if (summary.overall >= 75) parts.push('Photo is crisp and well-lit — read all features confidently.');
    return parts.join(' ');
  }

  // ─── browser installer: wraps existing index.html IIFE globals ──────────

  function install(opts) {
    opts = opts || {};
    const out = { hooked: [], skipped: [], errors: [] };
    if (typeof window === 'undefined' || typeof document === 'undefined') return out;

    // Wrap window.runAnalysis: preprocess the image BEFORE the existing chain.
    if (typeof window.runAnalysis === 'function' && !window.runAnalysis.__vq) {
      const orig = window.runAnalysis;
      const wrapped = async function (imgDataUrl) {
        try {
          const c = await fromDataUrl(imgDataUrl);
          const summary = scoreCanvas(c);
          window.__vqLastSummary = summary;
          window.__vqLastNotes = qualityNotes(summary);
          const processed = preprocess(c, { copy: true });
          const processedUrl = processed.toDataURL('image/jpeg', 0.92);
          return await orig.call(this, processedUrl);
        } catch (e) {
          out.errors.push('runAnalysis: ' + e.message);
          return orig.call(this, imgDataUrl);
        }
      };
      wrapped.__vq = true;
      window.runAnalysis = wrapped;
      out.hooked.push('runAnalysis');
    }

    // Wrap window.scoreFrame: enrich its return with VQ fields.
    if (typeof window.scoreFrame === 'function' && !window.scoreFrame.__vq) {
      const orig = window.scoreFrame;
      const wrapped = async function (dataUrl) {
        const base = orig.call(this, dataUrl);
        try {
          const c = await fromDataUrl(dataUrl);
          const vq = scoreCanvas(c);
          return Object.assign({}, base, vq);
        } catch (e) {
          out.errors.push('scoreFrame: ' + e.message);
          return base;
        }
      };
      wrapped.__vq = true;
      window.scoreFrame = wrapped;
      out.hooked.push('scoreFrame');
    }

    // Live-preview hook: rate-limited rAF that scores the webcam video and
    // updates the existing .glare-indicator element with VQ-driven feedback.
    function attachLive(videoEl, indicatorEl) {
      let raf = null, last = 0;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - last < 200) return; // 5 Hz
        last = now;
        if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return;
        try {
          const c = document.createElement('canvas');
          c.width = 192; c.height = 192;
          const ctx = c.getContext('2d');
          const r = Math.min(videoEl.videoWidth, videoEl.videoHeight);
          ctx.drawImage(videoEl, (videoEl.videoWidth - r) / 2, (videoEl.videoHeight - r) / 2, r, r, 0, 0, 192, 192);
          const s = scoreCanvas(c);
          if (indicatorEl) {
            const klass = s.tier === 'Good' ? 'good' : s.tier === 'Fair' ? 'warn' : 'bad';
            const symbol = s.tier === 'Good' ? '✓' : s.tier === 'Fair' ? '◐' : '⚠';
            if (indicatorEl.dataset.vqTier !== klass) {
              indicatorEl.dataset.vqTier = klass;
              indicatorEl.classList.remove('glare-good', 'glare-warn', 'glare-bad');
              indicatorEl.classList.add('glare-' + klass);
              indicatorEl.textContent = symbol + ' ' + (s.tier === 'Good' ? 'Good lighting' : s.tier === 'Fair' ? 'Adjust lighting' : 'Too blurry / glare');
            }
          }
        } catch (e) { /* swallow: this is best-effort UI hint */ }
      };
      tick();
      return function stop() { if (raf) cancelAnimationFrame(raf); };
    }

    window.__vqAttachLive = attachLive;
    window.attachLiveQuality = attachLive;

    if (opts.autostart && opts.video && opts.indicator) {
      attachLive(opts.video, opts.indicator);
      out.hooked.push('livGlare autostarted');
    }

    return out;
  }

  // ─── exports ─────────────────────────────────────────────────────────────

  const VQ = {
    // Pure:
    score: score,
    scoreFocus: scoreFocus,
    scoreExposure: scoreExposure,
    scoreGlareDOD: scoreGlareDOD,
    scoreColorCast: scoreColorCast,
    scoreGreenChannel: scoreGreenChannel,
    rankSum: rankSum,
    // DOM:
    readCanvas: readCanvas,
    scoreCanvas: scoreCanvas,
    fromDataUrl: fromDataUrl,
    scoreDataUrl: function (u) { return fromDataUrl(u).then(scoreCanvas); },
    grayWorld: grayWorld,
    claheLite: claheLite,
    greenEmphasis: greenEmphasis,
    attenuateHotspots: attenuateHotspots,
    preprocess: preprocess,
    medianMerge: medianMerge,
    bestOf: bestOf,
    qualityNotes: qualityNotes,
    // Hooking:
    install: install,
  };

  if (typeof window !== 'undefined') window.VQ = VQ;
  if (typeof module !== 'undefined' && module.exports) module.exports = VQ;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : globalThis));
