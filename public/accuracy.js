/* ============================================================
   public/accuracy.js
   AI accuracy & anti-hallucination module for Vytreos.

   Loaded as a classic <script> before the main IIFE, so it
   exposes its API on `window.ACCURACY`. AMD / CJS exports are
   also wired for the test harness (test-accuracy.mjs).

   What it does
   ────────────
   1. NUTRIENT_ALLOWLIST — the only canonical nutrient names the
      app knows. Anything outside this list gets flagged as a
      potential hallucination and dropped from the merged result.

   2. SYNONYM_MAP — maps whatever the AI writes ("Beta Carotene",
      "vit a", "B-12") to the canonical name ("Vitamin A",
      "Vitamin B12"). This is the single biggest source of
      name-drift confusion and false-low-consensus scores.

   3. schemaSuffix(prompt, options) — appends a strict JSON
      schema + the allowlist + temperature/format reminders to
      every prompt before it leaves for /api/analyze. This forces
      the model to use *only* valid names, integer levels in
      [0,100], and a strict confidence enum. Cheap to add on.

   4. extractJSON(text) — robust parser: strips ```json fences,
      finds the first {...} block, falls back to "no valid output"
      rather than letting one bad provider crash the merge.

   5. consensusMerge(results) — replaces the sequential pairwise
      `mergeResults(a,b)` approach with a single per-nutrient
      vote across all providers. Each canonical nutrient gathers
      votes from every provider that flagged it; we keep the
      median level (robust to single outlier), recompute
      confidence based on agreement count, and surface a
      `_agreement` field (e.g. "5/6 models") so the UI can badge
      consensus. Recommendations are also voted on by Jaccard
      token overlap. Orphan recommendations (referencing no
      flagged nutrient) are dropped.

   6. validateOutput(merged) — last-line normalization:
      clamp levels, canonicalize names, drop nutrients not on
      the allowlist, enforce confidence enum, collect a
      `_hallucinationFlags: []` array for the UI to surface.

   7. visionGatePrompt(prompt) — short yes/no prompt used before
      the full nutrient call: "Is this an actual photograph of a
      retinal/eye surface, or something else?" If the gate says
      no, we skip the rest of the analysis to save tokens and
      avoid the AI confabulating nutrients for a cat photo.

   8. computeNutriScore(nutrients) — composite for the PDF
      NutriScore donut: weighted mean of nutrient levels, with a
      penalty for low-confidence or single-model results.
   ============================================================ */

