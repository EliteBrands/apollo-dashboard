/* BFCM 2026 day-by-day view (browser only): window.BFCM_VIEW = { mount(el, ctx), unmount(), refresh(), _state }.
   ctx = { CHANNELS, parseCSV, esc, Chart } from index.html. Maths lives in bfcm-core.js (BFCM_CORE); this file is
   DOM, fetch and timers only. Rules: every sheet string (who) goes through ctx.esc into TEXT, never an attribute;
   attributes only ever carry numbers, ISO dates or fixed words. Clock = Date.now() only (never new Date() with no
   argument) so tools/render-sim.cjs can drive a fake clock. Every time shown is America/Toronto, labelled.
   Saving (spec 21, 22): the DOM side lives here, the network side (rid, POST, one retry, name storage) in
   bfcm-save.js (window.BFCM_SAVE). The typed name is set on its input by DOM property, never an attribute.
   Keyboard focus survives every rebuild (focusSel / refocus); save states are announced by the page's one live
   region #bf-live (index.html, outside the repainted content). */
(function (root) {
  'use strict';
  const SOURCES = ['google', 'meta', 'store'];
  const NAME = { google: 'Google', meta: 'Meta', store: 'store' };
  const TITLE = { google: 'Google', meta: 'Meta', store: 'Store' };
  const COL = { google: '#2393BE', meta: '#d55181', ink: '#E5E9F0', surface: '#0B1B26' };   // dataviz-validated pair on the card surface
  const SEED = 20261013;                 // forecast bootstrap seed: the same sliders always give the same range
  const STALE_REFETCH_MS = 300000;       // tab back to visible: refetch when the last fetch is older than 5 min
  const BACKOFF_CAP_MS = 3600000;        // repeated refresh errors: the wait doubles up to this (60 min)
  const HOLD_MS = 120000;                // after an ok save, an older gviz config cannot flip that key back for 2 min
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PRESETS = [['sale', 'Sale to date'], ['week', 'This week'], ['last7', 'Last 7 days'], ['oct', 'October'], ['nov', 'November'], ['dec', 'December']];
  const PRESET_MONTH = { oct: '-10', nov: '-11', dec: '-12' };

  let C = null, ctx = null, el = null, S = null, charts = [], timers = [], handlers = [], gen = 0;

  // ---------------------------------------------------------------- small helpers
  const E = s => ctx.esc(s);
  const isISO = s => !!C && C.realDate(String(s || ''));   // a real calendar day (30 Feb never passes)
  const dshort = iso => +iso.slice(8, 10) + ' ' + MON[+iso.slice(5, 7) - 1];
  const drange = (a, b) => a === b ? dshort(a) : (a.slice(0, 7) === b.slice(0, 7) ? +a.slice(8, 10) + ' to ' + dshort(b) : dshort(a) + ' to ' + dshort(b));
  const dlong = iso => DOW[new Date(Date.parse(iso + 'T00:00:00Z')).getUTCDay()] + ' ' + dshort(iso);
  const weekStart = iso => C.addDays(iso, -((new Date(Date.parse(iso + 'T00:00:00Z')).getUTCDay() + 6) % 7));
  const minD = (a, b) => a < b ? a : b, maxD = (a, b) => a > b ? a : b;
  const fin = v => typeof v === 'number' && isFinite(v);
  const m$ = v => { if (!fin(v)) return '-'; const r = Math.round(Math.abs(v)); return (v < 0 && r > 0 ? '-$' : '$') + r.toLocaleString('en-US'); };
  const k$ = v => !fin(v) ? '-' : Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? '$' + Math.round(v / 1000) + 'k' : m$(v);
  const x = v => fin(v) ? v.toFixed(1) + 'x' : '-';
  const join = parts => parts.filter(Boolean).join(' · ');
  const div = (a, b) => (fin(a) && fin(b) && b !== 0) ? a / b : null;
  const pctOf = (a, b) => (fin(a) && fin(b) && b > 0) ? Math.max(0, Math.min(100, a / b * 100)) : 0;
  const rgba = (hex, a) => 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
  function torontoToday() { return C.torontoDate(new Date(Date.now())); }
  // "16 Oct, 6:05 am" in Toronto for a UTC ISO instant ('' when unreadable)
  function torontoTime(iso) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      .formatToParts(new Date(t)).forEach(o => { p[o.type] = o.value; });
    return p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toLowerCase();
  }
  // "missing 14 Oct" / "missing 14 to 15 Oct, 18 Oct" (consecutive days folded)
  function dlist(dates) {
    const runs = [];
    dates.forEach(d => { const r = runs[runs.length - 1]; if (r && C.addDays(r[1], 1) === d) r[1] = d; else runs.push([d, d]); });
    const shown = runs.slice(0, 3).map(r => drange(r[0], r[1]));
    return shown.join(', ') + (runs.length > 3 ? ' and ' + (runs.length - 3) + ' more' : '');
  }
  // after the sale (Toronto today past sale end + 2 days) the data stops on purpose: no stale banners or marks
  const saleOver = () => !!(S && S.cfg && torontoToday() > C.addDays(S.cfg.saleEnd, 2));
  function staleNote(srcs) {
    if (!S.stale || saleOver()) return '';
    const st = srcs.filter(s => S.stale[s] && S.stale[s].stale).map(s => NAME[s]);
    if (!st.length) return '';
    const names = st.length === 1 ? st[0] : st.slice(0, -1).join(', ') + ' and ' + st[st.length - 1];
    return '<span class="bf-stalenote">uses stale ' + names + ' data</span>';
  }
  // per source, inside a window: a gap -> "missing <dates>", short -> "to <date>"
  function srcNote(o, to, label) {
    const pre = label ? label + ' ' : '';
    if (o.gaps && o.gaps.length) return pre + 'missing ' + dlist(o.gaps);
    if (!o.through) return pre + 'no data yet';
    if (o.through < to) return pre + 'to ' + dshort(o.through);
    return '';
  }
  // every patched area keeps keyboard focus where it was (see focusSel)
  function setHTML(id, html) { const n = document.getElementById(id); if (!n) return; const f = focusSel(); n.innerHTML = html; refocus(f); }
  function listen(target, ev, fn) { if (target && typeof target.addEventListener === 'function') { target.addEventListener(ev, fn); handlers.push([target, ev, fn]); } }
  const isVisible = () => typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
  function focusedInView() { const a = document.activeElement; return (a && el && typeof el.contains === 'function' && el.contains(a)) ? a : null; }
  // only a config number/text field being typed in (budget total, a target, the name) holds a background repaint
  // back; never a slider (forecast or split), a button or a date field, so a touched slider can never freeze the page
  const CONFIG_FIELDS = { 'budget-total': 1, target: 1, who: 1 };
  function editing() {
    const a = focusedInView();
    if (!a || a.tagName !== 'INPUT') return false;
    const type = String(a.type || '').toLowerCase();
    return (type === 'number' || type === 'text') && typeof a.getAttribute === 'function' && !!CONFIG_FIELDS[a.getAttribute('data-bf')];
  }
  // the 60 s timer's OWN repaint (today marker, staleness) also waits while a slider or a date field has focus, so a drag
  // or a date pick is never rebuilt under the person; its alerts + freshness area still updates, the rest on focusout
  function tickHeld() {
    const a = focusedInView();
    const type = a && a.tagName === 'INPUT' ? String(a.type || '').toLowerCase() : '';
    return type === 'range' || type === 'date';
  }
  // Keyboard focus survives a rebuild: before innerHTML is replaced the focused control is named by its id or its
  // data-bf (+ data-v / data-k / data-key), and the same control is focused again afterwards. Those values are fixed
  // words, months and keys the view itself writes (never sheet text); anything else is not restored.
  const SAFE_ID = /^[A-Za-z][\w-]*$/, SAFE_VAL = /^[\w .:-]*$/;
  function focusSel() {
    const a = focusedInView();
    if (!a || typeof a.getAttribute !== 'function') return null;
    if (a.id && SAFE_ID.test(a.id)) return '#' + a.id;
    const bf = a.getAttribute('data-bf');
    if (!bf || !SAFE_VAL.test(bf)) return null;
    let sel = '[data-bf="' + bf + '"]';
    for (const n of ['data-v', 'data-k', 'data-key']) {
      const v = a.getAttribute(n);
      if (v == null) continue;
      if (!SAFE_VAL.test(v)) return null;
      sel += '[' + n + '="' + v + '"]';
    }
    return sel;
  }
  function refocus(sel) {
    if (!sel || !el || typeof el.querySelector !== 'function') return;
    let n = null;
    try { n = el.querySelector(sel); } catch (e) { return; }
    if (n && n !== document.activeElement && typeof n.focus === 'function') { try { n.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
  }

  // ---------------------------------------------------------------- lifecycle
  function mount(target, context) {
    if (S && S.mounted) unmount();
    C = root.BFCM_CORE; ctx = context; el = target; gen++;
    const B = ctx.CHANNELS.bfcm;
    S = api._state = {
      mounted: true, loaded: false, rows: [], cfg: null, dailyError: null, fetchError: null, cfgKept: false,
      window: { preset: 'sale', from: null, to: null, label: '' }, custom: null, month: null,
      sliders: neutralSliders(), unsaved: {}, today: torontoToday(), stale: null, staleKey: '', totals: null, forecast: null,
      lastFetchAt: 0, lastOkAt: 0, pendingPaint: false, pendingData: false, sig: '', open: null, dataVersion: 0, paintedVersion: 0,
      saving: {}, who: SAVER() ? SAVER().loadName() : '', pendingRid: {}, holds: {}, focusSave: null,
      fetchSeq: 0, appliedSeq: 0, errStreak: 0, pollSkip: 0,
    };
    el.className = '';
    el.innerHTML = '<div class="bf"><div class="loading" role="status">Loading the day-by-day sale data…</div></div>';
    listen(el, 'click', onClick); listen(el, 'input', onInput); listen(el, 'change', onChange); listen(el, 'focusout', onFocusOut);
    listen(document, 'visibilitychange', onVisibility);
    timers.push(setInterval(poll, B.refreshMs || 900000));
    timers.push(setInterval(tick, 60000));
    return refresh();
  }
  function unmount() {
    timers.forEach(t => clearInterval(t)); timers = [];
    handlers.forEach(h => { if (typeof h[0].removeEventListener === 'function') h[0].removeEventListener(h[1], h[2]); }); handlers = [];
    destroyCharts();
    announce('');
    if (S) S.mounted = false;
    gen++;   // an in-flight fetch from this mount never paints
  }
  // the 15-minute poll. After 2 failed refreshes in a row it skips turns, so the wait doubles (30, then 60 min, capped);
  // a good refresh resets it. A tab coming back to visible still refetches at once.
  function poll() {
    if (!S || !S.mounted || !isVisible()) return;
    if (S.pollSkip > 0) { S.pollSkip--; return; }
    refresh();
  }
  function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

  // ---------------------------------------------------------------- data
  function get(url) {
    return fetch(url, { cache: 'no-store' })
      .then(r => { if (r.ok === false) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(t => /^\s*</.test(t) ? { err: 'html' } : { text: t }, () => ({ err: 'net' }));
  }
  function refresh() {
    if (!S || !S.mounted) return Promise.resolve();
    const my = gen, B = ctx.CHANNELS.bfcm, seq = ++S.fetchSeq;
    S.lastFetchAt = Date.now();
    return Promise.all([get(B.dailyCsvUrl), get(B.configCsvUrl), get(B.logCsvUrl)]).then(r => {
      if (my !== gen || !S.mounted) return;
      if (seq < S.appliedSeq) return;   // an older refresh answering after a newer one never overwrites it
      S.appliedSeq = seq;
      const base = B.refreshMs || 900000, maxSkip = Math.max(0, Math.floor(BACKOFF_CAP_MS / base) - 1);
      S.errStreak = r.some(o => o.err) ? S.errStreak + 1 : 0;
      S.pollSkip = S.errStreak >= 2 ? Math.min(maxSkip, Math.pow(2, S.errStreak - 1) - 1) : 0;
      // nothing changed since the last load: keep the page as it is (chart, open panels); the 60 s timer
      // still re-checks staleness and the today marker
      const sig = r.map(o => o.err ? '!' + o.err : o.text).join('\u0000');
      if (S.loaded && sig === S.sig) { if (!r[0].err) S.lastOkAt = Date.now(); return; }
      S.sig = sig;
      try { apply(r[0], r[1], r[2]); paint(); } catch (e) { broken(e); }
    });
  }
  // a fault while reading or showing the figures: a plain alert in place of the view (never the loading text left
  // on screen), the detail in the console; the next refresh tries again even when the sheet has not changed
  function broken(e) {
    try { if (typeof console !== 'undefined' && console.error) console.error('BFCM view could not show the figures:', e); } catch (_) { /* no console */ }
    try { destroyCharts(); } catch (_) { charts = []; }
    if (S) S.sig = '';
    el.className = '';
    el.innerHTML = '<div class="bf"><div class="bf-alert" role="alert">Something went wrong showing these figures. Please refresh the page.</div></div>';
  }
  function apply(d, c, l) {
    if (d.err) S.fetchError = S.rows.length ? 'refresh' : 'load';   // a failed refresh keeps the last good rows
    else {
      const p = C.parseDaily(d.text, ctx.parseCSV);
      S.fetchError = null; S.dailyError = p.error; S.rows = p.error ? [] : p.rows;
      if (!p.error) S.lastOkAt = Date.now();
    }
    // config + log: any failed fetch (network, or Google's HTML error page) keeps the last good settings; with no good
    // settings yet the unreadable tab is an error (never a guessed budget)
    if ((c.err || l.err) && S.cfg && !S.cfg.error) { S.cfgKept = true; }
    else { S.cfg = C.resolveConfig(c.text || '', l.text || '', ctx.parseCSV); S.cfgKept = false; keepHolds(); }
    S.loaded = true;
    S.dataVersion++;
  }
  // gviz can serve the config from before this person's save for a short while. For HOLD_MS after an ok save (or until
  // gviz shows that value, or a newer save by anyone) the value just saved stays on screen instead of flipping back.
  function holdSaved(key) {
    const lk = S.cfg.last[key];
    S.holds[key] = { until: Date.now() + HOLD_MS, sig: savedSig(key), val: valueOf(key), last: lk ? { who: lk.who, at: lk.at } : null };
  }
  function keepHolds() {
    Object.keys(S.holds).forEach(k => {
      const h = S.holds[k], nl = S.cfg.last[k];
      const newer = !!(nl && nl.at && h.last && h.last.at && String(nl.at) > String(h.last.at));
      if (S.cfg.error || Date.now() > h.until || savedSig(k) === h.sig || newer) { delete S.holds[k]; return; }
      putValue(k, h.val);
      if (h.last) S.cfg.last[k] = { who: h.last.who, at: h.last.at };
    });
  }
  function tick() {
    if (!S || !S.mounted || !S.loaded) return;
    const st = S.rows.length ? C.staleness(S.rows, new Date(Date.now())) : null;
    if (torontoToday() !== S.today || staleKeyOf(st) !== S.staleKey) paint(false, true);
  }
  const staleKeyOf = st => st ? SOURCES.map(s => st[s].stale ? 1 : 0).join('') : '';
  function onVisibility() { if (S && S.mounted && isVisible() && Date.now() - S.lastFetchAt > STALE_REFETCH_MS) refresh(); }

  // ---------------------------------------------------------------- state helpers
  function neutralSliders() { return { basis: 'last7', spend: { google: 0, meta: 0 }, roas: { google: 1, meta: 1 } }; }
  function defaultMonth() {
    const ms = C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd), m = S.today.slice(0, 7);
    if (ms.indexOf(m) >= 0) return m;
    return S.today < S.cfg.saleStart ? ms[0] : ms[ms.length - 1];
  }
  function computeWindow() {
    const w = S.window;
    if (!S.rows.length) { w.from = w.to = null; w.label = ''; return; }
    const r = C.presetRange(w.preset === 'custom' ? 'custom' : w.preset, S.today, S.cfg, S.rows, S.custom);
    w.from = r.from; w.to = r.to; w.label = r.label;
  }
  const targets = () => S.cfg.error ? null : S.cfg.targets;
  // the budget the page shows: an unsaved edit wins over the saved value (live preview), never on a config error
  function budgetFor(month) {
    if (S.cfg.error) return null;
    const u = S.unsaved['budget ' + month];
    if (u) return u.v == null ? null : { total: u.v, pct: u.v2 };
    return S.cfg.budgets[month] || null;
  }
  function savedSig(key) {
    const m = /^budget (\d{4}-\d{2})$/.exec(key);
    if (m) { const b = S.cfg.budgets[m[1]]; return b ? b.total + '|' + (b.pct == null ? '' : b.pct) : '|'; }
    const t = /^target (google_roas|meta_roas|mer)$/.exec(key);
    return t ? String(S.cfg.targets[t[1]]) : '';
  }
  function savedText(key) {
    const m = /^budget (\d{4}-\d{2})$/.exec(key);
    if (m) { const b = S.cfg.budgets[m[1]]; return b ? m$(b.total) + (b.pct == null ? '' : ' · Google ' + b.pct + '%') : 'no budget'; }
    const t = /^target (google_roas|meta_roas|mer)$/.exec(key);
    return t ? x(S.cfg.targets[t[1]]) : '';
  }
  // one key's saved value in the page's settings copy ({total, pct} or null for a budget, a number for a target)
  function valueOf(key) {
    const m = /^budget (\d{4}-\d{2})$/.exec(key), t = /^target (google_roas|meta_roas|mer)$/.exec(key);
    if (m) { const b = S.cfg.budgets[m[1]]; return b ? { total: b.total, pct: b.pct } : null; }
    return t ? S.cfg.targets[t[1]] : null;
  }
  function putValue(key, v) {
    const m = /^budget (\d{4}-\d{2})$/.exec(key), t = /^target (google_roas|meta_roas|mer)$/.exec(key);
    if (m) S.cfg.budgets[m[1]] = v ? { total: v.total, pct: v.pct } : null;
    else if (t && fin(v)) S.cfg.targets[t[1]] = v;
  }
  // a typed name, isolated so a right-to-left or odd name cannot reorder the text around it
  const whoHTML = w => '<bdi>' + E(w) + '</bdi>';
  // "Newer saved value: <v> by <who>" when the saved value moved under an unsaved edit (spec 10)
  function newerNote(key) {
    const u = S.unsaved[key];
    if (!u || savedSig(key) === u.base) return '';
    const last = S.cfg.last[key];
    return '<div class="bf-newer">Newer saved value: ' + savedText(key) + (last && last.who ? ' by ' + whoHTML(last.who) : '') + '</div>';
  }
  function editableKey(key) {
    const m = /^budget (\d{4}-\d{2})$/.exec(key);
    if (m) return C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd).indexOf(m[1]) >= 0;
    return /^target (google_roas|meta_roas|mer)$/.test(key);
  }
  const numOrNull = v => (v === '' || v == null || !isFinite(+v)) ? null : +v;

  // ---------------------------------------------------------------- public actions (the DOM handlers and the sim use the same ones)
  // user actions paint at once (true); only background refreshes wait for a focused input
  function setPreset(name) { if (!S) return; S.window.preset = PRESETS.some(p => p[0] === name) ? name : 'sale'; S.custom = null; paint(true); }
  function setCustom(from, to) { if (!S || !isISO(from) || !isISO(to)) return; S.window.preset = 'custom'; S.custom = { from: minD(from, to), to: maxD(from, to) }; paint(true); }
  function setMonth(m) { if (!S || !S.cfg || C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd).indexOf(m) < 0) return; S.month = m; paint(true); }
  function setBasis(b) { if (!S) return; S.sliders.basis = (b === 'last14' || b === 'sale') ? b : 'last7'; patchForecast(true); }
  function setSlider(k, v) {
    if (!S) return;
    const [kind, src] = String(k).split('.');
    if (!(kind === 'spend' || kind === 'roas') || !(src === 'google' || src === 'meta')) return;
    const lo = kind === 'spend' ? -0.5 : 0.5, hi = kind === 'spend' ? 1 : 1.5, neutral = kind === 'spend' ? 0 : 1;
    S.sliders[kind][src] = Math.min(hi, Math.max(lo, fin(+v) ? +v : neutral));
    patchForecast(false);
  }
  function resetSliders() { if (!S) return; S.sliders = neutralSliders(); patchForecast(true); }
  // config edits: only when saving is possible (configWrites on AND an endpoint); marks the control Unsaved (a new edit
  // clears the last save note)
  function edit(key, v, v2) {
    if (!S || !S.mounted || !canEdit() || !S.cfg || S.cfg.error || !editableKey(key)) return false;
    if (S.saving[key] && !inFlight(key)) delete S.saving[key];
    const prev = S.unsaved[key];
    S.unsaved[key] = { v: numOrNull(v), v2: numOrNull(v2), base: prev ? prev.base : savedSig(key) };
    const u = S.unsaved[key];
    if ((u.v == null ? '' : u.v) + (/^budget/.test(key) ? '|' + (u.v2 == null ? '' : u.v2) : '') === u.base) delete S.unsaved[key];   // typed back to the saved value
    patchMeta(); setHTML('bf-pace', paceHTML());
    return true;
  }

  // ---------------------------------------------------------------- saving (spec 21, 22); the network side is bfcm-save.js
  const TARGET_KEYS = ['target google_roas', 'target meta_roas', 'target mer'];
  const SAVER = () => root.BFCM_SAVE || null;
  const savingOn = () => !!(ctx.CHANNELS.bfcm.endpointUrl && SAVER());
  // edit controls only when a save can actually happen; configWrites on with no endpoint shows the read-only block
  const canEdit = () => !!(ctx.CHANNELS.bfcm.configWrites && savingOn());
  const inFlight = k => !!(S.saving[k] && (S.saving[k].state === 'saving' || S.saving[k].state === 'checking'));
  function patchMeta() { setHTML('bf-budget-meta', budgetMetaHTML()); setHTML('bf-targets-meta', targetsMetaHTML()); }
  // every save state change goes through setSt, so the page's one live region (#bf-live in index.html, outside the
  // repainted view) announces it; the per-key status lines under the controls are visual only
  const KEY_LABEL = { 'target google_roas': 'Google ROAS target', 'target meta_roas': 'Meta ROAS target', 'target mer': 'MER target' };
  const keyLabel = k => { const m = /^budget \d{4}-(\d{2})$/.exec(k); return m ? MONTH[+m[1] - 1] + ' budget' : (KEY_LABEL[k] || k); };
  function announce(text) { const n = document.getElementById('bf-live'); if (n) n.textContent = text; }
  function setSt(key, st) { S.saving[key] = st; announce(keyLabel(key) + ': ' + statusPlain(st)); }
  // a value the endpoint would refuse is named beside its control and never sent
  function blockText(key) {
    const u = S.unsaved[key];
    if (!u) return '';
    if (/^target /.test(key)) {
      if (u.v == null || u.v < 1 || u.v > 50) return 'Target must be between 1 and 50';
      return Math.abs(u.v * 10 - Math.round(u.v * 10)) > 1e-9 ? 'Use at most one decimal place' : '';
    }
    return u.v != null && u.v2 == null ? 'Move the Google / Meta split slider to set the split, then save.' : '';
  }
  // one person's save: the month's budget (scope 'budget') or every unsaved target (scope 'targets'), one request each
  function save(scope) {
    if (!S || !S.mounted || !S.cfg || S.cfg.error || !canEdit()) return Promise.resolve(false);
    const keys = (scope === 'targets' ? TARGET_KEYS : ['budget ' + S.month]).filter(k => S.unsaved[k] && !inFlight(k) && !blockText(k));
    if (!keys.length) return Promise.resolve(false);
    const who = String(S.who || '').trim();
    if (!who) { keys.forEach(k => setSt(k, { state: 'needname', text: 'Type your name in the box above, then save.' })); patchMeta(); return Promise.resolve(false); }
    SAVER().saveName(who);
    const my = gen, live = () => my === gen && S.mounted;
    keys.forEach(k => setSt(k, { state: 'saving' }));   // queued keys read "Saving…" and their button waits
    patchMeta();
    const runs = keys.map(k => (saveQueue = saveQueue.then(() => pause(lastAnswerAt + SAVE_GAP_MS - Date.now())).then(() => saveOne(k, who, my))
      .catch(() => { if (live() && inFlight(k)) { setSt(k, { state: 'unconfirmed' }); patchMeta(); } })));   // never stuck, never "Nothing changed"
    return Promise.all(runs).then(() => { if (live()) returnFocus(scope); return true; });
  }
  // when a save finishes, keyboard focus goes back to its Save button if it was lost on the way (refocus keeps it in the
  // normal case); focus the person moved elsewhere is left alone
  function returnFocus(scope) {
    if (S.focusSave !== scope) return;
    S.focusSave = null;
    const a = document.activeElement;
    if (!a || a === document.body) refocus('[data-bf="save"][data-v="' + scope + '"]');
  }
  // ONE page-wide queue: each POST waits SAVE_GAP_MS after the previous answer, because the server refuses a write less
  // than 3 s after its newest row (MIN_GAP_MS). So several targets, or a budget right after a target, never refuse
  // each other. The queue outlives a remount (a step from an old mount just returns), so the gap holds across it too.
  const SAVE_GAP_MS = 3500;
  let saveQueue = Promise.resolve(), lastAnswerAt = -Infinity;
  const pause = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
  // only these refusals put the saved value back; busy, closed or anything else keeps the typed edit to try again
  const REVERTS = { changed: 1, invalid: 1, 'log full': 1 };
  const bodySig = f => [f.key, f.value, f.value2, f.expect, f.expect2].join('|');
  function saveOne(key, who, my) {
    const live = () => my === gen && S.mounted;
    if (!live()) return null;
    const u = S.unsaved[key];
    if (!u || blockText(key)) { delete S.saving[key]; patchMeta(); return null; }   // typed back (or to a value that cannot be sent) while queued
    const isB = /^budget /.test(key), base = u.base.split('|'), txt = v => (v == null ? '' : String(v));
    // expect = the saved value this edit started from, so a change saved meanwhile by someone else is never overwritten
    const f = { key, value: txt(u.v), value2: isB ? txt(u.v2) : '', expect: base[0], expect2: isB ? (base[1] || '') : '', who };
    // a save left "Not confirmed" keeps its rid: the same change saved again reuses it, so one that did land answers
    // duplicate (Saved) instead of "someone else saved a change to this first"
    const pr = S.pendingRid[key];
    if (pr && pr.sig === bodySig(f)) f.rid = pr.rid;
    const sent = { v: u.v, v2: u.v2 };
    setSt(key, { state: 'saving' }); patchMeta();
    return SAVER().saveKey(ctx.CHANNELS.bfcm.endpointUrl, f,
      { onRetry: () => { if (live()) { setSt(key, { state: 'checking' }); patchMeta(); } } }).then(r => {
      lastAnswerAt = Date.now();   // the next queued POST waits SAVE_GAP_MS from here
      if (!live()) return;
      if (r.state === 'unconfirmed') { S.pendingRid[key] = { rid: r.rid, sig: bodySig(f) }; setSt(key, { state: 'unconfirmed' }); }   // no server answer: the edit stays, marked Unconfirmed
      else {
        delete S.pendingRid[key];
        const o = r.response, cur = o.current && typeof o.current === 'object' ? o.current : null;
        const adopted = cur ? adopt(cur) : false;
        if (o.ok && !adopted) patchSaved(key, sent, who, cur && cur[key] && typeof cur[key] === 'object' ? cur[key] : null);
        // only the edit that was sent is settled: one typed while it was in flight stays Unsaved (after an ok save it now
        // builds on the value just saved); saved -> the control shows the saved value; a final refusal reverts (spec 22)
        const now = S.unsaved[key], same = !!now && now.v === sent.v && now.v2 === sent.v2;
        if (o.ok) { if (same) delete S.unsaved[key]; else if (now) now.base = savedSig(key); holdSaved(key); }
        else if (same && Object.prototype.hasOwnProperty.call(REVERTS, String(o.error))) delete S.unsaved[key];
        const lk = S.cfg.last[key] || {};
        setSt(key, !o.ok ? { state: 'rejected', text: 'Not saved: ' + SAVER().reasonText(o) + '. Nothing changed.' }
          : { state: 'saved', at: String(lk.at || ''), who: String(lk.who || who), time: torontoTime(lk.at) || torontoTime(new Date(Date.now()).toISOString()) });
      }
      patchMeta(); paint();   // the status shows at once; the full repaint waits while a config field has focus
    }).catch(() => { lastAnswerAt = Date.now(); if (live()) { setSt(key, { state: 'unconfirmed' }); patchMeta(); } });   // never stuck on "Saving…", never "Nothing changed"
  }
  // the server's current values, read exactly as a page load reads the two CSV tabs (only a complete map is adopted)
  function adopt(cur) {
    const need = C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd).map(m => 'budget ' + m).concat(TARGET_KEYS);
    if (!need.every(k => cur[k] && typeof cur[k] === 'object')) return false;
    const t = SAVER().currentToCsv(cur, C.CONFIG_HEADERS, C.LOG_HEADERS), r = C.resolveConfig(t.config, t.log, ctx.parseCSV);
    if (r.error) return false;
    S.cfg = r; S.cfgKept = false;
    return true;
  }
  // an ok answer whose `current` cannot be adopted (incomplete, or a sale month the page does not know) still shows the
  // value just saved: it goes into the page's copy of the settings from what was sent
  function patchSaved(key, sent, who, ck) {
    putValue(key, sent.v == null ? null : (/^budget /.test(key) ? { total: sent.v, pct: sent.v2 } : sent.v));
    S.cfg.last[key] = { who: ck && ck.who ? String(ck.who) : who, at: ck && ck.at ? String(ck.at) : new Date(Date.now()).toISOString() };
  }
  const FSI = '⁨', PDI = '⁩';   // isolate a typed name in plain text (the live region); <bdi> does it in HTML
  function statusPlain(st) {
    if (st.state === 'saved') return 'Saved for everyone · ' + FSI + st.who + PDI + ' · ' + st.time + ' Toronto time';
    return st.state === 'saving' ? 'Saving…' : st.state === 'checking' ? 'Save outcome unknown, checking...' : st.state === 'unconfirmed' ? 'Not confirmed. Reload to see what is saved.' : String(st.text || '');
  }
  function statusHTML(st, label) {
    const pre = E(label ? label + ': ' : '');
    return st.state === 'saved' ? pre + E('Saved for everyone · ') + whoHTML(st.who) + E(' · ' + st.time + ' Toronto time') : pre + E(statusPlain(st));
  }
  // per key: Unsaved / Unconfirmed, else "Set by" (or this person's Saved line while it is the newest), the newer note,
  // a value that cannot be sent, the status
  function keyMeta(key, label) {
    const u = S.unsaved[key], st = S.saving[key], last = S.cfg.last[key] || {};
    const fresh = !!st && st.state === 'saved' && String(last.at || '') === st.at;
    let h = u ? (label ? label + ' ' : '') + '<span class="bf-unsaved">' + (st && st.state === 'unconfirmed' ? 'Unconfirmed' : 'Unsaved') + '</span>' : (fresh || label ? '' : setBy(key));
    h += newerNote(key);
    const bt = blockText(key);
    if (bt) h += '<div class="bf-status bf-st-needname">' + E((label ? label + ': ' : '') + bt) + '</div>';
    if (st && (st.state !== 'saved' || fresh)) h += '<div class="bf-status bf-st-' + st.state + '">' + statusHTML(st, label) + '</div>';
    return h;
  }
  // aria-disabled, never disabled: the button stays focusable, so keyboard focus survives a save
  function saveBtnHTML(scope, keys) {
    const ready = keys.some(k => S.unsaved[k] && !blockText(k)) && !keys.some(inFlight);
    return '<button type="button" class="bf-save" data-bf="save" data-v="' + scope + '"' + (ready ? '' : ' aria-disabled="true"') + '>Save for everyone</button>';
  }

  function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest('[data-bf]') : null;
    if (!t || !S || !S.mounted) return;
    const a = t.getAttribute('data-bf'), v = t.getAttribute('data-v');
    if (a === 'preset') setPreset(v);
    else if (a === 'month') setMonth(v);
    else if (a === 'basis') setBasis(v);
    else if (a === 'reset') resetSliders();
    else if (a === 'save' && t.getAttribute('aria-disabled') !== 'true') { S.focusSave = document.activeElement === t ? v : null; save(v); }
  }
  function onInput(e) {
    const t = e.target;
    if (!t || !t.getAttribute || !S || !S.mounted) return;
    const a = t.getAttribute('data-bf');
    if (a === 'slider') setSlider(t.getAttribute('data-k'), +t.value / 100);   // spend -50..100 % -> -0.5..1; ROAS 50..150 % -> 0.5..1.5
    else if (a === 'budget-total' || a === 'budget-pct') {
      const key = 'budget ' + S.month, tot = document.getElementById('bf-budget-total'), pct = document.getElementById('bf-budget-pct');
      const total = tot ? tot.value : null, blank = total == null || String(total).trim() === '';
      if (a === 'budget-pct' && blank) return;   // no split without a total
      if (pct && a === 'budget-total') pct.disabled = blank;   // the split slider wakes up once a total is typed
      // the split goes with the edit only once the slider was moved; otherwise the saved split (blank stays blank), so
      // typing a total never silently creates the slider's 50 / 50 default
      const u = S.unsaved[key], saved = S.cfg && !S.cfg.error ? S.cfg.budgets[S.month] : null;
      edit(key, total, a === 'budget-pct' ? (pct ? pct.value : null) : u ? u.v2 : (saved && saved.pct != null ? saved.pct : null));
    } else if (a === 'target') edit(t.getAttribute('data-key'), t.value);
    else if (a === 'who') S.who = String(t.value || '');
  }
  function onChange(e) {
    const t = e.target;
    if (!t || !t.getAttribute || !S || !S.mounted) return;
    const a = t.getAttribute('data-bf');
    if (a === 'from' || a === 'to') {
      const f = document.getElementById('bf-from'), to = document.getElementById('bf-to');
      if (f && to) setCustom(f.value, to.value);
    }
  }
  // a held repaint runs once focus has left the field that held it (a 60 s repaint held by a slider or date field waits
  // while focus stays on one; one held for new data only waits for the config fields)
  function onFocusOut() { if (S && S.pendingPaint) setTimeout(() => { if (S && S.mounted && S.pendingPaint && !editing() && (S.pendingData || !tickHeld())) paint(); }, 0); }

  // ---------------------------------------------------------------- render
  // userAction: a person's own action paints at once. Otherwise a focused config field holds the repaint, and a repaint
  // from the 60 s timer (fromTick) is also held by a focused slider or date field; the alerts area is always current.
  function paint(userAction, fromTick) {
    if (!S || !S.mounted || !S.loaded) return;
    if (!userAction && (editing() || (fromTick && tickHeld()))) {
      // a background repaint never yanks a field out from under the typist, but the alerts and the freshness
      // line are always current (stale banners never wait for focus to leave)
      S.pendingPaint = true;
      if (!fromTick) S.pendingData = true;
      S.stale = S.rows.length ? C.staleness(S.rows, new Date(Date.now())) : null;
      S.staleKey = staleKeyOf(S.stale);
      setHTML('bf-alerts', alertsHTML());
      if (S.rows.length) setHTML('bf-fresh', freshHTML());
      return;
    }
    const focus = focusSel();   // named before the rebuild, focused again after it
    S.pendingPaint = false; S.pendingData = false;
    S.paintedVersion = S.dataVersion;
    const isOpen = sel => { const n = typeof el.querySelector === 'function' ? el.querySelector(sel) : null; return !!(n && n.open); };
    S.open = { days: isOpen('.bf-days'), targets: isOpen('.bf-targets') };   // a repaint keeps open panels open
    destroyCharts();
    S.today = torontoToday();
    S.stale = S.rows.length ? C.staleness(S.rows, new Date(Date.now())) : null;
    S.staleKey = staleKeyOf(S.stale);
    if (!S.month || C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd).indexOf(S.month) < 0) S.month = defaultMonth();   // the sale window can move under a picked month
    computeWindow();
    let h = '<div class="bf"><div id="bf-alerts" class="bf-alerts">' + alertsHTML() + '</div>' + phaseHTML();
    if (S.rows.length) h += dateBarHTML() + budgetHTML() + returnsHTML() + forecastHTML();
    el.className = '';
    el.innerHTML = h + '</div>';
    const wb = document.getElementById('bf-who');
    if (wb) wb.value = S.who || '';   // by property: a typed name never goes into an attribute
    if (S.rows.length) { drawChart(); fcLabels(); }
    refocus(focus);
  }

  function alertsHTML() {
    let h = '';
    const over = saleOver();
    if (S.pendingPaint && S.dataVersion !== S.paintedVersion) h += '<div class="bf-stale" role="status">Newer figures have loaded. They appear when you finish typing in the budget, target or name field.</div>';
    if (S.fetchError === 'load') h += '<div class="bf-alert" role="alert">We could not load the BFCM sale data just now. The page keeps trying, or refresh the page.</div>';
    if (S.fetchError === 'refresh') h += '<div class="bf-stale" role="status">The latest refresh did not load, so these figures are from the load at ' + torontoTime(new Date(S.lastOkAt).toISOString()) + ' Toronto time.</div>';
    if (S.dailyError) h += '<div class="bf-alert" role="alert">The day-by-day data feed needs attention, so the figures are hidden rather than risk showing the wrong numbers. Please let your Elite Brands team know.</div>';
    if (!S.fetchError && !S.dailyError && !S.rows.length) h += '<div class="bf-info" role="status">The sale data has not started coming in yet.</div>';
    if (over && S.rows.length) h += '<div class="bf-info" role="status">The sale has ended. These are the final figures.</div>';
    if (S.rows.length && S.stale && !over) SOURCES.forEach(s => {
      const o = S.stale[s];
      if (!o.stale) return;
      h += '<div class="bf-stale" role="status"><b>' + (o.newest ? TITLE[s] + ' data last updated ' + torontoTime(o.newest) + ' Toronto time.' : TITLE[s] + ' data has not loaded yet.') +
        '</b> Every figure that uses it is marked "uses stale ' + NAME[s] + ' data".</div>';
    });
    return h;
  }

  function phaseHTML() {
    const cfg = S.cfg, t = S.today, total = C.daysBetween(cfg.saleStart, cfg.saleEnd) + 1, day = C.daysBetween(cfg.saleStart, t) + 1;
    const segs = C.phases(cfg.saleStart, cfg.saleEnd).map(p => '<div class="bf-ph' + (t >= p.from && t <= p.to ? ' now' : '') + '"><b>' + p.label + '</b><span>' + drange(p.from, p.to) + '</span></div>').join('');
    const where = t < cfg.saleStart ? 'the sale starts ' + dshort(cfg.saleStart) : t > cfg.saleEnd ? 'the sale ended ' + dshort(cfg.saleEnd) : 'day ' + day + ' of ' + total;
    const left = Math.max(0, Math.min(100, (day - 0.5) / total * 100));
    return '<div><div class="bf-phase">' + segs + '</div><div class="bf-prog" aria-hidden="true"><i style="left:' + left.toFixed(2) + '%"></i></div>' +
      '<div class="bf-today">Today · ' + dshort(t) + ' · ' + where + '</div></div>';
  }

  function dateBarHTML() {
    const w = S.window, ms = C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd).map(m => m.slice(4));
    const btn = p => '<button type="button" class="bf-pre" data-bf="preset" data-v="' + p[0] + '" aria-pressed="' + (w.preset === p[0]) + '">' + p[1] + '</button>';
    const presets = PRESETS.filter(p => !PRESET_MONTH[p[0]] || ms.indexOf(PRESET_MONTH[p[0]]) >= 0).map(btn).join('');
    const first = S.rows[0].date, last = S.rows[S.rows.length - 1].date, n = C.daysBetween(w.from, w.to) + 1;
    return '<div><div class="bf-datebar" role="group" aria-label="Date range">' + presets +
      '<label>From <input type="date" id="bf-from" data-bf="from" value="' + w.from + '" min="' + first + '" max="' + last + '"></label>' +
      '<label>To <input type="date" id="bf-to" data-bf="to" value="' + w.to + '" min="' + first + '" max="' + last + '"></label>' +
      '<span class="bf-wl">' + drange(w.from, w.to) + ' · ' + n + (n === 1 ? ' day' : ' days') + '</span></div>' +
      (w.from > last ? '<div class="bf-note">No days of data in this range yet.</div>' : '') +
      '<div class="bf-fresh" id="bf-fresh">' + freshHTML() + '</div></div>';
  }
  function freshHTML() {
    const fresh = SOURCES.map(s => { const o = S.stale[s]; return TITLE[s] + ' ' + (o.newest ? torontoTime(o.newest) : 'not loaded'); }).join(' · ');
    return 'Data updated ' + fresh + ' (Toronto time). Refreshes every 15 minutes while this page is open.' + (S.cfgKept ? ' Budget settings are from the previous load.' : '');
  }

  // ---- band 1: budget + pacing
  function budgetHTML() {
    const ms = C.saleMonths(S.cfg.saleStart, S.cfg.saleEnd);
    const mlabel = m => { const end = C.addDays(m + '-01', 40).slice(0, 7) + '-01', last = C.addDays(end, -1); return MONTH[+m.slice(5) - 1] + (S.cfg.saleEnd < last && S.cfg.saleEnd.slice(0, 7) === m ? ' (to ' + dshort(S.cfg.saleEnd) + ')' : ''); };
    const seg = ms.map(m => '<button type="button" class="bf-pre" data-bf="month" data-v="' + m + '" aria-pressed="' + (S.month === m) + '">' + mlabel(m) + '</button>').join('');
    let left = '<div class="bf-lbl">Month</div><div class="bf-segrow" role="group" aria-label="Budget month">' + seg + '</div>';
    if (S.cfg.error) left += '<div class="bf-alert" role="status">' + (S.cfg.error === C.SALE_DATES_ERROR ? 'The sale dates in the settings are not valid' : 'Budget settings could not be read') +
      ', so pacing against budget is hidden. Spend and where it lands are still live.</div>';
    else if (canEdit()) left += editControlsHTML();
    else left += readOnlyBudgetHTML();
    return '<div class="bf-band">1 · Budget</div><div class="bf-budget"><div class="bf-set">' + left + '</div>' +
      '<div><div class="bf-cap">At the last-7-day pace, by the end of ' + MONTH[+S.month.slice(5) - 1] + '</div><div id="bf-pace">' + paceHTML() + '</div></div></div>';
  }
  function splitHTML(b) {
    if (!b || b.total == null) return '';
    if (b.pct == null) return '<div class="bf-split">Google / Meta split not set</div>';
    return '<div class="bf-split"><span><i class="bf-sw g"></i>Google ' + b.pct + '% · ' + m$(b.total * b.pct / 100) + '</span><span><i class="bf-sw m"></i>Meta ' + (100 - b.pct) + '% · ' + m$(b.total * (100 - b.pct) / 100) + '</span></div>';
  }
  function setBy(key) {
    const last = S.cfg.last[key];
    if (!last || !last.who) return '';
    const at = torontoTime(last.at);
    return '<div class="bf-note">Set by ' + whoHTML(last.who) + (at ? ' · ' + at + ' Toronto time' : '') + '</div>';
  }
  function readOnlyBudgetHTML() {
    const key = 'budget ' + S.month, b = S.cfg.budgets[S.month], T = S.cfg.targets;
    let h = '<div class="bf-lbl">' + MONTH[+S.month.slice(5) - 1] + ' budget (CAD) · Google + Meta</div>';
    h += b ? '<div class="bf-big">' + m$(b.total) + '</div>' + splitHTML(b) + setBy(key) : '<div class="bf-big">No budget set</div><div class="bf-note">Spend and where it lands are still shown.</div>';
    h += '<div class="bf-lbl bf-gap">Targets</div><div class="bf-note">Google ROAS ' + x(T.google_roas) + ' · Meta ROAS ' + x(T.meta_roas) + ' · MER ' + x(T.mer) + '</div>';
    [['target google_roas', 'Google ROAS'], ['target meta_roas', 'Meta ROAS'], ['target mer', 'MER']].forEach(k => {
      const last = S.cfg.last[k[0]];
      if (last && last.who) { const at = torontoTime(last.at); h += '<div class="bf-note">' + k[1] + ' target set by ' + whoHTML(last.who) + (at ? ' · ' + at + ' Toronto time' : '') + '</div>'; }
    });
    return h;
  }
  // edit controls (configWrites:true with an endpoint only). Input values are numbers, never sheet strings. The split
  // slider is disabled while there is no total (a split needs a total to split).
  function editControlsHTML() {
    const b = budgetFor(S.month), T = S.cfg.targets;
    const num = v => fin(v) ? String(v) : '';
    let h = '<label class="bf-lbl" for="bf-budget-total">' + MONTH[+S.month.slice(5) - 1] + ' budget (CAD) · Google + Meta</label>' +
      '<input id="bf-budget-total" type="number" data-bf="budget-total" value="' + num(b && b.total) + '" min="0" max="500000" step="100" inputmode="numeric">' +
      '<input id="bf-budget-pct" class="bf-range" type="range" data-bf="budget-pct" value="' + (b && fin(b.pct) ? b.pct : 50) + '" min="0" max="100" step="1" aria-label="Google share of the budget, percent"' + (b && fin(b.total) ? '' : ' disabled') + '>' +
      '<label class="bf-lbl" for="bf-who">Your name (saved with each change)</label><input id="bf-who" type="text" data-bf="who" maxlength="40" autocomplete="name">' +
      '<div id="bf-budget-meta">' + budgetMetaHTML() + '</div>';
    h += '<details class="bf-targets"' + (S.open && S.open.targets ? ' open' : '') + '><summary data-bf="panel" data-v="targets">Targets</summary>' + [['target google_roas', 'Google ROAS', 'google_roas'], ['target meta_roas', 'Meta ROAS', 'meta_roas'], ['target mer', 'MER', 'mer']].map(k => {
      const u = S.unsaved[k[0]], v = u ? u.v : T[k[2]];
      return '<label class="bf-trow">' + k[1] + ' <input type="number" data-bf="target" data-key="' + k[0] + '" value="' + num(v) + '" min="1" max="50" step="0.1"></label>';
    }).join('') + '<div id="bf-targets-meta">' + targetsMetaHTML() + '</div></details>';
    return h;
  }
  function budgetMetaHTML() {
    if (!S.cfg || S.cfg.error) return '';
    const key = 'budget ' + S.month;
    return splitHTML(budgetFor(S.month)) + keyMeta(key, '') + saveBtnHTML('budget', [key]) +
      '<div class="bf-note">Saved budgets are shared with everyone who opens this page.</div>';
  }
  function targetsMetaHTML() {
    if (!S.cfg || S.cfg.error) return '';
    return [['target google_roas', 'Google ROAS'], ['target meta_roas', 'Meta ROAS'], ['target mer', 'MER']].map(k => keyMeta(k[0], k[1])).join('') + saveBtnHTML('targets', TARGET_KEYS);
  }
  const BAND = { under: 'under pace', ok: 'on pace', amber: 'slightly over', red: 'over budget' };
  function paceHTML() {
    const month = S.month, mStart = month + '-01', end = minD(C.addDays(C.addDays(mStart, 40).slice(0, 7) + '-01', -1), S.cfg.saleEnd);
    const p = C.pacing(S.rows, month, budgetFor(month), S.cfg.saleEnd, S.today);
    // unknown is never shown as blank: an unreadable config says "Budget unavailable", only a blank cell says "No budget set"
    if (p.status === 'not-started') return '<div class="bf-note bf-starts">Starts ' + dshort(mStart) + '.' + (S.cfg.error ? ' Budget unavailable.' : budgetFor(month) ? '' : ' No budget set yet.') + '</div>';
    const gaps = src => C.completeThrough(S.rows, src, mStart, end).gaps;
    // a month total with no Google share (Value 2 blank): the platform bars say the split is not set, the total still paces
    const bud = budgetFor(month), splitUnset = !S.cfg.error && !!bud && bud.total != null && bud.pct == null;
    // the budget words after "$X spent": a $0 budget (a 100% / 0% split) is "No budget for <Platform>", never "of $0"
    const budgetWords = (b, key, name) => b.budget === 0 ? ' · No budget for ' + (key === 'total' ? 'Google or Meta' : name)
      : b.budget != null ? ' of ' + m$(b.budget)
      : b.landsAt == null ? ''
      : ' · ' + (S.cfg.error ? 'Budget unavailable' : splitUnset && key !== 'total' ? 'Google / Meta split not set' : 'No budget set');
    return [['google', 'Google', ['google']], ['meta', 'Meta', ['meta']], ['total', 'Both', ['google', 'meta']]].map(r => {
      const b = p[r[0]], g = r[0] === 'total' ? gaps('google').concat(gaps('meta')).sort().filter((d, i, a) => a.indexOf(d) === i) : gaps(r[0]);
      const scale = Math.max(b.budget || 0, b.landsAt || 0, b.spent || 0);
      const short = b.through && b.through < minD(end, C.addDays(S.today, -1)) ? 'to ' + dshort(b.through) : '';
      const lands = b.landsAt == null ? 'lands at -' : 'lands at <b class="bf-' + b.band + '">' + m$(b.landsAt) +
        (b.pct == null ? '' : ' (' + Math.round(b.pct) + '% of ' + m$(b.budget) + ') · ' + BAND[b.band]) + '</b>';
      return '<div class="bf-bar"><div class="bf-bh"><span class="bf-bn">' + (r[0] === 'total' ? '<i class="bf-sw g"></i><i class="bf-sw m"></i>' : '<i class="bf-sw ' + r[0].charAt(0) + '"></i>') + r[1] + '</span>' +
        '<span class="bf-bv">' + m$(b.spent) + ' spent' + budgetWords(b, r[0], r[1]) + '</span></div>' +
        '<div class="bf-track"><div class="bf-fill ' + r[0] + '" style="width:' + pctOf(b.spent, scale).toFixed(1) + '%"></div>' +
        (b.budget ? '<div class="bf-budgetline" style="left:' + pctOf(b.budget, scale).toFixed(1) + '%"></div>' : '') +
        (b.landsAt != null ? '<div class="bf-proj" style="width:' + pctOf(b.landsAt, scale).toFixed(1) + '%"></div>' : '') + '</div>' +
        '<div class="bf-bs">' + join([short, g.length ? 'missing ' + dlist(g) : '', b.avgMtd == null ? '' : m$(b.avgMtd) + '/day this month', b.avg7 == null ? '' : m$(b.avg7) + '/day last 7 days', lands, staleNote(r[2])]) + '</div></div>';
    }).join('');
  }

  // ---- band 2: returns tiles, daily chart, weekly table, daily table
  function tile(id, k, v, s) { return '<div class="tile" id="bf-t-' + id + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }
  function vsTarget(v, t) { return t == null ? '' : 'target ' + x(t) + (fin(v) ? (v >= t ? ' (above)' : ' (below)') : ''); }
  // totals with Google, Meta and the store aligned to the same last day (MER rule)
  function aligned(from, to) {
    const wt = C.windowTotals(S.rows, from, to);
    const clean = wt.mer.through && !wt.google.gaps.length && !wt.meta.gaps.length && !wt.store.gaps.length;
    if (!clean) return { wt, spend: null, revenue: null, orders: null, through: wt.mer.through };
    const a = C.windowTotals(S.rows, from, wt.mer.through);
    let orders = 0;
    C.eachDay(from, wt.mer.through).forEach(d => { const r = S.rows.find(q => q.date === d); orders = (orders == null || !r.store || r.store.orders == null) ? null : orders + r.store.orders; });
    return { wt, spend: a.google.spend + a.meta.spend, revenue: a.store.revenue, orders, through: wt.mer.through };
  }
  function merNote(wt, to) {
    const parts = ['google', 'meta', 'store'].filter(s => wt[s].gaps.length).map(s => TITLE[s] + ' missing ' + dlist(wt[s].gaps));
    if (!parts.length && wt.mer.through && wt.mer.through < to) parts.push('to ' + dshort(wt.mer.through));
    return join(parts);
  }
  function returnsHTML() {
    const w = S.window, T = targets(), wt = C.windowTotals(S.rows, w.from, w.to);
    S.totals = wt;
    const tiles = [
      tile('google', 'Google ROAS', x(wt.google.roas), join([vsTarget(wt.google.roas, T && T.google_roas), 'conversion time', srcNote(wt.google, w.to), staleNote(['google'])])),
      tile('meta', 'Meta ROAS', x(wt.meta.roas), join([vsTarget(wt.meta.roas, T && T.meta_roas), 'Meta\'s own figures', srcNote(wt.meta, w.to), staleNote(['meta'])])),
      tile('mer', 'Global MER', x(wt.mer.value), join([vsTarget(wt.mer.value, T && T.mer), 'store sales ÷ ad spend', merNote(wt, w.to), staleNote(SOURCES)])),
      saleTile(),
    ].join('');
    return '<div class="bf-band">2 · Returns</div><div class="bf-tiles">' + tiles + '</div>' + chartCardHTML() + weeksHTML() + daysHTML();
  }
  function saleTile() {
    const cfg = S.cfg, last = S.rows[S.rows.length - 1].date;
    if (S.today < cfg.saleStart || last < cfg.saleStart) return tile('sale', 'Sale to date', '-', 'the sale starts ' + dshort(cfg.saleStart));
    const end = minD(last, cfg.saleEnd), a = aligned(cfg.saleStart, end);
    if (a.spend == null) return tile('sale', 'Sale to date', '-', join([merNote(a.wt, end) || 'not enough data yet', staleNote(SOURCES)]));
    const n = C.daysBetween(cfg.saleStart, a.through) + 1;
    return tile('sale', 'Sale to date', k$(a.spend) + ' → ' + k$(a.revenue), join(['ad spend → store sales', n + (n === 1 ? ' day' : ' days'), a.orders == null ? '' : a.orders.toLocaleString('en-US') + ' orders',
      a.through < end ? 'to ' + dshort(a.through) : '', staleNote(SOURCES)]));
  }
  function dayTags(d) {
    const r = S.rows.find(q => q.date === d), tags = [];
    if (d < S.cfg.saleStart) tags.push('before the sale');
    if (r && r.google && C.lagTag('google', d, S.today)) tags.push('Google ' + C.lagTag('google', d, S.today));
    if (r && r.meta && C.lagTag('meta', d, S.today)) tags.push('Meta ' + C.lagTag('meta', d, S.today));
    return tags;
  }
  function chartCardHTML() {
    const w = S.window, days = C.eachDay(w.from, w.to);
    const tagged = src => days.filter(d => { const r = S.rows.find(q => q.date === d); return r && r[src] && C.lagTag(src, d, S.today); });
    const gT = tagged('google'), mT = tagged('meta'), pre = days.filter(d => d < S.cfg.saleStart);
    const notes = [];
    if (gT.length) notes.push('Google ' + dlist(gT) + ' may still rise (Google reports can take up to 2 days to settle).');
    if (mT.length) notes.push('Meta ' + dlist(mT) + ' filling in (Meta adds sales to the day of the ad for up to 7 days after a click).');
    if (notes.length) notes.push('Those days are drawn as hollow points.');
    if (pre.length) notes.push('Days before the sale (' + dlist(pre) + ') are faded and are not part of Sale to date.');
    const prov = days.filter(d => { const r = S.rows.find(q => q.date === d); return r && r.store && r.store.fxProvisional; });
    if (prov.length) notes.push('Store sales for ' + dlist(prov) + ' use this week\'s latest exchange rates until the week closes.');
    const st = staleNote(SOURCES), T = targets();
    const leg = (cls, style, label) => '<span><span class="' + cls + '" style="' + style + '"></span>' + label + '</span>';
    return '<div class="card bf-card"><div class="cardhead"><div><h2>Day by day · spend and return</h2><div class="sub">tap or hover a day for exact values' + (st ? ' · ' + st : '') + '</div></div>' +
      '<div class="legend">' + leg('chip', 'background:' + COL.google, 'Google spend') + leg('chip', 'background:' + COL.meta, 'Meta spend') +
      leg('lchip', 'background:' + COL.google, 'Google ROAS') + leg('lchip', 'background:' + COL.meta, 'Meta ROAS') + leg('lchip', 'background:' + COL.ink, 'MER') +
      (T ? leg('lchip', 'border-top:1px dashed rgba(229,233,240,.6)', 'MER target ' + x(T.mer)) : '') + '</div></div>' +
      // the chart library comes from a CDN: when it did not load, say so in place of the chart (the tiles and tables stand)
      (typeof ctx.Chart !== 'function' ? '<div class="bf-note">The chart could not load. The figures above are still correct.</div>'
        : '<div class="bf-chartscroll" id="bf-chartscroll" tabindex="0" role="region" aria-label="Day by day chart, scrolls sideways"><div class="bf-chartbox" style="min-width:' + Math.max(0, days.length * 14) + 'px"><canvas id="bf-chart" role="img" aria-label="Daily ad spend by platform, with Google ROAS, Meta ROAS and MER"></canvas></div></div>') +
      (notes.length ? '<div class="bf-note">' + notes.join(' ') + '</div>' : '') + '</div>';
  }
  function drawChart() {
    const cv = document.getElementById('bf-chart');
    if (!cv || typeof ctx.Chart !== 'function') return;
    const w = S.window, days = C.eachDay(w.from, w.to), T = targets(), by = {};
    S.rows.forEach(r => { by[r.date] = r; });
    const pre = d => d < S.cfg.saleStart;
    const spend = src => days.map(d => by[d] && by[d][src] ? by[d][src].spend : null);
    const ratio = src => days.map(d => by[d] && by[d][src] ? div(by[d][src].revenue, by[d][src].spend) : null);
    const mer = days.map(d => { const r = by[d]; return r && r.google && r.meta && r.store ? div(r.store.revenueCad, r.google.spend + r.meta.spend) : null; });
    const fills = hex => days.map(d => pre(d) ? rgba(hex, 0.3) : hex);
    const hollow = (src, hex) => days.map(d => (by[d] && by[d][src] && C.lagTag(src, d, S.today)) ? COL.surface : (pre(d) ? rgba(hex, 0.35) : hex));
    const bar = (src, label) => ({ type: 'bar', label, data: spend(src), backgroundColor: fills(COL[src]), borderColor: COL.surface, borderWidth: { top: 2 }, borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 24, stack: 'spend', yAxisID: 'ySpend', order: 3 });
    const line = (label, data, hex, pts) => ({ type: 'line', label, data, borderColor: hex, backgroundColor: hex, pointBackgroundColor: pts || hex, pointBorderColor: hex, pointBorderWidth: 2, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.2, spanGaps: false, yAxisID: 'yRatio', order: 1,
      segment: { borderColor: c => pre(days[c.p1DataIndex]) ? rgba(hex, 0.35) : undefined } });
    const datasets = [bar('google', 'Google spend'), bar('meta', 'Meta spend'),
      line('Google ROAS', ratio('google'), COL.google, hollow('google', COL.google)), line('Meta ROAS', ratio('meta'), COL.meta, hollow('meta', COL.meta)), line('MER', mer, COL.ink),
      { type: 'line', label: 'MER target', data: days.map(() => T ? T.mer : null), borderColor: 'rgba(229,233,240,0.45)', borderWidth: 1, borderDash: [3, 5], pointRadius: 0, pointHitRadius: 0, yAxisID: 'yRatio', order: 4 }];
    const all = ratio('google').concat(ratio('meta'), mer).filter(fin);
    const rmax = Math.max(T ? Math.ceil(T.mer * 1.5) : 4, Math.ceil(Math.max(0, ...all) / 4) * 4);
    const tick = { color: '#9CA3AF', font: { family: 'JetBrains Mono', size: 10 } }, grid = { color: 'rgba(148,163,184,0.12)' };
    const chart = new ctx.Chart(cv, {
      data: { labels: days.map(dshort), datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#050816', borderColor: 'rgba(245,158,11,0.5)', borderWidth: 1, padding: 12,
            titleFont: { family: 'Space Grotesk' }, bodyFont: { family: 'JetBrains Mono' },
            filter: i => i.dataset.label !== 'MER target',
            callbacks: {
              title: items => items.length ? dlong(days[items[0].dataIndex]) : '',
              label: c => { const v = c.parsed.y; if (v == null || !fin(v)) return c.dataset.label + ': no data'; return c.dataset.label + ' ' + (c.dataset.yAxisID === 'yRatio' ? v.toFixed(1) + 'x' : m$(v)); },
              afterBody: items => items.length ? dayTags(days[items[0].dataIndex]) : [],
            },
          },
        },
        // two panels stacked one above the other on a shared day axis (never two y-scales over one plot)
        scales: {
          x: { stacked: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: Object.assign({ maxRotation: 0, autoSkip: true }, tick) },
          yRatio: { type: 'linear', position: 'left', stack: 'bf', stackWeight: 1, offset: true, min: 0, max: rmax, grid, ticks: Object.assign({ callback: v => v + 'x' }, tick), title: { display: true, text: 'Return', color: '#9CA3AF' } },
          ySpend: { type: 'linear', position: 'left', stack: 'bf', stackWeight: 1, offset: true, stacked: true, min: 0, grid, ticks: Object.assign({ callback: v => '$' + (v >= 1000 ? (v / 1000) + 'k' : v) }, tick), title: { display: true, text: 'Ad spend', color: '#9CA3AF' } },
        },
      },
    });
    charts.push(chart);
  }
  function weeksHTML() {
    const w = S.window, rows = [];
    for (let ws = weekStart(w.from); ws <= w.to; ws = C.addDays(ws, 7)) {
      const a = maxD(ws, w.from), b = minD(C.addDays(ws, 6), w.to), cur = ws === weekStart(S.today), al = aligned(a, b), wt = al.wt;
      // the Total / store sales / MER cells run to the earliest complete day of all three sources: say so when that is short
      const note = join([srcNote(wt.google, b, 'Google'), srcNote(wt.meta, b, 'Meta'), srcNote(wt.store, b, 'Store'),
        al.spend != null && al.through && al.through < b ? 'Total, store sales and MER to ' + dshort(al.through) : '']);
      rows.push('<tr><td>' + drange(a, b) + (cur ? ' (this week)' : '') + (note ? '<small>' + note + '</small>' : '') + '</td><td>' + m$(wt.google.spend) + '</td><td>' + m$(wt.meta.spend) + '</td><td>' + m$(al.spend) +
        '</td><td>' + m$(al.revenue) + '</td><td>' + x(wt.google.roas) + '</td><td>' + x(wt.meta.roas) + '</td><td>' + x(wt.mer.value) + '</td></tr>');
      if (cur) {
        const p = C.weekProjection(S.rows, S.today), rev = (fin(wt.mer.value) && fin(p.total.landsAt)) ? wt.mer.value * p.total.landsAt : null;
        rows.push('<tr class="bf-projrow"><td>projected full week ' + drange(ws, C.addDays(ws, 6)) + ', if spend stays at the last-7-day pace</td><td>' + m$(p.google.landsAt) + '</td><td>' + m$(p.meta.landsAt) +
          '</td><td>' + m$(p.total.landsAt) + '</td><td>' + m$(rev) + '</td><td>' + x(wt.google.roas) + '</td><td>' + x(wt.meta.roas) + '</td><td>' + x(wt.mer.value) + '</td></tr>');
      }
    }
    return '<div class="card bf-card"><div class="cardhead"><h2>Weeks · Monday to Sunday, Toronto days</h2>' + (staleNote(SOURCES) ? '<div class="sub">' + staleNote(SOURCES) + '</div>' : '') + '</div>' +
      '<div class="bf-tw" id="bf-weeks-tw" tabindex="0" role="region" aria-label="Weeks table, scrolls sideways"><table class="bf-table"><thead><tr><th>Week</th><th>Google spend</th><th>Meta spend</th><th>Total spend</th><th>Store sales</th><th>Google ROAS</th><th>Meta ROAS</th><th>MER</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div></div>';
  }
  function daysHTML() {
    const w = S.window, by = {};
    S.rows.forEach(r => { by[r.date] = r; });
    const body = C.eachDay(w.from, w.to).map(d => {
      const r = by[d] || {}, g = r.google, m = r.meta, s = r.store;
      const tags = dayTags(d).concat(['google', 'meta', 'store'].filter(k => !r[k]).map(k => TITLE[k] + ' missing'));
      return '<tr><td>' + dlong(d) + '</td><td>' + m$(g && g.spend) + '</td><td>' + x(g && div(g.revenue, g.spend)) + '</td><td>' + m$(m && m.spend) + '</td><td>' + x(m && div(m.revenue, m.spend)) +
        '</td><td>' + m$(s && s.revenueCad) + '</td><td>' + (s && fin(s.orders) ? s.orders : '-') + '</td><td>' + x(g && m && s ? div(s.revenueCad, g.spend + m.spend) : null) + '</td><td>' + tags.join(', ') + '</td></tr>';
    }).join('');
    return '<details class="bf-days"' + (S.open && S.open.days ? ' open' : '') + '><summary data-bf="panel" data-v="days">Show every day as a table</summary><div class="bf-tw" id="bf-days-tw" tabindex="0" role="region" aria-label="Every day table, scrolls sideways"><table class="bf-table"><thead><tr><th>Day</th><th>Google spend</th><th>Google ROAS</th><th>Meta spend</th><th>Meta ROAS</th><th>Store sales</th><th>Orders</th><th>MER</th><th>Notes</th></tr></thead><tbody>' + body + '</tbody></table></div></details>';
  }

  // ---- band 3: forecast (play-only, never saved)
  function forecastHTML() {
    return '<div class="bf-band">3 · Forecast (what if)</div><div class="bf-fc" id="bf-fc">' + fcInnerHTML() + '</div>';
  }
  function fcInnerHTML() {
    const s = S.sliders, basis = [['last7', 'Last 7 days'], ['last14', 'Last 14 days'], ['sale', 'Sale to date']];
    const row = (k, label, min, max, val) => '<div class="bf-ctl"><label class="bf-lbl" for="bf-s-' + k.replace('.', '-') + '"><span>' + label + '</span><span id="bf-fl-' + k.replace('.', '-') + '"></span></label>' +
      '<input id="bf-s-' + k.replace('.', '-') + '" class="bf-range" type="range" data-bf="slider" data-k="' + k + '" min="' + min + '" max="' + max + '" step="5" value="' + Math.round(val * 100) + '"></div>';
    return '<div class="bf-ctls"><div class="bf-lbl">Run-rate basis</div><div class="bf-segrow" role="group" aria-label="Run-rate basis">' +
      basis.map(b => '<button type="button" class="bf-pre" data-bf="basis" data-v="' + b[0] + '" aria-pressed="' + (s.basis === b[0]) + '">' + b[1] + '</button>').join('') + '</div>' +
      row('spend.google', 'Google daily spend', -50, 100, s.spend.google) + row('spend.meta', 'Meta daily spend', -50, 100, s.spend.meta) +
      row('roas.google', 'Google ROAS assumption', 50, 150, s.roas.google) + row('roas.meta', 'Meta ROAS assumption', 50, 150, s.roas.meta) +
      '<button type="button" class="bf-pre" data-bf="reset">Reset</button><div class="bf-note">The sliders are for trying ideas. They are not saved and nobody else sees them.</div></div>' +
      '<div id="bf-fc-out">' + fcOutHTML() + '</div>';
  }
  function patchForecast(full) {
    if (!S.loaded || !S.rows.length) return;   // sliders before the first load: kept in state, drawn by the first paint
    if (full) setHTML('bf-fc', fcInnerHTML()); else setHTML('bf-fc-out', fcOutHTML());
    fcLabels();
  }
  // slider readouts: measured basis value -> slider value
  function fcLabels() {
    const f = S.forecast;
    if (!f || !f.basis.from) return;
    const n = C.daysBetween(f.basis.from, f.basis.to) + 1, wt = C.windowTotals(S.rows, f.basis.from, f.basis.to), s = S.sliders;
    ['google', 'meta'].forEach(src => {
      const day = wt[src].spend == null ? null : wt[src].spend / n, ro = wt[src].roas;
      const a = document.getElementById('bf-fl-spend-' + src), b = document.getElementById('bf-fl-roas-' + src);
      if (a) a.textContent = s.spend[src] === 0 ? m$(day) + '/day (as measured)' : m$(day) + '/day → ' + m$(day == null ? null : day * (1 + s.spend[src])) + '/day (' + (s.spend[src] > 0 ? '+' : '') + Math.round(s.spend[src] * 100) + '%)';
      if (b) b.textContent = s.roas[src] === 1 ? x(ro) + ' (as measured)' : x(ro) + ' → ' + x(ro == null ? null : ro * s.roas[src]);
    });
  }
  function fcOutHTML() {
    const cfg = S.cfg, T = targets();
    const f = C.forecast(S.rows, { saleStart: cfg.saleStart, saleEnd: cfg.saleEnd, targets: T || {}, month: S.month }, S.sliders, SEED);
    S.forecast = f;
    if (!f.basis.from) return '<div class="bf-note">Not enough complete days yet to project. The forecast starts once Google, Meta and store sales all have data from ' + dshort(cfg.saleStart) + '.</div>';
    const basis = '<span class="bf-basis">Based on ' + f.basis.label + '</span>';
    const b = budgetFor(S.month), mName = MONTH[+S.month.slice(5) - 1];
    const ft = (k, v, s) => '<div class="tile bf-ftile"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';
    const bwt = C.windowTotals(S.rows, f.basis.from, f.basis.to), n = C.daysBetween(f.basis.from, f.basis.to) + 1;
    const nowDay = (bwt.google.spend == null || bwt.meta.spend == null) ? null : (bwt.google.spend + bwt.meta.spend) / n;
    return '<div class="bf-out">' +
      ft(mName + ' spend lands at', k$(f.monthSpend.total), join(['Google ' + m$(f.monthSpend.google), 'Meta ' + m$(f.monthSpend.meta), S.cfg.error ? 'budget unavailable' : b && fin(b.total) ? 'budget ' + m$(b.total) : 'no budget set', basis, staleNote(['google', 'meta'])])) +
      ft('Store revenue lands at', k$(f.storeRevenue.point), join(['whole sale to ' + dshort(cfg.saleEnd), fin(f.storeRevenue.p10) ? 'likely range ' + k$(f.storeRevenue.p10) + ' to ' + k$(f.storeRevenue.p90) : '', basis, staleNote(SOURCES)])) +
      ft('Sale MER lands at', x(f.saleMer.point), join([fin(f.saleMer.p10) ? 'likely range ' + x(f.saleMer.p10) + ' to ' + x(f.saleMer.p90) : '', T ? 'target ' + x(T.mer) : '', basis, staleNote(SOURCES)])) +
      ft('Daily spend that would still meet the MER target', f.spendCeiling == null ? '-' : m$(f.spendCeiling) + '/day', join(['at the current store sales pace', nowDay == null ? '' : 'now ' + m$(nowDay) + '/day', basis, staleNote(SOURCES)])) +
      ft('Google-reported revenue lands at', k$(f.platformRevenue.google), join(['Google\'s own count, by conversion time', basis, staleNote(['google'])])) +
      ft('Meta-reported revenue lands at', k$(f.platformRevenue.meta), join(['Meta\'s own count (7-day click / 1-day view)', basis, staleNote(['meta'])])) +
      '</div><div class="bf-note">Google and Meta both count some of the same orders, so their revenue figures are never added together. Store revenue is the one total.</div>';
  }

  const api = {
    mount, unmount, refresh, edit, save, setPreset, setCustom, setMonth, setBasis, setSlider, resetSliders,
    _state: null,
  };
  root.BFCM_VIEW = api;
}(typeof self !== 'undefined' ? self : this));
