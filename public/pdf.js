/* ============================================================
   public/pdf.js
   Redesigned wellness PDF report for Vytreos.

   Loaded as a classic <script> before the main IIFE. Exposes
   `window.PDF.render(scan, options)` which builds a brutalist-
   meets-editorial printable HTML doc in a hidden iframe and
   triggers `print()` for the user to confirm => "Save as PDF".

   Goals
   ─────
   • Less robotic. Use the existing brand colors (--green
     `#00d98b`, --bg `#06080a`) for accent + a warm paper-white
     body (#fbfaf6) so the report feels like a wellness-product
     magazine page rather than a CLI output.
   • Editorial typography. Fraunces for hero numbers +
     a smaller story block, Outfit for body + nutrient labels,
     Space Mono for data readouts.
   • Information density per page. Header strip with brand +
     scan meta, a NutriScore donut (SVG) + executive summary
     beside it, "Top 3 to act on" cards, a nutrient heatmap
     table with bar + color tier, optional per-nutrient trend
     sparklines (if 3+ history points), footer disclaimer.
   • Family-aware. Reads `window.Family.getActive()` (mounted in
     index.html via /family.js) to surface the active profile in
     the header.
   • Print ergonomics. Uses `cm` units, page-break-aware
     sections, embedded fonts via Google Fonts CDN so the
     printed doc keeps its serif headlines offline-friendly.

   No external libraries. No new env vars.
   ============================================================ */

