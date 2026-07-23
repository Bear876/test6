// ═══════════════════════════════════════════════════════════════════════════
// VYTREOS FEATURES — eye tracking · CSV export · nutrition v2 · lifestyle log
// ═══════════════════════════════════════════════════════════════════════════

// ── EYE SELECTOR ──────────────────────────────────────────────────────────
let _scanEye = 'both';
window.setScanEye = function(eye) {
  _scanEye = eye;
  document.querySelectorAll('.eye-select-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.eye === eye));
};

// ── EYE-AWARE SAVE ────────────────────────────────────────────────────────
const _origSaveScan = window.saveScan;
if (_origSaveScan) {
  window.saveScan = async function() {
    if (pendingResult) pendingResult.eye = _scanEye;
    return _origSaveScan();
  };
}

// ── EYE FILTER ────────────────────────────────────────────────────────────
let _eyeFilter = 'all';
window.filterByEye = function(eye) {
  _eyeFilter = eye;
  document.querySelectorAll('.eye-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.eye === eye));
  if (typeof renderScans === 'function') {
    // Re-render with filter applied via DOM
    renderScans();
    applyEyeFilter();
  }
};
function applyEyeFilter() {
  if (_eyeFilter === 'all') {
    document.querySelectorAll('.scan-item').forEach(el => el.style.display = '');
    return;
  }
  document.querySelectorAll('.scan-item').forEach(el => {
    const eyePill = el.querySelector('.eye-pill');
    el.style.display = (eyePill && eyePill.textContent.toLowerCase().includes(_eyeFilter)) ? '' : 'none';
  });
}

// ── EYE PILL in scan items ─────────────────────────────────────────────────
function eyePillHTML(eye) {
  if (!eye || eye === 'both') return '';
  const label = eye === 'left' ? 'OS' : 'OD';
  return `<span class="eye-pill" style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700;background:rgba(77,143,255,0.15);color:var(--blue);border:1px solid rgba(77,143,255,0.25);margin-right:4px;">${label}</span>`;
}

// ── CSV EXPORT ────────────────────────────────────────────────────────────
window.downloadCSV = function() {
  if (!scans || !scans.length) { toast('No scans to export', 'err'); return; }
  const rows = [['Date', 'Eye', 'Nutrient', 'Level', 'Status', 'Confidence', 'Quality']];
  scans.forEach(s => {
    const ts = s.createdAt;
    const date = ts ? new Date((ts.seconds || ts) * (ts.seconds ? 1000 : 1)).toISOString().split('T')[0] : '';
    const eye = s.eye || 'both';
    (s.nutrients || []).forEach(n => {
      rows.push([date, eye, n.name, n.level || '', n.status || '', n.confidence || '', s.imageQuality || '']);
    });
  });
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vytreos-export-' + new Date().toISOString().split('T')[0] + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV downloaded', '');
};

// ── NUTRITION CARDS V2 ─────────────────────────────────────────────────────
const FOOD_V2 = {
  'Iron': { foods: 'Chicken liver (85g, 2×/wk) · Lentils (1 cup daily) · Spinach + lemon', tip: 'Pair with vitamin C for 3× absorption. Avoid tea/coffee 1hr after meals.' },
  'Vitamin B12': { foods: 'Salmon (85g, 3×/wk) · Eggs (1–2 daily)', tip: 'Vegans: 500–1000mcg sublingual B12 daily — far better than oral tablets.' },
  'Folate': { foods: 'Spinach (1 cup, lightly steamed) · Avocado (½) · Black beans (3×/wk)', tip: 'Heat destroys ~50% of folate. Steam greens 2–3 min max, never boil.' },
  'Vitamin C': { foods: 'Red bell pepper (½ raw) · Kiwi (1) · Strawberries (1 cup)', tip: 'Bell peppers have 3× more C than oranges. Eat raw — cooking destroys it.' },
  'Vitamin A': { foods: 'Sweet potato (1 medium) · Carrots (½ cup cooked)', tip: 'Always eat with 1 tsp fat (olive oil, butter) — A is fat-soluble.' },
  'Lutein': { foods: 'Cooked kale (1 cup) · Eggs (2, include yolks)', tip: 'Egg yolks boost lutein absorption 3× more than spinach alone.' },
  'Zeaxanthin': { foods: 'Corn (1 cup/wk) · Eggs (2 daily) · Orange peppers', tip: 'Z + lutein work synergistically. Get both from the same meal.' },
  'Omega-3': { foods: 'Salmon (85g, 2–3×/wk) · Walnuts (1oz) · Ground flax (1 Tbsp)', tip: 'DHA/EPA from fish is 10× more bioavailable than plant ALA. Prioritize fatty fish.' },
  'Zinc': { foods: 'Beef (85g, 3×/wk) · Pumpkin seeds (1oz) · Oysters', tip: 'Soak beans/grains overnight — phytates block zinc absorption.' },
  'Magnesium': { foods: 'Almonds (1oz) · Spinach (1 cup) · Dark chocolate 85% (1oz)', tip: 'Stress + caffeine deplete magnesium. Epsom salt baths help topical absorption.' },
  'Vitamin D': { foods: 'Salmon (85g, 3×/wk) · Fortified milk · Midday sun 15min', tip: 'Take with your largest meal — absorbs 50% better with food.' },
  'Vitamin E': { foods: 'Almonds (1oz) · Olive oil (1 Tbsp) · Avocado (½)', tip: 'Almonds deliver the most bioavailable form (α-tocopherol).' },
  'Vitamin K': { foods: 'Kale (1 cup cooked) · Broccoli · Spinach', tip: '⚠ Caution with blood thinners (warfarin). Keep intake consistent.' },
};

function buildNutritionCards(nutrients) {
  const lowNuts = (nutrients || []).filter(n => n.status === 'low' || n.status === 'borderline');
  if (!lowNuts.length) return '';
  return '<div style="margin-top:16px;">' +
    '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;">🍽 Personalized food plan</div>' +
    lowNuts.map(n => {
      const info = FOOD_V2[n.name] || { foods: 'Consult a dietitian for personalized guidance.', tip: '' };
      const clr = n.status === 'low' ? 'var(--red)' : 'var(--amber)';
      return `<div style="background:var(--bg-3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:13px;font-weight:700;color:var(--text);">${n.name}</span>
          <span style="font-size:9px;padding:2px 7px;border-radius:20px;color:${clr};border:1px solid;font-weight:700;">${n.status === 'low' ? '↓ LOW' : 'BORDERLINE'}</span>
          <span style="font-size:10px;color:var(--text-3);margin-left:auto;">${n.level}/100</span>
        </div>
        <div style="font-size:11px;color:var(--text-2);line-height:1.65;margin-bottom:4px;">▸ ${info.foods}</div>
        ${info.tip ? '<div style="font-size:10px;color:var(--green);line-height:1.5;background:var(--green-dim);border-radius:6px;padding:7px 10px;">💡 ' + info.tip + '</div>' : ''}
      </div>`;
    }).join('') + '</div>';
}
window.buildNutritionCards = buildNutritionCards;

// ── LIFESTYLE EXPERIMENT LOG ───────────────────────────────────────────────
let _experiments = [];
try { _experiments = JSON.parse(localStorage.getItem('vytreos_experiments') || '[]'); } catch(e) {}

window.addExperiment = function() {
  const label = prompt('What did you start? (e.g., "Fish oil 1000mg", "No dairy")');
  if (!label || !label.trim()) return;
  const date = prompt('Start date (YYYY-MM-DD)?', new Date().toISOString().split('T')[0]);
  if (!date) return;
  _experiments.push({ label: label.trim(), date, addedAt: new Date().toISOString() });
  localStorage.setItem('vytreos_experiments', JSON.stringify(_experiments));
  renderExperiments();
  toast('Experiment logged', '');
};
window.removeExperiment = function(idx) {
  _experiments.splice(idx, 1);
  localStorage.setItem('vytreos_experiments', JSON.stringify(_experiments));
  renderExperiments();
};
function renderExperiments() {
  const el = document.getElementById('experimentLog');
  if (!el) return;
  if (!_experiments.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:12px;text-align:center;">No experiments yet. Track supplements, diet changes, or habits here.</div>';
    return;
  }
  el.innerHTML = _experiments.map((e, i) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;"><div style="font-size:12px;font-weight:600;color:var(--text);">${e.label}</div>
      <div style="font-size:10px;color:var(--text-3);">Since ${e.date}</div></div>
      <button onclick="removeExperiment(${i})" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:15px;padding:4px 8px;">✕</button>
    </div>`).join('');
}

// ── UI INJECTION ───────────────────────────────────────────────────────────
let _installed = false;
function installFeatures() {
  if (_installed) return;

  // Eye selector in analyzer panel
  const panel = document.querySelector('.analysis-panel h3');
  if (panel && !document.getElementById('eyeSelector')) {
    panel.insertAdjacentHTML('afterend', `<div id="eyeSelector" style="margin-bottom:14px;">
      <div style="font-size:10px;font-weight:600;color:var(--text-3);margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase;">Scanning which eye?</div>
      <div style="display:flex;gap:5px;">
        <button class="eye-select-btn active" data-eye="both" onclick="setScanEye('both')" style="flex:1;padding:7px 6px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:var(--green-dim);color:var(--green);border:1px solid rgba(0,217,139,.3);transition:all .12s;">👁 Both</button>
        <button class="eye-select-btn" data-eye="left" onclick="setScanEye('left')" style="flex:1;padding:7px 6px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:var(--bg-3);color:var(--text-2);border:1px solid var(--border);transition:all .12s;">👁 Left</button>
        <button class="eye-select-btn" data-eye="right" onclick="setScanEye('right')" style="flex:1;padding:7px 6px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:var(--bg-3);color:var(--text-2);border:1px solid var(--border);transition:all .12s;">👁 Right</button>
      </div>
    </div>`);
  }

  // Eye filter in dashboard & history
  ['#dash-list', '#hist-list'].forEach(sel => {
    const list = document.querySelector(sel);
    if (list && !list.parentElement.querySelector('.eye-filter-bar')) {
      list.insertAdjacentHTML('beforebegin', `<div class="eye-filter-bar" style="display:flex;gap:4px;margin-bottom:10px;">
        <button class="eye-filter-btn active" data-eye="all" onclick="filterByEye('all')" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:var(--green-dim);color:var(--green);border:1px solid rgba(0,217,139,.2);">All</button>
        <button class="eye-filter-btn" data-eye="left" onclick="filterByEye('left')" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:transparent;color:var(--text-3);border:1px solid var(--border);">OS</button>
        <button class="eye-filter-btn" data-eye="right" onclick="filterByEye('right')" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;cursor:pointer;font-family:'Syne',sans-serif;background:transparent;color:var(--text-3);border:1px solid var(--border);">OD</button>
      </div>`);
    }
  });

  // CSV export button in history tab
  const histHeader = document.querySelector('.history-header');
  if (histHeader && !document.getElementById('csvExportBtn')) {
    const btn = document.createElement('button');
    btn.id = 'csvExportBtn';
    btn.textContent = '📥 CSV';
    btn.style.cssText = 'padding:5px 12px;background:var(--bg-3);color:var(--text-2);border:1px solid var(--border);border-radius:20px;font-size:10px;font-weight:600;cursor:pointer;font-family:\'Syne\',sans-serif;';
    btn.onclick = () => window.downloadCSV();
    btn.onmouseenter = () => { btn.style.borderColor = 'var(--green)'; btn.style.color = 'var(--green)'; };
    btn.onmouseleave = () => { btn.style.borderColor = 'var(--border)'; btn.style.color = 'var(--text-2)'; };
    histHeader.appendChild(btn);
  }

  // Experiment log in trends tab
  const trendsGrid = document.getElementById('trend-all-nutrients');
  if (trendsGrid && !document.getElementById('experimentSection')) {
    trendsGrid.insertAdjacentHTML('afterend', `<div id="experimentSection" style="margin-top:24px;background:var(--bg-2);border:1px solid var(--border);border-radius:12px;padding:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div><div style="font-size:12px;font-weight:700;color:var(--text);">🧪 Lifestyle experiments</div>
        <div style="font-size:10px;color:var(--text-3);">Log supplements or diet changes to correlate with trends</div></div>
        <button onclick="addExperiment()" style="padding:6px 14px;background:var(--green);color:var(--bg);border:none;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;font-family:'Syne',sans-serif;white-space:nowrap;">+ Add</button>
      </div>
      <div id="experimentLog"></div>
    </div>`);
    renderExperiments();
  }

  _installed = true;
}

// Enrich scan items with eye pill after rendering
function enrichScanItems() {
  document.querySelectorAll('.scan-item').forEach(el => {
    if (el.querySelector('.eye-pill') || el.dataset.eyeEnriched) return;
    el.dataset.eyeEnriched = '1';
    const dateEl = el.querySelector('.scan-date');
    if (!dateEl) return;
    // Find scan index from onclick attribute
    const onclick = el.getAttribute('onclick') || '';
    const match = onclick.match(/openScan\((\d+)\)/);
    if (match && scans && scans[parseInt(match[1])]) {
      const eye = scans[parseInt(match[1])].eye;
      if (eye && eye !== 'both') {
        const pill = eyePillHTML(eye);
        dateEl.insertAdjacentHTML('afterbegin', pill);
      }
    }
  });
}

// ── HOOK INTO EXISTING RENDER ──────────────────────────────────────────────
const _origSwitchTab = window.switchTab;
if (_origSwitchTab) {
  window.switchTab = function(tab) {
    _origSwitchTab(tab);
    setTimeout(() => { installFeatures(); enrichScanItems(); }, 150);
  };
}

// Note: A prior attempt tried to capture module-scoped loadScans /
// renderScans identifiers declared inside the inline
// <script type="module"> block of public/index.html, but module
// top-level bindings are not auto-promoted to window and resolve to
// undefined in this external module, causing ReferenceError on page
// load. The polling loop below is the supported installation path.

// Poll for DOM changes and inject features
let _pollTimer = null;
function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    const appView = document.getElementById('view-app');
    if (appView && appView.classList.contains('active') && getComputedStyle(appView).display !== 'none') {
      installFeatures();
      enrichScanItems();
    }
  }, 800);
}
startPolling();

// Also trigger on tab visibility
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { installFeatures(); enrichScanItems(); }
});

console.log('🔬 Vytreos features active: eye tracking, CSV export, nutrition v2, lifestyle log');
