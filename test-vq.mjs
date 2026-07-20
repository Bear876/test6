// test-vq.mjs — Sanity tests for public/vq.js pure algorithms.
//
// Loads public/vq.js via Node's `vm` module so the IIFE-UMD legacy script can
// run in a context where it sees `module` (matching what `require()` would do
// in a CJS wrapper), but without forcing the parent test file to be CJS.
//
// Each fixture is a synthetic RGBA Uint8ClampedArray (width × height) crafted
// so the *expected* tier / property is obvious.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, 'public', 'vq.js'), 'utf8');

// Build a context that mimics a CJS module wrapper so the UMD tail
// `module.exports = VQ` inside vq.js executes.
const sandbox = { module: { exports: {} }, exports: {} };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'public/vq.js' });
const VQ = sandbox.module.exports;

if (!VQ || typeof VQ.score !== 'function') {
  console.error('VQ failed to expose itself via vm context. Got keys:', Object.keys(sandbox.module.exports || {}));
  process.exit(1);
}

const W = 320, H = 240;
function blank() {
  return { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
}
function fillRgb(id, r, g, b) {
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = r; id.data[i + 1] = g; id.data[i + 2] = b; id.data[i + 3] = 255;
  }
}
function setPx(id, x, y, r, g, b) {
  const i = (y * id.width + x) * 4;
  id.data[i] = r; id.data[i + 1] = g; id.data[i + 2] = b;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ': ' + e.message); failed++; }
}

console.log('Vytreos VQ test fixtures (' + W + '×' + H + ')');

test('sharp checkerboard → focus ≥ 60', () => {
  const id = blank();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const onWhite = (((x >> 3) + (y >> 3)) & 1) === 0;
    setPx(id, x, y, onWhite ? 245 : 10, onWhite ? 245 : 10, onWhite ? 245 : 10);
  }
  const f = VQ.scoreFocus(id);
  assert.ok(f.score >= 60, 'expected high focus, got ' + f.score + ' (var=' + f.variance + ')');
});

test('smooth gradient → focus ≤ 30', () => {
  const id = blank();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = (x * 255 / W) | 0;
    setPx(id, x, y, v, v, v);
  }
  const f = VQ.scoreFocus(id);
  assert.ok(f.score <= 30, 'expected low focus, got ' + f.score + ' (var=' + f.variance + ')');
});

test('dark image → exposure tier is Poor or p10 near 0', () => {
  const id = blank();
  fillRgb(id, 20, 20, 20);
  const e = VQ.scoreExposure(id);
  assert.ok(e.median < 80 || e.rangeScore < 60,
    'expected dark image to score poorly, got median=' + e.median + ' rangeScore=' + e.rangeScore);
});

test('bright image → exposure tier is Poor or p90 too high', () => {
  const id = blank();
  fillRgb(id, 235, 235, 235);
  const e = VQ.scoreExposure(id);
  assert.ok(e.median > 200 || e.rangeScore < 60,
    'expected bright image to score poorly, got median=' + e.median + ' rangeScore=' + e.rangeScore);
});

test('glare hotspot → detects ≥ 1 cluster', () => {
  const id = blank();
  fillRgb(id, 100, 100, 100);
  for (let dy = -9; dy < 9; dy++) for (let dx = -9; dx < 9; dx++) {
    const x = (W >> 1) + dx, y = (H >> 1) + dy;
    if (x >= 0 && x < W && y >= 0 && y < H) setPx(id, x, y, 250, 250, 250);
  }
  const g = VQ.scoreGlareDOD(id);
  assert.ok(g.clusterCount >= 1,
    'expected ≥ 1 glare cluster, got ' + g.clusterCount + ' (brightPx=' + g.brightPixelCount + ')');
  assert.ok(g.score < 100, 'glare score should be penalized, got ' + g.score);
});

test('uniform-dark image → minimal glare clusters', () => {
  const id = blank();
  fillRgb(id, 24, 22, 20);
  const g = VQ.scoreGlareDOD(id);
  assert.ok(g.clusterCount <= 1, 'unexpected glare in uniform dark, got ' + g.clusterCount);
});

test('red color cast → colorCast score below 80', () => {
  const id = blank();
  fillRgb(id, 200, 100, 80);
  const c = VQ.scoreColorCast(id);
  assert.ok(c.score < 80, 'expected cast-score < 80, got ' + c.score + ' (dev=' + c.deviation + ')');
});

test('neutral gray image → colorCast score ≥ 80', () => {
  const id = blank();
  fillRgb(id, 128, 128, 128);
  const c = VQ.scoreColorCast(id);
  assert.ok(c.score >= 80, 'expected cast-score ≥ 80 on neutral, got ' + c.score);
});

test('sparse high-contrast green veins → greenCh ratio ≥ 0.30', () => {
  const id = blank();
  fillRgb(id, 110, 150, 110);
  for (let dx = 0; dx < 30; dx++) {
    const x = 20 + dx * 10;
    for (let y = 10; y < H - 10; y++) {
      const i = (y * W + x) * 4;
      id.data[i + 1] = Math.max(0, id.data[i + 1] - 50);
    }
  }
  const g = VQ.scoreGreenChannel(id);
  assert.ok(g.greenToLumaRatio >= 0.30,
    'expected green-var-ratio ≥ 0.30 on vessel-like pattern, got ' + g.greenToLumaRatio);
});

test('composite: sharp photo has higher overall than motion-blur photo', () => {
  const sharp = blank();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const onWhite = (((x >> 3) + (y >> 3)) & 1) === 0;
    setPx(sharp, x, y, onWhite ? 240 : 20, onWhite ? 240 : 20, onWhite ? 240 : 20);
  }
  const blur = blank();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = (x * 255 / W) | 0;
    setPx(blur, x, y, v, v, v);
  }
  const sA = VQ.score(sharp).overall;
  const sB = VQ.score(blur).overall;
  assert.ok(sA > sB, 'expected sharp (' + sA + ') > blur (' + sB + ')');
});

test('rankSum picks a sharp frame over a flat frame', () => {
  const sharpA = blank(), sharpB = blank(), flat = blank();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const onWhite1 = (((x >> 3) + (y >> 3)) & 1) === 0;
    const onWhite2 = (((x >> 4) + (y >> 4)) & 1) === 0;
    setPx(sharpA, x, y, onWhite1 ? 240 : 10, onWhite1 ? 240 : 10, onWhite1 ? 240 : 10);
    setPx(sharpB, x, y, onWhite2 ? 220 : 30, onWhite2 ? 220 : 30, onWhite2 ? 220 : 30);
    setPx(flat, x, y, 100, 100, 100);
  }
  const scores = [VQ.score(sharpA), VQ.score(sharpB), VQ.score(flat)];
  const idx = VQ.rankSum(scores);
  assert.notEqual(idx, 2, 'should not pick the flat frame');
  assert.ok(idx === 0 || idx === 1, 'should pick a sharp frame, got ' + idx);
});

test('qualityNotes returns non-empty human-readable hints', () => {
  const id = blank();
  fillRgb(id, 24, 24, 24);
  const s = VQ.score(id);
  const txt = VQ.qualityNotes(s);
  assert.ok(txt && txt.length > 5, 'expected non-empty notes');
  assert.ok(/Poor|Fair|Good/.test(txt), 'expected tier in notes');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
