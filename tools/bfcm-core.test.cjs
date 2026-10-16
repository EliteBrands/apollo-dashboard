'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../bfcm-core.js');

// ---- the page's own parser, copied verbatim from index.html (parseCSV)
function parseCSV(text){
  const recs=[]; let rec=[], cell='', q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){ if(q && text[i+1]==='"'){ cell+='"'; i++; } else q=!q; }
    else if(ch===',' && !q){ rec.push(cell); cell=''; }
    else if((ch==='\n'||ch==='\r') && !q){
      if(ch==='\r' && text[i+1]==='\n') i++;
      rec.push(cell); cell='';
      if(rec.length>1 || rec[0]!=='') recs.push(rec);
      rec=[];
    } else cell+=ch;
  }
  rec.push(cell);
  if(rec.length>1 || rec[0]!=='') recs.push(rec);
  return recs.map(r=>r.map(c=>String(c==null?'':c).trim()));
}

// ---- fixture builders (every cell a quoted string, like the real gviz CSV)
const HDR = C.DAILY_HEADERS;
const q = v => '"' + (v == null ? '' : String(v)) + '"';
// spec: {d, g:[spend,rev,purch], m:[spend,rev,purch], s:[storeRevCad, orders], pg, pm, ps (Pulled At)}
function dailyCsv(specs, headers) {
  const lines = [(headers || HDR).map(q).join(',')];
  for (const x of specs) {
    const g = x.g || [], m = x.m || [], s = x.s || [];
    lines.push([x.d, g[0], g[1], g[2], m[0], m[1], m[2], '', '', '', '', '', x.prov || '', s[0], s[1], x.pg, x.pm, x.ps].map(q).join(','));
  }
  return lines.join('\n');
}
const FRESH = '2026-10-16T09:03:55.690Z';
function day(d, g, m, s) { return { d, g, m, s, pg: FRESH, pm: FRESH, ps: FRESH }; }
function range(from, to) { const out = []; for (let d = from; d <= to; d = C.addDays(d, 1)) out.push(d); return out; }
const parse = specs => C.parseDaily(dailyCsv(specs), parseCSV);
const flat = (from, to, g, m, s) => range(from, to).map(d => day(d, g, m, s));
// Google 1000/day revenue 5000 (ROAS 5), Meta 200/day revenue 1000 (ROAS 5), store 3000/day, 1..15 Oct
const octSpecs = flat('2026-10-01', '2026-10-15', [1000, 5000, 10], [200, 1000, 5], [3000, 9]);
const rows = parse(octSpecs).rows;

const cfgCsv = [
  'Key,Value,Value 2', 'sale_start,2026-10-13,', 'sale_end,2026-12-06,', 'budget 2026-10,55000,60', 'budget 2026-11,,', 'budget 2026-12,20000,70',
  'target google_roas,12,', 'target meta_roas,12,', 'target mer,12,'].join('\n');
const cfgCsvJan = cfgCsv.replace('sale_end,2026-12-06,', 'sale_end,2027-01-10,');
const logHdr = 'Seq,At,Who,Key,Value,Value 2,Request ID';
const logCsv = [logHdr,
  '1,2026-10-14T01:00:00.000Z,glen@x.com,budget 2026-11,40000,50,r1',
  '2,2026-10-15T01:00:00.000Z,dan@x.com,budget 2026-11,45000,55,r2'].join('\n');
const cfg = C.resolveConfig(cfgCsv, logCsv, parseCSV);

test('DAILY_HEADERS equals the writer lib BFCM_HEADERS (dev-time cross-check)', t => {
  const lib = path.join(__dirname, '../../../clients/apollo-scooters/scripts/lib/bfcm-daily.cjs');
  if (!fs.existsSync(lib)) return t.skip('writer lib not present (page repo cloned alone)');
  assert.deepEqual(C.DAILY_HEADERS, require(lib).BFCM_HEADERS);
  assert.equal(C.DAILY_HEADERS.length, 18);
});

