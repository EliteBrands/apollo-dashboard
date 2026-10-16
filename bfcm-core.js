/* BFCM 2026 page maths: pure, no DOM, no fetch. UMD: module.exports under node, window.BFCM_CORE in the browser.
   parseCSV is injected (the page's own quote-aware parser) so tests and the page share one behaviour.
   Rule everywhere: a blank / uncomputable figure is null, never 0, NaN or Infinity. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BFCM_CORE = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAILY_HEADERS = ['Date', 'Google Spend', 'Google Revenue', 'Google Purchases', 'Meta Spend', 'Meta Revenue', 'Meta Purchases',
    'USA Revenue USD', 'CAN Revenue CAD', 'AUS Revenue AUD', 'FX USDCAD', 'FX AUDCAD', 'FX Provisional',
    'Store Revenue CAD', 'Store Orders', 'Google Pulled At', 'Meta Pulled At', 'Store Pulled At'];
  var CONFIG_HEADERS = ['Key', 'Value', 'Value 2'];
  var LOG_HEADERS = ['Seq', 'At', 'Who', 'Key', 'Value', 'Value 2', 'Request ID'];

  var DEFAULTS = { saleStart: '2026-10-13', saleEnd: '2026-12-06', google_roas: 12, meta_roas: 12, mer: 12 };
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAY_MS = 86400000;

  // ---- small helpers
  function num(s) {   // nullable number: blank / junk -> null (the page's nullableNum)
    if (s == null || s === '') return null;
    var v = parseFloat(String(s).replace(/[,$%\s]/g, ''));
    return isFinite(v) ? v : null;
  }
  function utc(iso) { return Date.parse(iso + 'T00:00:00Z'); }
  function addDays(iso, n) { return new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((utc(b) - utc(a)) / DAY_MS); }
  function eachDay(from, to) {
    var out = [];
    if (!from || !to || from > to) return out;
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  function minDate(a, b) { return a < b ? a : b; }
  function maxDate(a, b) { return a > b ? a : b; }
  function monthEnd(month) {   // 'YYYY-MM' -> last calendar day
    var y = +month.slice(0, 4), m = +month.slice(5, 7);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  function weekStart(iso) { var dow = new Date(utc(iso)).getUTCDay(); return addDays(iso, -((dow + 6) % 7)); }   // Monday
  function shortDate(iso) { return +iso.slice(8, 10) + ' ' + MONTH_NAMES[+iso.slice(5, 7) - 1].slice(0, 3); }
  function div(a, b) { return (a == null || b == null || b === 0) ? null : a / b; }
  function checkHeader(head, expected, exact) {
    if (!head || head.length < expected.length) return false;
    if (exact && head.length !== expected.length) return false;
    for (var i = 0; i < expected.length; i++) if (head[i] !== expected[i]) return false;
    return true;
  }

  function torontoDate(instant) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  }

  // ---- phases / months
  function phases(saleStart, saleEnd) {
    return [
      { key: 'early', label: 'Early Access', from: saleStart, to: '2026-11-25' },
      { key: 'bfcm', label: 'Black Friday + Cyber Monday', from: '2026-11-26', to: '2026-11-30' },
      { key: 'ext', label: 'Extension', from: '2026-12-01', to: saleEnd }
    ];
  }
  function saleMonths(saleStart, saleEnd) {
    var out = [], y = +saleStart.slice(0, 4), m = +saleStart.slice(5, 7);
    var last = saleEnd.slice(0, 7);
    for (var guard = 0; guard < 60; guard++) {
      var key = y + '-' + (m < 10 ? '0' : '') + m;
      if (key > last) break;
      out.push(key);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // ---- parse the daily sheet
  function parseDaily(csvText, parseCSV) {
    var recs;
    try { recs = parseCSV(csvText); } catch (e) { return { rows: [], error: 'BFCM Daily could not be parsed' }; }
    if (!recs || !recs.length || !checkHeader(recs[0], DAILY_HEADERS, false)) return { rows: [], error: 'BFCM Daily header does not match' };
    var byDate = {};
    for (var i = 1; i < recs.length; i++) {
      var r = recs[i], date = r[0];
      if (!ISO_RE.test(date)) continue;
      var gs = num(r[1]), ms = num(r[4]), sr = num(r[13]);
      byDate[date] = {
        date: date,
        google: gs == null ? null : { spend: gs, revenue: num(r[2]), purchases: num(r[3]), pulledAt: r[15] || null },
        meta: ms == null ? null : { spend: ms, revenue: num(r[5]), purchases: num(r[6]), pulledAt: r[16] || null },
        store: sr == null ? null : { revenueCad: sr, orders: num(r[14]), fxProvisional: /^true$/i.test(r[12] || ''), pulledAt: r[17] || null },
        pulled: { google: r[15] || null, meta: r[16] || null, store: r[17] || null }   // kept even when the source cell is blank, for staleness
      };
    }
    var rows = Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
    return { rows: rows, error: null };
  }

  // ---- resolve config + log
  function resolveConfig(configCsv, logCsv, parseCSV) {
    function failed(msg, saleStart, saleEnd) {
      var b = {};
      saleMonths(saleStart || DEFAULTS.saleStart, saleEnd || DEFAULTS.saleEnd).forEach(function (m) { b[m] = null; });
      return { saleStart: saleStart || DEFAULTS.saleStart, saleEnd: saleEnd || DEFAULTS.saleEnd, budgets: b,
        targets: { google_roas: DEFAULTS.google_roas, meta_roas: DEFAULTS.meta_roas, mer: DEFAULTS.mer }, last: {}, error: msg };
    }
    var cfgRecs, logRecs;
    try { cfgRecs = parseCSV(configCsv); } catch (e) { return failed('BFCM Config could not be parsed'); }
    try { logRecs = parseCSV(logCsv); } catch (e2) { return failed('BFCM Config Log could not be parsed'); }
    if (!cfgRecs || !cfgRecs.length || !checkHeader(cfgRecs[0], CONFIG_HEADERS, false)) return failed('BFCM Config header does not match');
    if (!logRecs || !logRecs.length || !checkHeader(logRecs[0], LOG_HEADERS, false)) return failed('BFCM Config Log header does not match');

    var vals = {};   // key -> {v, v2}
    var last = {};
    cfgRecs.slice(1).forEach(function (r) { if (r[0]) vals[r[0]] = { v: r[1] || '', v2: r[2] || '' }; });
    var logRows = logRecs.slice(1).filter(function (r) { return r[3]; });
    var seqOk = logRows.every(function (r) { return num(r[0]) != null; });
    if (seqOk) logRows = logRows.map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return (num(a.r[0]) - num(b.r[0])) || (a.i - b.i); }).map(function (x) { return x.r; });
    logRows.forEach(function (r) {
      vals[r[3]] = { v: r[4] || '', v2: r[5] || '' };
      last[r[3]] = { who: r[2] || '', at: r[1] || '' };
    });

    var saleStart = vals.sale_start && ISO_RE.test(vals.sale_start.v) ? vals.sale_start.v : DEFAULTS.saleStart;
    var saleEnd = vals.sale_end && ISO_RE.test(vals.sale_end.v) ? vals.sale_end.v : DEFAULTS.saleEnd;
    function target(k) { var t = vals['target ' + k] ? num(vals['target ' + k].v) : null; return t == null ? DEFAULTS[k] : t; }
    var budgets = {};
    saleMonths(saleStart, saleEnd).forEach(function (m) { budgets[m] = null; });
    Object.keys(vals).forEach(function (k) {
      var mm = /^budget (\d{4}-\d{2})$/.exec(k);
      if (!mm) return;
      var total = num(vals[k].v), pct = num(vals[k].v2);
      budgets[mm[1]] = total == null ? null : { total: total, pct: pct };
    });
    return { saleStart: saleStart, saleEnd: saleEnd, budgets: budgets,
      targets: { google_roas: target('google_roas'), meta_roas: target('meta_roas'), mer: target('mer') }, last: last, error: null };
  }

  // ---- row lookups
  function indexRows(rows) { var m = {}; rows.forEach(function (r) { m[r.date] = r; }); return m; }
  function has(map, d, source) { return !!(map[d] && map[d][source]); }

  // ---- complete-through (spec 13)
  function completeThroughMap(map, source, from, to) {
    var days = eachDay(from, to), through = null, broken = false, lastPresent = -1, i;
    for (i = 0; i < days.length; i++) {
      if (has(map, days[i], source)) { lastPresent = i; if (!broken) through = days[i]; } else broken = true;
    }
    var gaps = [];
    for (i = 0; i < lastPresent; i++) if (!has(map, days[i], source)) gaps.push(days[i]);
    return { through: through, gaps: gaps };
  }
  function completeThrough(rows, source, from, to) { return completeThroughMap(indexRows(rows), source, from, to); }

  // sum a field over from..to; null if any day is absent or the field blank
  function sumField(map, source, field, from, to) {
    var total = 0, days = eachDay(from, to);
    if (!days.length) return null;
    for (var i = 0; i < days.length; i++) {
      var o = map[days[i]] && map[days[i]][source];
      if (!o || o[field] == null) return null;
      total += o[field];
    }
    return total;
  }

  function windowTotals(rows, from, to) {
    var map = indexRows(rows);
    function spendSource(source) {
      var ct = completeThroughMap(map, source, from, to), out = { spend: null, revenue: null, purchases: null, roas: null, through: ct.through, gaps: ct.gaps };
      if (ct.through && !ct.gaps.length) {
        out.spend = sumField(map, source, 'spend', from, ct.through);
        out.revenue = sumField(map, source, 'revenue', from, ct.through);
        out.purchases = sumField(map, source, 'purchases', from, ct.through);
        out.roas = div(out.revenue, out.spend);
      }
      return out;
    }
    var g = spendSource('google'), m = spendSource('meta');
    var sct = completeThroughMap(map, 'store', from, to);
    var store = { revenue: null, through: sct.through, gaps: sct.gaps };
    if (sct.through && !sct.gaps.length) store.revenue = sumField(map, 'store', 'revenueCad', from, sct.through);
    var mer = { value: null, through: null };
    if (g.through && m.through && store.through) {
      mer.through = minDate(minDate(g.through, m.through), store.through);
      if (!g.gaps.length && !m.gaps.length && !store.gaps.length) {
        var gs = sumField(map, 'google', 'spend', from, mer.through), ms = sumField(map, 'meta', 'spend', from, mer.through);
        var sr = sumField(map, 'store', 'revenueCad', from, mer.through);
        mer.value = (gs == null || ms == null) ? null : div(sr, gs + ms);
      }
    }
    return { google: g, meta: m, store: store, mer: mer };
  }

  // ---- pacing
  function emptyBar() { return { spent: null, avgMtd: null, avg7: null, landsAt: null, through: null }; }
  // spendOf(date) -> number or null (missing). Bar runs start..through, projects to end.
  function bar(spendOf, through, start, end) {
    var b = emptyBar();
    if (!through || through < start) return b;
    var spent = 0, days = eachDay(start, through), i;
    for (i = 0; i < days.length; i++) { var v = spendOf(days[i]); if (v == null) return b; spent += v; }
    b.through = through;
    b.spent = spent;
    b.avgMtd = spent / days.length;
    var sum7 = 0, n7 = 0, w = eachDay(addDays(through, -6), through);
    for (i = 0; i < w.length; i++) { var x = spendOf(w[i]); if (x != null) { sum7 += x; n7++; } }
    b.avg7 = n7 ? sum7 / n7 : null;   // mean over the days of the last 7 that have a value
    var remaining = Math.max(0, daysBetween(through, end));
    b.landsAt = b.avg7 == null ? null : spent + b.avg7 * remaining;
    return b;
  }
  function bars(map, start, end) {
    var gct = completeThroughMap(map, 'google', start, end), mct = completeThroughMap(map, 'meta', start, end);
    var tthrough = (gct.through && mct.through) ? minDate(gct.through, mct.through) : null;
    var gs = function (d) { return has(map, d, 'google') ? map[d].google.spend : null; };
    var ms = function (d) { return has(map, d, 'meta') ? map[d].meta.spend : null; };
    var ts = function (d) { var a = gs(d), b = ms(d); return (a == null || b == null) ? null : a + b; };
    return { google: bar(gs, gct.through, start, end), meta: bar(ms, mct.through, start, end), total: bar(ts, tthrough, start, end), totalThrough: tthrough };
  }
  function bandOf(pct) {
    if (pct == null) return 'none';
    if (pct < 90) return 'under';
    if (pct <= 100) return 'ok';
    if (pct <= 105) return 'amber';
    return 'red';
  }
  function withBudget(b, budget) {
    var out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    out.budget = budget;
    out.pct = (budget == null || budget === 0 || b.landsAt == null) ? null : b.landsAt / budget * 100;
    out.band = bandOf(out.pct);
    return out;
  }
  function pacing(rows, month, budget, saleEnd, todayISO) {
    var map = indexRows(rows), start = month + '-01', end = monthEnd(month);
    if (saleEnd && saleEnd.slice(0, 7) === month) end = saleEnd;
    var gB = null, mB = null, tB = null;
    if (budget && budget.total != null) {
      tB = budget.total;
      if (budget.pct != null) { gB = budget.total * budget.pct / 100; mB = budget.total * (100 - budget.pct) / 100; }
    }
    var status;
    var b = todayISO < start ? { google: emptyBar(), meta: emptyBar(), total: emptyBar(), totalThrough: null } : bars(map, start, end);
    if (todayISO < start) status = 'not-started';
    else if (b.totalThrough && b.totalThrough >= end) status = 'ended';
    else status = 'running';
    return { status: status, google: withBudget(b.google, gB), meta: withBudget(b.meta, mB), total: withBudget(b.total, tB) };
  }

  function weekProjection(rows, todayISO) {
    var from = weekStart(todayISO), to = addDays(from, 6), b = bars(indexRows(rows), from, to);
    return { from: from, to: to, google: b.google, meta: b.meta, total: b.total };
  }

  // ---- date presets
  function presetRange(name, todayISO, cfg, rows, custom) {
    var dates = rows.map(function (r) { return r.date; }).sort();
    var oldest = dates.length ? dates[0] : null, newest = dates.length ? dates[dates.length - 1] : null;
    var year = cfg.saleStart.slice(0, 4), from, to, label;
    switch (name) {
      case 'sale': from = cfg.saleStart; to = newest ? minDate(newest, cfg.saleEnd) : cfg.saleEnd; label = 'Sale to date'; break;
      case 'last7': to = newest || todayISO; from = addDays(to, -6); label = 'Last 7 days'; break;
      case 'week': from = weekStart(todayISO); to = addDays(from, 6); label = 'This week'; break;
      case 'oct': from = year + '-10-01'; to = year + '-10-31'; label = 'October'; break;
      case 'nov': from = year + '-11-01'; to = year + '-11-30'; label = 'November'; break;
      case 'dec': from = year + '-12-01'; to = minDate(year + '-12-31', cfg.saleEnd); label = 'December'; break;
      default: from = custom && custom.from; to = custom && custom.to; label = null;
    }
    if (oldest) from = maxDate(from, oldest);
    if (newest) to = minDate(to, newest);
    if (to < from) to = from;
    if (label == null) label = shortDate(from) + ' to ' + shortDate(to);
    return { from: from, to: to, label: label };
  }

  // ---- staleness (spec 33), each source on its own
  function staleness(rows, now, hours) {
    var limit = (hours == null ? 30 : hours) * 3600000, out = {};
    ['google', 'meta', 'store'].forEach(function (s) {
      var best = null, bestMs = -Infinity;
      rows.forEach(function (r) {
        var p = (r.pulled && r.pulled[s]) || (r[s] && r[s].pulledAt) || null, t = p ? Date.parse(p) : NaN;
        if (isFinite(t) && t > bestMs) { bestMs = t; best = p; }
      });
      out[s] = { stale: best == null || (now.getTime() - bestMs) > limit, newest: best };
    });
    return out;
  }

  // ---- recent-day tags (spec 17)
  function lagTag(source, dateISO, todayISO) {
    var age = daysBetween(dateISO, todayISO);
    if (age < 0) return null;
    if (source === 'google' && age <= 2) return 'may still rise';
    if (source === 'meta' && age <= 7) return 'filling in';
    return null;
  }

  return {
    DAILY_HEADERS: DAILY_HEADERS, CONFIG_HEADERS: CONFIG_HEADERS, LOG_HEADERS: LOG_HEADERS,
    phases: phases, saleMonths: saleMonths, parseDaily: parseDaily, resolveConfig: resolveConfig, torontoDate: torontoDate,
    presetRange: presetRange, completeThrough: completeThrough, windowTotals: windowTotals, pacing: pacing,
    weekProjection: weekProjection, staleness: staleness, lagTag: lagTag,
    addDays: addDays, daysBetween: daysBetween, eachDay: eachDay
  };
}));
