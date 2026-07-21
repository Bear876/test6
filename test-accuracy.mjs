// test-accuracy.mjs — sanity tests for public/accuracy.js
//
// Loads public/accuracy.js via Node's `vm` module so the
// IIFE-UMD-style wrapper can run in a context where it sees
// `module` (mimicking what a CJS wrapper would), without
// forcing the test file itself to be CJS.
//
// Each test exercises a single concern of the accuracy module:
//   • synonym normalization (canonicalize)
//   • JSON extraction (extractJSON)
//   • per-nutrient consensus math (consensusMerge)
//   • post-merge validator (validateOutput)
//   • schema contract presence (schemaSuffix)
//   • vision-gate parser (parseVisionGate)
//   • NutriScore composite (computeNutriScore)

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, 'public', 'accuracy.js'), 'utf8');

const sandbox = { module: { exports: {} }, exports: {} };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'public/accuracy.js' });
const ACC = sandbox.module.exports;

if (!ACC || typeof ACC.consensusMerge !== 'function') {
  console.error('accuracy.js failed to expose its API via vm context.');
  process.exit(1);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + (e && e.message ? e.message : e)); failed++; }
}

console.log('Vytreos accuracy module tests');

// --- synonym normalization ---------------------------------------------------
test('canonicalize → maps "vit a" / "Beta Carotene" / "B-12" to canonical', () => {
  assert.equal(ACC.canonicalize('Vit A'), 'Vitamin A');
  assert.equal(ACC.canonicalize('Beta Carotene'), 'Beta-carotene');
  assert.equal(ACC.canonicalize('b-12'), 'Vitamin B12');
  assert.equal(ACC.canonicalize('omega-3'), 'Omega-3 (DHA + EPA)');
  assert.equal(ACC.canonicalize('Lutein'), 'Lutein');
});

test('canonicalize → returns null for junk nutrient names', () => {
  assert.equal(ACC.canonicalize(''), null);
  assert.equal(ACC.canonicalize('Vitamin XYZ-9999'), null);
  assert.equal(ACC.canonicalize(null), null);
});

test('clampLevel → clamps to integer 0–100', () => {
  assert.equal(ACC.clampLevel(42), 42);
  assert.equal(ACC.clampLevel(150), 100);
  assert.equal(ACC.clampLevel(-7), 0);
  assert.equal(ACC.clampLevel('abc'), 50);
  assert.equal(ACC.clampLevel(43.7), 44);
});

// --- JSON extraction ---------------------------------------------------------
test('extractJSON → parses bare object', () => {
  const out = ACC.extractJSON('{"nutrients":[]}');
  assert.equal(JSON.stringify(out), JSON.stringify({ nutrients: [] }));
});

test('extractJSON → strips ```json fences and parses', () => {
  const out = ACC.extractJSON('Here:\n```json\n{"a":1}\n```\nthanks');
  assert.equal(out.a, 1);
});

test('extractJSON → returns null on garbage', () => {
  assert.equal(ACC.extractJSON('not json at all'), null);
  assert.equal(ACC.extractJSON(''), null);
  assert.equal(ACC.extractJSON(null), null);
});

// --- schemaSuffix -----------------------------------------------------------
test('schemaSuffix → contains allowlist + JSON contract', () => {
  const s = ACC.schemaSuffix();
  assert.ok(s.indexOf('Vitamin A') !== -1, 'allowlist includes Vitamin A');
  assert.ok(s.indexOf('"confidence"') !== -1, 'schema includes confidence');
  assert.ok(s.indexOf('"level"') !== -1, 'schema includes level');
  assert.ok(/"low"\|"medium"\|"high"/i.test(s), 'schema mentions confidence enum');
});

// --- consensusMerge ---------------------------------------------------------
test('consensusMerge → single model passes through nutrients', () => {
  const r = ACC.consensusMerge([
    { nutrients: [
      { name: 'Lutein', level: 70, confidence: 'high', evidence: 'macula', status: 'ok' }
    ], recommendations: ['Eat spinach for Lutein'], summary: 'S' }
  ]);
  assert.equal(r.nutrients.length, 1);
  assert.equal(r.nutrients[0].name, 'Lutein');
  assert.equal(r.nutrients[0].level, 70);
  assert.equal(r.nutrients[0]._agreement, '1/1 models');
});

test('consensusMerge → median level when models disagree', () => {
  const r = ACC.consensusMerge([
    { nutrients: [{ name: 'Iron', level: 30, confidence: 'high' }] },
    { nutrients: [{ name: 'Iron', level: 60, confidence: 'medium' }] },
    { nutrients: [{ name: 'Iron', level: 40, confidence: 'high' }] }
  ]);
  assert.equal(r.nutrients.length, 1);
  assert.ok(r.nutrients[0].level >= 35 && r.nutrients[0].level <= 60,
    'median should be 40-ish, got ' + r.nutrients[0].level);
});