test('parseDaily: blank is null never 0; header mismatch -> error', () => {
  const r = parse([
    day('2026-10-01', [896.18, 5611.96, 16], [248.94, 4326.61, 12], [9585.06, 27]),
    { d: '2026-10-02', g: [100, 500, 2], m: ['', '', ''], s: ['', ''], pg: FRESH },
  ]);
  assert.equal(r.error, null);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0].google, { spend: 896.18, revenue: 5611.96, purchases: 16, pulledAt: FRESH });
  assert.equal(r.rows[0].store.revenueCad, 9585.06);
  assert.equal(r.rows[0].store.orders, 27);
  assert.equal(r.rows[1].meta, null);
  assert.equal(r.rows[1].store, null);
  assert.equal(r.rows[1].google.spend, 100);
  const bad = C.parseDaily(dailyCsv([], ['Date', 'Google Spend']), parseCSV);
  assert.deepEqual(bad.rows, []);
  assert.ok(bad.error);
  assert.ok(C.parseDaily('', parseCSV).error);
});

test('resolveConfig: defaults from config sheet, last log row per key wins', () => {
  assert.equal(cfg.saleStart, '2026-10-13');
  assert.equal(cfg.saleEnd, '2026-12-06');
  assert.deepEqual(cfg.budgets['2026-10'], { total: 55000, pct: 60 });
  assert.deepEqual(cfg.budgets['2026-11'], { total: 45000, pct: 55 });   // second log row wins
  assert.deepEqual(cfg.budgets['2026-12'], { total: 20000, pct: 70 });
  assert.deepEqual(cfg.targets, { google_roas: 12, meta_roas: 12, mer: 12 });
  assert.equal(cfg.last['budget 2026-11'].who, 'dan@x.com');
  assert.equal(cfg.last['budget 2026-11'].at, '2026-10-15T01:00:00.000Z');
  assert.equal(cfg.error, null);
  // a deleted row falls back to the previous one
  const one = C.resolveConfig(cfgCsv, logCsv.split('\n').slice(0, 2).join('\n'), parseCSV);
  assert.deepEqual(one.budgets['2026-11'], { total: 40000, pct: 50 });
  // no log rows at all: the config default (blank = null)
  const none = C.resolveConfig(cfgCsv, logHdr, parseCSV);
  assert.equal(none.budgets['2026-11'], null);
  assert.deepEqual(none.budgets['2026-10'], { total: 55000, pct: 60 });
});

test('resolveConfig: log can change targets and dates; bad header -> error and null budgets', () => {
  const log = [logHdr, '1,2026-10-14T01:00:00.000Z,g,target mer,10,,r1', '2,2026-10-14T02:00:00.000Z,g,sale_end,2026-12-10,,r2'].join('\n');
  const c = C.resolveConfig(cfgCsv, log, parseCSV);
  assert.equal(c.targets.mer, 10);
  assert.equal(c.saleEnd, '2026-12-10');
  const bad = C.resolveConfig(cfgCsv, 'Nope,Header\n1,2', parseCSV);
  assert.ok(bad.error);
  assert.equal(bad.budgets['2026-10'], null);
  const bad2 = C.resolveConfig('x,y\n1,2', logCsv, parseCSV);
  assert.ok(bad2.error);
  assert.ok(Object.values(bad2.budgets).every(v => v === null));
});