(function (root) {
  'use strict';

  /* ── Layout constants (centered on a 1100px-print page) ── */
  var PRINT_WIDTH = '1100px';
  var TOC_PALETTE = {
    bg: '#06080a',
    bg2: '#10131a',
    paper: '#fbfaf6',
    paperDim: '#f1ede0',
    text: '#161616',
    text2: '#4f5560',
    text3: '#7a8090',
    border: '#e5e0d2',
    green: '#00a36b',
    greenDim: '#e6f7ee',
    amber: '#c99849',
    amberDim: '#fbf2dd',
    red: '#c1483b',
    redDim: '#fbecdf',
    blue: '#3a6fa8'
  };

  /* ─────────────────────────────────────────────────────────
     Helpers
     ───────────────────────────────────────────────────────── */
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmtDate(ts) {
    var d = (ts instanceof Date) ? ts : new Date(ts || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function fmtDateShort(ts) {
    var d = (ts instanceof Date) ? ts : new Date(ts || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function colorForStatus(status) {
    if (status === 'low') return TOC_PALETTE.red;
    if (status === 'high') return TOC_PALETTE.amber;
    return TOC_PALETTE.green;
  }
  function colorForLevel(level, status) {
    if (status === 'low' || level < 40) return TOC_PALETTE.red;
    if (status === 'high' || level > 75) return TOC_PALETTE.amber;
    return TOC_PALETTE.green;
  }

  /* ─────────────────────────────────────────────────────────
     NutriScore donut — SVG ring + center number.
     Returns SVG markup string.
     ───────────────────────────────────────────────────────── */
  function donutSvg(score, opts) {
    opts = opts || {};
    var size = opts.size || 220;
    var stroke = 18;
    var r = (size - stroke) / 2;
    var cx = size / 2, cy = size / 2;
    var circ = 2 * Math.PI * r;
    var s = (typeof score === 'number') ? clamp(score, 0, 100) : null;
    var frac = (s == null) ? 0 : s / 100;
    var ringColor = s == null ? TOC_PALETTE.border
                  : s >= 75 ? TOC_PALETTE.green
                  : s >= 40 ? TOC_PALETTE.amber
                  : TOC_PALETTE.red;
    var dashLen = (s == null) ? 0 : circ * frac;
    return [
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">',
      '  <circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + TOC_PALETTE.border + '" stroke-width="' + stroke + '"/>',
      '  <circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + ringColor + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + dashLen + ' ' + (circ - dashLen) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>',
      '  <text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-family="\'Fraunces\', serif" font-size="64" fill="' + TOC_PALETTE.text + '">' + (s == null ? '—' : s) + '</text>',
      '  <text x="' + cx + '" y="' + (cy + 28) + '" text-anchor="middle" font-family="\'Space Mono\', monospace" font-size="11" letter-spacing="2" fill="' + TOC_PALETTE.text3 + '">NUTRISCORE</text>',
      '</svg>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Trend sparkline — SVG path, normalized to width 220 h 32
     ───────────────────────────────────────────────────────── */
  function sparklineSvg(points, opts) {
    opts = opts || {};
    var w = opts.w || 220, h = opts.h || 32, pad = 2;
    if (!Array.isArray(points) || points.length < 2) {
      return '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg"><text x="' + (w / 2) + '" y="' + (h / 2 + 4) + '" text-anchor="middle" font-family="\'Space Mono\', monospace" font-size="9" fill="' + TOC_PALETTE.text3 + '">no trend</text></svg>';
    }
    var min = Math.min.apply(null, points);
    var max = Math.max.apply(null, points);
    var range = (max - min) || 1;
    var stepX = (w - pad * 2) / (points.length - 1);
    var path = [];
    for (var i = 0; i < points.length; i++) {
      var x = pad + i * stepX;
      var y = pad + (h - pad * 2) * (1 - (points[i] - min) / range);
      path.push((i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1));
    }
    var delta = points[points.length - 1] - points[0];
    var lineColor = delta > 0 ? TOC_PALETTE.green : delta < 0 ? TOC_PALETTE.red : TOC_PALETTE.text3;
    return [
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">',
      '  <path d="' + path.join(' ') + '" fill="none" stroke="' + lineColor + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      '  <circle cx="' + (pad + (points.length - 1) * stepX).toFixed(1) + '" cy="' + (pad + (h - pad * 2) * (1 - (points[points.length - 1] - min) / range)).toFixed(1) + '" r="2.5" fill="' + lineColor + '"/>',
      '</svg>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Action card — for "Top 3 to act on"
     ───────────────────────────────────────────────────────── */
  function actionCardHtml(nutrient, priorLevel, idx) {
    var color = colorForStatus(nutrient.status);
    var dimBg = nutrient.status === 'low' ? TOC_PALETTE.redDim
              : nutrient.status === 'high' ? TOC_PALETTE.amberDim
              : TOC_PALETTE.greenDim;
    var tagLabel = nutrient.status === 'low' ? 'top up'
                 : nutrient.status === 'high' ? 'rebalance'
                 : 'maintain';
    var delta = (typeof priorLevel === 'number')
      ? (nutrient.level - priorLevel)
      : null;
    var deltaStr = (delta == null) ? '—'
                 : (delta > 0 ? '+' : '') + delta;
    return [
      '<div class="pdf-action">',
      '  <div class="pdf-action-num">0' + (idx + 1) + '</div>',
      '  <div class="pdf-action-body">',
      '    <div class="pdf-action-row">',
      '      <div class="pdf-action-name">' + escapeHtml(nutrient.name) + '</div>',
      '      <div class="pdf-action-tag" style="background:' + dimBg + ';color:' + color + ';">' + tagLabel + '</div>',
      '    </div>',
      '    <div class="pdf-action-meta">',
      '      <span>Level <strong>' + nutrient.level + '/100</strong></span>',
      '      <span>Status <strong style="color:' + color + ';">' + (nutrient.status || '—') + '</strong></span>',
      '      <span>Δ vs prior <strong>' + deltaStr + '</strong></span>',
      '    </div>',
      'arnament  </div>',
      '</div>'
    ].join('\n').replace('arnament  ', '');
  }

  /* ─────────────────────────────────────────────────────────
     Nutrient heatmap row (table row)
     ───────────────────────────────────────────────────────── */
  function nutrientRowHtml(nutrient, points) {
    var color = colorForLevel(nutrient.level, nutrient.status);
    var conf = nutrient.confidence || 'low';
    var filledPct = clamp(nutrient.level || 0, 0, 100);
    var evidence = (nutrient.evidence || '').slice(0, 110);
    return [
      '<tr>',
      '  <td class="pdf-nname">' + escapeHtml(nutrient.name) + '</td>',
      '  <td class="pdf-nbar"><div class="pdf-bar"><div class="pdf-bar-fill" style="width:' + filledPct + '%;background:' + color + ';"></div></div></td>',
      '  <td class="pdf-nlvl" style="color:' + color + ';">' + filledPct + '</td>',
      '  <td class="pdf-nconf"><span class="pdf-conf-tag conf-' + conf + '">' + conf + '</span></td>',
      '  <td class="pdf-nspark">' + sparklineSvg(points, { w: 110, h: 24 }) + '</td>',
      '  <td class="pdf-nevid">' + escapeHtml(evidence) + '</td>',
      '</tr>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Header — branded masthead with scan meta
     ───────────────────────────────────────────────────────── */
  function headerHtml(scan, profile) {
    var date = fmtDate(scan && scan.createdAt);
    var eye = (scan && scan.eye) ? scan.eye.toUpperCase() : '—';
    var profName = (profile && profile.name) ? profile.name : 'You';
    var profRel = (profile && profile.relation) ? profile.relation : '';
    var meta = scan && scan._models
      ? (scan._models + '-model consensus')
      : 'AI wellness analysis';
    return [
      '<header class="pdf-head">',
      '  <div class="pdf-head-left">',
      '    <div class="pdf-mark"><div class="pdf-mark-pip"></div><span>Vytreos</span></div>',
      '    <div class="pdf-mark-sub">Retinal wellness report · Personal summary</div>',
      '  </div>',
      '  <div class="pdf-head-right">',
      '    <div class="pdf-head-rline">' + escapeHtml(date) + '</div>',
      '    <div class="pdf-head-rline2">Profile: <strong>' + escapeHtml(profName) + '</strong>' + (profRel ? ' (' + escapeHtml(profRel) + ')' : '') + ' · Eye: <strong>' + escapeHtml(eye) + '</strong></div>',
      '    <div class="pdf-head-rline3">' + escapeHtml(meta) + '</div>',
      '  </div>',
      '</header>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Hero strip — NutriScore donut + executive summary + key stats
     ───────────────────────────────────────────────────────── */
  function heroStripHtml(scan, priorScore) {
    var n = (scan && Array.isArray(scan.nutrients)) ? scan.nutrients : [];
    var lowN = n.filter(function (x) { return x.status === 'low'; }).length;
    var highN = n.filter(function (x) { return x.status === 'high'; }).length;
    var okN = n.length - lowN - highN;
    var score = (scan && typeof scan._nutriScore === 'number') ? scan._nutriScore : null;
    var donut = donutSvg(score, { size: 220 });
    var summary = (scan && scan.summary) ? scan.summary
      : 'A ' + n.length + '-nutrient wellness assessment with ' + (scan && scan._models ? scan._models + ' AI models' : 'multiple AI models') + ' in agreement.';
    var delta = (typeof priorScore === 'number' && score != null)
      ? (score - priorScore)
      : null;
    var deltaStr = (delta == null) ? '—'
                 : ((delta > 0 ? '+' : '') + delta + ' vs prior scan');

    return [
      '<section class="pdf-hero">',
      '  <div class="pdf-hero-donut">' + donut + '<div class="pdf-delta">' + escapeHtml(deltaStr) + '</div></div>',
      '  <div class="pdf-hero-text">',
      '    <div class="pdf-hero-eyebrow">EXECUTIVE SUMMARY</div>',
      '    <div class="pdf-hero-summary">' + escapeHtml(summary) + '</div>',
      '    <div class="pdf-hero-stats">',
      '      <div><span class="pdf-stat-num" style="color:' + TOC_PALETTE.red + ';">' + lowN + '</span><span class="pdf-stat-label">low</span></div>',
      '      <div><span class="pdf-stat-num" style="color:' + TOC_PALETTE.green + ';">' + okN + '</span><span class="pdf-stat-label">on track</span></div>',
      '      <div><span class="pdf-stat-num" style="color:' + TOC_PALETTE.amber + ';">' + highN + '</span><span class="pdf-stat-label">high</span></div>',
      '      <div><span class="pdf-stat-num">' + n.length + '</span><span class="pdf-stat-label">nutrients</span></div>',
      '    </div>',
      '  </div>',
      '</section>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Top 3 to act on — DOM-tree of the lowest-status nutrients
     ───────────────────────────────────────────────────────── */
  function topThreeHtml(scan, priorNutrientsByName) {
    var n = (scan && Array.isArray(scan.nutrients)) ? scan.nutrients.slice() : [];
    // Sort by effective "act-on" priority: low first, then by name weight
    function priority(x) {
      return (x.status === 'low' ? 0 : x.status === 'high' ? 1 : 2) * 1000 + (100 - (x.level || 50));
    }
    n.sort(function (a, b) { return priority(a) - priority(b); });
    var top = n.slice(0, 3);
    if (top.length === 0) return '';
    var cards = top.map(function (nutrient, idx) {
      var prior = priorNutrientsByName ? priorNutrientsByName[nutrient.name] : null;
      var priorLvl = prior && typeof prior.level === 'number' ? prior.level : null;
      return actionCardHtml(nutrient, priorLvl, idx);
    }).join('\n');
    return [
      '<section class="pdf-topthree">',
      '  <h2 class="pdf-section-title">Top <span>3</span> to act on this week</h2>',
      '  <div class="pdf-actions">' + cards + '</div>',
      '</section>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Nutrient heatmap table
     ───────────────────────────────────────────────────────── */
  function heatmapHtml(scan, historyByName) {
    var n = (scan && Array.isArray(scan.nutrients)) ? scan.nutrients.slice() : [];
    if (n.length === 0) return '';
    // Sort: low first, then by level ascending
    n.sort(function (a, b) {
      var aP = (a.status === 'low' ? 0 : a.status === 'high' ? 2 : 1);
      var bP = (b.status === 'low' ? 0 : b.status === 'high' ? 2 : 1);
      if (aP !== bP) return aP - bP;
      return (a.level || 50) - (b.level || 50);
    });
    var rows = n.map(function (nutrient) {
      var pts = historyByName && historyByName[nutrient.name]
        ? historyByName[nutrient.name].map(function (h) { return h.level; })
        : [];
      return nutrientRowHtml(nutrient, pts);
    }).join('\n');
    return [
      '<section class="pdf-heatmap">',
      '  <h2 class="pdf-section-title">Nutrient heatmap</h2>',
      '  <table class="pdf-htable">',
      '    <thead><tr>',
      '      <th>Nutrient</th><th>Level</th><th>Score</th>',
      '      <th>Confidence</th><th>Trend</th><th>Evidence</th>',
      '    </tr></thead>',
      '    <tbody>' + rows + '</tbody>',
      '  </table>',
      '</section>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Footer disclaimer
     ───────────────────────────────────────────────────────── */
  function disclaimerFooterHtml() {
    return [
      '<footer class="pdf-foot">',
      '  <div class="pdf-foot-strong">Vytreos is wellness exploration, not a medical device.</div>',
      '  <div class="pdf-foot-body">',
      '    AI vision models used here are general-purpose and were not trained or validated for clinical-grade ocular assessment. Outputs should be treated as personal wellness exploration only, never as a diagnosis. If you have any concerns about your eyes or vision, consult a licensed ophthalmologist or visit an emergency department. This report is generated from your retinal photograph at the time of the scan and is not a substitute for in-person clinical evaluation. Vytreos never stores retinal photos on a server — the image is held in your browser\'s memory, sent to the AI provider you chose, then discarded.',
      '  </div>',
      '  <div class="pdf-foot-line">© Vytreos · Generated ' + fmtDate(Date.now()) + ' · vytreos.app</div>',
      '</footer>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Recommendations list (full, for completeness)
     ───────────────────────────────────────────────────────── */
  function recsHtml(scan) {
    var recs = (scan && Array.isArray(scan.recommendations)) ? scan.recommendations : [];
    if (recs.length === 0) return '';
    var items = recs.map(function (rec, i) {
      return '<li><span class="pdf-rec-num">' + String(i + 1).padStart(2, '0') + '</span>' + escapeHtml(rec) + '</li>';
    }).join('\n');
    return [
      '<section class="pdf-recs">',
      '  <h2 class="pdf-section-title">All recommendations</h2>',
      '  <ol class="pdf-rec-list">' + items + '</ol>',
      '</section>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     CSS — embedded print-friendly styles.
     ───────────────────────────────────────────────────────── */
  function buildCss() {
    return [
      '<style>',
      '@import url("https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Outfit:wght@300;400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap");',
      '@page { size: A4; margin: 14mm 12mm; }',
      ':root{',
      '  --paper:' + TOC_PALETTE.paper + ';',
      '  --paper-dim:' + TOC_PALETTE.paperDim + ';',
      '  --text:' + TOC_PALETTE.text + ';',
      '  --text-2:' + TOC_PALETTE.text2 + ';',
      '  --text-3:' + TOC_PALETTE.text3 + ';',
      '  --border:' + TOC_PALETTE.border + ';',
      '  --green:' + TOC_PALETTE.green + ';',
      '  --green-dim:' + TOC_PALETTE.greenDim + ';',
      '  --amber:' + TOC_PALETTE.amber + ';',
      '  --amber-dim:' + TOC_PALETTE.amberDim + ';',
      '  --red:' + TOC_PALETTE.red + ';',
      '  --red-dim:' + TOC_PALETTE.redDim + ';',
      '  --blue:' + TOC_PALETTE.blue + ';',
      '}',
      '* { box-sizing: border-box; }',
      'html, body { margin: 0; padding: 0; background: var(--paper); color: var(--text); font-family: "Outfit", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }',
      '.pdf-body { width: ' + PRINT_WIDTH + '; max-width: 100%; margin: 0 auto; padding: 28px 36px 36px; background: var(--paper); }',
      // Masthead
      '.pdf-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid var(--text); padding-bottom: 18px; margin-bottom: 26px; }',
      '.pdf-mark { display: flex; align-items: center; gap: 12px; font-family: "Fraunces", serif; font-size: 32px; letter-spacing: 0.04em; color: var(--text); }',
      '.pdf-mark-pip { width: 12px; height: 12px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px ' + TOC_PALETTE.greenDim + '; }',
      '.pdf-mark-sub { font-family: "Space Mono", monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--text-3); margin-top: 8px; }',
      '.pdf-head-right { text-align: right; font-family: "Space Mono", monospace; }',
      '.pdf-head-rline { font-size: 13px; color: var(--text); font-weight: 600; }',
      '.pdf-head-rline2 { font-size: 11px; color: var(--text-2); margin-top: 4px; }',
      '.pdf-head-rline2 strong { color: var(--text); font-weight: 600; }',
      '.pdf-head-rline3 { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-3); margin-top: 6px; }',
      // Hero
      '.pdf-hero { display: grid; grid-template-columns: 240px 1fr; gap: 36px; padding: 22px 0 30px; border-bottom: 1px solid var(--border); align-items: center; }',
      '.pdf-hero-donut { display: flex; flex-direction: column; align-items: center; gap: 8px; }',
      '.pdf-delta { font-family: "Space Mono", monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); }',
      '.pdf-hero-text { padding-left: 12px; }',
      '.pdf-hero-eyebrow { font-family: "Space Mono", monospace; font-size: 10px; font-weight: 700; color: var(--green); letter-spacing: 0.2em; margin-bottom: 14px; }',
      '.pdf-hero-summary { font-family: "Fraunces", serif; font-size: 22px; line-height: 1.35; color: var(--text); font-style: italic; margin-bottom: 26px; }',
      '.pdf-hero-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }',
      '.pdf-hero-stats > div { display: flex; flex-direction: column; align-items: flex-start; padding: 10px 14px; background: var(--paper-dim); border-radius: 8px; }',
      '.pdf-stat-num { font-family: "Fraunces", serif; font-size: 28px; line-height: 1; }',
      '.pdf-stat-label { font-family: "Space Mono", monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-3); margin-top: 4px; }',
      // Sections
      '.pdf-section-title { font-family: "Fraunces", serif; font-size: 24px; margin: 32px 0 18px; color: var(--text); font-weight: 400; }',
      '.pdf-section-title span { color: var(--green); }',
      // Top 3 cards
      '.pdf-topthree { margin-top: 30px; }',
      '.pdf-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }',
      '.pdf-action { background: var(--paper-dim); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; position: relative; }',
      '.pdf-action-num { font-family: "Fraunces", serif; font-size: 30px; color: var(--green); line-height: 1; margin-bottom: 8px; }',
      '.pdf-action-name { font-weight: 600; font-size: 15px; }',
      '.pdf-action-tag { font-family: "Space Mono", monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; padding: 3px 8px; border-radius: 4px; }',
      '.pdf-action-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }',
      '.pdf-action-meta { font-family: "Space Mono", monospace; font-size: 10px; color: var(--text-2); display: flex; flex-direction: column; gap: 3px; }',
      '.pdf-action-meta strong { color: var(--text); font-weight: 600; }',
      // Heatmap table
      '.pdf-heatmap { margin-top: 36px; }',
      '.pdf-htable { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.pdf-htable thead th { text-align: left; font-family: "Space Mono", monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-3); padding: 10px 8px; border-bottom: 2px solid var(--text); }',
      '.pdf-htable tbody td { padding: 12px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }',
      '.pdf-nname { font-weight: 600; font-size: 13px; width: 22%; }',
      '.pdf-nbar { width: 22%; }',
      '.pdf-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }',
      '.pdf-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }',
      '.pdf-nlvl { width: 70px; font-family: "Space Mono", monospace; font-weight: 700; font-size: 13px; }',
      '.pdf-nconf { width: 110px; }',
      '.pdf-conf-tag { font-family: "Space Mono", monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 8px; border-radius: 4px; font-weight: 700; }',
      '.pdf-conf-tag.conf-high { background: var(--green-dim); color: var(--green); }',
      '.pdf-conf-tag.conf-medium { background: var(--amber-dim); color: var(--amber); }',
      '.pdf-conf-tag.conf-low { background: rgba(0,0,0,0.04); color: var(--text-3); }',
      '.pdf-nspark { width: 130px; }',
      '.pdf-nevid { font-style: italic; color: var(--text-3); font-size: 11px; width: 26%; font-family: "Space Mono", monospace; }',
      // Recs
      '.pdf-recs { margin-top: 30px; page-break-inside: avoid; }',
      '.pdf-rec-list { list-style: none; padding: 0; margin: 0; }',
      '.pdf-rec-list li { padding: 10px 0; border-bottom: 1px solid var(--border); display: flex; gap: 14px; align-items: flex-start; font-size: 12px; line-height: 1.7; }',
      '.pdf-rec-list li:last-child { border-bottom: none; }',
      '.pdf-rec-num { font-family: "Space Mono", monospace; font-size: 11px; color: var(--green); font-weight: 700; flex-shrink: 0; padding-top: 1px; }',
      // Hallucination flags
      '.pdf-flags { margin: 24px 0 0; padding: 14px 18px; background: var(--amber-dim); border: 1px solid var(--amber); border-radius: 8px; font-family: "Space Mono", monospace; font-size: 10px; line-height: 1.6; color: var(--amber); }',
      '.pdf-flags strong { color: var(--text); font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 4px; }',
      // Footer
      '.pdf-foot { margin-top: 50px; padding-top: 18px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-3); line-height: 1.7; }',
      '.pdf-foot-strong { color: var(--text); font-weight: 700; font-size: 11px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.1em; }',
      '.pdf-foot-line { font-family: "Space Mono", monospace; color: var(--text-3); margin-top: 8px; }',
      // Print rules
      '@media print { .pdf-body { padding: 0; } .pdf-head, .pdf-hero, .pdf-section-title, .pdf-action, .pdf-htable tbody tr { page-break-inside: avoid; } }',
      // Mobile preview only — collapses grid for phone-sized previews
      '@media (max-width: 760px) { .pdf-hero { grid-template-columns: 1fr; gap: 18px; } .pdf-actions { grid-template-columns: 1fr; } .pdf-htable { font-size: 11px; } .pdf-nevid { display: none; } }',
      '</style>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Wrap the HTML body into a full printable document.
     ───────────────────────────────────────────────────────── */
  function buildHtml(scan, historyByName, profile, priorScore) {
    var priorNutrientsByName = {};
    if (Array.isArray(historyByName)) {
      historyByName.forEach(function (h) {
        if (!h || !Array.isArray(h.nutrients)) return;
        h.nutrients.forEach(function (nut) {
          if (nut && nut.name && priorNutrientsByName[nut.name] == null) {
            priorNutrientsByName[nut.name] = nut;
          }
        });
      });
    } else if (historyByName && typeof historyByName === 'object') {
      priorNutrientsByName = historyByName;
    }

    var flags = (scan && Array.isArray(scan._hallucinationFlags)) ? scan._hallucinationFlags : [];
    var flagsHtml = flags.length > 0 ? [
      '<div class="pdf-flags">',
      '  <strong>AI integrity flags</strong>',
      '  This scan triggered ' + flags.length + ' hallucination guard(s):',
      '  <ul style="margin:6px 0 0;padding-left:18px;">',
      flags.map(function (f) { return '<li>' + escapeHtml(f) + '</li>'; }).join(''),
      '  </ul>',
      '</div>'
    ].join('\n') : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="en"><head>',
      '<meta charset="UTF-8">',
      '<title>Vytreos · Wellness Report · ' + escapeHtml(fmtDate(scan && scan.createdAt)) + '</title>',
      buildCss(),
      '</head><body>',
      '<div class="pdf-body">',
      headerHtml(scan, profile),
      heroStripHtml(scan, priorScore),
      topThreeHtml(scan, priorNutrientsByName),
      heatmapHtml(scan, priorNutrientsByName),
      recsHtml(scan),
      flagsHtml,
      disclaimerFooterHtml(),
      '</div>',
      '</body></html>'
    ].join('\n');
  }

  /* ─────────────────────────────────────────────────────────
     Helpers that read data from the SPA: gather priors, the
     active profile, etc. — wrapped in try/catch so the PDF
     module never crashes the host app.
     ───────────────────────────────────────────────────────── */
  function gatherFromHost(scan) {
    try {
      var family = (typeof window !== 'undefined') ? window.FAMILY : null;
      var profile = family && typeof family.getActive === 'function' ? family.getActive() : null;
      var allScans = (typeof window !== 'undefined' && Array.isArray(window.SCANS)) ? window.SCANS : [];
      var sorted = allScans.slice().sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      var idx = sorted.findIndex(function (s) { return s === scan || (scan && scan.id && s.id === scan.id); });
      var prior = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1] : null;
      var priorScore = prior && typeof prior._nutriScore === 'number' ? prior._nutriScore : null;
      var history = prior ? [prior] : [];
      return { profile: profile, prior: prior, priorScore: priorScore, history: history };
    } catch (e) {
      return { profile: null, prior: null, priorScore: null, history: [] };
    }
  }

  /* ─────────────────────────────────────────────────────────
     Render: build a hidden iframe, inject the doc, print.
     Public entry — `window.PDF.render(scan)`.
     ───────────────────────────────────────────────────────── */
  function render(scan, opts) {
    opts = opts || {};
    if (!scan) {
      if (typeof window.toast === 'function') window.toast('No scan to export.', true);
      return;
    }
    var host = gatherFromHost(scan);
    var html = buildHtml(scan, host.history, host.profile, host.priorScore);
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('title', 'Vytreos printable report');
    document.body.appendChild(iframe);
    var doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
    } catch (e) {
      // Fallback: open as a Blob in a new tab
      try {
        var blob = new Blob([html], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        if (typeof window.toast === 'function') window.toast('Opened report in a new tab.', false);
      } catch (e2) {
        if (typeof window.toast === 'function') window.toast('Could not generate report.', true);
      }
      if (doc && doc.body) { /* keep alive */ } else { return; }
    }

    var printed = false;
    function triggerPrint() {
      if (printed) return; printed = true;
      try {
        var w = iframe.contentWindow;
        if (!w) return;
        w.focus();
        setTimeout(function () { try { w.print(); } catch (e) { /* user denied */ } }, 280);
      } catch (e) { /* ignore */ }
      setTimeout(function () {
        try { document.body.removeChild(iframe); } catch (e) { /* iframe may have unmounted */ }
      }, 1200);
    }
    // Try to wait for fonts + images; fall back to a short timeout
    try {
      var w = iframe.contentWindow;
      if (w.document.fonts && typeof w.document.fonts.ready === 'object') {
        w.document.fonts.ready.then(triggerPrint).catch(function () { triggerPrint(); });
        setTimeout(triggerPrint, 900);
      } else {
        setTimeout(triggerPrint, 600);
      }
    } catch (e) {
      setTimeout(triggerPrint, 600);
    }
    return { html: html };
  }

  /* ─────────────────────────────────────────────────────────
     Exports
     ───────────────────────────────────────────────────────── */
  var api = {
    render: render,
    buildHtml: buildHtml,
    donutSvg: donutSvg,
    sparklineSvg: sparklineSvg,
    computeNutriScore: function (scan) {
      // Local NutriScore algorithm (kept simple to avoid coupling
      // with the accuracy module). Mirrors its weights.
      if (!scan || !Array.isArray(scan.nutrients) || scan.nutrients.length === 0) return null;
      var W = {
        'Lutein': 1.4, 'Zeaxanthin': 1.3, 'Omega-3 (DHA + EPA)': 1.3,
        'Vitamin A': 1.2, 'Vitamin C': 1.1, 'Vitamin D': 1.2,
        'Vitamin E': 1.0, 'Vitamin B12': 1.0, 'Vitamin B6': 0.9,
        'Folate': 1.0, 'Iron': 1.1, 'Zinc': 1.1
      };
      var totalW = 0, totalS = 0;
      scan.nutrients.forEach(function (n) {
        var w = W[n.name] || 1.0;
        var conf = n.confidence === 'high' ? 1.0
                 : n.confidence === 'medium' ? 0.85 : 0.65;
        totalS += (n.level || 50) * w * conf;
        totalW += w * conf;
      });
      return totalW === 0 ? null : Math.round(totalS / totalW);
    }
  };
  if (typeof window !== 'undefined') window.PDF = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
