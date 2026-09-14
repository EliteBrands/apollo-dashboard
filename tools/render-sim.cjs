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

function bootPage(csvText, metaCsvText, merCsvText) {
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
    fetch: (url) => Promise.resolve({ ok: true, text: () => Promise.resolve(
      String(url).includes('sheet=Total%20MER') ? (merCsvText == null ? '<html>no mer fixture</html>' : merCsvText)
      : String(url).includes('sheet=Meta') ? (metaCsvText == null ? csvText : metaCsvText)
      : csvText) }),
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
    const hasNote = !!((newest[22] || '').trim() || (newest[23] || '').trim());
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
  }

  // ---------------- Total MER channel (v3)
  section('total mer channel');
  check('CHANNELS.mer present and pinned to sheet=Total%20MER', !!(A.CHANNELS.mer && String(A.CHANNELS.mer.csvUrl).includes('&sheet=Total%20MER')));
  check('page exposes buildMerRows', typeof A.buildMerRows === 'function');
  {
    // the page SHIPS with CHANNELS.mer.enabled:false (launch switch). Prove the switch
    // holds at boot, then flip it in the sandbox so the view itself can be exercised.
    check('shipped flag: mer pill hidden at boot (enabled:false)', A.CHANNELS.mer.enabled === false && !!els['ch-mer'] && els['ch-mer'].style.display === 'none', `display=${els['ch-mer'] && els['ch-mer'].style.display}`);
    const before = A.channel;
    await A.switchChannel('mer'); await flush();
    check('shipped flag: switchChannel(mer) is a no-op while disabled', A.channel === before, `channel=${A.channel}`);
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
    check('newest mer row: aus.revenue is null, usa/can revenue are numbers', lastRow && lastRow.aus.revenue === null && typeof lastRow.usa.revenue === 'number' && typeof lastRow.can.revenue === 'number', lastRow && JSON.stringify({ usa: lastRow.usa.revenue, can: lastRow.can.revenue, aus: lastRow.aus.revenue }));
    const iAllRev = parseFloat(R.get(lastRow.week)[10]);
    check('newest mer row: all.revenue is the sheet ALL Revenue cell, not usa+can+aus', Math.abs(lastRow.all.revenue - iAllRev) < 0.01, `${lastRow.all.revenue} vs ${iAllRev}`);
    const dgMulti = parseFloat(G.get(lastRow.week)[18] || 0) + parseFloat(M.get(lastRow.week)[26] || 0);
    const cardSum = ['usa', 'can', 'aus'].reduce((s, b) => s + lastRow[b].spend, 0);
    check('DG + MULTI spend sits in ALL but not in any market card', Math.abs((lastRow.all.spend - cardSum) - dgMulti) < 0.01, `${lastRow.all.spend - cardSum} vs ${dgMulti}`);
    for (const k of ['overview', 'usa', 'can', 'aus']) A.expanded[k] = false;
    A.setWindow(8); A.render();
    const rlive = createdCharts.filter(c => !c.destroyed);
    check('mer: exactly 1 chart when nothing expanded', rlive.length === 1, `got ${rlive.length}`);
    check('mer overview has 3 datasets, ratio dataset labelled MER, no target', rlive[0] && rlive[0].config.data.datasets.length === 3 && rlive[0].config.data.datasets.some(d => d.label === 'MER'));
    const rhtml = els.content ? els.content.innerHTML : '';
    check('mer tiles: Ad Spend, Revenue, MER, Orders present', ['>Ad Spend<', '>Revenue<', '>MER<', '>Orders<'].every(s => rhtml.includes(s)));
    check('mer tiles: no ROAS, no Cost / Purchase, no New Customers, no Purchases', !['>ROAS<', 'Cost / Purchase', 'New Customers', '>Purchases<'].some(s => rhtml.includes(s)));
    check('mer rate line shows both rates', /1 USD = \d\.\d{4} CAD/.test(rhtml) && /1 AUD = \d\.\d{4} CAD/.test(rhtml));
    check('mer market cards: USA, CAN, AUS only', ['card-usa', 'card-can', 'card-aus'].every(s => rhtml.includes(`id="${s}"`)) && !rhtml.includes('card-dg') && !rhtml.includes('card-multi'));
    check('mer view has no note card', !rhtml.includes('notecard'));
    await A.switchChannel('google'); await flush();
    check('switching back restores google rows untouched', A.channel === 'google' && A.data === gRows);
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

  finish();

  function finish() {
    console.log(`\n${checks} checks, ${failures} failures`);
    process.exit(failures ? 1 : 0);
  }
}

main().catch(e => { console.error('SIM CRASH: ' + (e.stack || e.message)); process.exit(2); });