test('consensusMerge → drops orphan recommendations', () => {
  const r = ACC.consensusMerge([
    { nutrients: [{ name: 'Lutein', level: 70, confidence: 'high' }],
      recommendations: ['Go for a brisk walk in the park.'],
      summary: '' }
  ]);
  assert.equal(r.recommendations.length, 0,
    'orphan rec (no flagged nutrient, no food keyword) should be dropped');
});

test('consensusMerge → keeps recs that reference flagged nutrient', () => {
  const r = ACC.consensusMerge([
    { nutrients: [{ name: 'Iron', level: 30, confidence: 'high' }],
      recommendations: ['Eat more spinach and lentils for Iron levels'],
      summary: '' }
  ]);
  assert.ok(r.recommendations.length >= 1, 'rec referencing Iron should pass');
});

test('consensusMerge → collects low-confidence pile-up flag', () => {
  const r = ACC.consensusMerge([
    { nutrients: [
      { name: 'Lutein', level: 30, confidence: 'low' },
      { name: 'Iron', level: 30, confidence: 'low' },
      { name: 'Zinc', level: 30, confidence: 'low' }
    ], recommendations: [], summary: '' }
  ]);
  assert.ok(r._lowConfPileUp, 'should flag low-confidence majority');
});

test('consensusMerge → summary taken from longest non-empty input', () => {
  const r = ACC.consensusMerge([
    { nutrients: [], recommendations: [], summary: 'short' },
    { nutrients: [], recommendations: [], summary: 'longer summary with detail' }
  ]);
  assert.ok(r.summary.indexOf('longer') !== -1);
});

// --- validateOutput ---------------------------------------------------------
test('validateOutput → drops unknown nutrients, clamps levels', () => {
  const v = ACC.validateOutput({
    nutrients: [
      { name: 'Lutein', level: 75, confidence: 'high', status: 'ok' },
      { name: 'Vitamin XYZ', level: 50, confidence: 'medium', status: 'ok' },
      { name: 'Iron', level: 200, confidence: 'medium', status: 'ok' }
    ],
    recommendations: [], summary: '',
    _models: 1, _agreement: '1-model'
  });
  assert.equal(v.nutrients.length, 2, 'unknown nutrient dropped');
  assert.equal(v.nutrients[1].level, 100, 'level clamped to 100');
  assert.ok(v._hallucinationFlags.indexOf('unknown_nutrient:Vitamin XYZ') !== -1);
});

test('validateOutput → coerces bad confidence to "low"', () => {
  const v = ACC.validateOutput({
    nutrients: [{ name: 'Iron', level: 50, confidence: 'super-duper', status: 'ok' }],
    recommendations: [], summary: '',
    _models: 1, _agreement: '1-model'
  });
  assert.equal(v.nutrients[0].confidence, 'low');
});

test('validateOutput → surfaces no_valid_nutrients', () => {
  const v = ACC.validateOutput({
    nutrients: [{ name: 'Unknown Mineral X', level: 50, confidence: 'high' }],
    recommendations: [], summary: '', _models: 1
  });
  assert.ok(v._hallucinationFlags.indexOf('no_valid_nutrients') !== -1);
});

// --- parseVisionGate -------------------------------------------------------
test('parseVisionGate → true → true; false → false', () => {
  assert.equal(ACC.parseVisionGate('{"isEye":true,"reason":"retina"}').isEye, true);
  assert.equal(ACC.parseVisionGate('{"isEye":false,"reason":"cat"}').isEye, false);
});

test('parseVisionGate → non-JSON falls back to true', () => {
  const out = ACC.parseVisionGate('I cannot tell');
  assert.equal(out.isEye, true, 'default pass');
});

// --- computeNutriScore -----------------------------------------------------
test('computeNutriScore → returns null for empty', () => {
  assert.equal(ACC.computeNutriScore([]).score, null);
});

test('computeNutriScore → weighted mean in 0–100', () => {
  const ns = [
    { name: 'Lutein', level: 80, confidence: 'high' },
    { name: 'Iron', level: 40, confidence: 'high' },
    { name: 'Zinc', level: 60, confidence: 'medium' }
  ];
  const out = ACC.computeNutriScore(ns);
  assert.ok(out.score > 30 && out.score < 90, 'score should be a blend, got ' + out.score);
});

test('computeNutriScore → downweights low-confidence', () => {
  const a = ACC.computeNutriScore([
    { name: 'Iron', level: 100, confidence: 'high' }
  ]);
  const b = ACC.computeNutriScore([
    { name: 'Iron', level: 100, confidence: 'low' }
  ]);
  assert.ok(a.score > b.score, 'high confidence should score higher than low; got ' + a.score + ' vs ' + b.score);
});

// --- end -------------------------------------------------------------------
console.log('\n  ✓ ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed === 0 ? 0 : 1);
