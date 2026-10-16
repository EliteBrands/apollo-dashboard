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
      // BFCM tabs first; the Log URL contains the Config URL, so it is matched before it
      const body = u.includes('sheet=BFCM%20Daily') ? bf.daily
        : u.includes('sheet=BFCM%20Config%20Log') ? bf.log
        : u.includes('sheet=BFCM%20Config') ? bf.config
        : null;
      if (u.includes('sheet=BFCM%20')) {
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
    // v4: the page loads bfcm-core.js + bfcm-view.js + bfcm-save.js (cache-busted ?v=4.0.0) BEFORE the inline script
    const parts = pageParts(PAGE);
    check('page loads bfcm-core.js, bfcm-view.js and bfcm-save.js (?v=4.0.0) before the inline script',
      /<script src="bfcm-core\.js\?v=4\.0\.0"><\/script>\s*<script src="bfcm-view\.js\?v=4\.0\.0"><\/script>\s*<script src="bfcm-save\.js\?v=4\.0\.0"><\/script>\s*<script>/.test(html) && parts.srcs.join() === 'bfcm-core.js,bfcm-view.js,bfcm-save.js');
    for (const f of ['bfcm-core.js', 'bfcm-view.js', 'bfcm-save.js']) {
      let ok = true;
      try { execFileSync(process.execPath, ['--check', path.join(parts.dir, f)], { stdio: 'pipe' }); } catch (e) { ok = false; }
      check(f + ' passes node --check', ok);
    }
    check('version marker line 2 is v4.0.0', html.split(/\r?\n/)[1] === '<!-- apollo-dashboard v4.0.0 -->');
    check('footer shows v4.0.0', /<footer>[\s\S]*v4\.0\.0[\s\S]*<\/footer>/.test(html));
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
    check('channel hint matches the number of pills on screen', (shippedOn ? (!!els['channelhint'] && /Three views/.test(els['channelhint'].textContent)) : !(els['channelhint'] && /Three views/.test(els['channelhint'].textContent || ''))), `hint=${els['channelhint'] && els['channelhint'].textContent}`);
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
        const grab = () => ({ html: t.els.content.innerHTML, chrome: [txt('subline'), txt('footnote'), txt('channelhint'), txt('week-ending'), txt('wcount')].join(' | '),
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
      for (const k of ['google', 'meta', 'mer']) {
        const raw = a[k].html === b[k].html;
        check(`${k}: content HTML identical to v3.3.0 (raw ${raw ? 'byte-identical' : 'differs only by esc() quote entities'})`, decode(b[k].html) === a[k].html, firstDiff(a[k].html, decode(b[k].html)));
        check(`${k}: subline, footnote, channel hint, week ending, window count identical`, a[k].chrome === b[k].chrome, `v3.3 ${a[k].chrome}\n        v4   ${b[k].chrome}`);
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
  const BFCM_ON = ["key:'bfcm', label:'BFCM 2026', enabled:false", "key:'bfcm', label:'BFCM 2026', enabled:true"];
  const bfUrls = log => ({
    daily: log.filter(u => u.includes('sheet=BFCM%20Daily')).length,
    config: log.filter(u => u.includes('sheet=BFCM%20Config') && !u.includes('sheet=BFCM%20Config%20Log')).length,
    log: log.filter(u => u.includes('sheet=BFCM%20Config%20Log')).length,
  });
  // boot the page, flip the launch switch in the sandbox (as the mer section does) and open the view
  const bootBfcm = async (o) => {
    o = o || {};
    const clock = makeClock(o.now || '2026-10-17T18:00:00.000Z');
    const bf = Object.assign({}, BFX, o.bf || {});
    const bo = { clock, bfcm: bf, patch: o.patch, location: o.location, post: o.post, storage: o.storage };
    if ('crypto' in o) bo.crypto = o.crypto;
    const t = bootPage(csv, metaCsv, merCsv, bo);
    await flush();
    const TA = t.sandbox.window.__apollo, V = t.sandbox.BFCM_VIEW;
    if (o.open !== false) {
      TA.CHANNELS.bfcm.enabled = true;
      if (o.configWrites) TA.CHANNELS.bfcm.configWrites = true;
      if (o.endpoint) TA.CHANNELS.bfcm.endpointUrl = o.endpoint;
      await TA.switchChannel('bfcm'); await flush();
    }
    return { t, TA, V, clock, bf, posts: t.postLog, html: () => String(t.els.content.innerHTML || '') };
  };

  if (bfOK) {
    // ---- shipped state: hidden pill, deep link ignored, no BFCM fetch
    {
      const t = bootPage(csv, metaCsv, merCsv, { clock: makeClock('2026-10-17T18:00:00.000Z'), location: { hash: '#bfcm', pathname: '/', search: '' } });
      await flush();
      const TA = t.sandbox.window.__apollo, B = TA.CHANNELS.bfcm || {};
      check('CHANNELS.bfcm ships enabled:false, configWrites:false, endpointUrl empty, refreshMs 900000',
        B.key === 'bfcm' && B.label === 'BFCM 2026' && B.enabled === false && B.configWrites === false && B.endpointUrl === '' && B.refreshMs === 900000, JSON.stringify({ enabled: B.enabled, configWrites: B.configWrites, refreshMs: B.refreshMs }));
      check('CHANNELS.bfcm CSV URLs pinned to the three BFCM tabs',
        /&sheet=BFCM%20Daily$/.test(B.dailyCsvUrl || '') && /&sheet=BFCM%20Config$/.test(B.configCsvUrl || '') && /&sheet=BFCM%20Config%20Log$/.test(B.logCsvUrl || ''));
      check('CHANNELS.bfcm subline copy', B.subline === 'Prepared by Elite Brands · BFCM 2026 · All figures CAD · Toronto days', B.subline);
      check('pill #ch-bfcm hidden while enabled:false', !!t.els['ch-bfcm'] && t.els['ch-bfcm'].style.display === 'none');
      check('#bfcm deep link ignored while enabled:false (google stays, no BFCM fetch, view not mounted)',
        TA.channel === 'google' && !t.fetchLog.some(u => u.includes('sheet=BFCM%20')) && !(t.sandbox.BFCM_VIEW && t.sandbox.BFCM_VIEW._state && t.sandbox.BFCM_VIEW._state.mounted), `channel=${TA.channel}`);
      await TA.switchChannel('bfcm'); await flush();
      check('switchChannel(bfcm) is a no-op while disabled', TA.channel === 'google' && !t.fetchLog.some(u => u.includes('sheet=BFCM%20')));
      check('channel hint does not claim four views while bfcm is off', !/Four views/.test((t.els.channelhint && t.els.channelhint.textContent) || ''));
      check('esc() also escapes " and \' (spec 23)', typeof TA.esc === 'function' && TA.esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
      check('__apollo exposes the pure forecast (spec 19)', typeof TA.forecast === 'function');
    }
    // ---- launch switch on before boot: the #bfcm deep link opens the view
    {
      const { t, TA, V } = await bootBfcm({ open: false, patch: [BFCM_ON], location: { hash: '#bfcm', pathname: '/', search: '' } });
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
      check('weekly table: Mon-Sun week row for 12 to 18 Oct clipped to 13 to 16 Oct, plus a projected run-rate row', /13 to 16 Oct/.test(h) && /projected full week/.test(h) && /run-rate/.test(h));

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
      check('forecast outputs render, each with its basis line', /Based on/.test(h) && /spend lands at/.test(h) && /Store revenue lands at/.test(h) && /Sale MER lands at/.test(h) && /Google-reported revenue/.test(h) && /Meta-reported revenue/.test(h) && /Spend ceiling/.test(h));
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
      const h = html();
      check('focused forecast slider: the refresh still paints the new data', h.includes('$999'));
      check('focused forecast slider: the stale banner still appears past 30 h', /Meta data last updated 16 Oct, 6:05 am Toronto time/.test(h));
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

    // ---- config edit controls (configWrites:true in the sandbox; endpointUrl stays '' as shipped)
    {
      const { V, clock, bf, html } = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true });
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
      const meta = t => String((t.els['bf-budget-meta'] && t.els['bf-budget-meta'].innerHTML) || '');
      const tmeta = t => String((t.els['bf-targets-meta'] && t.els['bf-targets-meta'].innerHTML) || '');
      const fire = (t, ev, target) => (t.els.content._listeners[ev] || []).forEach(fn => fn({ target }));
      const typeName = (t, name) => fire(t, 'input', { getAttribute: k => (k === 'data-bf' ? 'who' : null), value: name });
      const clickSave = (t, scope) => fire(t, 'click', { closest: () => ({ getAttribute: k => (k === 'data-bf' ? 'save' : k === 'data-v' ? scope : null) }) });
      const bodyOf = (posts, i) => { try { return JSON.parse(posts[i].init.body); } catch (e) { return {}; } };
      const saveBtn = s => (String(s).match(/<button[^>]*data-bf="save"[^>]*>[^<]*<\/button>/g) || []);
      const boot = o => bootBfcm(Object.assign({ now: '2026-10-17T12:00:00.000Z', configWrites: true, endpoint: EP }, o || {}));
      // edit the October budget, type a name, click Save; returns after the stub's answers have been handled
      const saveBudget = async (b, name) => { b.V.edit('budget 2026-10', 45000, 60); typeName(b.t, name == null ? 'Glen' : name); clickSave(b.t, 'budget'); await flush(); };

      {
        // shipped: endpointUrl '' -> the button says so, is disabled, and nothing is ever posted
        const b = await bootBfcm({ now: '2026-10-17T12:00:00.000Z', configWrites: true });
        b.V.edit('budget 2026-10', 45000, 60);
        const btn = saveBtn(meta(b.t)).concat(saveBtn(b.html()));
        check('endpointUrl empty: Save button disabled with "Saving is not switched on yet", no name box',
          btn.length >= 1 && btn.every(x => /disabled/.test(x) && />Saving is not switched on yet</.test(x)) && !/Save for everyone/.test(meta(b.t) + b.html()) && !/data-bf="who"/.test(b.html()), btn.join(' | '));
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
        check('busy: "Not saved: ... Nothing changed." and the control reverts to the saved value (32000)', /Not saved: [^<]+\. Nothing changed\./.test(h) && /data-bf="budget-total"[^>]*value="32000"/.test(h) && !/Unsaved/.test(h));
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
        typeName(b.t, 'Glen'); clickSave(b.t, 'targets'); await flush(); await flush();
        const k = b.posts.map((p, i) => bodyOf(b.posts, i));
        check('targets: one POST per key, in panel order, each with a different rid',
          k.length === 2 && k[0].key === 'target google_roas' && k[1].key === 'target mer' && k[0].rid !== k[1].rid && k.every(x => UUID.test(x.rid) && x.value2 === '' && x.expect2 === ''), JSON.stringify(k));
        check('targets: expect = the saved values the edits started from (12, 11.5)', k.length === 2 && k[0].value === '11' && k[0].expect === '12' && k[1].value === '10' && k[1].expect === '11.5');
        check('targets: each target shows its own Saved line', (b.html().match(/Saved for everyone · Glen/g) || []).length >= 2 && b.V._state.cfg.targets.mer === 10 && b.V._state.cfg.targets.google_roas === 11);
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
  }

  // ---------------- the live BFCM tabs parse and render (live runs only)
  if (!LOCAL_CSV) {
    section('bfcm channel (live sheet)');
    const base = csvUrl.replace('&sheet=Sheet1', '&sheet=');
    let live = null;
    try { live = { daily: await fetchCSV(base + 'BFCM%20Daily'), config: await fetchCSV(base + 'BFCM%20Config'), log: await fetchCSV(base + 'BFCM%20Config%20Log') }; } catch (e) { live = null; }
    check('live BFCM tabs fetched', !!live);
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