test('phases and saleMonths', () => {
  assert.deepEqual(C.phases('2026-10-13', '2026-12-06'), [
    { key: 'early', label: 'Early Access', from: '2026-10-13', to: '2026-11-25' },
    { key: 'bfcm', label: 'Black Friday + Cyber Monday', from: '2026-11-26', to: '2026-11-30' },
    { key: 'ext', label: 'Extension', from: '2026-12-01', to: '2026-12-06' }]);
  assert.deepEqual(C.saleMonths('2026-10-13', '2026-12-06'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(C.saleMonths('2026-10-13', '2027-01-10').slice(-1), ['2027-01']);
});

test('check-deep L2: phases are clamped to the sale window and empty ones dropped', () => {
  // a sale that starts after Early Access ends: no Early Access phase, BF + CM starts on the sale's first day
  assert.deepEqual(C.phases('2026-11-27', '2026-12-06'), [
    { key: 'bfcm', label: 'Black Friday + Cyber Monday', from: '2026-11-27', to: '2026-11-30' },
    { key: 'ext', label: 'Extension', from: '2026-12-01', to: '2026-12-06' }]);
  // a sale that ends on Black Friday weekend: no Extension, BF + CM stops at the sale end
  assert.deepEqual(C.phases('2026-10-13', '2026-11-28'), [
    { key: 'early', label: 'Early Access', from: '2026-10-13', to: '2026-11-25' },
    { key: 'bfcm', label: 'Black Friday + Cyber Monday', from: '2026-11-26', to: '2026-11-28' }]);
  // every phase that is kept lies inside the window and is never inverted
  for (const [s, e] of [['2026-10-13', '2026-12-06'], ['2026-11-30', '2026-11-30'], ['2026-12-02', '2027-01-10'], ['2026-10-01', '2026-11-10']]) {
    const ps = C.phases(s, e);
    assert.ok(ps.length >= 1, s + '..' + e);
    assert.ok(ps.every(p => p.from >= s && p.to <= e && p.from <= p.to), JSON.stringify(ps));
  }
});

test('check-deep L4: resolveConfig keeps a __proto__ key as plain data (no inherited keys, no prototype change)', () => {
  const log = [logHdr, '1,2026-10-14T01:00:00.000Z,vandal,__proto__,1,2,r1', '2,2026-10-14T02:00:00.000Z,vandal,toString,1,2,r2'].join('\n');
  const c = C.resolveConfig(cfgCsv + '\n__proto__,9,9', log, parseCSV);
  assert.equal(c.error, null);
  assert.equal(Object.getPrototypeOf(c.last), null, 'last has no prototype');
  assert.ok(Object.prototype.hasOwnProperty.call(c.last, '__proto__'), 'the __proto__ row is an own entry, not a prototype swap');
  assert.equal(c.last.constructor, undefined, 'no inherited keys');
  assert.deepEqual(c.budgets['2026-10'], { total: 55000, pct: 60 });
  assert.deepEqual(c.targets, { google_roas: 12, meta_roas: 12, mer: 12 });
});

test('check-deep L6: realDate is exported (the view uses it for typed date ranges)', () => {
  assert.equal(typeof C.realDate, 'function');
  assert.equal(C.realDate('2026-10-02'), true);
  assert.equal(C.realDate('2026-02-30'), false);
  assert.equal(C.realDate('2026-10-2'), false);
});

test('REVIEW FOCUS 1: Brisbane Saturday morning is still Friday in Toronto', () => {
  assert.equal(C.torontoDate(new Date('2026-11-27T21:30:00Z')), '2026-11-27');
  // DST edge (clocks fall back 1 Nov 2026 at 06:00Z)
  assert.equal(C.torontoDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01');   // 00:30 EDT
  assert.equal(C.torontoDate(new Date('2026-11-01T03:30:00Z')), '2026-10-31');   // 23:30 EDT
  const wrows = parse(flat('2026-11-20', '2026-11-27', [1, 1, 1], [1, 1, 1], [1, 1])).rows;
  const today = C.torontoDate(new Date('2026-11-27T21:30:00Z'));
  const r = C.presetRange('week', today, cfg, wrows);   // chained: the page feeds presetRange torontoDate(now)
  assert.equal(r.from, '2026-11-23');
  assert.equal(r.to, '2026-11-27');   // clamped to rows present
});

test('presetRange: sale, last7, week, oct, nov, dec, custom', () => {
  assert.deepEqual(C.presetRange('sale', '2026-10-16', cfg, rows), { from: '2026-10-13', to: '2026-10-15', label: 'Sale to date' });
  assert.deepEqual(C.presetRange('last7', '2026-10-16', cfg, rows), { from: '2026-10-09', to: '2026-10-15', label: 'Last 7 days' });
  const w = C.presetRange('week', '2026-10-16', cfg, rows);
  assert.deepEqual([w.from, w.to, w.label], ['2026-10-12', '2026-10-15', 'This week']);
  const o = C.presetRange('oct', '2026-10-16', cfg, rows);
  assert.deepEqual([o.from, o.to], ['2026-10-01', '2026-10-15']);
  const long = parse(flat('2026-10-01', '2026-12-20', [1, 1, 1], [1, 1, 1], [1, 1])).rows;
  assert.deepEqual(C.presetRange('nov', '2026-12-20', cfg, long), { from: '2026-11-01', to: '2026-11-30', label: 'November' });
  assert.deepEqual(C.presetRange('dec', '2026-12-20', cfg, long), { from: '2026-12-01', to: '2026-12-06', label: 'December' });
  assert.deepEqual(C.presetRange('sale', '2026-12-20', cfg, long), { from: '2026-10-13', to: '2026-12-06', label: 'Sale to date' });
  const c = C.presetRange('custom', '2026-10-16', cfg, rows, { from: '2026-10-13', to: '2026-10-30' });
  assert.deepEqual(c, { from: '2026-10-13', to: '2026-10-15', label: '13 Oct to 15 Oct' });
});

test('a gap inside the window nulls that source, a trailing gap shortens it', () => {
  const noMeta5 = octSpecs.map(x => x.d === '2026-10-05' ? Object.assign({}, x, { m: [] }) : x);
  const r = parse(noMeta5).rows;
  const t = C.windowTotals(r, '2026-10-01', '2026-10-15');
  assert.equal(t.meta.spend, null);
  assert.equal(t.meta.roas, null);
  assert.deepEqual(t.meta.gaps, ['2026-10-05']);
  assert.equal(t.google.spend, 15000);
  assert.deepEqual(t.google.gaps, []);
  assert.equal(t.mer.value, null);   // a spend source has a gap
  const trail = parse(octSpecs.slice(0, -1)).rows;   // newest day missing
  assert.deepEqual(C.completeThrough(trail, 'google', '2026-10-01', '2026-10-15'), { through: '2026-10-14', gaps: [] });
  assert.deepEqual(C.completeThrough(r, 'meta', '2026-10-01', '2026-10-15'), { through: '2026-10-04', gaps: ['2026-10-05'] });
  assert.deepEqual(C.completeThrough(r, 'google', '2026-10-01', '2026-10-15'), { through: '2026-10-15', gaps: [] });
  assert.deepEqual(C.completeThrough([], 'google', '2026-10-01', '2026-10-15'), { through: null, gaps: [] });
});

test('windowTotals: sum over sum ROAS and MER with the earliest through', () => {
  // Meta is one day behind: its through is 14 Oct, so MER stops at 14 Oct
  const lag = octSpecs.map(x => x.d === '2026-10-15' ? Object.assign({}, x, { m: [] }) : x);
  const t = C.windowTotals(parse(lag).rows, '2026-10-13', '2026-10-15');
  assert.equal(t.google.spend, 3000);
  assert.equal(t.google.revenue, 15000);
  assert.equal(t.google.roas, 5);
  assert.equal(t.google.through, '2026-10-15');
  assert.equal(t.meta.spend, 400);
  assert.equal(t.meta.through, '2026-10-14');
  assert.equal(t.store.revenue, 9000);
  assert.equal(t.mer.through, '2026-10-14');
  assert.equal(t.mer.value, 6000 / 2400);   // store 2 days / (google 2 days + meta 2 days)
});

test('pacing lands-at = spent + avg7 x days remaining, band thresholds', () => {
  const p = C.pacing(rows, '2026-10', { total: 55000, pct: 60 }, '2026-12-06', '2026-10-16');
  assert.equal(p.status, 'running');
  assert.equal(p.google.spent, 15000);
  assert.equal(p.google.avgMtd, 1000);
  assert.equal(p.google.avg7, 1000);
  assert.equal(p.google.landsAt, 31000);   // 15000 + 1000 x 16
  assert.equal(p.google.budget, 33000);
  assert.equal(Math.round(p.google.pct * 10) / 10, 93.9);
  assert.equal(p.google.band, 'ok');
  assert.equal(p.meta.budget, 22000);
  assert.equal(p.meta.landsAt, 3000 + 200 * 16);
  assert.equal(p.meta.band, 'under');
  assert.equal(p.total.landsAt, 31000 + 6200);
  assert.equal(p.total.budget, 55000);
  assert.equal(p.total.band, 'under');   // 37200 / 55000 = 67.6
  // Google lands at 31000; pick budgets so pct is exactly on each boundary
  const band = pct => C.pacing(rows, '2026-10', { total: 31000 / pct * 100, pct: 100 }, '2026-12-06', '2026-10-16').google.band;
  assert.equal(band(89.9), 'under');
  assert.equal(band(90), 'ok');
  assert.equal(band(100), 'ok');
  assert.equal(band(100.5), 'amber');
  assert.equal(band(105), 'amber');
  assert.equal(band(105.5), 'red');
});

test('pacing: Google and Meta use their own through, Total the earlier; avg7 reaches into the prior month', () => {
  const sp = range('2026-09-20', '2026-10-15').map(d => day(d, [100, 1, 1], d <= '2026-10-14' ? [50, 1, 1] : [], [1, 1]));
  const p = C.pacing(parse(sp).rows, '2026-10', null, '2026-12-06', '2026-10-16');
  assert.equal(p.google.spent, 1500);
  assert.equal(p.meta.spent, 700);    // to 14 Oct
  assert.equal(p.total.spent, 2100);  // to 14 Oct: google 1400 + meta 700
  assert.equal(p.google.band, 'none');
  assert.equal(p.google.budget, null);
  assert.equal(p.google.pct, null);
  const early = parse(flat('2026-09-25', '2026-10-01', [100, 1, 1], [10, 1, 1], [1, 1])).rows;
  const r1 = C.pacing(early, '2026-10', null, '2026-12-06', '2026-10-02');
  assert.equal(r1.google.avg7, 100);
  assert.equal(r1.google.spent, 100);
  assert.equal(r1.google.landsAt, 100 + 100 * 30);
});

test('REVIEW FOCUS 2: a 100% Google split gives Meta a $0 budget and no band', () => {
  const p = C.pacing(rows, '2026-10', { total: 55000, pct: 100 }, '2026-12-06', '2026-10-16');
  assert.equal(p.meta.budget, 0);
  assert.notEqual(p.meta.landsAt, null);   // real data, so only the zero-budget branch can null pct
  assert.equal(p.meta.pct, null);
  assert.equal(p.meta.band, 'none');
});

test('REVIEW FOCUS 4: December before it starts, and a January extension with no budget key', () => {
  const p = C.pacing(rows, '2026-12', { total: 20000, pct: 70 }, '2026-12-06', '2026-11-20');
  assert.equal(p.status, 'not-started');
  assert.equal(p.total.avgMtd, null);
  assert.equal(p.total.landsAt, null);
  assert.deepEqual(C.saleMonths('2026-10-13', '2027-01-10').slice(-1), ['2027-01']);
  assert.equal(C.resolveConfig(cfgCsvJan, logCsv, parseCSV).budgets['2027-01'], null);
});

test('pacing: December runs to sale end; ended when through reaches month end; zero budget is none', () => {
  const dec = parse(flat('2026-11-24', '2026-12-03', [100, 1, 1], [100, 1, 1], [1, 1])).rows;
  const p = C.pacing(dec, '2026-12', { total: 2000, pct: 50 }, '2026-12-06', '2026-12-04');
  assert.equal(p.status, 'running');
  assert.equal(p.google.spent, 300);
  assert.equal(p.google.landsAt, 300 + 100 * 3);   // 4, 5, 6 Dec remain
  const full = parse(flat('2026-11-24', '2026-12-06', [100, 1, 1], [100, 1, 1], [1, 1])).rows;
  const e = C.pacing(full, '2026-12', { total: 2000, pct: 50 }, '2026-12-06', '2026-12-07');
  assert.equal(e.status, 'ended');
  assert.equal(e.google.landsAt, 600);
  const z = C.pacing(full, '2026-12', { total: 0, pct: 50 }, '2026-12-06', '2026-12-07');
  assert.equal(z.total.pct, null);
  assert.equal(z.total.band, 'none');
});

test('weekProjection: current Mon-Sun Toronto week run-rate', () => {
  const w = C.weekProjection(rows, '2026-10-15');   // Thu; week 12..18 Oct, rows to 15 Oct
  assert.equal(w.from, '2026-10-12');
  assert.equal(w.to, '2026-10-18');
  assert.equal(w.google.spent, 4000);
  assert.equal(w.google.avgMtd, 1000);
  assert.equal(w.google.landsAt, 7000);
  assert.equal(w.total.landsAt, 7000 + 1400);
  assert.equal(w.google.budget, undefined);
});

test('staleness is per source: fresh Google, 31 h old Meta', () => {
  const now = new Date('2026-10-16T10:00:00.000Z');
  const s = parse([{ d: '2026-10-15', g: [1, 1, 1], m: [1, 1, 1], s: [1, 1],
    pg: '2026-10-16T09:00:00.000Z', pm: '2026-10-15T03:00:00.000Z', ps: '2026-10-16T09:00:00.000Z' }]).rows;
  const r = C.staleness(s, now);
  assert.equal(r.google.stale, false);
  assert.equal(r.meta.stale, true);
  assert.equal(r.store.stale, false);
  assert.equal(r.meta.newest, '2026-10-15T03:00:00.000Z');
  assert.equal(C.staleness([], now).google.stale, true);
  assert.equal(C.staleness(s, new Date('2026-10-16T09:30:00.000Z'), 36).meta.stale, false);
});

test('lag tags: Google <= 2 days, Meta <= 7 days, none for the store', () => {
  const t = '2026-10-16';
  assert.equal(C.lagTag('google', '2026-10-14', t), 'may still rise');   // age 2
  assert.equal(C.lagTag('google', '2026-10-13', t), null);              // age 3
  assert.equal(C.lagTag('meta', '2026-10-09', t), 'filling in');        // age 7
  assert.equal(C.lagTag('meta', '2026-10-08', t), null);                // age 8
  assert.equal(C.lagTag('store', '2026-10-16', t), null);
});

// ---- Task 9: forecast engine
const FC_CFG = { saleStart: '2026-10-13', saleEnd: '2026-12-06', month: '2026-10', targets: { google_roas: 12, meta_roas: 12, mer: 12 } };
const fcRows = parse(flat('2026-10-01', '2026-10-19', [1000, 10000, 10], [500, 3000, 5], [12000, 9])).rows;   // 1..12 Oct pre-sale rows count toward month spend   // 7 days, through 19 Oct
// remaining = 20 Oct .. 6 Dec = 48 days
const fcVarRows = parse(range('2026-10-13', '2026-10-19').map((d, i) => day(d, [1000, 10000, 10], [500, 3000, 5], [[8200, 9300, 13100, 15400, 7700, 16900, 11250][i], 9]))).rows;

test('mulberry32: deterministic, in [0,1), differs by seed', () => {
  const a = C.mulberry32(5), b = C.mulberry32(5), c = C.mulberry32(6);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  xs.forEach(v => assert.ok(v >= 0 && v < 1));
  assert.notEqual(c(), xs[0]);
});

test('forecast neutral sliders reproduce the 7-day run-rate exactly', () => {
  const f = C.forecast(fcRows, FC_CFG, {});
  assert.equal(f.throughDate, '2026-10-19');
  assert.equal(f.basis.from, '2026-10-13');
  assert.equal(f.basis.to, '2026-10-19');
  assert.equal(f.basis.label, 'last 7 days, 13 Oct to 19 Oct');
  assert.equal(f.platformRevenue.google, 70000 + 10000 * 48);
  assert.equal(f.platformRevenue.meta, 21000 + 3000 * 48);
  assert.equal(f.storeRevenue.point, 84000 + 12000 * 48);
  assert.equal(f.spendCeiling, 1000);
  // sale MER = store / (realised spend + projected spend)
  assert.equal(f.saleMer.point, (84000 + 12000 * 48) / (10500 + 1500 * 48));
  // Oct (D2, whole calendar month): spent 1..19 Oct (19 days) + 12 days left
  assert.equal(f.monthSpend.google, 19000 + 1000 * 12);
  assert.equal(f.monthSpend.meta, 9500 + 500 * 12);
  assert.equal(f.monthSpend.total, f.monthSpend.google + f.monthSpend.meta);
});

test('forecast: same seed identical, other seed moves p10/p90 not point', () => {
  const a = C.forecast(fcVarRows, FC_CFG, {}, 7), b = C.forecast(fcVarRows, FC_CFG, {}, 7), c = C.forecast(fcVarRows, FC_CFG, {}, 8);
  assert.deepEqual(a.storeRevenue, b.storeRevenue);
  assert.equal(a.storeRevenue.point, c.storeRevenue.point);
  assert.ok(a.storeRevenue.p10 !== c.storeRevenue.p10 || a.storeRevenue.p90 !== c.storeRevenue.p90);
  assert.ok(a.storeRevenue.p10 < a.storeRevenue.point && a.storeRevenue.p90 > a.storeRevenue.point);
  assert.ok(a.saleMer.p10 < a.saleMer.p90);
});

test('forecast clamps sliders: spend.google 5 -> 1.0, roas 9 -> 1.5, spend -3 -> -0.5', () => {
  const hi = C.forecast(fcRows, FC_CFG, { spend: { google: 5 } });
  const one = C.forecast(fcRows, FC_CFG, { spend: { google: 1.0 } });
  assert.deepEqual(hi, one);
  const lo = C.forecast(fcRows, FC_CFG, { spend: { meta: -3 } });
  assert.equal(C.forecast(fcRows, FC_CFG, { spend: { meta: -0.5 } }).monthSpend.meta, lo.monthSpend.meta);
  assert.equal(lo.monthSpend.meta, 9500 + 250 * 12);
  const r = C.forecast(fcRows, FC_CFG, { roas: { google: 9 } });
  assert.equal(r.platformRevenue.google, 70000 + 1000 * 10 * 1.5 * 48);
  assert.equal(C.forecast(fcRows, FC_CFG, { roas: { google: 0.1 } }).platformRevenue.google, 70000 + 1000 * 10 * 0.5 * 48);
});

test('forecast REVIEW FOCUS 3: Meta spend 0 on every basis day', () => {
  const r = parse(flat('2026-10-13', '2026-10-19', [1000, 10000, 10], [0, 0, 0], [12000, 9])).rows;
  const f = C.forecast(r, FC_CFG, {});
  assert.equal(f.platformRevenue.meta, null);
  assert.ok(Number.isFinite(f.storeRevenue.point));
  assert.ok(f.storeRevenue.point > 84000);
  assert.equal(f.storeRevenue.point, 84000 + 12000 * 48);   // baseMer 12 x google 1000 x m 1
});

test('forecast: basis windows, young sale, and not-enough-data', () => {
  const long = parse(flat('2026-10-13', '2026-10-30', [1000, 10000, 10], [500, 3000, 5], [12000, 9])).rows;
  const l7 = C.forecast(long, FC_CFG, { basis: 'last7' }), l14 = C.forecast(long, FC_CFG, { basis: 'last14' }), s = C.forecast(long, FC_CFG, { basis: 'sale' });
  assert.equal(l7.basis.from, '2026-10-24');
  assert.equal(l14.basis.from, '2026-10-17');
  assert.equal(s.basis.from, '2026-10-13');
  const young = C.forecast(fcRows, FC_CFG, { basis: 'last14' });
  assert.equal(young.basis.from, '2026-10-13');
  const none = C.forecast([], FC_CFG, {});
  assert.equal(none.throughDate, null);
  assert.equal(none.storeRevenue.point, null);
  assert.equal(none.spendCeiling, null);
  assert.equal(none.platformRevenue.google, null);
  assert.match(none.basis.label, /Not enough data yet/);
  const noStore = parse(flat('2026-10-13', '2026-10-19', [1000, 10000, 10], [500, 3000, 5], [])).rows;
  assert.equal(C.forecast(noStore, FC_CFG, {}).storeRevenue.point, null);
});

test('forecast: no NaN or Infinity anywhere, month not started', () => {
  const z = parse(flat('2026-10-13', '2026-10-19', [0, 0, 0], [0, 0, 0], [0, 0])).rows;
  const f = C.forecast(z, FC_CFG, {});
  assert.doesNotMatch(JSON.stringify(f).replace(/null/g, ''), /NaN|Infinity/);
  (function walk(o) { Object.keys(o).forEach(k => { const v = o[k]; if (typeof v === 'number') assert.ok(Number.isFinite(v), k); else if (v && typeof v === 'object') walk(v); }); })(f);
  const nov = C.forecast(fcRows, Object.assign({}, FC_CFG, { month: '2026-11' }), {});
  assert.equal(nov.monthSpend.google, 1000 * 30);
  const dec = C.forecast(fcRows, Object.assign({}, FC_CFG, { month: '2026-12' }), {});
  assert.equal(dec.monthSpend.google, 1000 * 6);
});

test('forecast monthSpend: pre-sale days counted, gap = null, stops at month end', () => {
  const f = C.forecast(fcRows, FC_CFG, {});
  assert.equal(f.monthSpend.google, 19000 + 12000);
  // missing 5 Oct -> null, not a partial sum
  const gap = parse(flat('2026-10-01', '2026-10-19', [1000, 10000, 10], [500, 3000, 5], [12000, 9]).filter(x => x.d !== '2026-10-05')).rows;
  assert.equal(C.forecast(gap, FC_CFG, {}).monthSpend.google, null);
  // through past the October end: only October spend, no projected term
  const long = parse(flat('2026-10-01', '2026-11-05', [1000, 10000, 10], [500, 3000, 5], [12000, 9])).rows;
  const o = C.forecast(long, FC_CFG, {});
  assert.equal(o.throughDate, '2026-11-05');
  assert.equal(o.monthSpend.google, 31000);
  assert.equal(o.monthSpend.meta, 15500);
});

test('final fix M1: impossible sale dates set an error and fall back to the default dates (never an empty month list)', () => {
  const ERR = 'Sale dates in the settings are not valid';
  const withDates = (end, start) => C.resolveConfig(cfgCsv.replace('sale_end,2026-12-06,', 'sale_end,' + end + ',')
    .replace('sale_start,2026-10-13,', 'sale_start,' + (start == null ? '2026-10-13' : start) + ','), logCsv, parseCSV);
  // end before start, not a real day, month 13, after 31 Jan 2027, not zero-padded, a start that is not a real day
  for (const [end, start] of [['2026-10-01'], ['2026-02-30'], ['2026-13-01'], ['2027-02-01'], ['2026-12-6'], ['2026-12-06', '2026-11-31']]) {
    const c = withDates(end, start), at = end + ' / ' + start;
    assert.equal(c.error, ERR, at);
    assert.equal(c.saleStart, '2026-10-13', at);
    assert.equal(c.saleEnd, '2026-12-06', at);
    assert.deepEqual(C.saleMonths(c.saleStart, c.saleEnd), ['2026-10', '2026-11', '2026-12'], at);
    assert.ok(Object.values(c.budgets).every(v => v === null), at);   // no guessed budget, as for any unreadable setting
    assert.deepEqual(c.targets, { google_roas: 12, meta_roas: 12, mer: 12 }, at);
  }
  // the same through the log (the page's save path)
  assert.equal(C.resolveConfig(cfgCsv, [logHdr, '1,2026-10-14T01:00:00.000Z,g,sale_end,2026-10-05,,r1'].join('\n'), parseCSV).error, ERR);
  // fine: end on the start day, end on 31 Jan 2027, a blank cell (= not set, the default, no error)
  assert.equal(withDates('2026-10-13').error, null);
  assert.equal(withDates('2026-10-13').saleEnd, '2026-10-13');
  assert.equal(withDates('2027-01-31').error, null);
  assert.equal(withDates('2027-01-31').saleEnd, '2027-01-31');
  assert.equal(withDates('').error, null);
  assert.equal(withDates('').saleEnd, '2026-12-06');
});

test('final fix M2: torontoDate reads formatToParts, whatever shape format() returns', () => {
  const Real = Intl.DateTimeFormat;
  // older ICU builds format en-CA as MM/DD/YYYY: a format() that returns any other shape must not matter
  Intl.DateTimeFormat = function (loc, opts) {
    const f = new Real(loc, opts);
    return { format: () => '10/17/2026', formatToParts: d => f.formatToParts(d), resolvedOptions: () => f.resolvedOptions() };
  };
  try {
    assert.equal(C.torontoDate(new Date('2026-11-27T21:30:00Z')), '2026-11-27');
    assert.equal(C.torontoDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01');   // DST edge: 00:30 EDT
    assert.equal(C.torontoDate(new Date('2026-11-01T03:30:00Z')), '2026-10-31');   // 23:30 EDT
    assert.equal(C.torontoDate(new Date('2027-01-01T04:59:00Z')), '2026-12-31');   // year turns in Toronto at 05:00Z
  } finally { Intl.DateTimeFormat = Real; }
});
