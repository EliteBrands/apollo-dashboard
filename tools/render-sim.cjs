#!/usr/bin/env node
/**
 * Render simulator for the Apollo client weekly dashboard.
 * Adapted from projects/LPS-Dashboard/tools/render-sim.cjs (the committed original;
 * the stub layer differs because this page renders via innerHTML + a __apollo hook).
 *
 * Stubs document / Chart / fetch, evals the page's REAL <script> against the REAL
 * published sheet CSV, then asserts: parsing, the positional-header tripwire, sum/sum
 * window math against an INDEPENDENT recomputation, ratio-locked axes on every chart,
 * the tooltip null guard, note rendering, sparkline geometry, and a full (from,to)
 * filter sweep over every window.
 *
 *   node tools/render-sim.cjs                 fetch the live sheet
 *   node tools/render-sim.cjs <google.csv> <meta.csv> [mer.csv]   use saved CSV snapshots
 *   RENDER_SIM_PAGE=<file> node tools/...     point at a mutated page copy
 *   RENDER_SIM_MER_CSV=<file>                 local Total MER CSV (argv[4] wins)
 *   RENDER_SIM_BFCM_DIR=<dir>                 BFCM fixtures bfcm-daily.csv / bfcm-config.csv / bfcm-log.csv
 *                                             (default tools/fixtures); the live BFCM tabs get a smoke section
 *                                             when the weekly CSVs are fetched live (no argv)
 *
 * v4: bootPage also evaluates the page's local <script src="bfcm-*.js"> files (from the page's own
 * folder, so RENDER_SIM_PAGE can point at a mutated copy with mutated scripts beside it) in the same
 * vm context BEFORE the inline script, mirroring the browser. BFCM sections run on a fake clock.
 */
// Pin the machine's local zone BEFORE any Date use: the page must work in Toronto days whatever zone the
// viewer's machine is in, and a "local date instead of Toronto date" bug only shows when the two differ.
// Brisbane is never the Toronto date at the BFCM test instants, so that bug is caught on every machine.
process.env.TZ = 'Australia/Brisbane';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const https = require('https');

const PAGE = process.env.RENDER_SIM_PAGE
  ? path.resolve(process.env.RENDER_SIM_PAGE)
  : path.resolve(__dirname, '../index.html');
const REPO_DIR = path.resolve(__dirname, '..');   // the page repo (git history for the v3.3.0 comparison)
const BFCM_DIR = process.env.RENDER_SIM_BFCM_DIR ? path.resolve(process.env.RENDER_SIM_BFCM_DIR) : path.resolve(__dirname, 'fixtures');
const LOCAL_CSV = process.argv[2] || null;

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
const section = t => console.log('\n' + t);

// ---------------------------------------------------------------- fetch CSV
function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => https.get(u, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return go(res.headers.location, hops + 1); }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
    }).on('error', reject);
    go(url, 0);
  });
}

// independent CSV cell reader (deliberately simpler than the page's parser)
function indieRows(csv) {
  return csv.trim().split(/\r?\n/).map(line => {
    const cells = []; let c = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { cells.push(c); c = ''; }
      else c += ch;
    }
    cells.push(c); return cells.map(s => s.trim());
  });
}

