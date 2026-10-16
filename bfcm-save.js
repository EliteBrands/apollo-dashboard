/* BFCM 2026 save flow, network side (browser only): window.BFCM_SAVE. Loaded after bfcm-view.js, which owns the
   DOM and calls this lazily. Spec 22: one key per request, POST as text/plain (no CORS preflight), 15 s timeout,
   a rid made ONCE per user save and reused on its ONE automatic retry (the server answers a known rid as
   "already done"). Only a JSON {ok: true|false} is a server answer; a network error, a timeout or any other reply
   (Google's error page after a crash) means "outcome unknown". No DOM, no innerHTML here; the view escapes every
   string it shows. Timers come from setTimeout so tools/render-sim.cjs can drive them on its fake clock. */
(function (root) {
  'use strict';
  var TIMEOUT_MS = 15000, RETRY_DELAY_MS = 2000, NAME_KEY = 'apollo-bfcm-who';
  var REASON = {
    closed: 'saving is switched off right now',
    busy: 'the server is busy or the save limit was reached, please try again in a few minutes',
    changed: 'someone else saved a change to this first',
    'log full': 'the change history is full, please contact Elite Brands'
  };

  // crypto.randomUUID, else a UUID-shaped timestamp + random string (the server only accepts the UUID shape)
  function newRid() {
    var c = root.crypto;
    if (c && typeof c.randomUUID === 'function') { try { return c.randomUUID(); } catch (e) { /* fall through */ } }
    var t = ('000000000000' + Date.now().toString(16)).slice(-12), r = '';
    for (var i = 0; i < 18; i++) r += Math.floor(Math.random() * 16).toString(16);
    return t.slice(0, 8) + '-' + t.slice(8) + '-4' + r.slice(0, 3) + '-' + '89ab'.charAt(Math.floor(Math.random() * 4)) + r.slice(3, 6) + '-' + r.slice(6);
  }

  function timeoutSignal(ms) {
    var A = root.AbortSignal;
    if (A && typeof A.timeout === 'function') { try { return A.timeout(ms); } catch (e) { return undefined; } }
    return undefined;
  }

  // resolves with the server's JSON answer; rejects on anything that is not one
  function post(url, body) {
    var timer;
    var guard = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, TIMEOUT_MS); });
    var init = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body };
    var sig = timeoutSignal(TIMEOUT_MS);
    if (sig) init.signal = sig;
    var req = Promise.resolve().then(function () { return fetch(url, init); })
      .then(function (r) { if (!r || r.ok === false) throw new Error('HTTP ' + (r && r.status)); return r.text(); })
      .then(function (t) {
        var o = JSON.parse(t);
        if (!o || typeof o !== 'object' || typeof o.ok !== 'boolean') throw new Error('not a server answer');
        return o;
      });
    return Promise.race([req, guard]).then(function (o) { clearTimeout(timer); return o; }, function (e) { clearTimeout(timer); throw e; });
  }

  // f = {key, value, value2, expect, expect2, who}, all strings. opts.onRetry() runs when the first try had no answer.
  // -> Promise<{state: 'saved' | 'duplicate' | 'rejected' | 'unconfirmed', response?, rid}>
  function saveKey(url, f, opts) {
    var rid = newRid();
    var body = JSON.stringify({ rid: rid, key: f.key, value: f.value, value2: f.value2, expect: f.expect, expect2: f.expect2, who: f.who });
    function answered(o) { return { state: o.ok ? (o.duplicate === true ? 'duplicate' : 'saved') : 'rejected', response: o, rid: rid }; }
    return post(url, body).then(answered, function () {
      if (opts && typeof opts.onRetry === 'function') opts.onRetry();
      return new Promise(function (r) { setTimeout(r, RETRY_DELAY_MS); })
        .then(function () { return post(url, body); })
        .then(answered, function () { return { state: 'unconfirmed', rid: rid }; });
    });
  }

  // plain words for "Not saved: <reason>. Nothing changed." (the view escapes it)
  function reasonText(o) {
    if (o && o.error === 'invalid' && typeof o.reason === 'string' && o.reason) return o.reason.slice(0, 200);
    return (o && typeof o.error === 'string' && Object.prototype.hasOwnProperty.call(REASON, o.error)) ? REASON[o.error] : 'the server refused the change';
  }

  // the "Your name" box, remembered per browser; storage can be missing or throw (private mode, blocked site data)
  function loadName() {
    try { var v = root.localStorage ? root.localStorage.getItem(NAME_KEY) : null; return typeof v === 'string' ? v.slice(0, 40) : ''; } catch (e) { return ''; }
  }
  function saveName(n) {
    try { if (root.localStorage) root.localStorage.setItem(NAME_KEY, String(n).slice(0, 40)); } catch (e) { /* not remembered, still saved */ }
  }

  // the server's `current` map ({key: {value, value2, who, at}}) as config + log CSV text, so the view adopts it
  // through BFCM_CORE.resolveConfig, the same reading as a page load
  function currentToCsv(cur, configHeaders, logHeaders) {
    function q(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
    function line(a) { return a.map(q).join(','); }
    var cfg = [line(configHeaders)], log = [line(logHeaders)], n = 0;
    Object.keys(cur || {}).forEach(function (k) {
      var o = cur[k];
      if (!o || typeof o !== 'object') return;
      cfg.push(line([k, o.value, o.value2]));
      if (o.who || o.at) log.push(line([++n, o.at, o.who, k, o.value, o.value2, '']));
    });
    return { config: cfg.join('\n'), log: log.join('\n') };
  }

  root.BFCM_SAVE = { saveKey: saveKey, newRid: newRid, reasonText: reasonText, loadName: loadName, saveName: saveName, currentToCsv: currentToCsv, TIMEOUT_MS: TIMEOUT_MS };
}(typeof self !== 'undefined' ? self : this));