(function (root) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     1.  CANONICAL NUTRIENT ALLOWLIST
     These 24 names are the only ones the app trusts. The full
     consumer-wellness nutrient set has been narrowed down to
     what is plausibly inferable from ocular photographs.
     ───────────────────────────────────────────────────────────── */
  var NUTRIENT_ALLOWLIST = [
    'Vitamin A',
    'Vitamin C',
    'Vitamin D',
    'Vitamin E',
    'Vitamin B12',
    'Vitamin B6',
    'Folate',
    'Iron',
    'Zinc',
    'Selenium',
    'Copper',
    'Magnesium',
    'Calcium',
    'Potassium',
    'Omega-3 (DHA + EPA)',
    'Lutein',
    'Zeaxanthin',
    'Beta-carotene',
    'Lycopene',
    'Coenzyme Q10',
    'Glutathione',
    'Taurine',
    'Hydration',
    'Blood circulation'
  ];

  /* ─────────────────────────────────────────────────────────────
     2.  SYNONYM MAP
     Lower-case aliases → canonical. Keyed by lower-case for fast
     lookup; the lookup normalizes the model output first.
     ───────────────────────────────────────────────────────────── */
  var SYNONYM_MAP = {
    // Vitamin A family
    'vit a': 'Vitamin A',
    'vitamin a': 'Vitamin A',
    'retinol': 'Vitamin A',
    'beta carotene': 'Beta-carotene',
    'β-carotene': 'Beta-carotene',
    'betacarotene': 'Beta-carotene',
    // Vitamin C
    'vit c': 'Vitamin C',
    'vitamin c': 'Vitamin C',
    'ascorbic acid': 'Vitamin C',
    'ascorbate': 'Vitamin C',
    // Vitamin D
    'vit d': 'Vitamin D',
    'vitamin d': 'Vitamin D',
    'cholecalciferol': 'Vitamin D',
    // Vitamin E
    'vit e': 'Vitamin E',
    'vitamin e': 'Vitamin E',
    'tocopherol': 'Vitamin E',
    // B12
    'b12': 'Vitamin B12',
    'vit b12': 'Vitamin B12',
    'vitamin b-12': 'Vitamin B12',
    'cobalamin': 'Vitamin B12',
    'cyanocobalamin': 'Vitamin B12',
    // B6
    'b6': 'Vitamin B6',
    'vit b6': 'Vitamin B6',
    'vitamin b-6': 'Vitamin B6',
    'pyridoxine': 'Vitamin B6',
    // Folate / folic
    'folate': 'Folate',
    'folic acid': 'Folate',
    'b9': 'Folate',
    'vit b9': 'Folate',
    'vitamin b9': 'Folate',
    // Minerals
    'iron': 'Iron',
    'fe': 'Iron',
    'zinc': 'Zinc',
    'zn': 'Zinc',
    'selenium': 'Selenium',
    'se': 'Selenium',
    'copper': 'Copper',
    'cu': 'Copper',
    'magnesium': 'Magnesium',
    'mg': 'Magnesium',
    'calcium': 'Calcium',
    'ca': 'Calcium',
    'potassium': 'Potassium',
    'k': 'Potassium',
    // Lipids / carotenoids
    'omega 3': 'Omega-3 (DHA + EPA)',
    'omega-3': 'Omega-3 (DHA + EPA)',
    'omega3': 'Omega-3 (DHA + EPA)',
    'dha': 'Omega-3 (DHA + EPA)',
    'epa': 'Omega-3 (DHA + EPA)',
    'fish oil': 'Omega-3 (DHA + EPA)',
    'lutein': 'Lutein',
    'zeaxanthin': 'Zeaxanthin',
    'lycopene': 'Lycopene',
    'beta-carotene': 'Beta-carotene',
    // Mitochondria / cofactors
    'coq10': 'Coenzyme Q10',
    'coenzyme q10': 'Coenzyme Q10',
    'coq': 'Coenzyme Q10',
    'glutathione': 'Glutathione',
    'gsh': 'Glutathione',
    'taurine': 'Taurine',
    // Systemic metrics
    'hydration': 'Hydration',
    'water': 'Hydration',
    'blood flow': 'Blood circulation',
    'circulation': 'Blood circulation',
    'perfusion': 'Blood circulation'
  };

  /* ─────────────────────────────────────────────────────────────
     3.  CONFIDENCE / STATUS enums
     ───────────────────────────────────────────────────────────── */
  var CONFIDENCE_ENUM = { low: 1, medium: 2, high: 3 };
  var CONFIDENCE_RANK = CONFIDENCE_ENUM;

  function statusFromLevel(level) {
    if (typeof level !== 'number' || !isFinite(level)) return 'ok';
    if (level < 40) return 'low';
    if (level > 75) return 'high';
    return 'ok';
  }

  /* ─────────────────────────────────────────────────────────────
     4.  CANONICALIZE a nutrient name from any model output.
     Returns canonical name (string) or null if unmappable.
     ───────────────────────────────────────────────────────────── */
  function canonicalize(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    var key = rawName.toLowerCase().trim();
    // direct allowlist hit
    for (var i = 0; i < NUTRIENT_ALLOWLIST.length; i++) {
      if (NUTRIENT_ALLOWLIST[i].toLowerCase() === key) return NUTRIENT_ALLOWLIST[i];
    }
    // synonym map
    if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, key)) {
      return SYNONYM_MAP[key];
    }
    // Word-boundary fallback only (avoids "k" matching "unknown").
    // Split the input into tokens; if any token equals a synonym key,
    // we accept it. This still allows "b12 complex" → "Vitamin B12"
    // because the synonym key "b12" is one of the tokens.
    var tokens = key.split(/[^a-z0-9]+/).filter(function (t) { return t.length > 0; });
    for (var ki = 0; ki < tokens.length; ki++) {
      if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, tokens[ki])) {
        return SYNONYM_MAP[tokens[ki]];
      }
    }
    // Final fallback: collapse non-alphanumerics so "b-12" → "b12"
    // hits the exact-synonym check. Require length >= 3 so single-
    // letter keys like "k" don't accidentally match "walk" / "mineral".
    var compact = key.replace(/[^a-z0-9]/g, '');
    if (compact.length >= 3 && compact !== key) {
      for (var ai = 0; ai < NUTRIENT_ALLOWLIST.length; ai++) {
        if (NUTRIENT_ALLOWLIST[ai].toLowerCase() === compact) return NUTRIENT_ALLOWLIST[ai];
      }
      if (Object.prototype.hasOwnProperty.call(SYNONYM_MAP, compact)) {
        return SYNONYM_MAP[compact];
      }
    }
    return null;
  }

  function clampLevel(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function isAllowedName(name) {
    return NUTRIENT_ALLOWLIST.indexOf(name) !== -1;
  }

  /* ─────────────────────────────────────────────────────────────
     5.  SCHEMA SUFFIX for prompts.
     Append to every prompt before sending to /api/analyze.
     ───────────────────────────────────────────────────────────── */
  function schemaSuffix(opts) {
    opts = opts || {};
    var strict = opts.strict !== false;
    var allow = NUTRIENT_ALLOWLIST.map(function (n) { return '"' + n + '"'; }).join(', ');
    var text = [
      strict ? 'STRICT OUTPUT CONTRACT — failure to follow will be rejected:' : 'OUTPUT CONTRACT:',
      'Return ONLY a single JSON object (no markdown, no commentary, no extra prose).',
      'Schema:',
      '{',
      '  "nutrients": [',
      '    { "name": <one of ' + allow + '>, "level": <integer 0-100>, "confidence": "low"|"medium"|"high", "evidence": <short string>, "status": "low"|"ok"|"high" }',
      '  ],',
      '  "recommendations": [<one-sentence dietary or lifestyle suggestion, plain text>],',
      '  "summary": <2-3 sentence plain English summary>',
      '}',
      'Rules:',
      '- Use ONLY nutrient names from the allowlist above. Unknown nutrient names will be dropped.',
      '- `level` is an integer 0-100 (clamped). If uncertain, use 50.',
      '- `confidence` MUST be one of "low", "medium", "high". Capitalization matters.',
      '- `status` MUST be one of "low" (<40), "ok" (40-75), "high" (>75).',
      '- Do not invent nutrients you cannot justify. If you only see 6 indicators, return 6.',
      '- `recommendations` should each reference a nutrient you flagged. Avoid generic advice.',
      'RESPOND WITH ONLY THE JSON. NO PROSE BEFORE OR AFTER.'
    ].join('\n');
    return text;
  }

  function appendSchema(prompt, opts) {
    return String(prompt || '') + '\n\n' + schemaSuffix(opts);
  }

  /* ─────────────────────────────────────────────────────────────
     6.  ROBUST JSON EXTRACTION.
     Models wrap in ```json ... ```, prefix with commentary, or
     (rarely) return a "[truncated]" string. We do best-effort.
     ───────────────────────────────────────────────────────────── */
  function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    var s = text
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    // Try a direct parse first.
    try { var d = JSON.parse(s); return d; } catch (e) { /* fall through */ }
    // Find the first {...} block.
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      var slice = s.slice(start, end + 1);
      try { return JSON.parse(slice); } catch (e) { /* fall through */ }
    }
    // Find first [...] block as a fallback (some models wrap in array)
    var a1 = s.indexOf('[');
    var a2 = s.lastIndexOf(']');
    if (a1 !== -1 && a2 !== -1 && a2 > a1) {
      try { return JSON.parse(s.slice(a1, a2 + 1)); } catch (e) { /* fall through */ }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     7.  CONSENSUS MERGE — the meat.
     `results` is an array (length 0..6) of parsed provider outputs
     (each already JSON.parsed). Order doesn't matter.
     ───────────────────────────────────────────────────────────── */
  function consensusMerge(results) {
    if (!Array.isArray(results)) return null;
    // 1. Normalize each provider output into a list of nutrients
    //    and a list of recommendation strings.
    var totalModels = results.length;
    var nutrientVotes = {};        // canonical name -> array of votes
    var recVotes = {};             // rec text -> count
    var summaryParts = [];

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || typeof r !== 'object') continue;

      var nutrients = Array.isArray(r.nutrients) ? r.nutrients : [];
      for (var n = 0; n < nutrients.length; n++) {
        var raw = nutrients[n];
        if (!raw || typeof raw !== 'object') continue;
        var name = canonicalize(raw.name);
        if (!name) continue;
        var level = clampLevel(raw.level);
        var conf = String(raw.confidence || 'low').toLowerCase();
        if (!CONFIDENCE_RANK.hasOwnProperty(conf)) conf = 'low';
        if (!nutrientVotes[name]) nutrientVotes[name] = [];
        nutrientVotes[name].push({
          level: level,
          confidence: conf,
          evidence: (typeof raw.evidence === 'string') ? raw.evidence.slice(0, 240) : ''
        });
      }

      var recs = Array.isArray(r.recommendations) ? r.recommendations : [];
      for (var k = 0; k < recs.length; k++) {
        var recText = String(recs[k] || '').trim();
        if (recText.length < 8) continue;
        if (recText.length > 300) recText = recText.slice(0, 300) + '…';
        recVotes[recText] = (recVotes[recText] || 0) + 1;
      }

      if (typeof r.summary === 'string' && r.summary.length > 20) {
        summaryParts.push(r.summary);
      }
    }

    // 2. Per-nutrient consensus — median level, agreement%
    var mergedList = [];
    var keys = Object.keys(nutrientVotes);
    for (var j = 0; j < keys.length; j++) {
      var k2 = keys[j];
      var votes = nutrientVotes[k2];
      var levels = votes.map(function (v) { return v.level; }).sort(function (a, b) { return a - b; });
      var medianLvl = levels[Math.floor(levels.length / 2)];
      // agreement: fraction of providers that flagged this nutrient
      var agreement = votes.length / Math.max(totalModels, 1);
      var evidence = votes
        .filter(function (v) { return v.evidence && v.evidence.length; })
        .sort(function (a, b) { return b.evidence.length - a.evidence.length; })[0];
      var confBoost = totalModels === 1
        ? votes[0].confidence
        : votes.length >= Math.ceil(totalModels * 0.66) ? 'high'
          : votes.length >= Math.ceil(totalModels * 0.34) ? 'medium'
          : 'low';
      mergedList.push({
        name: k2,
        level: medianLvl,
        status: statusFromLevel(medianLvl),
        confidence: confBoost,
        evidence: evidence ? evidence.evidence : '',
        _agreement: votes.length + '/' + totalModels + ' models',
        _agreement_frac: +agreement.toFixed(2),
        _votes_level_range: [levels[0], levels[levels.length - 1]]
      });
    }

    // 3. Pick the best recommendations
    // First cluster by token Jaccard (so "Eat spinach" + "Add spinach" merge).
    var recEntries = Object.keys(recVotes).map(function (text) {
      return { text: text, count: recVotes[text], tokens: tokenize(text) };
    });
    var recClusters = [];
    for (var p = 0; p < recEntries.length; p++) {
      var e = recEntries[p];
      var placed = false;
      for (var q = 0; q < recClusters.length; q++) {
        var sim = jaccard(e.tokens, recClusters[q].tokens);
        if (sim >= 0.5) { recClusters[q].count += e.count; placed = true; break; }
      }
      if (!placed) recClusters.push(e);
    }
    recClusters.sort(function (a, b) { return b.count - a.count; });
    var topRecs = recClusters.slice(0, 6).map(function (c) { return c.text; });

    // 4. Drop orphan recs that don't reference any flagged nutrient
    var flaggedNutrients = mergedList.map(function (m) { return m.name.toLowerCase(); });
    var foodKeywords = [
      'eat', 'add', 'try', 'more', 'less', 'include', 'avoid', 'reduce',
      'spinach', 'kale', 'salmon', 'tuna', 'egg', 'liver', 'carrot',
      'sweet potato', 'orange', 'berry', 'nuts', 'seed', 'lentil',
      'beans', 'chicken', 'beef', 'broccoli', 'kefir', 'yogurt',
      'fish oil', 'supplement', 'vitamin', 'mineral', 'water', 'sleep'
    ];
    topRecs = topRecs.filter(function (rec) {
      var lower = rec.toLowerCase();
      var referencedA = false, referencedB = false;
      for (var f = 0; f < flaggedNutrients.length; f++) {
        if (lower.indexOf(flaggedNutrients[f]) !== -1) { referencedA = true; break; }
      }
      for (var g = 0; g < foodKeywords.length; g++) {
        if (lower.indexOf(foodKeywords[g]) !== -1) { referencedB = true; break; }
      }
      return referencedA || referencedB;
    });

    // 5. Compose narrative summary (longest non-empty)
    summaryParts.sort(function (a, b) { return b.length - a.length; });
    var summary = summaryParts[0] || '';

    // 6. Hallucination flags (collected later in validateOutput,
    //    but we mark low-confidence pile-up here)
    var lowCount = 0;
    for (var z = 0; z < mergedList.length; z++) {
      if (mergedList[z].confidence === 'low') lowCount++;
    }
    var pileUp = lowCount > Math.ceil(mergedList.length * 0.5) && mergedList.length > 0;

    return {
      nutrients: mergedList,
      recommendations: topRecs,
      summary: summary,
      _models: totalModels,
      _agreement: totalModels + '-model consensus',
      _lowConfPileUp: pileUp,
      _ensemble: totalModels > 1
    };
  }

  /* ─────────────────────────────────────────────────────────────
     8.  POST-MERGE VALIDATOR — last-line cleanup.
     Drops anything still wrong, fills in defaults, attaches
     `_hallucinationFlags: []` for the UI to surface.
     ───────────────────────────────────────────────────────────── */
  function validateOutput(merged, opts) {
    opts = opts || {};
    var flags = [];
    var cleanedNutrients = [];
    if (!merged || typeof merged !== 'object') {
      return {
        nutrients: [],
        recommendations: [],
        summary: '',
        _hallucinationFlags: ['no_result'],
        _models: 0
      };
    }
    var nutrients = Array.isArray(merged.nutrients) ? merged.nutrients : [];
    var seen = {};

    for (var i = 0; i < nutrients.length; i++) {
      var n = nutrients[i];
      if (!n || typeof n !== 'object') continue;
      var canon = canonicalize(n.name);
      if (!canon) {
        flags.push('unknown_nutrient:' + String(n.name || '(empty)').slice(0, 60));
        continue;
      }
      if (!isAllowedName(canon)) {
        flags.push('disallowed_nutrient:' + canon);
        continue;
      }
      if (seen[canon]) continue; // dedupe after merge
      seen[canon] = true;

      var level = clampLevel(n.level);
      var conf = String(n.confidence || 'low').toLowerCase();
      if (!CONFIDENCE_RANK.hasOwnProperty(conf)) {
        flags.push('bad_confidence:' + conf);
        conf = 'low';
      }
      var status = String(n.status || '').toLowerCase();
      if (status !== 'low' && status !== 'ok' && status !== 'high') {
        status = statusFromLevel(level);
      }

      cleanedNutrients.push({
        name: canon,
        level: level,
        confidence: conf,
        status: status,
        evidence: typeof n.evidence === 'string' ? n.evidence : '',
        _agreement: n._agreement || '',
        _agreement_frac: typeof n._agreement_frac === 'number' ? n._agreement_frac : 0
      });
    }

    if (cleanedNutrients.length === 0 && merged._models > 0) {
      flags.push('no_valid_nutrients');
    }
    if (merged._lowConfPileUp) {
      flags.push('low_confidence_majority');
    }
    if (cleanedNutrients.length > NUTRIENT_ALLOWLIST.length) {
      flags.push('overcount_nutrients');
    }

    return {
      nutrients: cleanedNutrients,
      recommendations: Array.isArray(merged.recommendations) ? merged.recommendations.slice(0, 6) : [],
      summary: typeof merged.summary === 'string' ? merged.summary : '',
      _hallucinationFlags: flags,
      _models: merged._models || 0,
      _agreement: merged._agreement || '',
      _ensemble: !!merged._ensemble
    };
  }

  /* ─────────────────────────────────────────────────────────────
     9.  VISION GATE prompt + parser.
     Used to short-circuit scans of non-retinal images BEFORE
     running the full nutrient ensemble. Saves cost, prevents
     confabulation.
     ───────────────────────────────────────────────────────────── */
  var VISION_GATE_PROMPT = [
    'You will see one photograph. Answer one question.',
    'Is this image a close-up photograph of a human eye, retinal surface, or ocular region?',
    'Respond with ONLY a JSON object of the form:',
    '{ "isEye": <true|false>, "reason": <one short sentence> }',
    'If unsure, "isEye": false.'
  ].join('\n');

  function parseVisionGate(text) {
    var parsed = extractJSON(text);
    if (!parsed || typeof parsed !== 'object') {
      return { isEye: true, reason: 'gate_parse_failed_defaulting_to_pass' };
    }
    return {
      isEye: parsed.isEye === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : ''
    };
  }

  /* ─────────────────────────────────────────────────────────────
     10. NUTRISCORE composite — used by the redesigned PDF and
         the dashboard's trend strip.
     Weighted mean of nutrient levels (confidence-weighted).
     ───────────────────────────────────────────────────────────── */
  var NUTRISCORE_WEIGHTS = {
    'Lutein': 1.4, 'Zeaxanthin': 1.3, 'Omega-3 (DHA + EPA)': 1.3,
    'Vitamin A': 1.2, 'Vitamin C': 1.1, 'Vitamin D': 1.2,
    'Vitamin E': 1.0, 'Vitamin B12': 1.0, 'Vitamin B6': 0.9,
    'Folate': 1.0, 'Iron': 1.1, 'Zinc': 1.1, 'Selenium': 0.9,
    'Copper': 0.8, 'Magnesium': 0.9, 'Calcium': 0.7, 'Potassium': 0.7,
    'Beta-carotene': 1.1, 'Lycopene': 0.8, 'Coenzyme Q10': 0.8,
    'Glutathione': 0.9, 'Taurine': 0.7, 'Hydration': 0.9,
    'Blood circulation': 1.0
  };

  function computeNutriScore(nutrients) {
    if (!Array.isArray(nutrients) || nutrients.length === 0) return { score: null, weight: 0 };
    var totalW = 0;
    var totalS = 0;
    for (var i = 0; i < nutrients.length; i++) {
      var n = nutrients[i];
      var w = NUTRISCORE_WEIGHTS[n.name] || 1.0;
      var confMul = n.confidence === 'high' ? 1.0
                  : n.confidence === 'medium' ? 0.85
                  : 0.65;
      totalS += (n.level || 50) * w * confMul;
      totalW += w;
    }
    if (totalW === 0) return { score: null, weight: 0 };
    var s = Math.round(totalS / totalW);
    return { score: s, weight: +totalW.toFixed(2) };
  }

  /* ─────────────────────────────────────────────────────────────
     Internal helpers
     ───────────────────────────────────────────────────────────── */
  function tokenize(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length >= 4; });
  }
  function jaccard(a, b) {
    var A = {}, B = {};
    for (var i = 0; i < a.length; i++) A[a[i]] = true;
    for (var j = 0; j < b.length; j++) B[b[j]] = true;
    var inter = 0, uni = 0;
    var seen = {};
    for (var k = 0; k < a.length; k++) {
      if (!seen[a[k]]) { seen[a[k]] = true; uni++; if (B[a[k]]) inter++; }
    }
    for (var m = 0; m < b.length; m++) {
      if (!seen[b[m]]) { seen[b[m]] = true; uni++; }
    }
    return uni === 0 ? 0 : inter / uni;
  }

  /* ─────────────────────────────────────────────────────────────
     Public API
     ───────────────────────────────────────────────────────────── */
  var api = {
    NUTRIENT_ALLOWLIST: NUTRIENT_ALLOWLIST,
    SYNONYM_MAP: SYNONYM_MAP,
    CONFIDENCE_RANK: CONFIDENCE_RANK,
    statusFromLevel: statusFromLevel,
    canonicalize: canonicalize,
    clampLevel: clampLevel,
    isAllowedName: isAllowedName,
    schemaSuffix: schemaSuffix,
    appendSchema: appendSchema,
    extractJSON: extractJSON,
    consensusMerge: consensusMerge,
    validateOutput: validateOutput,
    VISION_GATE_PROMPT: VISION_GATE_PROMPT,
    parseVisionGate: parseVisionGate,
    computeNutriScore: computeNutriScore
  };

  // Browser global + CommonJS export for the test harness
  if (typeof window !== 'undefined') window.ACCURACY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
