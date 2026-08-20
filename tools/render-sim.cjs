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
 *   node tools/render-sim.cjs <local.csv>     use a saved CSV snapshot
 *   RENDER_SIM_PAGE=<file> node tools/...     point at a mutated page copy
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const https = require('https');

const PAGE = process.env.RENDER_SIM_PAGE
  ? path.resolve(process.env.RENDER_SIM_PAGE)
  : path.resolve(__dirname, '../index.html');
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

function bootPage(csvText) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!scripts.length) throw new Error('no inline <script> found in page');
  const code = scripts[scripts.length - 1];

  const els = {};
  const createdCharts = [];
  class ChartStub {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; createdCharts.push(this); }
    destroy() { this.destroyed = true; }
  }
  const documentStub = {
    getElementById(id) { return els[id] || (els[id] = makeElement(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const sandbox = {
    window: {}, document: documentStub, Chart: ChartStub,
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(csvText) }),
    console, setTimeout, clearTimeout, Event: function () {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'apollo-page.js' });
  return { sandbox, els, createdCharts, code };
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

  // ---------------- boot against the real CSV
  section('boot + parse (real CSV)');
  const { sandbox, els, createdCharts } = bootPage(csv);
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
    const t = bootPage(csv);   // real CSV currently has empty notes
    await flush();
    const content = t.els.content ? t.els.content.innerHTML : '';
    check('no note card when the note column is empty', !content.includes('This week from your strategist'));
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

  finish();

  function finish() {
    console.log(`\n${checks} checks, ${failures} failures`);
    process.exit(failures ? 1 : 0);
  }
}

main().catch(e => { console.error('SIM CRASH: ' + (e.stack || e.message)); process.exit(2); });