// the exact `sheet=` tab name of a gviz URL (decoded), or null: routing on the whole parameter, never a substring,
// so "BFCM Config" never catches "BFCM Config Log" and an extra parameter (headers=1) anywhere changes nothing
function sheetOf(u) {
  const m = /[?&]sheet=([^&#]*)/.exec(String(u));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

// ---------------------------------------------------------------- page sandbox
function makeElement(id) {
  const el = {
    id, innerHTML: '', textContent: '', className: '', value: '',
    style: {},
    _listeners: {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    dispatchEvent() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  };
  return el;
}

// the page's inline script plus its local <script src="bfcm-*.js?v=..."> files, in document order
function pageParts(pageFile) {
  const html = fs.readFileSync(pageFile, 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const srcs = [...html.matchAll(/<script src="(bfcm-[a-z-]+\.js)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
  return { html, inline, srcs, dir: path.dirname(pageFile) };
}

// BFCM fixtures (mutable per boot: a test can swap a tab's text between refreshes)
function loadBfcmFixtures(dir) {
  const rd = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return null; } };
  return { daily: rd('bfcm-daily.csv'), config: rd('bfcm-config.csv'), log: rd('bfcm-log.csv') };
}
const BFX = loadBfcmFixtures(BFCM_DIR);

// fake clock: Date.now + setTimeout/setInterval driven by advance(ms); timers fire in time order
function makeClock(startIso) {
  let now = Date.parse(startIso), seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, ms || 0), every: 0 }); return id; },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
    clear: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  return clock;
}

// opts (all optional; the weekly sections pass none, so their stubs are unchanged):
//   page   - page file (default PAGE)          bfcm  - {daily, config, log} texts (default BFX)
//   clock  - makeClock(): fake Date.now, timers, document.visibilityState + listeners
//   location - {hash, pathname, search}       patch - [[from, to], ...] applied to the inline script
//   post   - (n, init) => Promise: the config endpoint's answer to the n-th POST (default: network error)
//   storage / crypto - localStorage and crypto stubs (BFCM boots only; defaults: an empty store, a counting randomUUID)
function makeStorage(init, throws) {
  const m = new Map(Object.entries(init || {}));
  return {
    _m: m,
    getItem(k) { if (throws) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
  };
}
function bootPage(csvText, metaCsvText, merCsvText, opts) {
  opts = opts || {};
  const parts = pageParts(opts.page || PAGE);
  const scripts = parts.inline;
  if (!scripts.length) throw new Error('no inline <script> found in page');
  let code = scripts[scripts.length - 1];
  for (const [from, to] of (opts.patch || [])) {
    if (!code.includes(from)) throw new Error('sim patch target not found in page: ' + from);
    code = code.replace(from, to);
  }

  const els = {};
  const createdCharts = [];
  const fetchLog = [];
  const bf = opts.bfcm || Object.assign({}, BFX);
  class ChartStub {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; createdCharts.push(this); }
    destroy() { this.destroyed = true; }
  }
  const documentStub = {
    getElementById(id) { return els[id] || (els[id] = makeElement(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  if (opts.clock) {
    documentStub.visibilityState = 'visible';
    documentStub._listeners = {};
    documentStub.addEventListener = (ev, fn) => { (documentStub._listeners[ev] = documentStub._listeners[ev] || []).push(fn); };
    documentStub.removeEventListener = (ev, fn) => { documentStub._listeners[ev] = (documentStub._listeners[ev] || []).filter(f => f !== fn); };
    documentStub.fire = ev => (documentStub._listeners[ev] || []).slice().forEach(fn => fn({ type: ev }));
  }
  const postLog = [];
  const sandbox = {
    window: {}, document: documentStub, Chart: ChartStub,
    fetch: (url, init) => {
      const u = String(url);
      if (init && init.method === 'POST') {   // the config endpoint (Task 11); never a sheet CSV
        postLog.push({ url: u, init });
        return opts.post ? opts.post(postLog.length, init) : Promise.reject(new TypeError('Failed to fetch'));
      }
      fetchLog.push(u);
      // BFCM tabs first, routed on the exact tab name (the Log URL contains the Config URL as a substring)
      const tab = sheetOf(u);
      const body = tab === 'BFCM Daily' ? bf.daily
        : tab === 'BFCM Config Log' ? bf.log
        : tab === 'BFCM Config' ? bf.config
        : null;
      if (tab && /^BFCM /.test(tab)) {
        if (body === 'NETWORK-ERROR') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body == null ? '<html>no bfcm fixture</html>' : body) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(
        u.includes('sheet=Total%20MER') ? (merCsvText == null ? '<html>no mer fixture</html>' : merCsvText)
        : u.includes('sheet=Meta') ? (metaCsvText == null ? csvText : metaCsvText)
        : csvText) });
    },
    console, setTimeout, clearTimeout, Event: function () {},
  };
  if (opts.clock) {
    const c = opts.clock;
    Object.assign(sandbox, { setTimeout: c.setTimeout, clearTimeout: c.clear, setInterval: c.setInterval, clearInterval: c.clear, __simNow: c.now });
    let uuidN = 0;
    sandbox.localStorage = opts.storage || makeStorage();
    sandbox.crypto = 'crypto' in opts ? opts.crypto : { randomUUID: () => 'f0000000-0000-4000-8000-' + String(++uuidN).padStart(12, '0') };
    sandbox.AbortSignal = { timeout: ms => ({ simTimeoutMs: ms }) };   // marker: the sim asserts the page asks for a 15 s timeout signal
  }
  if (opts.location) { sandbox.location = opts.location; sandbox.history = { replaceState() {} }; }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (opts.clock) vm.runInContext('Date.now = function () { return __simNow(); };', sandbox);
  for (const src of parts.srcs) vm.runInContext(fs.readFileSync(path.join(parts.dir, src), 'utf8'), sandbox, { filename: src });
  vm.runInContext(code, sandbox, { filename: 'apollo-page.js' });
  return { sandbox, els, createdCharts, code, fetchLog, postLog, documentStub, bf };
}
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

// ---------------------------------------------------------------- main
async function main() {
  console.log('render-sim: ' + PAGE);
  const html = fs.readFileSync(PAGE, 'utf8');

  section('script syntax');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop() || '';
  const tmp = path.join(__dirname, '.render-sim-script.tmp.js');
  fs.writeFileSync(tmp, code);
  let syntaxOK = true;
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { syntaxOK = false; }
  fs.unlinkSync(tmp);
  check('page script passes node --check', syntaxOK);
  {
    // v4: the page loads bfcm-core.js + bfcm-view.js + bfcm-save.js (cache-busted, all three on ONE ?v= value) BEFORE
    // the inline script; check-deep L15: bumped together to ?v=4.0.1, with the "bump all three together" comment above;
    // pass 2 L7: the comment also says mount() and CHANNELS.bfcm stay backward-compatible within one push
    const parts = pageParts(PAGE);
    check('page loads bfcm-core.js, bfcm-view.js and bfcm-save.js (?v=4.0.1, one unit, with the bump + backward-compatible comment) before the inline script',
      /<!-- [^>]*bump all three together on ANY bfcm-\*\.js change[^>]*keep mount\(\) and CHANNELS\.bfcm backward-compatible within one push \(an old cached index\.html can run new JS for ~10 min\)[^>]*-->\s*<script src="bfcm-core\.js\?v=4\.0\.1"><\/script>\s*<script src="bfcm-view\.js\?v=4\.0\.1"><\/script>\s*<script src="bfcm-save\.js\?v=4\.0\.1"><\/script>\s*<script>/.test(html) && parts.srcs.join() === 'bfcm-core.js,bfcm-view.js,bfcm-save.js');
    for (const f of ['bfcm-core.js', 'bfcm-view.js', 'bfcm-save.js']) {
      let ok = true;
      try { execFileSync(process.execPath, ['--check', path.join(parts.dir, f)], { stdio: 'pipe' }); } catch (e) { ok = false; }
      check(f + ' passes node --check', ok);
    }
    check('version marker line 2 is v4.0.1 (pass 2 L7)', html.split(/\r?\n/)[1] === '<!-- apollo-dashboard v4.0.1 -->');
    check('footer shows v4.0.1 (pass 2 L7)', /<footer>[\s\S]*v4\.0\.1[\s\S]*<\/footer>/.test(html) && !/<footer>[\s\S]*v4\.0\.0[\s\S]*<\/footer>/.test(html));
  }

  const sheetId = (code.match(/SHEET_ID\s*=\s*'([^']+)'/) || [])[1];
  check('SHEET_ID present', !!sheetId);
  // fetch EXACTLY the URL the page fetches (tab pin included) - certifying any
  // other byte-stream would let page/sim drift apart
  const urlExpr = (code.match(/CSV_URL\s*=\s*`([^`]+)`/) || [])[1];
  check('CSV_URL present and pinned to Sheet1', !!urlExpr && urlExpr.includes('&sheet=Sheet1'));
  const csvUrl = urlExpr ? urlExpr.replace('${SHEET_ID}', sheetId) : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Sheet1`;

  const csv = LOCAL_CSV
    ? fs.readFileSync(LOCAL_CSV, 'utf8')
    : await fetchCSV(csvUrl);
  const LOCAL_META_CSV = process.argv[3] || null;
  const metaUrl = csvUrl.replace('&sheet=Sheet1', '&sheet=Meta');
  const metaCsv = LOCAL_META_CSV ? fs.readFileSync(LOCAL_META_CSV, 'utf8') : await fetchCSV(metaUrl);
  const LOCAL_MER_CSV = process.argv[4] || process.env.RENDER_SIM_MER_CSV || null;
  const merUrl = csvUrl.replace('&sheet=Sheet1', '&sheet=Total%20MER');
  const merCsv = LOCAL_MER_CSV ? fs.readFileSync(LOCAL_MER_CSV, 'utf8') : await fetchCSV(merUrl);

  // ---------------- boot against the real CSV
  section('boot + parse (real CSV)');
  const { sandbox, els, createdCharts } = bootPage(csv, metaCsv, merCsv);
  await flush();
  const A = sandbox.window.__apollo;
  check('__apollo hook exposed', !!A);
  if (!A) { finish(); return; }
  const rows = A.data || [];
  check('rows parsed (>= 60 weeks)', rows.length >= 60, `got ${rows.length}`);
  const last = rows[rows.length - 1] || {};
  check('rows sorted by week ascending', rows.every((r, i) => i === 0 || r.week > rows[i - 1].week));
  check('newest row has an ISO end date', /^\d{4}-\d{2}-\d{2}$/.test(last.endISO || ''));
  check('banner not shown on a clean CSV', !(els.banner && els.banner.style.display === 'block'));

  // ---------------- independent sum/sum recomputation (8-week window, ALL bucket)
  section('window math is sum/sum (independent recomputation)');
  const ind = indieRows(csv).slice(1).filter(r => Number.isFinite(parseInt(r[0], 10)));
  const last8 = ind.slice(-8);
  const iSpend = last8.reduce((s, r) => s + parseFloat(r[2] || 0), 0);
  const iRev = last8.reduce((s, r) => s + parseFloat(r[3] || 0), 0);
  const iPur = last8.reduce((s, r) => s + parseFloat(r[4] || 0), 0);
  const W = A.windowStats(rows.slice(-8), 'all');
  check('spend matches independent sum', Math.abs(W.spend - iSpend) < 0.01, `${W.spend} vs ${iSpend}`);
  check('revenue matches independent sum', Math.abs(W.rev - iRev) < 0.01);
  check('ROAS is sum(rev)/sum(spend)', Math.abs(W.roas - iRev / iSpend) < 1e-9);
  check('CPA is sum(spend)/sum(purchases)', Math.abs(W.cpa - iSpend / iPur) < 1e-9);
  const avgOfRatios = last8.reduce((s, r) => s + parseFloat(r[3]) / parseFloat(r[2]), 0) / last8.length;
  check('sum/sum differs from avg-of-ratios on real data (guard is meaningful)', Math.abs(avgOfRatios - W.roas) > 1e-6);

  // ---------------- charts
  section('charts');
  check('USA card expanded by default (approved mock)', A.expanded.usa === true);
  for (const k of ['overview', 'usa', 'can', 'aus', 'dg']) A.expanded[k] = false;
  A.setWindow(8); A.render();
  const live = createdCharts.filter(c => !c.destroyed);
  check('exactly 1 chart when nothing expanded', live.length === 1, `got ${live.length}`);
  const ov = live[0];
  check('overview has 4 datasets (spend, revenue, roas, target)', ov && ov.config.data.datasets.length === 4);
  const ds = ov.config.data.datasets;
  check('spend dataset is a bar on ySpend', ds[0].type === 'bar' && ds[0].yAxisID === 'ySpend');
  check('revenue dataset is a line on yRev', ds[1].type === 'line' && ds[1].yAxisID === 'yRev');
  check('ROAS dataset is dashed on yRoas', ds[2].yAxisID === 'yRoas' && Array.isArray(ds[2].borderDash));
  const sc = ov.config.options.scales;
  check('ratio lock: ySpend.max = yRev.max / 12', Math.abs(sc.ySpend.max - sc.yRev.max / 12) < 1e-9);
  check('no-clip: every spend value fits the locked axis', Math.max(...ds[0].data.map(v => v || 0)) <= sc.ySpend.max + 1e-9);
  check('spend/revenue/roas lengths equal the window', ds[0].data.length === 8 && ds[1].data.length === 8 && ds[2].data.length === 8);
  const label = ov.config.options.plugins.tooltip.callbacks.label;
  let nullOK = false;
  try { nullOK = /no data/.test(label({ parsed: { y: null }, dataset: { label: 'Revenue' } })); } catch (e) { nullOK = false; }
  check('tooltip label survives a null point', nullOK);
  check('tooltip filters out the target line', ov.config.options.plugins.tooltip.filter({ dataset: { label: '__target' } }) === false);

  // expanded market charts
  for (const k of ['usa', 'can', 'aus', 'dg']) A.expanded[k] = true;
  A.render();
  const live5 = createdCharts.filter(c => !c.destroyed);
  check('5 charts when all markets expanded', live5.length === 5, `got ${live5.length}`);
  check('every chart keeps the ratio lock', live5.every(c => Math.abs(c.config.options.scales.ySpend.max - c.config.options.scales.yRev.max / 12) < 1e-9));
  for (const k of ['usa', 'can', 'aus', 'dg']) A.expanded[k] = false;

  // ---------------- market window footnotes match independent sums (USA)
  section('market bucket math');
  const iUsaSpend = last8.reduce((s, r) => s + parseFloat(r[6] || 0), 0);
  const WU = A.windowStats(rows.slice(-8), 'usa');
  check('USA window spend matches independent sum', Math.abs(WU.spend - iUsaSpend) < 0.01, `${WU.spend} vs ${iUsaSpend}`);

  // ---------------- sparkline geometry at full history
  section('sparkline');
  const svg = A.sparkSVG(rows.map(r => r.all.revenue));
  check('no negative rect widths at ' + rows.length + ' weeks', !/width="-/.test(svg));
  check('one rect per week', (svg.match(/<rect/g) || []).length === rows.length);

  // ---------------- tripwire: a silently inserted column must banner, not render
  section('positional tripwire (shifted-column fixture)');
  {
    const recs = indieRows(csv);
    const shifted = recs.map((r, i) => {
      const c = r.slice(); c.splice(2, 0, i === 0 ? 'Inserted Col' : '123'); return c;
    }).map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
    const t = bootPage(shifted);
    await flush();
    check('banner shown', t.els.banner && t.els.banner.style.display === 'block');
    check('no rows accepted', !t.sandbox.window.__apollo.data);
    check('no charts built', t.createdCharts.length === 0);
  }

  // ---------------- notes rendering fixture
  section('notes rendering (fixture)');
  {
    const recs = indieRows(csv);
    const lastIdx = recs.length - 1;
    recs[lastIdx][22] = 'A strong week overall. CPA <b>under</b> $50 & falling.';
    recs[lastIdx][23] = 'Win one | Win two | Win three';
    recs[lastIdx][24] = 'USA comment.'; recs[lastIdx][25] = 'CAN comment.';
    recs[lastIdx][26] = 'AUS comment.'; recs[lastIdx][27] = 'DG comment.';
    const withNotes = recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
    const t = bootPage(withNotes);
    await flush();
    const content = t.els.content ? t.els.content.innerHTML : '';
    check('note card renders', content.includes('This week from your strategist') && content.includes('A strong week overall.'));
    check('angle brackets in a note render literally, never as markup', content.includes('&lt;b&gt;under&lt;/b&gt;') && content.includes('&amp;') && !content.includes('<b>under</b>') && !content.includes('&amp;amp;'));
    check('3 win bullets render', (content.match(/class="win"/g) || []).length === 3);
    check('all 4 market comments render', ['USA comment.', 'CAN comment.', 'AUS comment.', 'DG comment.'].every(s => content.includes(s)));
    const mktAt = content.indexOf('<div class="markets">');
    check('market comments sit in the note card "By market" block, before the market cards', content.includes('By market') && (content.match(/class="bm"/g) || []).length === 4 && mktAt > 0 && ['USA comment.', 'CAN comment.', 'AUS comment.', 'DG comment.'].every(s => content.indexOf(s) < mktAt));
    check('market comments are not repeated inside the market cards', ['USA comment.', 'CAN comment.', 'AUS comment.', 'DG comment.'].every(s => content.split(s).length === 2));
    check('By market names each market in bucket order', /United States[\s\S]*USA comment\.[\s\S]*Canada[\s\S]*CAN comment\.[\s\S]*Australia[\s\S]*AUS comment\.[\s\S]*Demand Gen[\s\S]*DG comment\./.test(content.slice(0, mktAt)));
    // a window that ends BEFORE the newest week must hide the newest week's market comments too
    const TA = t.sandbox.window.__apollo;
    const tEnds = (TA && TA.data || []).map(r => r.endISO);
    if (TA && tEnds.length >= 2) {
      TA.state = { from: tEnds[0], to: tEnds[tEnds.length - 2] };
      TA.render();
      const old = t.els.content.innerHTML || '';
      check('market comments hidden when the window does not end at the newest week', !old.includes('By market') && !old.includes('USA comment.') && !old.includes('DG comment.'));
    } else check('market comments hidden when the window does not end at the newest week', false);
  }
  {
    // market comments only, no lead note and no bullets -> card must still render them
    // (blank every note column first: the live newest row may already carry a published pack)
    const recs = indieRows(csv);
    for (let k = 22; k <= 27; k++) recs[recs.length - 1][k] = '';
    recs[recs.length - 1][25] = 'Only CAN comment.';
    const t = bootPage(recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n'));
    await flush();
    const h = t.els.content.innerHTML || '';
    check('a market comment alone still renders the note card', h.includes('notecard') && h.includes('Only CAN comment.') && (h.match(/class="bm"/g) || []).length === 1);
  }
  {
    // bullets present, note empty -> card must still render
    const recs = indieRows(csv);
    recs[recs.length - 1][23] = 'Only bullet';
    const t = bootPage(recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n'));
    await flush();
    check('bullets without a lead note still render the card', (t.els.content.innerHTML || '').includes('Only bullet'));
  }
  // ---------------- duplicate week tripwire
  section('duplicate week tripwire (fixture)');
  {
    const recs = indieRows(csv);
    recs.push(recs[recs.length - 1].slice());           // duplicate the newest week row
    const t = bootPage(recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n'));
    await flush();
    check('banner shown on duplicate week', t.els.banner && t.els.banner.style.display === 'block');
    check('no rows accepted on duplicate week', !t.sandbox.window.__apollo.data);
  }
  {
    // the live sheet's newest row may or may not carry a published note, so assert
    // the branch the data actually selects rather than assuming an empty column
    const t = bootPage(csv);
    await flush();
    const content = t.els.content ? t.els.content.innerHTML : '';
    const newest = indieRows(csv).filter(r => Number.isFinite(parseInt(r[0], 10))).pop() || [];
    const hasNote = [22, 23, 24, 25, 26, 27].some(k => (newest[k] || '').trim());   // market comments alone also render the card
    if (hasNote) check('note card renders when the sheet carries a note', content.includes('This week from your strategist'));
    else check('no note card when the note column is empty', !content.includes('This week from your strategist'));
  }

  // ---------------- full filter sweep: every (from,to) end-date pair
  section('filter sweep (every window)');
  {
    const ends = rows.map(r => r.endISO);
    let swept = 0, errors = 0, lockBreaks = 0;
    for (let i = 0; i < ends.length; i++) {
      for (let j = i; j < ends.length; j++) {
        A.state = { from: ends[i], to: ends[j] };
        try {
          A.render();
          const c = createdCharts.filter(x => !x.destroyed)[0];
          const s = c.config.options.scales;
          if (Math.abs(s.ySpend.max - s.yRev.max / 12) > 1e-9) lockBreaks++;
          if (Math.max(...c.config.data.datasets[0].data.map(v => v || 0)) > s.ySpend.max + 1e-9) lockBreaks++;
          if (c.config.data.datasets[1].data.length !== j - i + 1) lockBreaks++;
        } catch (e) { errors++; }
        swept++;
      }
    }
    check(`swept ${swept} windows with no exceptions`, errors === 0, `${errors} threw`);
    check('ratio lock + lengths held in every window', lockBreaks === 0, `${lockBreaks} violations`);
  }

  // ---------------- Meta channel (v2)
  section('meta channel');
  check('page exposes switchChannel + CHANNELS', typeof A.switchChannel === 'function' && A.CHANNELS && A.CHANNELS.meta);
  check('CSV_URL for meta is pinned to sheet=Meta', !!(A.CHANNELS && A.CHANNELS.meta && String(A.CHANNELS.meta.csvUrl).includes('&sheet=Meta')));
  check('google view is the default', A.channel === 'google');
  const googleRows = A.data;
  if (A.switchChannel) {
    await A.switchChannel('meta'); await flush();
    check('channel is meta after switch', A.channel === 'meta');
    const mrows = A.data || [];
    check('meta rows parsed (>= 60 weeks)', mrows.length >= 60, `got ${mrows.length}`);
    check('meta rows carry reach/clicks/atc', mrows.length > 0 && ['reach', 'clicks', 'atc'].every(k => k in mrows[mrows.length - 1].all));
    check('meta rows have a multi bucket, no dg bucket', mrows.length > 0 && 'multi' in mrows[0] && !('dg' in mrows[0]));
    const mind = indieRows(metaCsv).slice(1).filter(r => Number.isFinite(parseInt(r[0], 10)));
    const m8 = mind.slice(-8);
    const mSpend = m8.reduce((s, r) => s + parseFloat(r[2] || 0), 0);
    const mRev = m8.reduce((s, r) => s + parseFloat(r[3] || 0), 0);
    const mPur = m8.reduce((s, r) => s + parseFloat(r[4] || 0), 0);
    const mClicks = m8.reduce((s, r) => s + parseFloat(r[6] || 0), 0);
    const MW = A.windowStats(mrows.slice(-8), 'all');
    check('meta spend matches independent sum', Math.abs(MW.spend - mSpend) < 0.01, `${MW.spend} vs ${mSpend}`);
    check('meta revenue matches independent sum', Math.abs(MW.rev - mRev) < 0.01);
    check('meta ROAS is sum(rev)/sum(spend)', Math.abs(MW.roas - mRev / mSpend) < 1e-9);
    check('meta CPA is sum(spend)/sum(purchases)', Math.abs(MW.cpa - mSpend / mPur) < 1e-9);
    check('meta clicks sum exposed', Math.abs((MW.clicks || 0) - mClicks) < 0.01, `${MW.clicks} vs ${mClicks}`);
    const mUsa = m8.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
    check('meta USA window spend matches independent sum (column 9)', Math.abs(A.windowStats(mrows.slice(-8), 'usa').spend - mUsa) < 0.01);
    for (const k of ['overview', 'usa', 'can', 'aus', 'multi']) A.expanded[k] = false;
    A.setWindow(8); A.render();
    const mlive = createdCharts.filter(c => !c.destroyed);
    check('meta: exactly 1 chart when nothing expanded', mlive.length === 1, `got ${mlive.length}`);
    const mov = mlive[0];
    check('meta overview has 3 datasets (no target line)', mov && mov.config.data.datasets.length === 3 && !mov.config.data.datasets.some(d => d.label === '__target'));
    check('meta spend axis is not ratio-locked (fits data)', mov && mov.config.options.scales.ySpend.max >= Math.max(...mov.config.data.datasets[0].data.map(v => v || 0)));
    const mhtml = els.content ? els.content.innerHTML : '';
    check('meta tiles: Reach, Link Clicks, Adds to Cart present', ['>Reach<', '>Link Clicks<', '>Adds to Cart<'].every(s => mhtml.includes(s)));
    // reach is a UNIQUE count: the tile must show the newest week, never the window sum
    const fmtIndep = v => Math.round(v).toLocaleString('en-US');
    const latestReach = parseFloat((mind[mind.length - 1] || [])[5] || 0);
    const sum8Reach = m8.reduce((s, r) => s + parseFloat(r[5] || 0), 0);
    check('meta Reach tile shows the latest week, not a window sum', mhtml.includes('>' + fmtIndep(latestReach) + '<'), `want >${fmtIndep(latestReach)}<`);
    if (Math.round(sum8Reach) !== Math.round(latestReach)) {
      check('meta Reach tile does not show the window sum', !mhtml.includes(fmtIndep(sum8Reach)), `found ${fmtIndep(sum8Reach)}`);
    }
    check('meta tiles: New Customers absent', !mhtml.includes('New Customers'));
    check('meta market cards: USA, Canada, Australia, Multi-market', ['card-usa', 'card-can', 'card-aus', 'card-multi'].every(s => mhtml.includes(`id="${s}"`)) && !mhtml.includes('card-dg'));
    check('meta market tag shows EB | ALL on multi', mhtml.includes('EB | ALL'));
    await A.switchChannel('google'); await flush();
    check('switching back restores google rows untouched', A.channel === 'google' && A.data === googleRows);
    const ghtml = els.content ? els.content.innerHTML : '';
    check('google view still has New Customers tile and DG card', ghtml.includes('New Customers') && ghtml.includes('card-dg'));
  }

  // ---------------- meta notes fixture (byline + multi comment)
  section('meta notes rendering (fixture)');
  {
    const recs = indieRows(metaCsv);
    const li = recs.length - 1;
    recs[li][32] = 'Meta lead note.'; recs[li][33] = 'M win one | M win two';
    recs[li][34] = 'USA meta comment.'; recs[li][35] = 'CAN meta comment.'; recs[li][36] = 'AUS meta comment.'; recs[li][37] = 'MULTI meta comment.';
    const withNotes = recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
    const t = bootPage(csv, withNotes);
    await flush();
    const TA = t.sandbox.window.__apollo;
    if (TA && TA.switchChannel) { await TA.switchChannel('meta'); await flush(); }
    const content = t.els.content ? t.els.content.innerHTML : '';
    check('meta note card renders with the Meta team title', content.includes('This week from your Meta team') && content.includes('Meta lead note.'));
    check('meta byline names Sam', content.includes('Sam · Elite Brands'));
    check('2 meta win bullets render', (content.match(/class="win"/g) || []).length === 2);
    check('all 4 meta market comments render', ['USA meta comment.', 'CAN meta comment.', 'AUS meta comment.', 'MULTI meta comment.'].every(s => content.includes(s)));
    const mAt = content.indexOf('<div class="markets">');
    check('meta market comments sit in the note card, once each', mAt > 0 && ['USA meta comment.', 'CAN meta comment.', 'AUS meta comment.', 'MULTI meta comment.'].every(s => content.indexOf(s) < mAt && content.split(s).length === 2) && content.slice(0, mAt).includes('Multi-market'));
  }

  // ---------------- Total MER channel (v3)
  section('total mer channel');
  check('CHANNELS.mer present and pinned to sheet=Total%20MER', !!(A.CHANNELS.mer && String(A.CHANNELS.mer.csvUrl).includes('&sheet=Total%20MER')));
  check('page exposes buildMerRows', typeof A.buildMerRows === 'function');
  {
    // the page SHIPS with CHANNELS.mer.enabled:false (launch switch). Prove the switch
    // holds at boot, then flip it in the sandbox so the view itself can be exercised.
    const shippedOn = A.CHANNELS.mer.enabled === true;   // whichever way the launch switch is set, the pill must MATCH it
    check('shipped flag: mer pill visibility matches CHANNELS.mer.enabled at boot', !!els['ch-mer'] && (shippedOn ? els['ch-mer'].style.display !== 'none' : els['ch-mer'].style.display === 'none'), `enabled=${shippedOn} display=${els['ch-mer'] && els['ch-mer'].style.display}`);
    // the hint counts the pills on screen: four with mer and bfcm both on, three with mer alone, none named otherwise
    const hintNow = String((els['channelhint'] && els['channelhint'].textContent) || '');
    const hintWant = shippedOn && A.CHANNELS.bfcm && A.CHANNELS.bfcm.enabled === true ? /^Four views/ : shippedOn ? /^Three views/ : null;
    check('channel hint matches the number of pills on screen', hintWant ? hintWant.test(hintNow) : !/Three views|Four views/.test(hintNow), `hint=${hintNow}`);
    const before = A.channel;
    await A.switchChannel('mer'); await flush();
    check('shipped flag: switchChannel(mer) is a no-op while disabled (or opens it when enabled)', shippedOn ? A.channel === 'mer' : A.channel === before, `channel=${A.channel}`);
    if (shippedOn) { await A.switchChannel('google'); await flush(); }
    A.CHANNELS.mer.enabled = true;   // launch switch flipped for the rest of this section
    await A.switchChannel('google'); await flush();
    const gRows = A.data;
    await A.switchChannel('mer'); await flush();
    check('channel is mer after switch', A.channel === 'mer');
    const rrows = A.data || [];
    check('mer rows parsed (>= 4 weeks)', rrows.length >= 4, `got ${rrows.length}`);
    check('banner not shown on clean mer feed', !(els.banner && els.banner.style.display === 'block'));
    const gind = indieRows(csv).slice(1).filter(r => Number.isFinite(parseInt(r[0], 10)));
    const mind = indieRows(metaCsv).slice(1).filter(r => Number.isFinite(parseInt(r[0], 10)));
    const rind = indieRows(merCsv).slice(1).filter(r => Number.isFinite(parseInt(r[0], 10)));
    const byWk = (arr) => new Map(arr.map(r => [parseInt(r[0], 10), r]));
    const G = byWk(gind), M = byWk(mind), R = byWk(rind);
    const last4 = rrows.slice(-4);
    const iSpend = last4.reduce((s, r) => s + parseFloat(G.get(r.week)[2] || 0) + parseFloat(M.get(r.week)[2] || 0), 0);
    const iRev = last4.reduce((s, r) => s + parseFloat(R.get(r.week)[10] || 0), 0);
    const iUsaSpend = last4.reduce((s, r) => s + parseFloat(G.get(r.week)[6] || 0) + parseFloat(M.get(r.week)[8] || 0), 0);
    const RW = A.windowStats(last4, 'all');
    check('mer Ad Spend = Google ALL Spend + Meta ALL Spend (independent sum)', Math.abs(RW.spend - iSpend) < 0.01, `${RW.spend} vs ${iSpend}`);
    check('mer Revenue = Total MER ALL Revenue (column 11)', Math.abs(RW.rev - iRev) < 0.01, `${RW.rev} vs ${iRev}`);
    check('MER is sum(rev)/sum(spend)', Math.abs(RW.roas - iRev / iSpend) < 1e-9);
    check('mer USA card spend = Google USA Spend + Meta USA Spend', Math.abs(A.windowStats(last4, 'usa').spend - iUsaSpend) < 0.01);
    const lastRow = last4[last4.length - 1];
    // AU store not connected yet: the AUS cell is blank and must stay null (never 0)
    check('newest mer row: aus.revenue is null (not connected) or a number, usa/can revenue are numbers', lastRow && (lastRow.aus.revenue === null || typeof lastRow.aus.revenue === 'number') && typeof lastRow.usa.revenue === 'number' && typeof lastRow.can.revenue === 'number', lastRow && JSON.stringify({ usa: lastRow.usa.revenue, can: lastRow.can.revenue, aus: lastRow.aus.revenue }));
    const iAllRev = parseFloat(R.get(lastRow.week)[10]);
    check('newest mer row: all.revenue is the sheet ALL Revenue cell, not usa+can+aus', Math.abs(lastRow.all.revenue - iAllRev) < 0.01, `${lastRow.all.revenue} vs ${iAllRev}`);
    const dgMulti = parseFloat(G.get(lastRow.week)[18] || 0) + parseFloat(M.get(lastRow.week)[26] || 0);
    const cardSum = ['usa', 'can', 'aus'].reduce((s, b) => s + lastRow[b].spend, 0);
    check('DG + MULTI spend sits in ALL but not in any market card', Math.abs((lastRow.all.spend - cardSum) - dgMulti) < 0.01, `${lastRow.all.spend - cardSum} vs ${dgMulti}`);
    for (const k of ['overview', 'usa', 'can', 'aus']) A.expanded[k] = false;
    A.setWindow(8); A.render();
    const rlive = createdCharts.filter(c => !c.destroyed);
    check('mer: exactly 1 chart when nothing expanded', rlive.length === 1, `got ${rlive.length}`);
    // v3.3: the Net band ships behind CHANNELS.mer.netEnabled. With it OFF the view is v3.2 plus the relabel.
    const netShipped = A.CHANNELS.mer.netEnabled === true;
    check('mer overview (net off) has 3 datasets, ratio dataset labelled Tracked MER, revenue dataset labelled Tracked Revenue, no target', netShipped || (rlive[0] && rlive[0].config.data.datasets.length === 3 && rlive[0].config.data.datasets.some(d => d.label === 'Tracked MER') && rlive[0].config.data.datasets.some(d => d.label === 'Tracked Revenue')));
    const rhtml = els.content ? els.content.innerHTML : '';
    check('mer tiles: Ad Spend, Tracked Revenue, Tracked MER, Orders present', ['>Ad Spend<', '>Tracked Revenue<', '>Tracked MER<', '>Orders<'].every(s => rhtml.includes(s)));
    check('mer tiles: no bare Revenue / MER label (relabel complete)', !rhtml.includes('>Revenue<') && !rhtml.includes('>MER<'));
    check('mer (net off): no Net band, no net tiles', netShipped || (!rhtml.includes('Shopify Net Sales') && !rhtml.includes('tile net')));
    check('mer: Tracked explainer card present, hidden at rest, with its first line', rhtml.includes('id="explain-tracked" hidden') && rhtml.includes('It is the order value after discounts, before shipping and tax.'));
    check('mer: explainer button wired by data-explain and exposed as toggleExplainer', rhtml.includes('data-explain="tracked"') && typeof A.toggleExplainer === 'function');
    check('mer tiles: no ROAS, no Cost / Purchase, no New Customers, no Purchases', !['>ROAS<', 'Cost / Purchase', 'New Customers', '>Purchases<'].some(s => rhtml.includes(s)));
    check('mer rate line shows both rates', /1 USD = \d\.\d{3} CAD/.test(rhtml) && /1 AUD = \d\.\d{3} CAD/.test(rhtml));
    check('mer window revenue for a not-connected market is null, never 0', (() => { const w = A.windowStats(last4, 'aus'); return lastRow.aus.revenue === null ? (w.rev === null && w.roas === null) : typeof w.rev === 'number'; })());
    check('mer market cards: USA, CAN, AUS only', ['card-usa', 'card-can', 'card-aus'].every(s => rhtml.includes(`id="${s}"`)) && !rhtml.includes('card-dg') && !rhtml.includes('card-multi'));
    check('mer view has no note card', !rhtml.includes('notecard'));

    // ---- v3.3 Net Sales ON (flip the switch in the sandbox, as the launch switch above)
    A.CHANNELS.mer.netEnabled = true; A.render(); await flush();
    const nhtml = els.content ? els.content.innerHTML : '';
    const nlive = createdCharts.filter(c => !c.destroyed);
    const newest = last4[last4.length - 1];
    const iNet = last4.reduce((s, r) => s + parseFloat(R.get(r.week)[18] || 0), 0);
    const iRet = last4.reduce((s, r) => s + parseFloat(R.get(r.week)[22] || 0), 0);
    const NW = A.windowStats(last4, 'all');
    check('net: showNet true on the live feed (net cells present)', A.showNet(rrows) === true);
    check('net: two band rows, Tracked Revenue then Shopify Net Sales', (nhtml.match(/class="band/g) || []).length === 2 && nhtml.indexOf('Tracked Revenue') < nhtml.indexOf('Shopify Net Sales'));
    check('net: three net tiles Net Sales, Net MER, Returns', (nhtml.match(/class="tile net/g) || []).length === 3 && ['>Net Sales<', '>Net MER<', '>Returns<'].every(s => nhtml.includes(s)));
    check('net: window Net Sales = sheet ALL Net Sales (column 19, independent sum)', NW.net != null && Math.abs(NW.net - iNet) < 0.01, `${NW.net} vs ${iNet}`);
    check('net: window Returns = sheet ALL Returns (column 23, independent sum)', NW.ret != null && Math.abs(NW.ret - iRet) < 0.01, `${NW.ret} vs ${iRet}`);
    check('net: Net MER is sum(net)/sum(spend)', NW.netRoas != null && Math.abs(NW.netRoas - iNet / iSpend) < 1e-9);
    check('net: netOf reads the stored cell', typeof newest.all.net === 'number' && A.netOf(newest.all) === newest.all.net && A.netOf({ revenue: 100, returns: 10 }) === null);
    check('net: chart title and subline switch to the Net flavour', nhtml.includes('Tracked Revenue, Net Sales and Ad Spend') && !!els.subline && /Net Sales/.test(els.subline.textContent || ''));
    check('net: overview has 4 datasets, Net Sales dashed lavender on yRev', nlive.length === 1 && nlive[0].config.data.datasets.length === 4 && nlive[0].config.data.datasets.some(d => d.label === 'Net Sales' && d.yAxisID === 'yRev' && Array.isArray(d.borderDash) && d.borderColor === '#B48CF2'));
    check('net: legend names Tracked Revenue, Net Sales and Tracked MER', ['>Tracked Revenue</span>', '>Net Sales</span>', '>Tracked MER</span>'].every(s => nhtml.includes(s)));
    const abody = nlive[0] && nlive[0].config.options.plugins.tooltip.callbacks.afterBody;
    const abOut = abody ? abody([{ dataIndex: nlive[0].config.data.labels.length - 1 }]) : null;
    check('net: tooltip afterBody yields one Net MER line', Array.isArray(abOut) && abOut.length === 1 && /^Net MER \d+\.\dx$/.test(abOut[0]), JSON.stringify(abOut));
    check('net: Net explainer card present, hidden at rest, with its first line', nhtml.includes('id="explain-net" hidden') && nhtml.includes('It is the Net sales figure from your Shopify Analytics'));
    check('net: USA market card carries a Net MER stat (ms net) and a net footer', nhtml.includes('class="ms net"') && (nhtml.match(/>Net MER</g) || []).length >= 2 && / · net \$/.test(nhtml));
    check('net: Returns tile subline reads "% of tracked revenue"', /\d+% of tracked revenue/.test(nhtml));
    check('net: market stat grid carries the net class only with the band on', nhtml.includes('class="mstats mer net"') && (netShipped || !rhtml.includes('class="mstats mer net"')));
    A.CHANNELS.mer.netEnabled = netShipped;   // back to the shipped setting for the rest of the run
    A.render(); await flush();
    const offHtml = els.content ? els.content.innerHTML : '';
    check('mer (net off): chart title, subline and footnote never mention Net Sales', netShipped || (!offHtml.includes('Net Sales') && !/Net Sales/.test((els.subline && els.subline.textContent) || '') && !/Net Sales/.test((els.footnote && els.footnote.textContent) || '')));

    await A.switchChannel('google'); await flush();
    check('switching back restores google rows untouched', A.channel === 'google' && A.data === gRows);
    const g2 = els.content ? els.content.innerHTML : '';
    check('google view: no Tracked label, no net class, no net key on rows, revenue dataset still "Revenue"', !g2.includes('Tracked') && !g2.includes('tile net') && !g2.includes('ms net') && !('net' in (A.data[0].all)) && createdCharts.filter(c => !c.destroyed)[0].config.data.datasets.some(d => d.label === 'Revenue'));
  }
  {
    // ---- v3.3 fixtures: the Net band must be honest about missing cells
    const merRecs = indieRows(merCsv);
    const toCsv = recs => recs.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const dataIdx = merRecs.map((r, i) => i).filter(i => i > 0 && Number.isFinite(parseInt(merRecs[i][0], 10)));
    const newestIdx = dataIdx.reduce((a, b) => (parseInt(merRecs[a][0], 10) >= parseInt(merRecs[b][0], 10) ? a : b));
    const blankNet = (recs, idxs) => recs.map((r, i) => (idxs.includes(i) ? r.map((c, j) => (j >= 12 && j <= 22 ? '' : c)) : r));
    const bootMer = async (csvText) => {
      const t = bootPage(csv, metaCsv, csvText); await flush();
      const TA = t.sandbox.window.__apollo; TA.CHANNELS.mer.enabled = true; TA.CHANNELS.mer.netEnabled = true;
      await TA.switchChannel('mer'); await flush();
      return { t, TA, html: t.els.content ? t.els.content.innerHTML : '' };
    };
    {
      // one in-window row (the newest) has revenue but blank net cells: window net is null, tile shows "-", band still shows
      const { TA, html } = await bootMer(toCsv(blankNet(merRecs, [newestIdx])));
      const w = TA.windowStats(TA.data.slice(-4), 'all');
      check('fixture mixed rows: window net and Net MER are null, never a partial sum', w.net === null && w.netRoas === null && w.ret === null);
      check('fixture mixed rows: Net Sales tile shows "-" while the band still renders (other rows carry net)', html.includes('<div class="k">Net Sales</div><div class="v">-</div>') && html.includes('Shopify Net Sales'));
    }
    {
      // every net cell blank (sheet written before v3.3 for all weeks): the band hides itself, chart back to 3 datasets
      const { TA, html, t } = await bootMer(toCsv(blankNet(merRecs, dataIdx)));
      const live = t.createdCharts.filter(c => !c.destroyed);
      check('fixture all blank: showNet false, no band, no net tiles, 3 datasets', TA.showNet(TA.data) === false && !html.includes('Shopify Net Sales') && !html.includes('tile net') && live[0] && live[0].config.data.datasets.length === 3);
    }
    {
      // a negative Shopify net sales week (big returns in a quiet week) is printed as is, never clamped
      const neg = merRecs.map((r, i) => (i === newestIdx ? r.map((c, j) => (j === 18 ? '-500' : c)) : r));
      const { html } = await bootMer(toCsv(neg));
      check('fixture negative net: tile prints the negative value as -$500', html.includes('this week -$500'), html.slice(html.indexOf('Net Sales'), html.indexOf('Net Sales') + 200));
    }
    {
      // the retired 2026-10-16 19-column header (USA Returns USD ...) must NOT be read as net sales: band hidden
      const retired = merRecs.map((r, i) => (i === 0 ? [...r.slice(0, 12), 'USA Returns USD', 'CAN Returns CAD', 'AUS Returns AUD', 'USA Returns', 'CAN Returns', 'AUS Returns', 'ALL Returns'] : r.slice(0, 19)));
      const { TA, html, t } = await bootMer(toCsv(retired));
      check('fixture retired 19-col header: parses, band hidden, no banner', (TA.data || []).length >= 4 && TA.showNet(TA.data) === false && !html.includes('tile net') && !(t.els.banner && t.els.banner.style.display === 'block'));
    }
    {
      // the pre-v3.3 12-column contract still parses and renders (band hidden, no banner)
      const legacy = merRecs.map(r => r.slice(0, 12));
      const { TA, html, t } = await bootMer(toCsv(legacy));
      check('fixture legacy 12-col CSV: rows parse, band hidden, no banner', (TA.data || []).length >= 4 && !html.includes('tile net') && !(t.els.banner && t.els.banner.style.display === 'block'));
    }
  }
  {
    // join rule: a Total MER week with no matching Meta row is dropped, never shown with partial spend
    const merRecs = indieRows(merCsv);
    const li = merRecs.length - 1;
    const orphan = merRecs[li].slice(); orphan[0] = String(parseInt(orphan[0], 10) + 500); orphan[1] = '01/07/2099 - 01/13/2099';
    const orphanCsv = [...merRecs, orphan].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const t = bootPage(csv, metaCsv, orphanCsv);
    await flush();
    const TA = t.sandbox.window.__apollo;
    TA.CHANNELS.mer.enabled = true;   // launch switch
    await TA.switchChannel('mer'); await flush();
    const weeks = (TA.data || []).map(r => r.week);
    check('orphan mer week (no ad rows) is dropped from the joined rows', !weeks.includes(parseInt(orphan[0], 10)));
  }
  {
    // a broken Total MER feed must banner ONLY on the mer view
    const t = bootPage(csv, metaCsv, '<html>broken</html>');
    await flush();
    const TA = t.sandbox.window.__apollo;
    TA.CHANNELS.mer.enabled = true;   // launch switch
    check('google renders with a broken mer feed', !!(TA.data && TA.data.length) && !(t.els.banner && t.els.banner.style.display === 'block'));
    await TA.switchChannel('mer'); await flush();
    check('mer banner shows once mer is opened', t.els.banner && t.els.banner.style.display === 'block');
    await TA.switchChannel('meta'); await flush();
    check('meta view is clean after a mer failure', !(t.els.banner && t.els.banner.style.display === 'block') && TA.data && TA.data.length > 0);
  }

  // ---------------- banner isolation: a broken Meta feed must not hide Google
  section('banner isolation (fixture)');
  {
    const t = bootPage(csv, '<html>not a csv</html>');
    await flush();
    const TA = t.sandbox.window.__apollo;
    const googleOK = !!(TA && TA.data && TA.data.length);
    if (TA && TA.switchChannel) { await TA.switchChannel('meta'); await flush(); }
    check('google rendered before the meta failure', googleOK);
    check('meta failure shows the banner', t.els.banner && t.els.banner.style.display === 'block');
    if (TA && TA.switchChannel) { await TA.switchChannel('google'); await flush(); }
    check('banner hidden again on google', !(t.els.banner && t.els.banner.style.display === 'block'));
    check('google rows survive the round trip', !!(TA && TA.data && TA.data.length));
  }
  {
    // RACE: a meta response that fails to parse must file its error against META and
    // leave the DOM alone while google is the channel on screen. Calling loadData with
    // the meta config directly is exactly what a late fetch resolution does.
    const t = bootPage(csv);
    await flush();
    const TA = t.sandbox.window.__apollo;
    TA.loadData('<html>not a csv</html>', TA.CHANNELS.meta);
    await flush();
    check('a meta parse failure while google is active does not paint the banner', !(t.els.banner && t.els.banner.style.display === 'block'));
    check('google view still renders after that', !!(TA.data && TA.data.length));
    await TA.switchChannel('meta'); await flush();
    check('the filed meta error shows once meta is opened', t.els.banner && t.els.banner.style.display === 'block');
  }
  {
    // a broken GOOGLE feed must not make a healthy meta view unreachable
    const t = bootPage('<html>broken</html>', metaCsv);
    await flush();
    const TA = t.sandbox.window.__apollo;
    check('channel row visible even when google fails', t.els.channelrow && t.els.channelrow.style.visibility === 'visible');
    await TA.switchChannel('meta'); await flush();
    check('meta renders while google is broken', !!(TA.data && TA.data.length));
    check('window controls visible on meta when google is broken', t.els.controls && t.els.controls.style.visibility === 'visible');
  }

  // ================================================================ v4
  // ---------------- the three weekly views render exactly as v3.3.0 did on the same CSVs
  section('weekly views identical to v3.3.0 (same CSVs)');
  {
    const v33 = path.join(os.tmpdir(), 'apollo-render-sim-v330-index.html');
    let got = true;
    try { fs.writeFileSync(v33, execFileSync('git', ['-C', REPO_DIR, 'show', '3241eb2:index.html'], { stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { got = false; }
    check('v3.3.0 page extracted from git (3241eb2:index.html)', got);
    if (got) {
      const snap = async (page) => {
        const t = bootPage(csv, metaCsv, merCsv, { page }); await flush();
        const TA = t.sandbox.window.__apollo;
        const txt = id => (t.els[id] ? String(t.els[id].textContent) : '');
        const grab = () => ({ html: t.els.content.innerHTML, chromeParts: [txt('subline'), txt('footnote'), txt('channelhint'), txt('week-ending'), txt('wcount')],
          charts: JSON.stringify(t.createdCharts.filter(c => !c.destroyed).map(c => c.config.data)) });
        const out = { google: grab() };
        await TA.switchChannel('meta'); await flush(); out.meta = grab();
        await TA.switchChannel('mer'); await flush(); out.mer = grab();
        return out;
      };
      const a = await snap(v33), b = await snap(PAGE);
      // spec 23: esc() now also writes ' as &#39; and " as &quot;. Inside text both spellings parse to the
      // same character, so the browser's DOM is identical; the stub DOM keeps the raw string, so decode first.
      const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const firstDiff = (x, y) => { let i = 0; while (i < x.length && x[i] === y[i]) i++; return i >= x.length && i >= y.length ? '' : `at ${i}: v3.3 "${x.slice(Math.max(0, i - 40), i + 40)}" vs v4 "${y.slice(Math.max(0, i - 40), i + 40)}"`; };
      // with the BFCM launch switch on (and Total MER on) the hint names four views by design; every other piece of chrome
      // must still match v3.3.0 exactly, and the hint must then be the four-view one
      const bfOn = A.CHANNELS.bfcm && A.CHANNELS.bfcm.enabled === true && A.CHANNELS.mer.enabled === true;
      const chromeOf = o => o.chromeParts.map((s, i) => (i === 2 && bfOn ? '(channel hint: four views)' : s)).join(' | ');
      for (const k of ['google', 'meta', 'mer']) {
        const raw = a[k].html === b[k].html;
        check(`${k}: content HTML identical to v3.3.0 (raw ${raw ? 'byte-identical' : 'differs only by esc() quote entities'})`, decode(b[k].html) === a[k].html, firstDiff(a[k].html, decode(b[k].html)));
        check(`${k}: subline, footnote, channel hint, week ending, window count identical` + (bfOn ? ' (BFCM on: the hint names four views)' : ''),
          chromeOf(a[k]) === chromeOf(b[k]) && (!bfOn || /^Four views/.test(b[k].chromeParts[2])), `v3.3 ${a[k].chromeParts.join(' | ')}\n        v4   ${b[k].chromeParts.join(' | ')}`);
        check(`${k}: chart data identical`, a[k].charts === b[k].charts);
      }
    }
  }

  // ---------------- BFCM 2026 view (fixtures, fake clock)
  section('bfcm channel (fixture)');
  const bfOK = !!(BFX.daily && BFX.config && BFX.log);
  check('BFCM fixtures present in ' + path.relative(process.cwd(), BFCM_DIR), bfOK);
  // independent readers over the fixture CSV (never bfcm-core.js, the code under test)
  const bfRows = bfOK ? indieRows(BFX.daily).slice(1).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0])) : [];
  const bfSum = (from, to, col) => {
    let s = 0, n = 0;
    for (let d = from; d <= to; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
      const r = bfRows.find(x => x[0] === d);
      if (!r || r[col] === '') return null;
      s += parseFloat(r[col]); n++;
    }
    return n ? s : null;
  };
  const iX = v => v.toFixed(1) + 'x';
  const i$ = v => '$' + Math.round(v).toLocaleString('en-US');
  // a tile's value and sub line by its id (tiles are <div class="tile ..." id="bf-t-KEY"><div class="k">..</div><div class="v">..</div><div class="s">..</div></div>)
  const tileOf = (h, key) => {
    const m = new RegExp('id="bf-t-' + key + '"[^>]*>\\s*<div class="k">([\\s\\S]*?)</div>\\s*<div class="v">([\\s\\S]*?)</div>\\s*<div class="s">([\\s\\S]*?)</div>').exec(h);
    return m ? { k: m[1], v: m[2], s: m[3] } : { k: '', v: '(tile missing)', s: '' };
  };
  // flips the launch switch in the inline script before boot; applied only while index.html still ships enabled:false
  // (once it says enabled:true there is nothing to flip, and the boot already has the switch on)
  const BFCM_ON = ["key:'bfcm', label:'BFCM 2026', enabled:false", "key:'bfcm', label:'BFCM 2026', enabled:true"];
  const BFCM_ON_PATCH = code.includes(BFCM_ON[0]) ? [BFCM_ON] : [];
  const EXEC_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  const isBfcmFetch = u => /^BFCM /.test(sheetOf(u) || '');
  const bfUrls = log => ({
    daily: log.filter(u => sheetOf(u) === 'BFCM Daily').length,
    config: log.filter(u => sheetOf(u) === 'BFCM Config').length,
    log: log.filter(u => sheetOf(u) === 'BFCM Config Log').length,
  });
  // boot the page and set every BFCM switch explicitly in the sandbox (as the mer section does), so the checks below
  // hold whichever way index.html ships them: configWrites only when asked, endpointUrl only when given; then open the view
  const bootBfcm = async (o) => {
    o = o || {};
    const clock = makeClock(o.now || '2026-10-17T18:00:00.000Z');
    const bf = Object.assign({}, BFX, o.bf || {});
    const bo = { clock, bfcm: bf, patch: o.patch, location: o.location, post: o.post, storage: o.storage };
    if ('crypto' in o) bo.crypto = o.crypto;
    const t = bootPage(csv, metaCsv, merCsv, bo);
    await flush();
    const TA = t.sandbox.window.__apollo, V = t.sandbox.BFCM_VIEW;
    TA.CHANNELS.bfcm.configWrites = !!o.configWrites;
    TA.CHANNELS.bfcm.endpointUrl = o.endpoint || '';
    if (o.open !== false) {
      TA.CHANNELS.bfcm.enabled = true;
      await TA.switchChannel('bfcm'); await flush();
    }
    // html(): the view's text with the <bdi> isolation tags around typed names removed (check-deep L3), so the text checks
    // read as before; the L3 checks read t.els.content.innerHTML raw
    return { t, TA, V, clock, bf, posts: t.postLog, html: () => String(t.els.content.innerHTML || '').replace(/<\/?bdi>/g, '') };
  };
  // the text of one pacing bar (Google / Meta / Both) inside #bf-pace, never the tiles or the forecast
  const paceBars = h => {
    const pace = h.indexOf('id="bf-pace"') >= 0 ? h.slice(h.indexOf('id="bf-pace"'), h.indexOf('2 · Returns')) : '';
    const parts = pace.split('<div class="bf-bar">');
    const one = mark => parts.find(s => s.includes(mark)) || '';
    return { g: one('<i class="bf-sw g"></i>Google</span>'), m: one('<i class="bf-sw m"></i>Meta</span>'), t: one('<i class="bf-sw m"></i>Both</span>') };
  };
  const plain = s => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (bfOK) {
    // ---- the launch switches as shipped: each check follows whichever way its switch is set in index.html
    //      enabled false -> pill hidden, #bfcm ignored, no BFCM fetch; enabled true -> pill shown, #bfcm opens the view
    {
      const t = bootPage(csv, metaCsv, merCsv, { clock: makeClock('2026-10-17T18:00:00.000Z'), location: { hash: '#bfcm', pathname: '/', search: '' } });
      await flush(); await flush();
      const TA = t.sandbox.window.__apollo, B = TA.CHANNELS.bfcm || {}, on = B.enabled === true;
      const mounted = () => !!(t.sandbox.BFCM_VIEW && t.sandbox.BFCM_VIEW._state && t.sandbox.BFCM_VIEW._state.mounted);
      const shipped = JSON.stringify({ enabled: B.enabled, configWrites: B.configWrites, endpointUrl: B.endpointUrl, refreshMs: B.refreshMs });
      check('CHANNELS.bfcm switches: enabled and configWrites are true/false, endpointUrl is empty or an Apps Script /exec URL, refreshMs 900000',
        B.key === 'bfcm' && B.label === 'BFCM 2026' && typeof B.enabled === 'boolean' && typeof B.configWrites === 'boolean' &&
        (B.endpointUrl === '' || EXEC_URL.test(B.endpointUrl || '')) && B.refreshMs === 900000, shipped);
      // gviz guesses how many rows are headers unless told: headers=1 pins it to the first row on all three tabs
      const bfTab = (u, tab) => sheetOf(u) === tab && /\/gviz\/tq\?tqx=out:csv&/.test(u || '') && /[?&]headers=1(&|$)/.test(u || '');
      check('CHANNELS.bfcm CSV URLs pinned to the three BFCM tabs, each with headers=1',
        bfTab(B.dailyCsvUrl, 'BFCM Daily') && bfTab(B.configCsvUrl, 'BFCM Config') && bfTab(B.logCsvUrl, 'BFCM Config Log'), [B.dailyCsvUrl, B.configCsvUrl, B.logCsvUrl].join(' | '));
      check('the three weekly-view URLs are unchanged (no headers=1)', [csvUrl, TA.CHANNELS.meta.csvUrl, TA.CHANNELS.mer.csvUrl].every(u => !/headers=/.test(u) && /tqx=out:csv&sheet=[^&]+$/.test(u)));
      check('CHANNELS.bfcm subline copy', B.subline === 'Prepared by Elite Brands · BFCM 2026 · All figures CAD · Toronto days', B.subline);
      check('pill #ch-bfcm visibility matches enabled (' + B.enabled + ')', !!t.els['ch-bfcm'] && (on ? t.els['ch-bfcm'].style.display !== 'none' : t.els['ch-bfcm'].style.display === 'none'), `display=${t.els['ch-bfcm'] && t.els['ch-bfcm'].style.display}`);
      if (on) check('enabled:true as shipped: the #bfcm deep link opens the BFCM view and fetches its tabs',
        TA.channel === 'bfcm' && mounted() && t.fetchLog.some(isBfcmFetch), `channel=${TA.channel}`);
      else check('#bfcm deep link ignored while enabled:false (google stays, no BFCM fetch, view not mounted)',
        TA.channel === 'google' && !t.fetchLog.some(isBfcmFetch) && !mounted(), `channel=${TA.channel}`);
      await TA.switchChannel('bfcm'); await flush();
      if (on) check('enabled:true as shipped: switchChannel(bfcm) keeps the view open', TA.channel === 'bfcm' && mounted());
      else check('switchChannel(bfcm) is a no-op while disabled', TA.channel === 'google' && !t.fetchLog.some(isBfcmFetch));
      check('channel hint names four views only when Total MER and BFCM are both on', /Four views/.test((t.els.channelhint && t.els.channelhint.textContent) || '') === (on && TA.CHANNELS.mer.enabled === true), (t.els.channelhint && t.els.channelhint.textContent) || '');
      check('esc() also escapes " and \' (spec 23)', typeof TA.esc === 'function' && TA.esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
      check('__apollo exposes the pure forecast (spec 19)', typeof TA.forecast === 'function');
      // the Save button follows the shipped configWrites + endpointUrl (the view opened in the sandbox to look at it)
      if (!on) { TA.CHANNELS.bfcm.enabled = true; await TA.switchChannel('bfcm'); await flush(); }
      const sh = String(t.els.content.innerHTML || ''), btns = sh.match(/<button[^>]*data-bf="save"[^>]*>[^<]*<\/button>/g) || [];
      if (!B.configWrites) check('configWrites:false as shipped: no Save button and no edit controls', !btns.length && !/data-bf="budget-total"/.test(sh));
      else if (B.endpointUrl === '') check('configWrites:true with endpointUrl empty: the read-only budget block, no edit controls, no Save button (check-deep M7)', !btns.length && !/data-bf="budget-total"/.test(sh) && !/switched on/.test(sh), btns.join(' | '));
      else check('configWrites:true with an /exec endpointUrl: "Save for everyone" (disabled until an edit) and the name box', btns.length >= 1 && btns.every(x => />Save for everyone</.test(x) && /disabled/.test(x)) && /data-bf="who"/.test(sh), btns.join(' | '));
      await TA.switchChannel('google'); await flush();
    }
    // ---- launch switch on before boot: the #bfcm deep link opens the view
    {
      const { t, TA, V } = await bootBfcm({ open: false, patch: BFCM_ON_PATCH, location: { hash: '#bfcm', pathname: '/', search: '' } });
      await flush();
      const n = bfUrls(t.fetchLog);
      check('enabled:true: #bfcm deep link opens the BFCM view', TA.channel === 'bfcm' && !!(V && V._state && V._state.mounted), `channel=${TA.channel}`);
      check('enabled:true: each BFCM tab fetched once on open', n.daily === 1 && n.config === 1 && n.log === 1, JSON.stringify(n));
      check('enabled:true: pill visible and hint names four views', t.els['ch-bfcm'].style.display !== 'none' && /Four views/.test((t.els.channelhint && t.els.channelhint.textContent) || ''));
    }

    // ---- the view on the fixture, 17 Oct 14:00 Toronto (Meta last pulled 31.9 h ago)
    const googleBefore = { html: '' };
    {
      const { t, TA, V, clock, html } = await bootBfcm({ open: false });
      googleBefore.html = t.els.content.innerHTML;
      TA.CHANNELS.bfcm.enabled = true;
      await TA.switchChannel('bfcm'); await flush();
      const h = html(), S = V && V._state;
      check('view mounts with the 16 fixture rows', !!S && S.mounted === true && S.rows.length === 16, S ? `rows=${S.rows.length}` : 'no _state');
      if (!S) { finish(); return; }
      check('weekly #controls hidden in the BFCM view', t.els.controls.style.display === 'none');
      check('subline + footnote switch to the BFCM copy', t.els.subline.textContent === TA.CHANNELS.bfcm.subline && t.els.footnote.textContent === TA.CHANNELS.bfcm.footnote);
      const fn = TA.CHANNELS.bfcm.footnote || '';
      check('footnote names every basis (conversion time, Meta 7d/1d, Tracked Revenue = Total MER basis, Bank of Canada, Toronto days)',
        /conversion time/.test(fn) && /7-day click \/ 1-day view/.test(fn) && /Tracked Revenue/.test(fn) && /Total MER/.test(fn) && /Bank of Canada/.test(fn) && /Toronto/.test(fn), fn);
      check('no em-dash anywhere in the view or its chrome', !/—/.test(h + fn + TA.CHANNELS.bfcm.subline));
      check('default window = Sale to date, 13 to 16 Oct', S.window && S.window.preset === 'sale' && S.window.from === '2026-10-13' && S.window.to === '2026-10-16', JSON.stringify(S.window));
      check('Toronto today = 2026-10-17 and the phase strip marks it', S.today === '2026-10-17' && /Today · 17 Oct/.test(h), S.today);

      // band 2 tiles vs an independent sum/sum from the fixture CSV
      const gS = bfSum('2026-10-13', '2026-10-16', 1), gR = bfSum('2026-10-13', '2026-10-16', 2);
      const tg = tileOf(h, 'google');
      check('Google ROAS tile = sum(revenue) / sum(spend) over 13..16 Oct (independent)', tg.v === iX(gR / gS) && Math.abs(S.totals.google.roas - gR / gS) < 1e-9, `${tg.v} vs ${iX(gR / gS)}`);
      check('Google ROAS tile names its target from config', /target 12\.0x/.test(tg.s), tg.s);
      const tm = tileOf(h, 'meta');
      check('Meta ROAS tile: gap on 14 Oct shows "-" plus "missing 14 Oct", never a partial sum', tm.v === '-' && /missing 14 Oct/.test(tm.s) && S.totals.meta.spend === null, `${tm.v} | ${tm.s}`);
      const tx = tileOf(h, 'mer');
      check('MER tile: "-" (Meta gap) and carries "uses stale Meta data"', tx.v === '-' && /uses stale Meta data/.test(tx.s), `${tx.v} | ${tx.s}`);
      check('MER tile names the MER target from the log (11.5x)', /target 11\.5x/.test(tx.s), tx.s);
      check('Google ROAS tile carries no stale note (Google is fresh)', !/stale/.test(tg.s), tg.s);
      check('stale banner names Meta with its last update in Toronto time', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(h), (h.match(/class="bf-stale"[^]*?<\/div>/) || [''])[0]);
      check('no stale banner for Google or the store (fresh sources are not hidden by a stale one)', !/Google data last updated/.test(h) && !/Store data last updated/.test(h));
      check('data freshness line shows each source in Toronto time', /Google 17 Oct, 6:00 am/.test(h) && /Toronto time/.test(h));
      const ts = tileOf(h, 'sale');
      check('Sale to date tile present and honest about the Meta gap', /Sale to date/.test(ts.k) && ts.v === '-' && /missing 14 Oct/.test(ts.s), `${ts.v} | ${ts.s}`);

      // daily chart
      const live = t.createdCharts.filter(c => !c.destroyed);
      const ds = live[0] ? live[0].config.data.datasets : [];
      const labels = ds.map(d => d.label).join(',');
      check('one daily chart: Google spend, Meta spend bars + Google ROAS, Meta ROAS, MER lines + MER target', live.length === 1 && labels === 'Google spend,Meta spend,Google ROAS,Meta ROAS,MER,MER target', `${live.length} charts: ${labels}`);
      const sc = live[0] ? live[0].config.options.scales : {};
      check('spend and ratios sit in stacked panels (shared stack key), never two overlaid y-axes',
        ds.length === 6 && ds[0].yAxisID === 'ySpend' && ds[1].yAxisID === 'ySpend' && ds.slice(2).every(d => d.yAxisID === 'yRatio') && sc.ySpend && sc.yRatio && sc.ySpend.stack && sc.ySpend.stack === sc.yRatio.stack);
      check('chart covers the window (4 days) and Meta spend on 14 Oct is null, never 0', ds.length === 6 && ds[1].data.length === 4 && ds[1].data[1] === null, ds[1] && JSON.stringify(ds[1].data));
      check('MER target line = 11.5 on every day', ds[5] && ds[5].data.every(v => v === 11.5));
      check('recent-day tags: Google "may still rise", Meta "filling in"', /may still rise/.test(h) && /filling in/.test(h));
      check('no expected-landed scale-up wording (D1)', !/expected|lag included/i.test(h));
      // weekly table: Mon-Sun Toronto weeks, current week + projected run-rate row
      check('weekly table: Mon-Sun week row for 12 to 18 Oct clipped to 13 to 16 Oct, plus a projected row in plain words (check-deep L13)',
        /13 to 16 Oct/.test(h) && /projected full week 12 to 18 Oct, if spend stays at the last-7-day pace/.test(h) && !/run-rate:|ratios as so far/.test(h));

      // band 1: read-only budget (configWrites:false)
      check('configWrites:false: no edit controls, no Save button', !/data-bf="budget-total"/.test(h) && !/Save for everyone/.test(h) && !/data-bf="target"/.test(h));
      check('budget band shows the log value (32000, Google 70%) read-only', /\$32,000/.test(h) && /Google 70%/.test(h) && /\$22,400/.test(h));
      check('"Set by" names the log author, escaped, with a Toronto time', /Set by Mac O&#39;Neil &quot;Mac&quot; · 15 Oct, 10:00 am Toronto time/.test(h), (h.match(/Set by[^<]*/) || [''])[0]);
      check('XSS: who = <img src=x onerror=alert(1)> renders as text only', !/<img/i.test(h) && h.includes('&lt;img src=x onerror=alert(1)&gt;'));
      check('pacing caption "At the last-7-day pace"', /At the last-7-day pace/.test(h));
      const gSpent = bfSum('2026-10-01', '2026-10-16', 1), gAvg7 = bfSum('2026-10-10', '2026-10-16', 1) / 7, gLands = gSpent + gAvg7 * 15;
      check('Google pacing bar: lands at = spent (1..16 Oct) + last-7 avg x 15 days (independent), % of $22,400',
        h.includes(i$(gLands)) && h.includes(Math.round(gLands / 22400 * 100) + '% of'), `want ${i$(gLands)} (${Math.round(gLands / 22400 * 100)}%)`);
      // the Meta bar's OWN text only (between id="bf-pace" and the Returns band), never the tiles or the forecast
      const pace = h.indexOf('id="bf-pace"') >= 0 ? h.slice(h.indexOf('id="bf-pace"'), h.indexOf('2 · Returns')) : '';
      const metaBar = pace.split('<div class="bf-bar">').find(s => s.includes('<i class="bf-sw m"></i>Meta</span>')) || '';
      const mSpent = bfSum('2026-10-01', '2026-10-13', 4), mLands = mSpent + bfSum('2026-10-07', '2026-10-13', 4) / 7 * 18;
      check('Meta pacing bar (its own text): spent 1..13 Oct, "to 13 Oct", "missing 14 Oct", lands at = spent + last-7 avg x 18 days (independent)',
        !!metaBar && metaBar.includes(i$(mSpent) + ' spent') && /to 13 Oct/.test(metaBar) && /missing 14 Oct/.test(metaBar) && metaBar.includes('lands at <b class="bf-') && metaBar.includes(i$(mLands)),
        `want ${i$(mSpent)} spent, lands ${i$(mLands)}; bar: ${metaBar.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
      check('edit() is refused while configWrites:false', V.edit('budget 2026-10', 1, 50) === false && Object.keys(S.unsaved).length === 0);
      V.setMonth('2026-12');
      const hd = html();
      check('December: "No budget set" and "Starts 1 Dec"', S.month === '2026-12' && /No budget set/.test(hd) && /Starts 1 Dec/.test(hd));
      V.setMonth('2026-11');
      check('November: budget $60,000 (config default) and "Starts 1 Nov"', /\$60,000/.test(html()) && /Starts 1 Nov/.test(html()));
      V.setMonth('2026-10');

      // custom window with every source complete: MER + Meta ROAS vs independent sums; pre-sale days greyed
      V.setCustom('2026-10-01', '2026-10-13');
      const h2 = html(), S2 = V._state;
      const mS = bfSum('2026-10-01', '2026-10-13', 4), mR = bfSum('2026-10-01', '2026-10-13', 5);
      const g2 = bfSum('2026-10-01', '2026-10-13', 1), st = bfSum('2026-10-01', '2026-10-13', 13);
      check('custom 1..13 Oct: Meta ROAS = sum/sum (independent)', tileOf(h2, 'meta').v === iX(mR / mS) && Math.abs(S2.totals.meta.roas - mR / mS) < 1e-9, `${tileOf(h2, 'meta').v} vs ${iX(mR / mS)}`);
      check('custom 1..13 Oct: MER = store revenue / (Google + Meta spend) (independent)', tileOf(h2, 'mer').v === iX(st / (g2 + mS)) && Math.abs(S2.totals.mer.value - st / (g2 + mS)) < 1e-9, `${tileOf(h2, 'mer').v} vs ${iX(st / (g2 + mS))}`);
      check('custom window does not move the Sale to date tile', tileOf(h2, 'sale').v === '-');
      const c2 = t.createdCharts.filter(c => !c.destroyed)[0];
      const bg = c2 ? c2.config.data.datasets[0].backgroundColor : [];
      check('pre-sale days (1..12 Oct) greyed in the chart', Array.isArray(bg) && bg.length === 13 && bg[0] !== bg[12] && bg.slice(0, 12).every(x => x === bg[0]));
      V.setPreset('sale');

      // band 3 forecast: play-only, deterministic, bounded, never "unsaved"
      const fo = () => String((t.els['bf-fc-out'] && t.els['bf-fc-out'].innerHTML) || '');
      check('forecast outputs render, each with its basis line', /Based on/.test(h) && /spend lands at/.test(h) && /Store revenue lands at/.test(h) && /Sale MER lands at/.test(h) && /Google-reported revenue/.test(h) && /Meta-reported revenue/.test(h) && /Daily spend that would still meet the MER target/.test(h) && !/Spend ceiling/.test(h));
      check('platform revenues shown separately, never summed', !/Google \+ Meta revenue|combined platform revenue/i.test(h));
      V.setSlider('spend.google', 0.5); const a1 = fo();
      V.setSlider('spend.google', 0.5); const a2 = fo();
      check('forecast is deterministic for the same sliders (seeded)', a1 && a1 === a2);
      V.setSlider('spend.google', 9); V.setSlider('roas.meta', 0.01);
      check('slider bounds clamp (+100% spend, 0.5x ROAS)', S.sliders.spend.google === 1 && S.sliders.roas.meta === 0.5, JSON.stringify(S.sliders));
      check('forecast sliders never mark anything unsaved', Object.keys(S.unsaved).length === 0 && !/Unsaved/.test(html() + fo()));
      V.resetSliders();
      check('Reset returns every slider to neutral', S.sliders.spend.google === 0 && S.sliders.spend.meta === 0 && S.sliders.roas.google === 1 && S.sliders.roas.meta === 1 && S.sliders.basis === 'last7');

      // leaving the view stops every timer and restores the weekly page
      await TA.switchChannel('google'); await flush();
      const pend = clock.pending(), before = t.fetchLog.length;
      await clock.advance(3600000);
      check('leaving BFCM: view unmounted, all timers stopped, no further fetches', S.mounted === false && pend === 0 && t.fetchLog.length === before, `pending=${pend} fetches+${t.fetchLog.length - before}`);
      check('leaving BFCM: weekly controls back, google HTML identical to before the visit', t.els.controls.style.display === '' && t.els.content.innerHTML === googleBefore.html);
    }

    // ---- broken feeds
    {
      const shifted = indieRows(BFX.daily).map((r, i) => { const c = r.slice(); c.splice(2, 0, i === 0 ? 'Inserted Col' : '123'); return c; })
        .map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
      const { t, V, html } = await bootBfcm({ bf: { daily: shifted } });
      check('header-shift fixture: no rows accepted, error banner, no chart', V._state.rows.length === 0 && /needs attention/.test(html()) && t.createdCharts.filter(c => !c.destroyed).length === 0);
    }
    {
      const { V, html } = await bootBfcm({ bf: { config: '<html>not a csv</html>' } });
      const h = html();
      check('config read fails: "Budget settings could not be read", data bands still work, no % of budget', /Budget settings could not be read/.test(h) && /x$/.test(tileOf(h, 'google').v) && !/% of \$/.test(h) && V._state.rows.length === 16);
      // unknown is not blank: an unreadable config must never say "No budget set" (pacing bars, forecast, future month)
      check('config read fails: says "Budget unavailable", never "No budget set" (pacing + forecast)', /Budget unavailable/.test(h) && /budget unavailable/.test(h) && !/no budget set/i.test(h), (h.match(/[^>]{0,40}[Nn]o budget set[^<]{0,20}/g) || []).join(' | '));
      V.setMonth('2026-12');
      check('config read fails: a future month says "Budget unavailable", not "No budget set yet"', /Starts 1 Dec\. Budget unavailable/.test(html()) && !/no budget set/i.test(html()), (html().match(/Starts 1 Dec[^<]*/) || [''])[0]);
    }
    {
      const { html } = await bootBfcm({ bf: { log: '<html>not a csv</html>' } });
      check('log read fails: same message, no guessed budget', /Budget settings could not be read/.test(html()) && !/% of \$/.test(html()));
    }

    // ---- final fix I2 (REVIEW FOCUS 2 on screen): a 100% or 0% split leaves one platform a $0 budget, which must
    //      read "No budget for <Platform>", never "$X spent of $0"; a blank split is "not set", never "No budget set"
    {
      const logWith = v2 => BFX.log.replace(/\n?$/, '\n') + '"3","2026-10-17T11:00:00.000Z","Glen","budget 2026-10","32000","' + v2 + '","00000000-0000-4000-8000-000000000003"\n';
      for (const [pct, zero, other, name] of [['100', 'm', 'g', 'Meta'], ['0', 'g', 'm', 'Google']]) {
        const { V, html } = await bootBfcm({ bf: { log: logWith(pct) } });
        const b = paceBars(html());
        check(`split ${pct}% Google: the ${name} bar reads "No budget for ${name}", never "of $0", no % and no colour band`,
          V._state.cfg.budgets['2026-10'].pct === +pct && b[zero].includes('No budget for ' + name) && !b[zero].includes('of $0') && !/% of/.test(b[zero]) && !/class="bf-(under|ok|amber|red)"/.test(b[zero]), plain(b[zero]));
        check(`split ${pct}% Google: the other platform and the total still pace against their budgets`,
          new RegExp('\\d+% of \\$32,000').test(b[other]) && b[other].includes('of $32,000</span>') && /\d+% of \$32,000/.test(b.t), plain(b[other]) + ' || ' + plain(b.t));
      }
      const { html } = await bootBfcm({ bf: { log: logWith('') } });
      const b = paceBars(html());
      check('blank split: the Google and Meta bars read "Google / Meta split not set", never "No budget set"',
        ['g', 'm'].every(k => b[k].includes('Google / Meta split not set') && !/No budget set/.test(b[k]) && !/% of/.test(b[k])), plain(b.g) + ' || ' + plain(b.m));
      check('blank split: the total bar still paces against $32,000', /\d+% of \$32,000/.test(b.t) && b.t.includes('of $32,000</span>'), plain(b.t));
    }

    // ---- final fix M1: one owner typo (sale_end before sale_start) or a paint that throws never leaves "Loading..."
    {
      const badEnd = BFX.config.replace('"sale_end","2026-12-06",""', '"sale_end","2026-10-01",""');
      const { V, html } = await bootBfcm({ bf: { config: badEnd } });
      const h = html(), S = V._state;
      check('sale_end before sale_start: the view paints (no "Loading"), the sale dates fall back to 13 Oct to 6 Dec',
        badEnd !== BFX.config && !/Loading/.test(h) && S.cfg && S.cfg.saleStart === '2026-10-13' && S.cfg.saleEnd === '2026-12-06' && S.month === '2026-10', S.cfg ? JSON.stringify({ s: S.cfg.saleStart, e: S.cfg.saleEnd, m: S.month, err: S.cfg.error }) : 'no cfg');
      check('sale_end before sale_start: says the sale dates are not valid, hides pacing against budget, data still live',
        S.cfg.error === 'Sale dates in the settings are not valid' && /sale dates in the settings are not valid/i.test(h) && !/% of \$/.test(h) && /x$/.test(tileOf(h, 'google').v), (h.match(/<div class="bf-alert">[^<]*/) || ['(no alert)'])[0]);
    }
    {
      const { t, TA, V, html } = await bootBfcm({ open: false });
      const logged = [];
      t.sandbox.console = { log() {}, warn() {}, error: (...a) => logged.push(a.map(String).join(' ')) };
      const real = t.sandbox.BFCM_CORE.pacing;
      t.sandbox.BFCM_CORE.pacing = () => { throw new Error('sim forced paint throw'); };
      TA.CHANNELS.bfcm.enabled = true;
      let threw = false;
      try { await TA.switchChannel('bfcm'); await flush(); } catch (e) { threw = true; }
      const h = html();
      check('a paint that throws: the "needs attention" alert style with plain text, never the loading text',
        !threw && !/Loading/.test(h) && /<div class="bf-alert" role="alert">Something went wrong showing these figures\. Please refresh the page\.<\/div>/.test(h), h.slice(0, 200));
      check('a paint that throws: the error is logged to the console', logged.some(s => /sim forced paint throw/.test(s)), JSON.stringify(logged));
      t.sandbox.BFCM_CORE.pacing = real;
      V.setPreset('last7');
      check('a paint that throws: the next paint recovers once the fault is gone', /2 · Returns/.test(html()) && !/Something went wrong/.test(html()));
    }

    // ---- refresh timers on a fake clock (17 Oct 08:00 Toronto: every source fresh)
    {
      const { t, V, clock, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
      const D = t.documentStub;
      check('fresh fixture at 08:00 Toronto: no stale banner', !/data last updated/.test(html()));
      const chartsBefore = t.createdCharts.length;
      await clock.advance(16 * 60000);
      let n = bfUrls(t.fetchLog);
      check('fake clock +16 min: all three BFCM tabs fetched a second time', n.daily === 2 && n.config === 2 && n.log === 2, JSON.stringify(n));
      check('a refresh with unchanged CSVs does not repaint (chart kept, open panels stay open)', t.createdCharts.length === chartsBefore, `charts ${chartsBefore} -> ${t.createdCharts.length}`);
      D.visibilityState = 'hidden';
      await clock.advance(16 * 60000);
      n = bfUrls(t.fetchLog);
      check('hidden tab: no refetch', n.daily === 2, JSON.stringify(n));
      D.visibilityState = 'visible'; D.fire('visibilitychange'); await flush();
      n = bfUrls(t.fetchLog);
      check('back to visible after > 5 min: refetch at once', n.daily === 3 && n.config === 3 && n.log === 3, JSON.stringify(n));
      D.fire('visibilitychange'); await flush();
      check('back to visible again within 5 min: no extra fetch', bfUrls(t.fetchLog).daily === 3);
      // 30 h threshold: Meta pulled 2026-10-16T10:05Z goes stale at 2026-10-17T16:05Z. Hidden tab = no
      // refetch, so only the 60 s timer can flip the banner on.
      D.visibilityState = 'hidden';
      await clock.advance(4 * 3600000);
      check('fake clock across 30 h: Meta banner appears without a reload or refetch (60 s timer)', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(html()) && bfUrls(t.fetchLog).daily === 3);
      void V;
    }
    {
      // Toronto today, not the machine's: 2026-10-17T03:00Z is 16 Oct 23:00 in Toronto (17 Oct in UTC and Brisbane)
      const { V, clock, html } = await bootBfcm({ now: '2026-10-17T03:00:00.000Z' });
      check('today marker uses the Toronto date (16 Oct at 23:00 Toronto)', V._state.today === '2026-10-16' && /Today · 16 Oct/.test(html()), V._state.today);
      await clock.advance(2 * 3600000);
      check('60 s timer moves the today marker past Toronto midnight', V._state.today === '2026-10-17' && /Today · 17 Oct/.test(html()), V._state.today);
    }

    {
      // focus rule: a background refresh never repaints under a focused input inside the view (it waits for
      // focusout); a user's own action (a picked date fires "change" while its input still has focus) paints at once
      const { t, V, clock, bf, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
      t.els.content.contains = () => true;
      t.documentStub.activeElement = { tagName: 'INPUT', type: 'number', getAttribute: k => (k === 'data-bf' ? 'budget-total' : null) };   // a config number input being typed in
      const before = html();
      bf.log = bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:10:00.000Z","Maria","budget 2026-10","35000","70","c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"\n';
      await clock.advance(16 * 60000);
      check('background refresh with new data waits while an input in the view has focus', html() === before && V._state.pendingPaint === true);
      V.setCustom('2026-10-02', '2026-10-09');
      check('a user date pick paints at once, focused input or not', /2 to 9 Oct/.test(html()) && V._state.pendingPaint === false && /\$35,000/.test(html()));
      V.setSlider('spend.google', 0.2);
      t.documentStub.activeElement = null;
    }
    {
      // a focused FORECAST SLIDER never holds back a refresh or a stale banner (a client drags it, leaves the tab, returns hours later)
      const { t, clock, bf, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
      t.els.content.contains = () => true;
      t.documentStub.activeElement = { tagName: 'INPUT', type: 'range', getAttribute: k => (k === 'data-bf' ? 'slider' : null) };
      bf.daily = bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","999.00"');
      await clock.advance(4.5 * 3600000);   // several refreshes, and past 16:05Z when Meta turns 30 h old
      const h = html(), al = String((t.els['bf-alerts'] && t.els['bf-alerts'].innerHTML) || '');
      check('focused forecast slider: the refresh still paints the new data', h.includes('$999'));
      // check-deep L7: the 60 s timer's own repaint waits while a slider has focus, but the alerts area is always current
      check('focused forecast slider: the stale banner still appears past 30 h (in the alerts area)', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(al), al.slice(0, 160));
      t.documentStub.activeElement = null;
    }
    {
      // a focused config number input defers the full repaint, but the alerts + freshness area is always repainted
      const { t, V, clock, bf, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true });
      t.els.content.contains = () => true;
      t.documentStub.activeElement = { tagName: 'INPUT', type: 'number', getAttribute: k => (k === 'data-bf' ? 'budget-total' : null) };
      const before = html();
      bf.daily = bf.daily.split('2026-10-17T10:00:00.000Z').join('2026-10-17T14:00:00.000Z');   // a newer Google pull (10:00 am Toronto)
      await clock.advance(4.5 * 3600000);
      const al = String((t.els['bf-alerts'] && t.els['bf-alerts'].innerHTML) || ''), fr = String((t.els['bf-fresh'] && t.els['bf-fresh'].innerHTML) || '');
      check('focused budget input: the full repaint waits (the control is kept)', html() === before && V._state.pendingPaint === true);
      check('focused budget input: the alerts area still gets the stale banner', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(al), al.slice(0, 160));
      check('focused budget input: the freshness line still gets the new pull time', /Google 17 Oct, 10:00 am/.test(fr), fr.slice(0, 160));
      t.documentStub.activeElement = null;
    }
    {
      // weekly table: when only Meta ends early (no gap), Total spend / store sales / MER are cut to 15 Oct, and the row says so
      const recs = indieRows(BFX.daily);
      const r13 = recs.find(r => r[0] === '2026-10-13'), r14 = recs.find(r => r[0] === '2026-10-14');
      [4, 5, 6].forEach(c => { r14[c] = r13[c]; });   // fill the 14 Oct Meta gap
      const noGap = recs.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
      const { html } = await bootBfcm({ bf: { daily: noGap } });
      const row = (html().match(/<tr><td>13 to 16 Oct \(this week\)[\s\S]*?<\/tr>/) || [''])[0];
      const tds = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      const st15 = bfSum('2026-10-13', '2026-10-15', 13);
      check('weekly row: store sales summed to 15 Oct (independent)', tds[4] === i$(st15), `${tds[4]} vs ${i$(st15)}`);
      check('weekly row: names the cut-off "Total, store sales and MER to 15 Oct"', /Total, store sales and MER to 15 Oct/.test(tds[0] || ''), (tds[0] || '(row missing)').replace(/<[^>]+>/g, ' '));
    }
    {
      // slider / basis actions before the first load are ignored, never a crash
      const t = bootPage(csv, metaCsv, merCsv, { clock: makeClock('2026-10-17T12:00:00.000Z') });
      await flush();
      const V = t.sandbox.BFCM_VIEW;
      let ok = true;
      try { V.mount(t.els.content, { CHANNELS: t.sandbox.window.__apollo.CHANNELS, parseCSV: t.sandbox.window.__apollo.parseCSV, esc: t.sandbox.window.__apollo.esc, Chart: t.sandbox.Chart }); V.setSlider('spend.google', 0.5); V.setBasis('last14'); V.resetSliders(); V.unmount(); } catch (e) { ok = false; }
      check('slider / basis / reset before the data loads do not throw', ok);
    }

    // ---- config edit controls (configWrites:true and an endpoint in the sandbox; without an endpoint the block is read-only, M7)
    {
      const { V, clock, bf, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true, endpoint: 'https://script.google.com/macros/s/SIM-TEST/exec' });
      const h = html();
      check('configWrites:true: budget total, split slider, Save button and Targets panel render', /data-bf="budget-total"/.test(h) && /data-bf="budget-pct"/.test(h) && /data-bf="save"/.test(h) && /data-bf="target"/.test(h) && /Targets/.test(h));
      check('controls show the current values (log over defaults)', /data-bf="budget-total"[^>]*value="32000"/.test(h) && /data-bf="budget-pct"[^>]*value="70"/.test(h));
      check('no config string or who in an attribute (spec 23)', !/="[^"]*(Mac|onerror)[^"]*"/.test(h));
      check('edit() marks the budget Unsaved', V.edit('budget 2026-10', 45000, 60) === true && !!V._state.unsaved['budget 2026-10']);
      bf.log = bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:10:00.000Z","Maria","budget 2026-10","35000","70","c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"\n';
      await clock.advance(16 * 60000);
      const h2 = html();
      check('refresh adopts the newer saved value in state (35000)', V._state.cfg.budgets['2026-10'] && V._state.cfg.budgets['2026-10'].total === 35000);
      check('refresh keeps the unsaved budget in its control (45000, 60%)', /data-bf="budget-total"[^>]*value="45000"/.test(h2) && /data-bf="budget-pct"[^>]*value="60"/.test(h2) && /Unsaved/.test(h2));
      check('refresh shows "Newer saved value: <v> by <who>" beside it', /Newer saved value: \$35,000 · Google 70% by Maria/.test(h2), (h2.match(/Newer saved value[^<]*/) || ['(none)'])[0]);
    }

    // ---- save flow (spec 21, 22, 43) with a fetch stub for the config endpoint
    section('bfcm save flow (fetch stub)');
    {
      const EP = 'https://script.google.com/macros/s/SIM-TEST/exec';
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const answer = o => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(o)) });
      const netErr = () => Promise.reject(new TypeError('Failed to fetch'));
      // the server's `current` map: the fixture config + log, with overrides {key: [value, value2, who, at]}
      const cur = over => {
        const c = {
          sale_start: ['2026-10-13', '', '', ''], sale_end: ['2026-12-06', '', '', ''],
          'budget 2026-10': ['32000', '70', 'Mac O\'Neil "Mac"', '2026-10-15T14:00:00.000Z'], 'budget 2026-11': ['60000', '65', '', ''], 'budget 2026-12': ['', '', '', ''],
          'target google_roas': ['12', '', '', ''], 'target meta_roas': ['12', '', '', ''], 'target mer': ['11.5', '', '<img src=x onerror=alert(1)>', '2026-10-16T13:30:00.000Z'],
        };
        Object.assign(c, over || {});
        const out = {};
        Object.keys(c).forEach(k => { out[k] = { value: c[k][0], value2: c[k][1], who: c[k][2], at: c[k][3] }; });
        return out;
      };
      const SAVED_AT = '2026-10-17T12:00:01.000Z';   // 8:00 am Toronto
      const okBudget = (who, extra) => answer(Object.assign({ ok: true, current: cur({ 'budget 2026-10': ['45000', '60', who || 'Glen', SAVED_AT] }) }, extra || {}));
      const meta = t => String((t.els['bf-budget-meta'] && t.els['bf-budget-meta'].innerHTML) || '').replace(/<\/?bdi>/g, '');
      const tmeta = t => String((t.els['bf-targets-meta'] && t.els['bf-targets-meta'].innerHTML) || '').replace(/<\/?bdi>/g, '');
      const fire = (t, ev, target) => (t.els.content._listeners[ev] || []).forEach(fn => fn({ target }));
      const typeName = (t, name) => fire(t, 'input', { getAttribute: k => (k === 'data-bf' ? 'who' : null), value: name });
      const clickSave = (t, scope) => fire(t, 'click', { closest: () => ({ getAttribute: k => (k === 'data-bf' ? 'save' : k === 'data-v' ? scope : null) }) });
      const bodyOf = (posts, i) => { try { return JSON.parse(posts[i].init.body); } catch (e) { return {}; } };
      const saveBtn = s => (String(s).match(/<button[^>]*data-bf="save"[^>]*>[^<]*<\/button>/g) || []);
      const boot = o => bootBfcm(Object.assign({ now: '2026-10-17T12:00:00.000Z', configWrites: true, endpoint: EP }, o || {}));
      // edit the October budget, type a name, click Save; returns after the stub's answers have been handled
      const saveBudget = async (b, name) => { b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, name == null ? 'Glen' : name); clickSave(b.t, 'budget'); await flush(); };

      {
        // endpointUrl '' (check-deep M7): saving is not possible, so the budget block is read-only (no edit controls, no
        // Save button, no name box), edit() is refused and nothing is ever posted
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true });
        const ed = b.V.edit('budget 2026-10', 45000, 60);
        const btn = saveBtn(meta(b.t)).concat(saveBtn(b.html()));
        check('endpointUrl empty: read-only budget block, no Save button, no name box, edit() refused',
          !btn.length && !/data-bf="budget-total"/.test(b.html()) && !/data-bf="who"/.test(b.html()) && /\$32,000/.test(b.html()) && ed === false && !Object.keys(b.V._state.unsaved).length, btn.join(' | '));
        typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush();
        const r = typeof b.V.save === 'function' ? await b.V.save('budget') : 'no save()';
        check('endpointUrl empty: a click or save() posts nothing', b.posts.length === 0 && r === false, String(r));
      }
      {
        // ok: one POST, the exact body and transport, "Saved for everyone", the page adopts `current`
        const b = await boot({ post: () => okBudget('Glen') });
        b.V.edit('budget 2026-10', 45000, 60);
        check('with an endpoint and an unsaved edit: "Save for everyone" enabled, name box shown', saveBtn(meta(b.t)).some(x => !/disabled/.test(x) && />Save for everyone</.test(x)) && /data-bf="who"/.test(b.html()));
        typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush();
        const p = b.posts[0] || { init: {} }, bd = bodyOf(b.posts, 0), h = b.html();
        check('ok: exactly one POST to the endpoint, text/plain (no preflight), a 15 s timeout signal',
          b.posts.length === 1 && p.url === EP && p.init.method === 'POST' && p.init.headers && p.init.headers['Content-Type'] === 'text/plain;charset=utf-8' && p.init.signal && p.init.signal.simTimeoutMs === 15000, JSON.stringify(p.init));
        check('ok: body is {rid, key, value, value2, expect, expect2, who}, all text, expect = the value the edit started from',
          Object.keys(bd).join() === 'rid,key,value,value2,expect,expect2,who' && UUID.test(bd.rid) && bd.key === 'budget 2026-10' && bd.value === '45000' && bd.value2 === '60' && bd.expect === '32000' && bd.expect2 === '70' && bd.who === 'Glen', JSON.stringify(bd));
        check('ok: "Saved for everyone · Glen · 17 Oct, 8:00 am Toronto time"', h.includes('Saved for everyone · Glen · 17 Oct, 8:00 am Toronto time'), (h.match(/[^>]*Saved for everyone[^<]*/) || ['(none)'])[0]);
        check('ok: the page adopts `current` (control 45000 / 60, no Unsaved, pacing on the new budget)',
          /data-bf="budget-total"[^>]*value="45000"/.test(h) && /data-bf="budget-pct"[^>]*value="60"/.test(h) && !/Unsaved/.test(h) && b.V._state.cfg.budgets['2026-10'].total === 45000 && b.V._state.cfg.budgets['2026-10'].pct === 60 && /% of \$27,000/.test(h));
        check('ok: the name is remembered in localStorage', b.t.sandbox.localStorage._m.get('apollo-bfcm-who') === 'Glen');
        check('ok: the Save button is disabled again once nothing is unsaved', saveBtn(meta(b.t)).every(x => /disabled/.test(x)));
      }
      {
        const b = await boot({ post: () => okBudget('Glen', { duplicate: true }) });
        await saveBudget(b);
        check('duplicate: same "Saved for everyone" outcome', b.html().includes('Saved for everyone · Glen · 17 Oct, 8:00 am Toronto time') && !/Unsaved/.test(b.html()));
      }
      {
        // changed: "Not saved: ... Nothing changed." and the control reverts to the server's current value
        const b = await boot({ post: () => answer({ ok: false, error: 'changed', current: cur({ 'budget 2026-10': ['50000', '55', 'Maria', '2026-10-17T11:59:00.000Z'] }) }) });
        await saveBudget(b);
        const h = b.html();
        check('changed: "Not saved: <reason>. Nothing changed."', /Not saved: [^<]+\. Nothing changed\./.test(h) && !/Saved for everyone/.test(h), (h.match(/Not saved[^<]*/) || ['(none)'])[0]);
        check('changed: the control reverts to `current` (50000 / 55 by Maria), no Unsaved',
          /data-bf="budget-total"[^>]*value="50000"/.test(h) && /data-bf="budget-pct"[^>]*value="55"/.test(h) && !/Unsaved/.test(h) && /Set by Maria/.test(h));
      }
      {
        // a refresh brings someone else's newer value while the edit is open: the save still expects the value the
        // edit started from (32000 / 70), so the server answers "changed" instead of silently overwriting Maria
        const b = await boot({ post: () => answer({ ok: false, error: 'changed', current: cur({ 'budget 2026-10': ['35000', '70', 'Maria', '2026-10-17T12:10:00.000Z'] }) }) });
        b.V.edit('budget 2026-10', 45000, 60);
        b.bf.log = b.bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:10:00.000Z","Maria","budget 2026-10","35000","70","c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"\n';
        await b.clock.advance(16 * 60000);
        typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush();
        const bd = bodyOf(b.posts, 0);
        check('newer value loaded mid-edit: expect is still the value the edit started from (32000 / 70)', b.V._state.cfg.budgets['2026-10'] && bd.expect === '32000' && bd.expect2 === '70', JSON.stringify(bd));
        check('newer value loaded mid-edit: "changed" reverts the control to Maria\'s 35000', /data-bf="budget-total"[^>]*value="35000"/.test(b.html()) && /Set by Maria/.test(b.html()));
      }
      {
        const b = await boot({ post: () => answer({ ok: false, error: 'busy' }) });
        await saveBudget(b);
        const h = b.html();
        // check-deep L11: busy is a transient refusal, so the typed edit stays (only changed / invalid / log full revert)
        check('busy: "Not saved: ... Nothing changed." and the control keeps the typed value (45000, Unsaved)', /Not saved: [^<]+\. Nothing changed\./.test(h) && /data-bf="budget-total"[^>]*value="45000"/.test(h) && /Unsaved/.test(h));
      }
      {
        // network error, then the retry is answered: ONE retry, the SAME rid (same body), then Saved
        const b = await boot({ post: n => (n === 1 ? netErr() : okBudget('Glen', n === 2 ? { duplicate: true } : {})) });
        await saveBudget(b);
        const mid = meta(b.t);
        check('network error: "Save outcome unknown, checking..." and the button is disabled while it checks', mid.includes('Save outcome unknown, checking...') && saveBtn(mid).every(x => /disabled/.test(x)) && !/Nothing changed/.test(mid + b.html()), mid.replace(/<[^>]+>/g, ' ').slice(0, 200));
        await b.clock.advance(5000);
        check('network error then retry ok: exactly one retry with the same rid and body', b.posts.length === 2 && b.posts[0].init.body === b.posts[1].init.body && UUID.test(bodyOf(b.posts, 1).rid));
        check('network error then retry ok: "Saved for everyone"', b.html().includes('Saved for everyone · Glen') && !/Unsaved|Unconfirmed/.test(b.html()));
      }
      {
        // a 15 s timeout counts as no answer (the fetch never settles)
        const b = await boot({ post: n => (n === 1 ? new Promise(() => {}) : okBudget('Glen')) });
        await saveBudget(b);
        check('timeout: still waiting before 15 s, no retry yet', b.posts.length === 1 && /Saving/.test(meta(b.t)));
        await b.clock.advance(15000);
        check('timeout: after 15 s "Save outcome unknown, checking..."', meta(b.t).includes('Save outcome unknown, checking...'));
        await b.clock.advance(5000);
        check('timeout then retry ok: one retry, same rid, then Saved', b.posts.length === 2 && b.posts[0].init.body === b.posts[1].init.body && b.html().includes('Saved for everyone · Glen'));
      }
      {
        // an answer that is not JSON (Google's error page after a crash) is not a server answer: retry
        const b = await boot({ post: n => (n === 1 ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('<!DOCTYPE html><html>Error</html>') }) : okBudget('Glen', { duplicate: true })) });
        await saveBudget(b);
        await b.clock.advance(5000);
        check('non-JSON answer: treated as unknown, retried once with the same rid, then Saved', b.posts.length === 2 && b.posts[0].init.body === b.posts[1].init.body && b.html().includes('Saved for everyone'));
      }
      {
        // two failures: "Not confirmed. Reload to see what is saved.", the control marked Unconfirmed, never "Nothing changed"
        const b = await boot({ post: () => netErr() });
        await saveBudget(b);
        await b.clock.advance(5000);
        await b.clock.advance(5000);
        const h = b.html() + meta(b.t);
        check('two failures: exactly 2 POSTs, then "Not confirmed. Reload to see what is saved."', b.posts.length === 2 && h.includes('Not confirmed. Reload to see what is saved.'), String(b.posts.length));
        check('two failures: the control is marked Unconfirmed and keeps the typed value', /Unconfirmed/.test(h) && /data-bf="budget-total"[^>]*value="45000"/.test(b.html()));
        check('two failures: never "Nothing changed" and never "Saved"', !/Nothing changed/.test(h) && !/Saved for everyone/.test(h));
        b.V.edit('budget 2026-10', 46000, 60);
        check('a new edit after Unconfirmed is plain Unsaved again', /Unsaved/.test(meta(b.t)) && !/Unconfirmed/.test(meta(b.t)));
      }
      {
        // no name: nothing is posted, the person is asked for a name
        const b = await boot({ post: () => okBudget('Glen') });
        await saveBudget(b, '   ');
        check('no name: nothing posted, asks for a name, no "Nothing changed"', b.posts.length === 0 && /Type your name/.test(meta(b.t)) && !/Nothing changed/.test(meta(b.t) + b.html()));
      }
      {
        // the remembered name fills the box by DOM property, never into an attribute; a throwing localStorage is harmless
        const b = await boot({ storage: makeStorage({ 'apollo-bfcm-who': 'Priya <b>"P"</b>' }), post: () => okBudget('Priya') });
        check('remembered name: the box is filled by property, the name never appears in the HTML', b.t.els['bf-who'] && b.t.els['bf-who'].value === 'Priya <b>"P"</b>' && !/Priya/.test(b.html()));
        b.V.edit('budget 2026-10', 45000, 60); clickSave(b.t, 'budget'); await flush();
        check('remembered name: used for the save', bodyOf(b.posts, 0).who === 'Priya <b>"P"</b>');
        const c = await boot({ storage: makeStorage({}, true), post: () => okBudget('Glen') });
        await saveBudget(c);
        check('localStorage that throws: the view mounts and the save still works', c.V._state.mounted && c.html().includes('Saved for everyone · Glen'));
      }
      {
        // who and every server string are escaped into text: the server's who, and an invalid reason with markup
        const b = await boot({ post: () => okBudget('<img src=x onerror=alert(2)>') });
        await saveBudget(b);
        const h = b.html();
        check('XSS: the server\'s who renders as text in "Saved for everyone"', h.includes('Saved for everyone · &lt;img src=x onerror=alert(2)&gt;') && !/<img/i.test(h));
        const c = await boot({ post: () => answer({ ok: false, error: 'invalid', field: 'value', reason: 'bad <b>value</b> & "more"' }) });
        await saveBudget(c);
        const hc = c.html();
        check('invalid: the server\'s reason is shown escaped: "Not saved: <reason>. Nothing changed."', hc.includes('Not saved: bad &lt;b&gt;value&lt;/b&gt; &amp; &quot;more&quot;. Nothing changed.') && !/<b>value/.test(hc), (hc.match(/Not saved[^<]*/) || ['(none)'])[0]);
        const d = await boot({ post: () => answer({ ok: false, error: '__proto__' }) });
        await saveBudget(d);
        check('an unknown error code reads as a plain refusal', /Not saved: the server refused the change\. Nothing changed\./.test(d.html()));
      }
      {
        // targets: one request per key, each with its own new rid, value2/expect2 empty
        const srv = {};   // the fake server keeps every accepted row
        const b = await boot({ post: (n, init) => { const q = JSON.parse(init.body); srv[q.key] = [q.value, '', q.who, SAVED_AT]; return answer({ ok: true, current: cur(srv) }); } });
        b.V.edit('target mer', 10); b.V.edit('target google_roas', 11);
        check('targets: the Targets panel has its own enabled Save button', saveBtn(tmeta(b.t)).some(x => !/disabled/.test(x) && />Save for everyone</.test(x)));
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush(); await b.clock.advance(4000);
        const k = b.posts.map((p, i) => bodyOf(b.posts, i));
        check('targets: one POST per key, in panel order, each with a different rid',
          k.length === 2 && k[0].key === 'target google_roas' && k[1].key === 'target mer' && k[0].rid !== k[1].rid && k.every(x => UUID.test(x.rid) && x.value2 === '' && x.expect2 === ''), JSON.stringify(k));
        check('targets: expect = the saved values the edits started from (12, 11.5)', k.length === 2 && k[0].value === '11' && k[0].expect === '12' && k[1].value === '10' && k[1].expect === '11.5');
        check('targets: each target shows its own Saved line', (b.html().match(/Saved for everyone · Glen/g) || []).length >= 2 && b.V._state.cfg.targets.mer === 10 && b.V._state.cfg.targets.google_roas === 11);
      }
      // ---- fix round 1, I-2: a refusal on the RETRY says nothing about attempt 1 (busy / closed are decided before the
      // rid lookup), so it stays "Not confirmed"; only changed / invalid / log full are conclusive
      for (const [err, conclusive] of [['busy', false], ['closed', false], ['weird', false], ['changed', true], ['invalid', true], ['log full', true]]) {
        const b = await boot({ post: n => (n === 1 ? netErr() : answer(Object.assign({ ok: false, error: err }, err === 'changed' ? { current: cur() } : {}, err === 'invalid' ? { field: 'value', reason: 'bad value' } : {}))) });
        await saveBudget(b);
        await b.clock.advance(5000);
        const h = b.html() + meta(b.t);
        if (conclusive) check('retry answered "' + err + '": a conclusive refusal, "Not saved: ... Nothing changed."', b.posts.length === 2 && /Not saved: [^<]+\. Nothing changed\./.test(h) && !/Not confirmed/.test(h));
        else check('retry answered "' + err + '": attempt 1 is still unknown, so "Not confirmed. Reload to see what is saved." and never "Nothing changed"',
          b.posts.length === 2 && h.includes('Not confirmed. Reload to see what is saved.') && !/Nothing changed/.test(h) && /Unconfirmed/.test(h), (h.match(/(Not saved|Not confirmed)[^<]*/) || ['(none)'])[0]);
      }

      // ---- fix round 1, I-1: ONE page-wide queue; each POST waits >= 3.5 s after the previous answer, because the
      // server refuses a write less than 3 s after the newest row (MIN_GAP_MS)
      const gapServer = ref => {
        const srv = {}, times = [];
        let last = -Infinity;
        return {
          times,
          post: (n, init) => {
            const now = ref.b.clock.now(), q = JSON.parse(init.body);
            times.push(now);
            if (now - last < 3000) return answer({ ok: false, error: 'busy' });
            last = now;
            srv[q.key] = [q.value, q.value2, q.who, new Date(now).toISOString()];
            return answer({ ok: true, current: cur(srv) });
          },
        };
      };
      {
        const ref = {}, gs = gapServer(ref);
        const b = ref.b = await boot({ post: gs.post });
        b.V.edit('target google_roas', 11); b.V.edit('target meta_roas', 13); b.V.edit('target mer', 10);
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush();
        const mid = tmeta(b.t);
        check('queue: one POST at a time; the waiting targets show "Saving…"', b.posts.length === 1 && mid.includes('Meta ROAS: Saving…') && mid.includes('MER: Saving…') && saveBtn(mid).every(x => /disabled/.test(x)), `posts=${b.posts.length} ${mid.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
        for (let i = 0; i < 3; i++) await b.clock.advance(4000);
        const h = b.html(), T = b.V._state.cfg.targets;
        check('queue: a server that enforces the 3 s gap saves all three targets (no "Not saved")',
          b.posts.length === 3 && (h.match(/Saved for everyone · Glen/g) || []).length === 3 && !/Not saved/.test(h) && T.google_roas === 11 && T.meta_roas === 13 && T.mer === 10, `posts=${b.posts.length} ${(h.match(/(Not saved|Saved for everyone)[^<]*/g) || []).join(' | ')}`);
        check('queue: the POSTs are at least 3.5 s apart', gs.times.length === 3 && gs.times.every((t, i) => i === 0 || t - gs.times[i - 1] >= 3500), JSON.stringify(gs.times.map(t => t - gs.times[0])));
      }
      {
        // a budget save right after a target save (two clicks) shares the same queue
        const ref = {}, gs = gapServer(ref);
        const b = ref.b = await boot({ post: gs.post });
        b.V.edit('target mer', 10); b.V.edit('budget 2026-10', 45000, 60);
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); clickSave(b.t, 'budget'); await flush();
        check('queue: a budget save right after a target save waits its turn ("Saving…")', b.posts.length === 1 && meta(b.t).includes('Saving…'));
        for (let i = 0; i < 2; i++) await b.clock.advance(4000);
        const c = b.V._state.cfg;
        check('queue: both the target and the budget save against the 3 s gap', b.posts.length === 2 && !/Not saved/.test(b.html()) && c.targets.mer === 10 && c.budgets['2026-10'].total === 45000 && c.budgets['2026-10'].pct === 60);
      }
      {
        // a queued key typed back to its saved value is dropped from the queue, never stuck on "Saving…"
        const ref = {}, gs = gapServer(ref);
        const b = ref.b = await boot({ post: gs.post });
        b.V.edit('target google_roas', 11); b.V.edit('target mer', 10);
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush();
        b.V.edit('target mer', 11.5);   // back to the saved 11.5 while queued
        for (let i = 0; i < 2; i++) await b.clock.advance(4000);
        // (the live #bf-targets-meta element is what the person sees; the sim's content string is the last full paint)
        check('queue: a key typed back to the saved value while queued is skipped and its "Saving…" clears',
          b.posts.length === 1 && !b.V._state.saving['target mer'] && !/MER: Saving/.test(tmeta(b.t)), `posts=${b.posts.length} state=${JSON.stringify(b.V._state.saving['target mer'])} meta=${tmeta(b.t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      {
        // an incomplete `current` (a broken answer) is never adopted: no budget or target is wiped
        const b = await boot({ post: () => answer({ ok: true, current: { 'budget 2026-10': { value: '45000', value2: '60', who: 'Glen', at: SAVED_AT } } }) });
        await saveBudget(b);
        const c = b.V._state.cfg;
        check('an incomplete `current` is not adopted (November 60000 and the MER target 11.5 survive)', c.budgets['2026-11'] && c.budgets['2026-11'].total === 60000 && c.targets.mer === 11.5 && !c.error);
      }
      {
        // rid without crypto.randomUUID: still UUID-shaped (the server checks the shape)
        const b = await boot({ crypto: undefined, post: () => okBudget('Glen') });
        await saveBudget(b);
        const c = await boot({ crypto: {}, post: () => okBudget('Glen') });
        await saveBudget(c);
        check('no crypto.randomUUID: the rid falls back to a UUID-shaped timestamp + random string', UUID.test(bodyOf(b.posts, 0).rid || '') && UUID.test(bodyOf(c.posts, 0).rid || '') && bodyOf(b.posts, 0).rid !== bodyOf(c.posts, 0).rid);
      }
      {
        // leaving the view mid-save: the late answer never paints or throws
        const b = await boot({ post: () => new Promise(r => setTimeout(() => r({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, current: cur() })) }), 0)) });
        b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, 'Glen'); clickSave(b.t, 'budget');
        await b.TA.switchChannel('google'); await flush(); await flush();
        check('leaving mid-save: the weekly view is untouched by the late answer', b.TA.channel === 'google' && !/Saved for everyone/.test(b.html()));
      }
    }

    // ================================================================ /check-deep pass 1 fixes (each check failed first)
    section('bfcm check-deep fixes (pass 1)');
    {
      const EP = 'https://script.google.com/macros/s/SIM-TEST/exec';
      const SAVED_AT = '2026-10-17T12:00:01.000Z';   // 8:00 am Toronto
      const answer = o => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(o)) });
      const netErr = () => Promise.reject(new TypeError('Failed to fetch'));
      const curOf = over => {
        const c = {
          sale_start: ['2026-10-13', '', '', ''], sale_end: ['2026-12-06', '', '', ''],
          'budget 2026-10': ['32000', '70', 'Mac O\'Neil "Mac"', '2026-10-15T14:00:00.000Z'], 'budget 2026-11': ['60000', '65', '', ''], 'budget 2026-12': ['', '', '', ''],
          'target google_roas': ['12', '', '', ''], 'target meta_roas': ['12', '', '', ''], 'target mer': ['11.5', '', '<img src=x onerror=alert(1)>', '2026-10-16T13:30:00.000Z'],
        };
        Object.assign(c, over || {});
        const out = {};
        Object.keys(c).forEach(k => { out[k] = { value: c[k][0], value2: c[k][1], who: c[k][2], at: c[k][3] }; });
        return out;
      };
      const ok45 = () => answer({ ok: true, current: curOf({ 'budget 2026-10': ['45000', '60', 'Glen', SAVED_AT] }) });
      const fire = (t, ev, target) => (t.els.content._listeners[ev] || []).forEach(fn => fn({ target }));
      const typeName = (t, name) => fire(t, 'input', { getAttribute: k => (k === 'data-bf' ? 'who' : null), value: name });
      const clickSave = (t, scope) => fire(t, 'click', { closest: () => ({ getAttribute: k => (k === 'data-bf' ? 'save' : k === 'data-v' ? scope : null) }) });
      const bodyOf = (posts, i) => { try { return JSON.parse(posts[i].init.body); } catch (e) { return {}; } };
      const rawMeta = t => String((t.els['bf-budget-meta'] && t.els['bf-budget-meta'].innerHTML) || '');
      const meta = t => rawMeta(t).replace(/<\/?bdi>/g, '');
      const tmeta = t => String((t.els['bf-targets-meta'] && t.els['bf-targets-meta'].innerHTML) || '').replace(/<\/?bdi>/g, '');
      const boot = o => bootBfcm(Object.assign({ now: '2026-10-17T12:00:00.000Z', configWrites: true, endpoint: EP }, o || {}));
      const saveBudget = async (b, v, v2) => { b.V.edit('budget 2026-10', v == null ? 45000 : v, v2 == null ? 60 : v2); typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush(); };
      // the budget inputs as the browser has them, then the input event the person's typing fires
      const budgetInput = (t, which, tot, pct) => { const D = t.documentStub; D.getElementById('bf-budget-total').value = tot; D.getElementById('bf-budget-pct').value = pct; fire(t, 'input', { getAttribute: k => (k === 'data-bf' ? which : null) }); };
      const logWith = (v, v2) => BFX.log.replace(/\n?$/, '\n') + '"3","2026-10-17T11:00:00.000Z","Glen","budget 2026-10","' + v + '","' + v2 + '","00000000-0000-4000-8000-000000000003"\n';
      const PAGE_SRC = fs.readFileSync(PAGE, 'utf8');
      const BF_600 = (PAGE_SRC.match(/@media \(max-width:600px\)\{[^\n]*\.bf-[^\n]*\}/g) || []).join(' ');
      // a focus rig over the stub DOM: document.activeElement inside the view, and a querySelector on the view's container
      // that finds an element by #id or by its [data-*="..."] attributes in the HTML the view last wrote (any patched area)
      const focusRig = b => {
        const D = b.t.documentStub, C = b.t.els.content, els = b.t.els;
        const attrsOf = tag => { const o = { tag: ((/^<(\w+)/.exec(tag) || [])[1] || '').toUpperCase() }; for (const m of tag.matchAll(/\s([\w-]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
        const mk = attrs => ({ __inView: true, tagName: attrs.tag || 'BUTTON', type: attrs.type || '', id: attrs.id || '',
          getAttribute: k => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null), focus() { D.activeElement = this; } });
        C.contains = n => !!(n && n.__inView);
        C.querySelector = sel => {
          const all = Object.keys(els).map(k => String(els[k].innerHTML || '')).join('\n'), tags = all.match(/<[a-z]+\b[^>]*>/g) || [];
          const idm = /^#([\w-]+)$/.exec(sel);
          const pairs = idm ? [['id', idm[1]]] : [...sel.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].map(m => [m[1], m[2]]);
          if (!pairs.length) return null;
          const hit = tags.find(tg => pairs.every(([k, v]) => tg.includes(' ' + k + '="' + v + '"')));
          return hit ? mk(attrsOf(hit)) : null;
        };
        return { focus: attrs => { D.activeElement = mk(attrs); return D.activeElement; }, active: () => D.activeElement };
      };
      const desc = a => (a ? [a.tagName, a.id, a.getAttribute('data-bf'), a.getAttribute('data-v')].join('/') : 'nothing focused');

      // ---- H1: the focused control is focused again after the view rebuilds it (user actions and background repaints)
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const rig = focusRig(b);
        const op = rig.focus({ tag: 'BUTTON', 'data-bf': 'preset', 'data-v': 'last7' });
        fire(b.t, 'click', { closest: () => op });
        let a = rig.active();
        check('H1: a focused preset button, clicked: the view repaints and the same preset button has focus again',
          b.V._state.window.preset === 'last7' && a !== op && !!a && a.getAttribute('data-bf') === 'preset' && a.getAttribute('data-v') === 'last7', desc(a));
        const om = rig.focus({ tag: 'BUTTON', 'data-bf': 'month', 'data-v': '2026-11' });
        fire(b.t, 'click', { closest: () => om });
        a = rig.active();
        check('H1: a focused month button keeps focus after the month change', b.V._state.month === '2026-11' && a !== om && !!a && a.getAttribute('data-bf') === 'month' && a.getAttribute('data-v') === '2026-11', desc(a));
        const ob = rig.focus({ tag: 'BUTTON', 'data-bf': 'basis', 'data-v': 'last14' });
        fire(b.t, 'click', { closest: () => ob });
        a = rig.active();
        check('H1: a focused forecast basis button keeps focus when the forecast panel is rebuilt', b.V._state.sliders.basis === 'last14' && a !== ob && !!a && a.getAttribute('data-bf') === 'basis' && a.getAttribute('data-v') === 'last14', desc(a));
        const orr = rig.focus({ tag: 'BUTTON', 'data-bf': 'reset' });
        fire(b.t, 'click', { closest: () => orr });
        a = rig.active();
        check('H1: a focused Reset button keeps focus after the reset', a !== orr && !!a && a.getAttribute('data-bf') === 'reset', desc(a));
        const od = rig.focus({ tag: 'INPUT', type: 'date', id: 'bf-from', 'data-bf': 'from' });
        b.t.documentStub.getElementById('bf-from').value = '2026-10-05'; b.t.documentStub.getElementById('bf-to').value = '2026-10-12';
        fire(b.t, 'change', { getAttribute: k => (k === 'data-bf' ? 'from' : null) });
        a = rig.active();
        // pass 2 P6: the date inputs are never rebuilt on a pick (an open phone date picker would close), so focus stays on
        // the very same From input and only the window-dependent areas are patched
        check('H1 + pass 2 P6: a date pick applies at once and the From date input itself keeps focus (not rebuilt)', /5 to 12 Oct/.test(String(b.t.els['bf-wl'] && b.t.els['bf-wl'].innerHTML)) && a === od, desc(a));
        const ox = rig.focus({ tag: 'BUTTON', 'data-bf': 'preset', 'data-v': 'sale' }), dv = b.V._state.dataVersion;
        b.bf.daily = b.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","901.00"');
        await b.clock.advance(16 * 60000);
        a = rig.active();
        check('H1: a background refresh that repaints the view restores focus too', b.V._state.dataVersion > dv && b.V._state.paintedVersion === b.V._state.dataVersion && a !== ox && !!a && a.getAttribute('data-bf') === 'preset' && a.getAttribute('data-v') === 'sale', desc(a));
        const ou = rig.focus({ tag: 'SUMMARY', 'data-bf': 'panel', 'data-v': 'days' });
        b.V.setPreset('week');
        a = rig.active();
        check('H1: a focused panel toggle ("Show every day as a table") keeps focus across a repaint', a !== ou && !!a && a.tagName === 'SUMMARY' && a.getAttribute('data-v') === 'days', desc(a));
      }

      // ---- M1: typing only a total never invents a 50/50 split; L10: the split slider waits for a total
      {
        const b = await boot({ bf: { log: logWith('32000', '') }, post: () => answer({ ok: true, current: curOf({ 'budget 2026-10': ['45000', '40', 'Glen', SAVED_AT] }) }) });
        budgetInput(b.t, 'budget-total', '45000', '50');   // the split slider sits at its 50 default because the saved split is blank
        const u = b.V._state.unsaved['budget 2026-10'];
        check('M1: a typed total with a blank saved split keeps the split blank (never a silent 50)', !!u && u.v === 45000 && u.v2 === null, JSON.stringify(u));
        budgetInput(b.t, 'budget-total', '32000', '50');
        check('M1: typing the saved total back clears Unsaved', !b.V._state.unsaved['budget 2026-10'], JSON.stringify(b.V._state.unsaved['budget 2026-10']));
        budgetInput(b.t, 'budget-total', '45000', '50'); typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush();
        check('M1: Save with the split still blank posts nothing and asks for the split', b.posts.length === 0 && /Move the Google \/ Meta split slider to set the split, then save\./.test(meta(b.t)), plain(meta(b.t)).slice(0, 200));
        budgetInput(b.t, 'budget-pct', '45000', '40'); clickSave(b.t, 'budget'); await flush();
        const bd = bodyOf(b.posts, 0);
        check('M1: once the split slider is moved, the save sends that split (expect = the saved total, blank split)',
          b.posts.length === 1 && bd.value === '45000' && bd.value2 === '40' && bd.expect === '32000' && bd.expect2 === '', JSON.stringify(bd));
        const c = await boot({ post: ok45 });
        budgetInput(c.t, 'budget-total', '45000', '50');   // a stale slider value in the DOM never wins over the saved 70
        check('M1: with a saved split (70), a typed total keeps the saved 70', (c.V._state.unsaved['budget 2026-10'] || {}).v2 === 70, JSON.stringify(c.V._state.unsaved['budget 2026-10']));
        // L10
        const d = await boot({});
        d.V.setMonth('2026-12');   // December: no budget set
        const hd = d.html();
        budgetInput(d.t, 'budget-pct', '', '40');
        check('L10: the split slider is ignored while the total is blank (nothing marked Unsaved)', !d.V._state.unsaved['budget 2026-12'], JSON.stringify(d.V._state.unsaved['budget 2026-12']));
        check('L10: the split slider is drawn disabled until a total is typed', /<input id="bf-budget-pct"[^>]*\sdisabled[\s>]/.test(hd), (hd.match(/<input id="bf-budget-pct"[^>]*>/) || ['(none)'])[0]);
      }

      // ---- M2: an edit typed while its own save is in flight is kept when the answer lands
      {
        let release = null;
        const b = await boot({ post: () => new Promise(r => { release = () => r({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, current: curOf({ 'budget 2026-10': ['45000', '60', 'Glen', SAVED_AT] }) })) }); }) });
        await saveBudget(b);
        b.V.edit('budget 2026-10', 47000, 60);   // typed while the 45000 save is in flight
        if (release) release();
        await flush(); await flush();
        const u = b.V._state.unsaved['budget 2026-10'], h = b.html();
        check('M2: the newer edit survives the answer (Unsaved, 47000 in the control, based on the 45000 just saved)',
          b.posts.length === 1 && !!u && u.v === 47000 && u.base === '45000|60' && b.V._state.cfg.budgets['2026-10'].total === 45000 && /data-bf="budget-total"[^>]*value="47000"/.test(h) && /Unsaved/.test(h), JSON.stringify(u));
      }

      // ---- M3: re-saving after "Not confirmed" reuses the rid (a save that did land answers duplicate)
      {
        const run = async (secondValue) => {
          let first = null;
          const b = await boot({ post: (n, init) => {
            const q = JSON.parse(init.body);
            if (n <= 2) { first = first || q.rid; return netErr(); }
            const c = curOf({ 'budget 2026-10': ['45000', '60', 'Glen', SAVED_AT] });
            return answer(q.rid === first ? { ok: true, duplicate: true, current: c } : { ok: false, error: 'changed', current: c });
          } });
          await saveBudget(b); await b.clock.advance(5000); await b.clock.advance(5000);
          const mid = b.html() + meta(b.t);
          if (secondValue) b.V.edit('budget 2026-10', secondValue, 60);
          clickSave(b.t, 'budget'); await flush(); await b.clock.advance(4000);
          return { b, mid };
        };
        const { b, mid } = await run(null);
        check('M3: same values saved again after "Not confirmed": the same rid is sent, so the landed save reads "Saved for everyone"',
          /Not confirmed/.test(mid) && b.posts.length === 3 && bodyOf(b.posts, 2).rid === bodyOf(b.posts, 0).rid && b.html().includes('Saved for everyone · Glen') && !/someone else saved/.test(b.html()),
          `posts=${b.posts.length} rids=${b.posts.map((p, i) => bodyOf(b.posts, i).rid).join(',')} ${(b.html().match(/(Not saved|Saved for everyone)[^<]*/) || ['(none)'])[0]}`);
        const r2 = await run(46000);
        check('M3: a different value after "Not confirmed" gets a new rid', r2.b.posts.length === 3 && bodyOf(r2.b.posts, 2).rid !== bodyOf(r2.b.posts, 0).rid && bodyOf(r2.b.posts, 2).value === '46000');
      }

      // ---- M4: ok with a `current` the page cannot adopt: the saved value is patched in locally
      {
        const b = await boot({ post: () => answer({ ok: true, current: { 'budget 2026-10': { value: '45000', value2: '60', who: 'Glen', at: SAVED_AT } } }) });
        await saveBudget(b);
        const c = b.V._state.cfg, h = b.html();
        check('M4: the new value shows under "Saved for everyone" (not the old one), the rest of the settings untouched',
          c.budgets['2026-10'] && c.budgets['2026-10'].total === 45000 && c.budgets['2026-10'].pct === 60 && /data-bf="budget-total"[^>]*value="45000"/.test(h) && h.includes('Saved for everyone · Glen · 17 Oct, 8:00 am Toronto time') &&
          c.budgets['2026-11'].total === 60000 && c.targets.mer === 11.5 && !/Unsaved/.test(h), JSON.stringify(c.budgets['2026-10']));
      }

      // ---- M5: a config or log tab answered with an HTML page keeps the last good settings
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        b.bf.config = '<!DOCTYPE html><html>Google error</html>';
        await b.clock.advance(16 * 60000);
        const c1 = b.V._state.cfg, h1 = b.html();
        b.bf.config = BFX.config; b.bf.log = '<html>Google error</html>';
        await b.clock.advance(16 * 60000);
        const c2 = b.V._state.cfg, h2 = b.html();
        check('M5: config tab answers HTML: budgets kept, "from the previous load" note, never "could not be read"',
          !c1.error && c1.budgets['2026-10'].total === 32000 && /Budget settings are from the previous load/.test(h1) && !/could not be read/.test(h1), c1.error || '');
        check('M5: log tab answers HTML: the same', !c2.error && c2.budgets['2026-10'].total === 32000 && /Budget settings are from the previous load/.test(h2) && !/could not be read/.test(h2), c2.error || '');
      }

      // ---- M6: save states are announced by one persistent live region; focus comes back to the Save button
      {
        const b = await boot({ post: ok45 });
        const live = b.t.documentStub.getElementById('bf-live'), said = [];
        let txt = '';
        Object.defineProperty(live, 'textContent', { get: () => txt, set: v => { txt = String(v); said.push(txt); }, configurable: true });
        const rig = focusRig(b);
        b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, 'Glen');
        const os = rig.focus({ tag: 'BUTTON', 'data-bf': 'save', 'data-v': 'budget' });
        fire(b.t, 'click', { closest: () => os }); await flush();
        check('M6: one live region in the page (role=status, aria-live=polite), outside the content the view repaints',
          /<div id="bf-live"[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/div>/.test(PAGE_SRC) && PAGE_SRC.indexOf('id="bf-live"') > PAGE_SRC.indexOf('<div id="content"') && !/bf-live/.test(b.html() + meta(b.t)));
        check('M6: the live region announces each save state (October budget: Saving, then Saved for everyone)',
          b.t.documentStub.getElementById('bf-live') === live && said.some(s => /^October budget: Saving/.test(s)) && said.some(s => /^October budget: Saved for everyone · .*Glen.* · 17 Oct, 8:00 am Toronto time$/.test(s)), JSON.stringify(said));
        const a = rig.active();
        check('M6: focus is back on the budget Save button when the save finishes; Save buttons are aria-disabled, never disabled (stay focusable)',
          a !== os && !!a && a.getAttribute('data-bf') === 'save' && a.getAttribute('data-v') === 'budget' && !/<button[^>]*data-bf="save"[^>]*\sdisabled[\s>]/.test(b.html() + rawMeta(b.t)) && /aria-disabled="true"/.test(rawMeta(b.t)), desc(a));
        check('M6: the per-key status lines are not live regions themselves (no double announcement)', !/class="bf-status[^"]*" role="status"/.test(b.html() + rawMeta(b.t)));
      }

      // ---- M7: configWrites on with no endpoint: read-only, no dead button, no "switched on" copy anywhere
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true });
        const h = b.html(), src = fs.readFileSync(path.join(path.dirname(PAGE), 'bfcm-view.js'), 'utf8');
        check('M7: configWrites on, endpoint empty: the read-only budget block (no inputs, no Save button), the "Set by" line shows',
          !/data-bf="budget-total"|data-bf="target"|data-bf="save"/.test(h) && /\$32,000/.test(h) && /Set by Mac/.test(h), plain(h).slice(0, 160));
        check('M7: no "switched on" wording left in the view', !/switched on/i.test(src + h));
      }

      // ---- M8: before any sale day: a neutral note, never the red alert
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', bf: { daily: BFX.daily.split(/\r?\n/)[0] + '\n' } });
        const h = b.html();
        // (pass 2 P1: banners carry no role of their own; #bf-live announces them once)
        check('M8: no sale days yet: "The sale data has not started coming in yet." in a neutral note, not bf-alert',
          /<div class="bf-info">The sale data has not started coming in yet\.<\/div>/.test(h) && !/No sale days/.test(h), plain(h).slice(0, 200));
      }

      // ---- M9: the Sale to date tile spans both columns at phone width
      check('M9: at max-width 600px #bf-t-sale spans both tile columns', /#bf-t-sale\{grid-column:1\/-1\}/.test(BF_600), BF_600.slice(0, 160));

      // ---- M10: Chart.js missing (CDN down): the view opens and says the chart could not load
      {
        const b = await bootBfcm({ open: false });
        delete b.t.sandbox.Chart;
        b.TA.CHANNELS.bfcm.enabled = true;
        let threw = null;
        try { await b.TA.switchChannel('bfcm'); await flush(); } catch (e) { threw = e; }
        const h = b.html();
        check('M10: no Chart.js: the view mounts, the tiles show, and "The chart could not load. The figures above are still correct."',
          !threw && !!b.V._state && b.V._state.mounted && /The chart could not load\. The figures above are still correct\./.test(h) && /x$/.test(tileOf(h, 'google').v) && !/<canvas/.test(h), threw ? String(threw) : plain(h).slice(0, 160));
      }

      // ---- M11: right after a save, an older gviz config does not flip the value back (held 120 s or until gviz catches up)
      {
        const b = await boot({ post: ok45 });
        await saveBudget(b);
        const tot = x => ((x.V._state.cfg.budgets['2026-10'] || {}).total);
        const t0 = tot(b);
        b.bf.daily = b.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","877.00"');   // new data, so the refresh re-reads the (still old) config
        await b.clock.advance(10000); await b.V.refresh(); await flush();
        const held = tot(b), hh = b.html();
        b.bf.daily = b.bf.daily.replace('"2026-10-16","877.00"', '"2026-10-16","878.00"');
        await b.clock.advance(120000); await b.V.refresh(); await flush();
        check('M11: 10 s after the save, an older gviz config keeps the saved 45000 on screen', t0 === 45000 && held === 45000 && /data-bf="budget-total"[^>]*value="45000"/.test(hh), `${t0} -> ${held}`);
        check('M11: after 120 s the sheet is believed again (gviz still says 32000)', tot(b) === 32000, String(tot(b)));
        const c = await boot({ post: ok45 });
        await saveBudget(c);
        c.bf.log = c.bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:00:30.000Z","Maria","budget 2026-10","50000","55","c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"\n';
        await c.clock.advance(40000); await c.V.refresh(); await flush();
        check('M11: a newer save by someone else inside the 120 s shows at once', tot(c) === 50000 && /Set by Maria/.test(c.html()), String(tot(c)));
      }

      // ---- M12: repeated refresh errors back off (15, 15, 30, 60, 60 min), a good refresh resets to 15
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const n = () => bfUrls(b.t.fetchLog).daily, seen = [], more = [];
        b.bf.daily = 'NETWORK-ERROR';
        for (let i = 0; i < 8; i++) { await b.clock.advance(15 * 60000); seen.push(n()); }
        b.bf.daily = BFX.daily;
        for (let i = 0; i < 5; i++) { await b.clock.advance(15 * 60000); more.push(n()); }
        check('M12: after 2 failed refreshes in a row the wait doubles to 30 min, then 60 min (capped)', seen.join() === '2,3,3,4,4,4,4,5', seen.join());
        check('M12: a good refresh resets the wait to 15 minutes', more.join() === '5,5,5,6,7', more.join());
      }

      // ---- L1: after the sale, no stale banners; a neutral "sale has ended" note. Pass 2 P4 moved "final" from sale end + 3
      //      to sale end + 8 (Meta fills in for 7 days), so these two now read the in-between note with the banners
      {
        const b = await bootBfcm({ now: '2026-12-10T18:00:00.000Z' });
        const h = b.html();
        check('L1 + pass 2 P4: on sale end + 4 the stale banners still show, with "The sale has ended. The last few days may still change a little."',
          /data last updated/.test(h) && /uses stale/.test(h) && /<div class="bf-info">The sale has ended\. The last few days may still change a little\.<\/div>/.test(h) && !/final figures/.test(h), plain(h).slice(0, 240));
        const c = await bootBfcm({ now: '2026-12-08T18:00:00.000Z' });
        check('L1 + pass 2 P4: on sale end + 2 days the stale banners still show (late pulls may still land), never "final figures"', /data last updated/.test(c.html()) && !/final figures/.test(c.html()));
      }

      // ---- L3: typed names are isolated with <bdi>; long names wrap
      {
        const r = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const hr = String(r.t.els.content.innerHTML);
        const b = await boot({ post: ok45 });
        await saveBudget(b);
        b.V.edit('budget 2026-10', 46000, 60);
        b.bf.log = b.bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:10:00.000Z","Maria","budget 2026-10","35000","70","c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"\n';
        await b.clock.advance(16 * 60000);
        const hb = String(b.t.els.content.innerHTML) + rawMeta(b.t);
        check('L3: "Set by" and the read-only target lines wrap the name in <bdi>', /Set by <bdi>Mac O&#39;Neil &quot;Mac&quot;<\/bdi>/.test(hr) && /MER target set by <bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/.test(hr), (hr.match(/Set by[^·]*/) || ['(none)'])[0]);
        check('L3: the Newer saved value line wraps the name in <bdi>', /Newer saved value: [^<]*by <bdi>Maria<\/bdi>/.test(hb), (hb.match(/Newer saved value[^<]*(<bdi>[^<]*<\/bdi>)?/) || ['(none)'])[0]);
        const s = await boot({ post: ok45 });
        await saveBudget(s);
        check('L3: the Saved line wraps the name in <bdi>', /Saved for everyone · <bdi>Glen<\/bdi> · 17 Oct/.test(rawMeta(s.t)), rawMeta(s.t).slice(0, 200));
        check('L3: .bf-note and .bf-status wrap long words (overflow-wrap:anywhere)', /\.bf-note\{[^}]*overflow-wrap:anywhere/.test(PAGE_SRC) && /\.bf-status\{[^}]*overflow-wrap:anywhere/.test(PAGE_SRC));
      }

      // ---- L5: the picked month resets when the sale window no longer has it
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        b.V.setMonth('2026-12');
        b.bf.config = b.bf.config.replace('"sale_end","2026-12-06",""', '"sale_end","2026-11-30",""');
        await b.clock.advance(16 * 60000);
        check('L5: sale_end moves to 30 Nov while December is picked: the month resets to the default (October)', b.V._state.cfg.saleEnd === '2026-11-30' && b.V._state.month === '2026-10' && /data-bf="month" data-v="2026-10" aria-pressed="true"/.test(b.html()), b.V._state.month);
      }

      // ---- L6: impossible typed dates are ignored
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        b.V.setCustom('2026-10-02', '2026-02-30');
        check('L6: a custom range with 30 Feb is ignored (the window stays Sale to date)', b.V._state.window.preset === 'sale' && !b.V._state.custom, JSON.stringify(b.V._state.window));
      }

      // ---- L7: the 60 s repaint waits under a focused date input; the alerts still update; focusout runs it
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        b.t.els.content.contains = () => true;
        b.t.documentStub.activeElement = { tagName: 'INPUT', type: 'date', id: 'bf-from', getAttribute: k => (k === 'data-bf' ? 'from' : null) };
        const before = b.html();
        await b.clock.advance(4.5 * 3600000);   // past 16:05Z: the 60 s timer sees Meta turn stale; the sheet itself does not change
        const al = String((b.t.els['bf-alerts'] && b.t.els['bf-alerts'].innerHTML) || '');
        check('L7: a focused date input holds the 60 s repaint (the input is not rebuilt under the person)', b.html() === before && b.V._state.pendingPaint === true);
        check('L7: the alerts area still gets the stale banner meanwhile', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(al), al.slice(0, 160));
        b.t.documentStub.activeElement = null;
        fire(b.t, 'focusout', {}); await b.clock.advance(1);
        check('L7: when focus leaves, the held repaint runs', /Meta data last updated 16 Oct/.test(b.html()) && b.V._state.pendingPaint === false);
      }

      // ---- L8: an older refresh that answers after a newer one is ignored
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const real = b.t.sandbox.fetch, gates = [];
        b.t.sandbox.fetch = (u, i) => { const p = real(u, i); return new Promise(r => gates.push(() => r(p))); };
        const slow = b.V.refresh();   // reads the old sheet; its answers are held back
        b.t.sandbox.fetch = real;
        b.bf.daily = b.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","999.00"');
        await b.V.refresh(); await flush();
        const fresh = /\$999/.test(b.html());
        gates.forEach(g => g()); await slow; await flush();
        check('L8: the late, older refresh does not overwrite the newer figures', fresh && /\$999/.test(b.html()) && gates.length === 3, `fresh=${fresh} gates=${gates.length}`);
      }

      // ---- L9: an out-of-range target says so beside it, is never posted, and never drives the maths
      {
        const b = await boot({ post: () => answer({ ok: true, current: curOf() }) });
        b.V.edit('target mer', 99);
        check('L9: a target typed outside 1..50 shows "Target must be between 1 and 50"', /MER: Target must be between 1 and 50/.test(tmeta(b.t)), plain(tmeta(b.t)).slice(0, 200));
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush();
        check('L9: the out-of-range target is never posted', b.posts.length === 0);
        b.V.setPreset('last7');
        const h = b.html(), ch = b.t.createdCharts.filter(c => !c.destroyed)[0];
        check('L9: an unsaved target never drives the tiles or the chart (MER target stays 11.5)', /target 11\.5x/.test(tileOf(h, 'mer').s) && !!ch && ch.config.data.datasets[5].data.every(v => v === 11.5));
      }

      // ---- L11: transient refusals keep the typed edit; changed / invalid / log full revert
      for (const [err, keep] of [['busy', true], ['closed', true], ['changed', false], ['invalid', false], ['log full', false]]) {
        const b = await boot({ post: () => answer(Object.assign({ ok: false, error: err }, err === 'changed' ? { current: curOf() } : {}, err === 'invalid' ? { field: 'value', reason: 'bad value' } : {})) });
        await saveBudget(b);
        const h = b.html();
        if (keep) check(`L11: "${err}" keeps the typed edit (45000, Unsaved) and says "Not saved: ... Nothing changed."`, /data-bf="budget-total"[^>]*value="45000"/.test(h) && /Unsaved/.test(h) && /Not saved: [^<]+\. Nothing changed\./.test(h), (h.match(/Not saved[^<]*/) || ['(none)'])[0]);
        else check(`L11: "${err}" reverts the control to the saved value (32000)`, /data-bf="budget-total"[^>]*value="32000"/.test(h) && !/Unsaved/.test(h) && /Not saved: [^<]+\. Nothing changed\./.test(h));
      }

      // ---- L12: keyboard-reachable scrolling regions, role=status on loading + config error, 40 px targets on phones
      {
        const b = await bootBfcm({ open: false });
        b.TA.CHANNELS.bfcm.enabled = true;
        const p = b.TA.switchChannel('bfcm');
        const loading = b.html();
        await p; await flush();
        const h = b.html();
        const e = await bootBfcm({ bf: { config: '<html>not a csv</html>' } });
        check('L12: the chart scroll box and both tables are focusable labelled regions',
          /<div class="bf-chartscroll" id="bf-chartscroll" tabindex="0" role="region" aria-label="[^"]+">/.test(h) && (h.match(/<div class="bf-tw" id="[\w-]+" tabindex="0" role="region" aria-label="[^"]+">/g) || []).length === 2);
        // pass 2 P1: the config-error alert is repainted with the view, so it no longer carries a role (#bf-live says it once)
        check('L12 + pass 2 P1: the loading text is role=status; the config-error alert shows without a role of its own', /<div class="loading" role="status">/.test(loading) && /<div class="bf-alert">Budget settings could not be read/.test(e.html()), loading.slice(0, 120));
        check('L12: at phone width .bf-pre and .bf-save are at least 40 px tall', /\.bf-pre,\.bf-save\{min-height:40px\}/.test(BF_600), BF_600.slice(0, 200));
      }

      // ---- L14: the channel row and its hint follow the enabled channels, not Meta / Total MER alone
      {
        const off = [["key:'meta', label:'Meta Ads', enabled:true", "key:'meta', label:'Meta Ads', enabled:false"], ["key:'mer', label:'Total MER', enabled:true", "key:'mer', label:'Total MER', enabled:false"]];
        const BFCM_OFF_PATCH = code.includes(BFCM_ON[1]) ? [[BFCM_ON[1], BFCM_ON[0]]] : [];
        const t = bootPage(csv, metaCsv, merCsv, { clock: makeClock('2026-10-17T18:00:00.000Z'), patch: off.concat(BFCM_ON_PATCH) });
        await flush(); await flush();
        const row = t.els.channelrow, hint = (t.els.channelhint && t.els.channelhint.textContent) || '';
        check('L14: Google + BFCM only: the channel row shows and the hint counts two views', row.style.display !== 'none' && row.style.visibility === 'visible' && hint === 'Two views, one report. BFCM 2026 follows the sale day by day.', `display=${row.style.display} visibility=${row.style.visibility} hint=${hint}`);
        const u = bootPage(csv, metaCsv, merCsv, { clock: makeClock('2026-10-17T18:00:00.000Z'), patch: off.concat(BFCM_OFF_PATCH) });
        await flush(); await flush();
        check('L14: Google alone: the channel row stays hidden', u.els.channelrow.style.display === 'none');
      }

      // ============================================================ /check-deep pass 2 fixes (each check failed first)
      section('bfcm check-deep fixes (pass 2)');
      // every text #bf-live is given, in order (a spy on its textContent, installed before the view opens when needed)
      const spyLive = b => {
        const live = b.t.documentStub.getElementById('bf-live'), said = [];
        let txt = '';
        Object.defineProperty(live, 'textContent', { get: () => txt, set: v => { txt = String(v); if (txt) said.push(txt); }, configurable: true });
        return said;
      };
      // a click on a [data-bf] element with these attributes (aria-disabled included)
      const clickAttrs = (t, attrs) => { const n = { tagName: 'BUTTON', getAttribute: k => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null) }; n.closest = () => n; fire(t, 'click', n); return n; };
      const saveBtnOf = s => (String(s).match(/<button[^>]*data-bf="save"[^>]*>[^<]*<\/button>/g) || []);
      const openNow = async b => { b.TA.CHANNELS.bfcm.enabled = true; await b.TA.switchChannel('bfcm'); await flush(); };

      // ---- P1: banners carry no live-region role (every repaint re-inserts them); #bf-live says each one once
      {
        const b = await bootBfcm({ now: '2026-10-17T18:00:00.000Z', open: false });
        const said = spyLive(b);
        await openNow(b);
        const h0 = b.html();
        b.V.setPreset('last7'); b.V.setPreset('sale'); b.V.setMonth('2026-11'); b.V.setMonth('2026-10');
        await b.clock.advance(5 * 60000);   // five 60 s ticks
        const metaSaid = () => said.filter(s => /Meta data last updated/.test(s)).length;
        check('P1: banners have no role (alert / status) of their own', /Meta data last updated/.test(h0) && !/<div class="bf-(alert|stale|info)" role=/.test(h0 + b.html()), (h0.match(/<div class="bf-(alert|stale|info)"[^>]*>/g) || []).join(' '));
        check('P1: a banner is announced once when it appears, never again on later repaints or ticks', metaSaid() === 1 && said.some(s => /Meta data last updated 16 Oct, 6:05 am Toronto time\./.test(s)), JSON.stringify(said));
        b.bf.daily = b.bf.daily.split('2026-10-16T10:05:00.000Z').join('2026-10-16T11:05:00.000Z');   // a newer Meta pull, still over 30 h old
        await b.clock.advance(16 * 60000);
        check('P1: a banner whose words change is announced again, once', metaSaid() === 2 && said.some(s => /Meta data last updated 16 Oct, 7:05 am/.test(s)), JSON.stringify(said));
        const e = await bootBfcm({ bf: { config: '<html>not a csv</html>' }, open: false });
        const es = spyLive(e);
        await openNow(e);
        check('P1: the config-error alert has no role either, and is announced once', /<div class="bf-alert">Budget settings could not be read/.test(e.html()) && es.filter(s => /Budget settings could not be read/.test(s)).length === 1, JSON.stringify(es));
      }
      {
        // a held repaint (a config field has focus) rewrites the alerts area only when its banners change
        const b = await boot({});
        b.t.els.content.contains = () => true;
        b.t.documentStub.activeElement = { tagName: 'INPUT', type: 'number', getAttribute: k => (k === 'data-bf' ? 'budget-total' : null) };
        const al = b.t.documentStub.getElementById('bf-alerts');
        let writes = 0, inner = '';
        Object.defineProperty(al, 'innerHTML', { get: () => inner, set: v => { writes++; inner = String(v); }, configurable: true });
        b.bf.daily = b.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","880.00"'); await b.clock.advance(16 * 60000);
        b.bf.daily = b.bf.daily.replace('"2026-10-16","880.00"', '"2026-10-16","884.00"'); await b.clock.advance(16 * 60000);
        check('P1: a held repaint skips the alerts area when its banners are unchanged', writes === 1 && /Newer figures have loaded/.test(inner) && b.V._state.pendingPaint === true, `writes=${writes}`);
        b.t.documentStub.activeElement = null;
      }

      // ---- P2: pressing an aria-disabled Save says why
      {
        const b = await boot({ post: ok45 });
        const said = spyLive(b);
        b.V.edit('target mer', 99);
        clickAttrs(b.t, { 'data-bf': 'save', 'data-v': 'targets', 'aria-disabled': 'true' }); await flush();
        check('P2: an aria-disabled Save names the first thing blocking it ("MER target: Target must be between 1 and 50")', said[said.length - 1] === 'MER target: Target must be between 1 and 50' && b.posts.length === 0, JSON.stringify(said));
        clickAttrs(b.t, { 'data-bf': 'save', 'data-v': 'budget', 'aria-disabled': 'true' }); await flush();
        check('P2: an aria-disabled Save with nothing unsaved says "Nothing to save"', said[said.length - 1] === 'Nothing to save' && b.posts.length === 0, JSON.stringify(said));
      }

      // ---- P3: only the DAILY feed's failures slow the refresh
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const n = () => bfUrls(b.t.fetchLog).daily, seen = [];
        b.bf.config = 'NETWORK-ERROR';
        for (let i = 0; i < 3; i++) { await b.clock.advance(15 * 60000); seen.push(n()); }
        b.bf.config = BFX.config; b.bf.log = '<html>Google error</html>';
        for (let i = 0; i < 3; i++) { await b.clock.advance(15 * 60000); seen.push(n()); }
        check('P3: failing config / log tabs never slow the daily refresh (every 15 minutes)', seen.join() === '2,3,4,5,6,7' && b.V._state.errStreak === 0, seen.join());
      }

      // ---- P4: "final" only from sale end + 8 (Meta fills in for 7 days); in between a softer note and the banners
      {
        const ENDED = /<div class="bf-info">The sale has ended\. The last few days may still change a little\.<\/div>/;
        const FINAL = /<div class="bf-info">The sale has ended\. These are the final figures\.<\/div>/;
        const days = {};
        for (const [k, iso] of [['last', '2026-12-06T18:00:00.000Z'], ['p1', '2026-12-07T18:00:00.000Z'], ['p3', '2026-12-09T18:00:00.000Z'], ['p7', '2026-12-13T18:00:00.000Z'], ['p8', '2026-12-14T18:00:00.000Z']]) days[k] = (await bootBfcm({ now: iso })).html();
        check('P4: sale end + 1 to + 7: "The sale has ended. The last few days may still change a little." and the stale banners and marks still show',
          ['p1', 'p3', 'p7'].every(k => ENDED.test(days[k]) && !FINAL.test(days[k]) && /data last updated/.test(days[k]) && /uses stale/.test(days[k])), ['p1', 'p3', 'p7'].map(k => k + ':' + ENDED.test(days[k]) + '/' + FINAL.test(days[k])).join(' '));
        check('P4: from sale end + 8: "These are the final figures." and no stale banners or marks', FINAL.test(days.p8) && !ENDED.test(days.p8) && !/data last updated|data has not loaded yet|uses stale/.test(days.p8), plain(days.p8).slice(0, 200));
        check('P4: on the last sale day neither note shows', !/The sale has ended/.test(days.last));
      }

      // ---- P5: the edit controls end with the sale
      {
        const b = await boot({ now: '2026-12-14T18:00:00.000Z', post: ok45 });
        const h = b.html();
        check('P5: from sale end + 8 the budget block is read-only even with saving on (no inputs, no Save, edit() refused)',
          !/data-bf="(budget-total|budget-pct|target|save|who)"/.test(h) && /No budget set|\$/.test(h) && b.V.edit('budget 2026-12', 1000, 50) === false && b.V.edit('target mer', 10) === false, plain(h).slice(0, 200));
        const c = await boot({ now: '2026-12-13T18:00:00.000Z' });
        check('P5: until then the edit controls stay', /data-bf="budget-total"/.test(c.html()) && /data-bf="save"/.test(c.html()));
      }

      // ---- P6: a date change never rebuilds the From / To inputs (a phone date picker closes when its input is replaced)
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const rig = focusRig(b), C0 = b.t.els.content;
        let rebuilt = 0, inner = String(C0.innerHTML);
        Object.defineProperty(C0, 'innerHTML', { get: () => inner, set: v => { rebuilt++; inner = String(v); }, configurable: true });
        const od = rig.focus({ tag: 'INPUT', type: 'date', id: 'bf-from', 'data-bf': 'from' });
        b.t.documentStub.getElementById('bf-from').value = '2026-10-05'; b.t.documentStub.getElementById('bf-to').value = '2026-10-12';
        fire(b.t, 'change', { getAttribute: k => (k === 'data-bf' ? 'from' : null) });
        const g = id => String((b.t.els[id] && b.t.els[id].innerHTML) || '');
        const ch = b.t.createdCharts.filter(c => !c.destroyed);
        check('P6: a date change keeps the same From input (the view is not rebuilt) and patches the window-dependent areas',
          rebuilt === 0 && rig.active() === od && b.V._state.window.from === '2026-10-05' && b.V._state.window.to === '2026-10-12' &&
          /5 to 12 Oct · 8 days/.test(g('bf-wl')) && !/aria-pressed="true"/.test(g('bf-presets')) && /data-bf="preset"/.test(g('bf-presets')) &&
          /2 · Returns/.test(g('bf-ret')) && /5 to 11 Oct/.test(g('bf-ret')) && ch.length === 1 && ch[0].config.data.labels.length === 8,
          `rebuilt=${rebuilt} same=${rig.active() === od} wl=${plain(g('bf-wl'))} charts=${ch.length} labels=${ch[0] ? ch[0].config.data.labels.length : '-'}`);
        b.t.documentStub.getElementById('bf-from').value = '2026-10-20';   // past the last day of data
        fire(b.t, 'change', { getAttribute: k => (k === 'data-bf' ? 'from' : null) });
        check('P6: the patched window still follows the swap / clamp rules (12 to 16 Oct)', rebuilt === 0 && b.V._state.window.from === '2026-10-12' && b.V._state.window.to === '2026-10-16' && /12 to 16 Oct/.test(g('bf-wl')), JSON.stringify(b.V._state.window));
        b.t.documentStub.activeElement = null;
        b.V.setPreset('last7');
        check('P6: a preset (no date input focused) still repaints the whole view', rebuilt === 1 && /aria-pressed="true">Last 7 days/.test(b.html()));
      }

      // ---- P7: only the endpoint's editable months can be edited; other sale months are read-only "Set in the sheet"
      {
        const jan = BFX.config.replace('"sale_end","2026-12-06",""', '"sale_end","2027-01-10",""').replace(/\n?$/, '\n') + '"budget 2027-01","20000","50"\n';
        const srvCur = curOf({ sale_end: ['2027-01-10', '', '', ''], 'budget 2026-11': ['61000', '65', 'Maria', '2026-10-17T11:58:00.000Z'], 'target mer': ['10', '', 'Glen', SAVED_AT] });
        const b = await boot({ bf: { config: jan }, post: () => answer({ ok: true, current: srvCur }) });
        b.V.setMonth('2027-01');
        const h = b.html();
        check('P7: January 2027 (a sale month outside the editable set) shows its budget read-only with "Set in the sheet"; targets and name stay editable',
          b.V._state.month === '2027-01' && !/data-bf="budget-total"|data-bf="budget-pct"/.test(h) && /\$20,000/.test(h) && /Set in the sheet/.test(h) && /data-bf="target"/.test(h) && /data-bf="who"/.test(h) && !/data-bf="save" data-v="budget"/.test(h), plain(h).slice(0, 260));
        check('P7: edit() refuses January 2027', b.V.edit('budget 2027-01', 25000, 50) === false && !b.V._state.unsaved['budget 2027-01']);
        b.V.edit('target mer', 10); typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush();
        const c = b.V._state.cfg;
        check('P7: an ok answer with the three editable months is adopted (Maria\'s November 61000 shows) and January\'s sheet budget is kept',
          b.posts.length === 1 && c.targets.mer === 10 && c.budgets['2026-11'] && c.budgets['2026-11'].total === 61000 && c.budgets['2027-01'] && c.budgets['2027-01'].total === 20000 && c.budgets['2027-01'].pct === 50, JSON.stringify(c.budgets));
        const viewSrc = fs.readFileSync(path.join(path.dirname(PAGE), 'bfcm-view.js'), 'utf8');
        const pm = /PAGE_EDITABLE_BUDGET_MONTHS = (\[[^\]]*\])/.exec(viewSrc);
        const gsFile = path.resolve(REPO_DIR, '../../clients/apollo-scooters/apps-script/bfcm-config.gs');
        let gsMonths = null;
        try { const ek = /var EDITABLE_KEYS = (\[[^\]]*\])/.exec(fs.readFileSync(gsFile, 'utf8')); gsMonths = JSON.parse(ek[1].replace(/'/g, '"')).filter(k => /^budget /.test(k)).map(k => k.slice(7)); } catch (e) { gsMonths = null; }
        const pageMonths = pm ? JSON.parse(pm[1].replace(/'/g, '"')) : null;
        check('P7: PAGE_EDITABLE_BUDGET_MONTHS is 2026-10..12' + (gsMonths ? ' and equals the endpoint\'s EDITABLE_KEYS budgets' : ' (endpoint file not found: cross-check skipped)'),
          !!pageMonths && pageMonths.join() === '2026-10,2026-11,2026-12' && (!gsMonths || gsMonths.join() === pageMonths.join()), JSON.stringify({ pageMonths, gsMonths }));
      }

      // ---- P8: the name is cleaned as the endpoint cleans it, before posting; a refusal about who / rid never reverts
      {
        for (const [typed, sent] of [['=Glen', 'Glen'], ["  '@+- Priya ", 'Priya'], ['Ann\u0007e', 'Anne']]) {
          const b = await boot({ post: ok45 });
          b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, typed); clickSave(b.t, 'budget'); await flush();
          check('P8: the name ' + JSON.stringify(typed) + ' is posted as the endpoint keeps it (' + JSON.stringify(sent) + ')', b.posts.length === 1 && bodyOf(b.posts, 0).who === sent, JSON.stringify(bodyOf(b.posts, 0).who));
        }
        for (const typed of ['==', " '@ -", '\u0001\u0002']) {
          const b = await boot({ post: ok45 });
          b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, typed); clickSave(b.t, 'budget'); await flush();
          check('P8: a name the endpoint strips to nothing (' + JSON.stringify(typed) + ') is never posted; the name message shows, the edit stays', b.posts.length === 0 && /Type your name in the box above, then save\./.test(meta(b.t)) && /Unsaved/.test(meta(b.t)), plain(meta(b.t)).slice(0, 160));
        }
        for (const field of ['who', 'rid']) {
          const b = await boot({ post: () => answer({ ok: false, error: 'invalid', field, reason: field === 'who' ? 'please type your name' : 'the request ID was not valid' }) });
          await saveBudget(b);
          const h = b.html();
          check('P8: an invalid answer about the ' + field + ' keeps the typed edit (45000, Unsaved)', /data-bf="budget-total"[^>]*value="45000"/.test(h) && /Unsaved/.test(h) && /Not saved: [^<]+\. Nothing changed\./.test(h), (h.match(/Not saved[^<]*/) || ['(none)'])[0]);
        }
      }

      // ---- P9: a 200 that cannot be read (wrong header, empty, truncated) never replaces good figures or settings
      {
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        b.bf.config = '"Foo","Bar"\n"x","y"\n';
        await b.clock.advance(16 * 60000);
        const c1 = b.V._state.cfg, h1 = b.html();
        check('P9: a config tab answering 200 with the wrong header keeps the last good settings ("from the previous load")', !c1.error && c1.budgets['2026-10'].total === 32000 && /Budget settings are from the previous load/.test(h1) && !/could not be read/.test(h1), c1.error || plain(h1).slice(0, 120));
        b.bf.config = BFX.config; b.bf.log = '';
        await b.clock.advance(16 * 60000);
        const c2 = b.V._state.cfg, h2 = b.html();
        check('P9: an empty log tab (200) keeps them too', !c2.error && c2.targets.mer === 11.5 && /Budget settings are from the previous load/.test(h2), c2.error || '');
        b.bf.log = BFX.log;
        await b.clock.advance(16 * 60000);
        check('P9: once the tabs read again the note goes', !/from the previous load/.test(b.html()) && b.V._state.cfgKept === false);
        b.bf.daily = BFX.daily.split(/\r?\n/)[0] + '\n"2026-10-01","617.25"\n';   // a truncated answer: the header, then one cut-off row
        await b.clock.advance(16 * 60000);
        const h3 = b.html(), t1 = b.V._state.lastOkAt;
        check('P9: a daily tab answering 200 that cannot be read keeps the last good rows and says the refresh did not load',
          b.V._state.rows.length === 16 && /The latest refresh did not load/.test(h3) && !/needs attention/.test(h3) && /x$/.test(tileOf(h3, 'google').v), `rows=${b.V._state.rows.length} ${plain(h3).slice(0, 160)}`);
        await b.clock.advance(16 * 60000);   // the same unreadable answer again
        check('P9: the same unreadable answer again does not move the "from the load at" time', b.V._state.lastOkAt === t1 && b.V._state.fetchError === 'refresh', `${t1} -> ${b.V._state.lastOkAt}`);
      }

      // ---- P10: budget totals and splits the endpoint would refuse are named beside the control and never posted
      {
        for (const [v, v2, re] of [['', 60, /Type a budget between 0 and 500,000/], [-5, 60, /Type a budget between 0 and 500,000/], [600000, 60, /Type a budget between 0 and 500,000/],
          [45000.5, 60, /Use whole dollars for the budget/], [45000, 101, /The Google share must be a whole number from 0 to 100/], [45000, 33.5, /The Google share must be a whole number from 0 to 100/]]) {
          const b = await boot({ post: ok45 });
          b.V.edit('budget 2026-10', v, v2); typeName(b.t, 'Glen'); clickSave(b.t, 'budget'); await flush();
          const m = meta(b.t), btn = saveBtnOf(m);
          check('P10: budget ' + JSON.stringify([v, v2]) + ' is named beside the control, Save stays aria-disabled, nothing posted', b.posts.length === 0 && re.test(m) && btn.length === 1 && /aria-disabled="true"/.test(btn[0]), plain(m).slice(0, 200));
        }
      }

      // ---- P11: a re-used rid answered busy / closed on its FIRST try is still unknown (attempt 1 may be committing)
      for (const err of ['busy', 'closed']) {
        let first = null;
        const b = await boot({ post: (n, init) => {
          const q = JSON.parse(init.body);
          if (n <= 2) { first = first || q.rid; return netErr(); }
          if (n === 3) return answer({ ok: false, error: err });
          const c = curOf({ 'budget 2026-10': ['45000', '60', 'Glen', SAVED_AT] });
          return answer(q.rid === first ? { ok: true, duplicate: true, current: c } : { ok: false, error: 'changed', current: c });
        } });
        await saveBudget(b); await b.clock.advance(5000); await b.clock.advance(5000);
        clickSave(b.t, 'budget'); await flush(); await b.clock.advance(4000);
        const mid = b.html() + meta(b.t), pr = b.V._state.pendingRid['budget 2026-10'];
        check('P11: a re-used rid answered "' + err + '" on its first try: "Not confirmed", the rid kept, never "Nothing changed"',
          b.posts.length === 3 && bodyOf(b.posts, 2).rid === first && /Not confirmed/.test(mid) && /Unconfirmed/.test(mid) && !/Nothing changed/.test(mid) && !!pr && pr.rid === first, `posts=${b.posts.length} ${(mid.match(/(Not saved|Not confirmed)[^<]*/) || ['(none)'])[0]}`);
        clickSave(b.t, 'budget'); await flush(); await b.clock.advance(4000);
        check('P11: (' + err + ') the next save reuses it again, and the save that did land reads "Saved for everyone"', b.posts.length === 4 && bodyOf(b.posts, 3).rid === first && b.html().includes('Saved for everyone · Glen'), `posts=${b.posts.length}`);
      }

      // ---- LOW
      {
        // L1: leaving the view clears #bf-live (unmount), and closeBfcm clears it too (even if the view script did not load)
        const b = await boot({ post: ok45 });
        await saveBudget(b);
        const live = b.t.documentStub.getElementById('bf-live'), before = String(live.textContent);
        await b.TA.switchChannel('google'); await flush();
        check('L1 (pass 2): leaving the BFCM view clears #bf-live', /Saved for everyone/.test(before) && live.textContent === '', JSON.stringify([before, live.textContent]));
        check('L1 (pass 2): closeBfcm clears #bf-live itself', /function closeBfcm\(\)\{[^]*?getElementById\('bf-live'\)[^]*?textContent=''[^]*?\n\}/.test(PAGE_SRC));
      }
      check('L2 (pass 2): .bf-stale sits on its own CSS line', /\n  \.bf-stale\{border:1px solid var\(--sale-line\)/.test(PAGE_SRC) && !/\}[ \t]+\.bf-stale\{border/.test(PAGE_SRC));
      {
        // L3: a save of several targets is announced once, and asks for the name once
        const srv = {};
        const b = await boot({ post: (n, init) => { const q = JSON.parse(init.body); srv[q.key] = [q.value, '', q.who, SAVED_AT]; return answer({ ok: true, current: curOf(srv) }); } });
        const said = spyLive(b);
        b.V.edit('target google_roas', 11); b.V.edit('target meta_roas', 13); b.V.edit('target mer', 10);
        typeName(b.t, '  '); clickSave(b.t, 'targets'); await flush();
        check('L3 (pass 2): no name on a save of three targets: ONE name line and one announcement', b.posts.length === 0 && (tmeta(b.t).match(/Type your name in the box above, then save\./g) || []).length === 1 && said.filter(s => /Type your name/.test(s)).length === 1, JSON.stringify(said) + ' ' + plain(tmeta(b.t)).slice(0, 200));
        said.length = 0;
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush();
        for (let i = 0; i < 3; i++) await b.clock.advance(4000);
        check('L3 (pass 2): the save of three targets is announced once ("Saving 3 targets…"), then each outcome', said[0] === 'Saving 3 targets…' && said.filter(s => /Saving/.test(s)).length === 1 && said.filter(s => /Saved for everyone/.test(s)).length === 3 && !/Type your name/.test(tmeta(b.t)), JSON.stringify(said));
      }
      {
        // L4: an in-flight Save reads "Saving…"; aria-disabled is at least .7 opaque
        let release = null;
        const b = await boot({ post: () => new Promise(r => { release = () => r({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, current: curOf({ 'budget 2026-10': ['45000', '60', 'Glen', SAVED_AT] }) })) }); }) });
        await saveBudget(b);
        const mid = saveBtnOf(meta(b.t));
        if (release) release();
        await flush(); await flush();
        const after = saveBtnOf(meta(b.t));
        check('L4 (pass 2): while its save is in flight the Save button reads "Saving…" (aria-disabled); "Save for everyone" after', mid.length === 1 && />Saving…</.test(mid[0]) && /aria-disabled="true"/.test(mid[0]) && after.length === 1 && />Save for everyone</.test(after[0]), mid.join() + ' | ' + after.join());
        check('L4 (pass 2): an aria-disabled Save keeps opacity .7 or more', /\.bf-save\[disabled\],\.bf-save\[aria-disabled="true"\]\{opacity:(0?\.[7-9]\d*|1)[;}]/.test(PAGE_SRC), (PAGE_SRC.match(/\.bf-save\[disabled\][^\n]*/) || [''])[0]);
      }
      {
        // L5: the disabled split slider says why
        const d = await boot({});
        d.V.setMonth('2026-12');
        const h = d.html(), sl = (h.match(/<input id="bf-budget-pct"[^>]*>/) || [''])[0];
        check('L5 (pass 2): with no total the disabled split slider is described by "Type a total to set the split."', /\sdisabled[\s>]/.test(sl) && /aria-describedby="bf-split-hint"/.test(sl) && /<div class="bf-note" id="bf-split-hint">Type a total to set the split\.<\/div>/.test(h), sl);
        const hint = d.t.documentStub.getElementById('bf-split-hint'), pctEl = d.t.documentStub.getElementById('bf-budget-pct');
        hint.hidden = false; pctEl.removed = []; pctEl.removeAttribute = k => pctEl.removed.push(k);
        budgetInput(d.t, 'budget-total', '1000', '50');
        check('L5 (pass 2): typing a total wakes the slider and hides the hint', pctEl.disabled === false && hint.hidden === true && pctEl.removed.includes('aria-describedby'), JSON.stringify({ disabled: pctEl.disabled, hidden: hint.hidden, removed: pctEl.removed }));
        const c = await boot({});
        check('L5 (pass 2): with a total the hint is there but hidden, and the slider has no description', /<div class="bf-note" id="bf-split-hint" hidden>/.test(c.html()) && !/<input id="bf-budget-pct"[^>]*aria-describedby/.test(c.html()));
      }
      check('L6 (pass 2): at phone width BFCM inputs are at least 40 px tall and the panel toggles get 8 px padding', /\.bf input\{min-height:40px\}/.test(BF_600) && /\.bf summary\{padding:8px 0\}/.test(BF_600), BF_600.slice(0, 300));
      {
        // L8: the freshness line says when the refresh has slowed down
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z' });
        const fr = () => String((b.t.els['bf-fresh'] && b.t.els['bf-fresh'].innerHTML) || '');
        b.bf.daily = 'NETWORK-ERROR';
        await b.clock.advance(15 * 60000);
        const one = b.html();
        await b.clock.advance(15 * 60000);
        check('L8 (pass 2): after 2 failed daily refreshes in a row the freshness line adds "(slower while the sheet is not answering)"', !/slower while/.test(one) && /Refreshes every 15 minutes while this page is open \(slower while the sheet is not answering\)\./.test(fr()), plain(fr()).slice(0, 200));
        b.bf.daily = BFX.daily;
        await b.clock.advance(30 * 60000);
        check('L8 (pass 2): a good refresh takes it away', b.V._state.errStreak === 0 && !/slower while/.test(b.html()), String(b.V._state.errStreak));
      }
      {
        // L9: a blank saved split is never a silent 50
        const b = await boot({ bf: { log: logWith('32000', '') } });
        const sl = (b.html().match(/<input id="bf-budget-pct"[^>]*>/) || [''])[0];
        check('L9 (pass 2): a blank saved split: the slider says "Split not set" (aria-valuetext) and the split line says so', /aria-valuetext="Split not set"/.test(sl) && /Google \/ Meta split not set/.test(b.html()), sl);
        const pctEl = b.t.documentStub.getElementById('bf-budget-pct');
        pctEl.removed = []; pctEl.removeAttribute = k => pctEl.removed.push(k);
        budgetInput(b.t, 'budget-pct', '32000', '40');
        check('L9 (pass 2): moving the slider gives it a real value (the "Split not set" text is removed)', pctEl.removed.includes('aria-valuetext') && (b.V._state.unsaved['budget 2026-10'] || {}).v2 === 40, JSON.stringify(pctEl.removed));
        const c = await boot({});
        check('L9 (pass 2): a saved split has no "Split not set" text', !/aria-valuetext/.test(c.html()));
      }
      {
        // L10: after "Not confirmed", a refresh showing the typed value settles it
        const b = await boot({ post: () => netErr() });
        await saveBudget(b); await b.clock.advance(5000); await b.clock.advance(5000);
        const mid = meta(b.t);
        b.bf.log = b.bf.log.replace(/\n?$/, '\n') + '"3","2026-10-17T12:00:01.000Z","Glen","budget 2026-10","45000","60","f0000000-0000-4000-8000-000000000001"\n';
        await b.clock.advance(16 * 60000);
        const h = b.html();
        check('L10 (pass 2): after "Not confirmed", a refresh that shows the typed value drops the Unconfirmed badge ("Set by Glen")',
          /Unconfirmed/.test(mid) && !/Unconfirmed|Unsaved|Not confirmed/.test(h) && /Set by Glen/.test(h) && !b.V._state.unsaved['budget 2026-10'] && !b.V._state.pendingRid['budget 2026-10'], plain(h.slice(h.indexOf('1 · Budget'), h.indexOf('2 · Returns'))).slice(0, 240));
        const c = await boot({ post: () => netErr() });
        await saveBudget(c); await c.clock.advance(5000); await c.clock.advance(5000);
        c.bf.daily = c.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","877.00"');   // new data, the saved value still the old one
        await c.clock.advance(16 * 60000);
        check('L10 (pass 2): a refresh that still shows the old value keeps Unconfirmed', /Unconfirmed/.test(c.html()) && !!c.V._state.unsaved['budget 2026-10']);
      }
      {
        // L11: a held repaint does not run between focus leaving a field and the click on a button
        const b = await boot({ post: ok45 });
        b.t.els.content.contains = () => true;
        b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, 'Glen');
        b.t.documentStub.activeElement = { tagName: 'INPUT', type: 'number', getAttribute: k => (k === 'data-bf' ? 'budget-total' : null) };
        b.bf.daily = b.bf.daily.replace('"2026-10-16","876.00"', '"2026-10-16","881.00"');
        await b.clock.advance(16 * 60000);
        const held = b.V._state.pendingPaint === true;
        const btn = { tagName: 'BUTTON', getAttribute: k => (k === 'data-bf' ? 'save' : k === 'data-v' ? 'budget' : null) };
        btn.closest = () => btn;
        b.t.documentStub.activeElement = btn;
        (b.t.els.content._listeners.focusout || []).forEach(fn => fn({ target: {}, relatedTarget: btn }));
        await b.clock.advance(1);
        const stillHeld = b.V._state.pendingPaint === true;
        fire(b.t, 'click', btn); await flush(); await b.clock.advance(1);   // the held repaint runs just after the click (setTimeout 0)
        check('L11 (pass 2): focus leaving a field for a [data-bf] button does not repaint before the click', held && stillHeld, `held=${held} stillHeld=${stillHeld}`);
        check('L11 (pass 2): the held repaint runs right after the click, and the click did its job (one POST)', b.V._state.pendingPaint === false && b.posts.length === 1 && /\$881/.test(b.html()), `pending=${b.V._state.pendingPaint} posts=${b.posts.length}`);
        b.t.documentStub.activeElement = null;
      }
      {
        // L12: an edit typed during the save that equals the value saved meanwhile is settled when the answer lands
        let release = null;
        const b = await boot({ post: () => new Promise(r => { release = () => r({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: false, error: 'changed', current: curOf({ 'budget 2026-10': ['50000', '55', 'Maria', '2026-10-17T11:59:00.000Z'] }) })) }); }) });
        await saveBudget(b);
        b.V.edit('budget 2026-10', 50000, 55);   // typed while in flight: exactly what Maria saved meanwhile
        if (release) release();
        await flush(); await flush();
        check('L12 (pass 2): an unsaved edit identical to the value that is now saved is dropped when the answer lands', !b.V._state.unsaved['budget 2026-10'] && !/Unsaved/.test(meta(b.t)) && b.V._state.cfg.budgets['2026-10'].total === 50000, JSON.stringify(b.V._state.unsaved['budget 2026-10']));
      }
    }
  }

  // ---------------- the live BFCM tabs parse and render (live runs only)
  if (!LOCAL_CSV) {
    section('bfcm channel (live sheet)');
    // fetch EXACTLY the URLs the page fetches (headers=1 included), as the weekly sections do
    const B = A.CHANNELS.bfcm;
    let live = null;
    try { live = { daily: await fetchCSV(B.dailyCsvUrl), config: await fetchCSV(B.configCsvUrl), log: await fetchCSV(B.logCsvUrl) }; } catch (e) { live = null; }
    check('live BFCM tabs fetched (the page\'s own URLs)', !!live);
    if (live) {
      const { V, html } = await bootBfcm({ now: new Date().toISOString(), bf: live });
      const h = html();
      check('live: rows parsed (>= 15 days from 1 Oct)', V._state.rows.length >= 15 && V._state.rows[0].date === '2026-10-01', `rows=${V._state.rows.length}`);
      check('live: header tripwire passes and the config reads', !/needs attention/.test(h) && !/could not be read/.test(h));
      check('live: Google ROAS tile renders a value', /x$/.test(tileOf(h, 'google').v), tileOf(h, 'google').v);
    }
  }

  finish();

  function finish() {
    console.log(`\n${checks} checks, ${failures} failures`);
    process.exit(failures ? 1 : 0);
  }
}

main().catch(e => { console.error('SIM CRASH: ' + (e.stack || e.message)); process.exit(2); });
