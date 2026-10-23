/*
 * App shell for the TeslaUSB web UI: navigation, the Home dashboard,
 * confirmation dialogs and toasts.
 *
 * The older page code (clip viewer, file browser, status polling, logs) still
 * lives in index.html. It calls into this file through the App object:
 *   App.onStatus(status)    after each cgi-bin/status.sh poll
 *   App.onConfig(config)    after cgi-bin/config.sh
 *   App.onClips(videos, newest)  after the clip list is built
 *   App.wantsStatus()       whether status polling is needed right now
 */
(function () {
  'use strict';

  const ICONS = {
    logo: '<path d="M12 2v13"/><path d="m8.5 5.5 3.5-3.5 3.5 3.5"/><path d="M7 10v2a2 2 0 0 0 2 2h3"/><path d="M17 8v4a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="19" r="2.5"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    clips: '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="m16 10.5 5.5-3.5v10L16 13.5z"/>',
    files: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M14 11v5.2"/><circle cx="12.4" cy="16.2" r="1.6"/><path d="M14 11l2.5.8"/>',
    system: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    archive: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1 .5 7.97"/><path d="M12 12.5v8M9 15.5l3-3 3 3"/>',
    storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
    wifi: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5.2 12.3a10 10 0 0 1 13.6 0"/><path d="M8.6 15.8a5 5 0 0 1 6.8 0"/><path d="M12 19.5h.01"/>',
    health: '<path d="M14 14.76V4.5a2 2 0 0 0-4 0v10.26a4 4 0 1 0 4 0z"/>',
    bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
    car: '<path d="M5 17H3v-4l2.2-5.1A2 2 0 0 1 7.04 6.6h9.92a2 2 0 0 1 1.84 1.3L21 13v4h-2"/><path d="M3 13h18"/><path d="M9.5 17h5"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.8 2.8L16 9.5"/>',
    alert: '<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
    wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>',
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function setText(sel, text) {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.textContent = text;
  }

  // ---------- formatting ----------

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '–';
    const gb = bytes / 1073741824;
    if (gb >= 100) return gb.toFixed(0) + ' GB';
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (bytes / 1048576).toFixed(0) + ' MB';
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + (d === 1 ? ' day ' : ' days ') + h + ' h';
    if (h > 0) return h + ' h ' + m + ' min';
    return m + ' min';
  }

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // "just now", "5 min ago", "2 h ago", "yesterday 2:05 PM", "Tuesday 9:14 AM", "Oct 3"
  function relativeTime(date, now) {
    now = now || new Date();
    const secs = (now - date) / 1000;
    if (secs < 0) return timeFormat.format(date);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
    if (secs < 6 * 3600) return Math.floor(secs / 3600) + ' h ago';
    if (sameDay(date, now)) return 'today ' + timeFormat.format(date);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'yesterday ' + timeFormat.format(date);
    if (secs < 6 * 86400) return weekdayFormat.format(date) + ' ' + timeFormat.format(date);
    return dateFormat.format(date);
  }

  function fromEpoch(v) {
    const n = num(v);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
  }

  // clip folder names look like 2026-10-23_14-05-31 (local time)
  function fromClipName(name) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})-(\d{2})-(\d{2}))?$/.exec(name || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  // "62/70" -> 0.886
  function signalFraction(s) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s || '');
    if (!m || +m[2] === 0) return NaN;
    return Math.min(1, +m[1] / +m[2]);
  }

  function signalWord(f) {
    if (!Number.isFinite(f)) return '';
    if (f >= 0.75) return 'Strong signal';
    if (f >= 0.5) return 'Good signal';
    if (f >= 0.3) return 'Fair signal';
    return 'Weak signal';
  }

  const THROTTLE_NOW = [[0, 'Not enough power right now'], [2, 'Slowed down to stay cool'], [3, 'Running hot']];
  const THROTTLE_PAST = [[16, 'Ran short on power since it started'], [18, 'Slowed down since it started'], [19, 'Ran hot since it started']];

  function throttleIssues(hex) {
    const bits = parseInt(hex, 16);
    if (!Number.isFinite(bits)) return { now: [], past: [] };
    const pick = list => list.filter(([bit]) => bits & (1 << bit)).map(([, text]) => text);
    return { now: pick(THROTTLE_NOW), past: pick(THROTTLE_PAST) };
  }

  // ---------- navigation ----------

  const VIEWS = {
    home: { title: 'Home', subs: null },
    clips: { title: 'Clips', subs: ['player', 'files'] },
    files: { title: 'Files', subs: ['lock', 'boombox', 'shows', 'all'] },
    system: { title: 'System', subs: ['status', 'activity', 'diagnostics', 'setup'] },
  };

  const lastSub = {};
  let current = { view: null, sub: null };
  const available = { home: true, clips: false, files: false, system: true };

  function parseHash() {
    const [view, sub] = location.hash.replace(/^#\/?/, '').split('/');
    // "Drives" was renamed "Files"; old links open the plain file browser
    if (view === 'drives') return { view: 'files', sub: 'all' };
    return { view: view || 'home', sub: sub || null };
  }

  function show(view, sub) {
    if (!VIEWS[view] || !available[view]) view = 'home';
    const subs = VIEWS[view].subs;
    if (subs) {
      if (!subs.includes(sub)) sub = lastSub[view] || subs[0];
      lastSub[view] = sub;
    } else {
      sub = null;
    }
    current = { view, sub };

    document.body.dataset.view = view;
    document.body.classList.toggle('has-subnav', !!subs);

    $$('.navitem').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    $$('.subnavbar').forEach(bar => bar.classList.toggle('active', bar.dataset.view === view));
    $$('.subnavitem').forEach(a => a.classList.toggle('active', a.dataset.view === view && a.dataset.sub === sub));
    $$('.tab').forEach(panel => {
      const match = panel.dataset.view === view && (!sub || panel.dataset.sub === sub);
      panel.classList.toggle('active', match);
    });
    setText('.appbar-title', VIEWS[view].title);
    document.title = VIEWS[view].title === 'Home' ? 'TeslaUSB' : VIEWS[view].title + ' · TeslaUSB';
    if (view === 'files' && sub !== 'all' && window.Files) window.Files.show(sub);
  }

  function go(view, sub) {
    const hash = '#' + view + (sub ? '/' + sub : '');
    if (location.hash === hash) {
      show(view, sub);
    } else {
      location.hash = hash;
    }
  }

  function setAvailable(view, yes) {
    available[view] = !!yes;
    $$('.navitem[data-view="' + view + '"]').forEach(a => { a.hidden = !yes; });
    $$('[data-needs="' + view + '"]').forEach(el => { el.hidden = !yes; });
    if (current.view === view && !yes) go('home');
    // a hash that pointed at a view that only just became available
    const wanted = parseHash();
    if (yes && wanted.view === view && current.view !== view) show(wanted.view, wanted.sub);
  }

  // ---------- dialog and toast ----------

  function confirmDialog({ title, body, ok, danger }) {
    const dlg = $('#appdialog');
    if (!dlg || typeof dlg.showModal !== 'function') {
      return Promise.resolve(window.confirm(title + '\n\n' + body));
    }
    setText('#appdialog-title', title);
    setText('#appdialog-text', body);
    const okBtn = $('#appdialog-ok');
    okBtn.textContent = ok || 'OK';
    okBtn.classList.toggle('danger', !!danger);
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(resolve => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    });
  }

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('shown'), 3500);
  }

  // ---------- data ----------

  let status = null;
  let statusAt = 0;
  let config = null;
  let clips = null;
  let latest = null;

  function onStatus(s) {
    status = s;
    statusAt = Date.now();
    renderHome();
    renderLive();
  }

  function onConfig(c) {
    config = c;
    if (window.Files) window.Files.onConfig(c);
    if (current.view === 'files' && current.sub !== 'all' && window.Files) window.Files.show(current.sub);
    renderHome();
  }

  function onClips(videos, newest) {
    latest = newest || null;
    const count = group => Object.keys((videos && videos[group]) || {}).filter(name => fromClipName(name)).length;
    clips = {
      saved: count('SavedClips'),
      sentry: count('SentryClips'),
      recent: count('RecentClips'),
      newestGroup: newest ? newest.sequencegroup : null,
      newestName: newest ? newest.sequencename : null,
    };
    const watch = $('#watchlatest');
    if (watch) watch.classList.toggle('noclips', !newest);
    renderHome();
  }

  function wantsStatus() {
    return current.view === 'home';
  }

  // status is only polled on Home and System > Status, so elsewhere an old
  // status doesn't mean the connection was lost
  function polling() {
    return current.view === 'home' || (current.view === 'system' && current.sub === 'status');
  }

  function renderLive() {
    const pill = $('#livepill');
    if (!pill) return;
    const age = Date.now() - statusAt;
    const live = statusAt > 0 && (age < 20000 || !polling());
    pill.classList.toggle('live', live);
    pill.classList.toggle('stale', statusAt > 0 && !live);
    pill.textContent = statusAt === 0 ? 'Connecting…' : (live ? 'Connected' : 'Reconnecting…');
  }

  // ---------- home ----------

  function card(id, state, value, detail, chip) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('state-ok', 'state-warn', 'state-bad');
    if (state) el.classList.add('state-' + state);
    setText(el.querySelector('.card-value'), value);
    setText(el.querySelector('.card-detail'), detail);
    const c = el.querySelector('.chip');
    if (c) {
      c.hidden = !chip;
      c.className = 'chip' + (chip ? ' ' + chip.state : '');
      c.textContent = chip ? chip.text : '';
    }
  }

  function archiveSummary(s, now) {
    const lastCheck = fromEpoch(s.last_check);
    const lastCopy = fromEpoch(s.last_copy);
    const files = parseInt(s.last_copy_files, 10);
    const result = s.last_check_result;
    const out = { lastCheck, lastCopy, files, result, problem: null };
    if (result === 'unreachable') {
      out.problem = "Couldn't connect to the archive " + relativeTime(lastCheck, now) + '.';
    } else if (result === 'error') {
      out.problem = 'Copying clips failed ' + relativeTime(lastCheck, now) + '.';
    } else if (s.last_copy_result === 'error' && lastCopy && (!lastCheck || lastCopy >= lastCheck)) {
      out.problem = 'Copying clips failed ' + relativeTime(lastCopy, now) + '.';
    }
    return out;
  }

  function renderHome() {
    const now = new Date();
    const s = status;

    // banner
    const hero = $('#home-hero');
    if (hero) {
      let state = null, title = 'Connecting to TeslaUSB…', detail = '', ico = 'wait', action = null;
      if (s) {
        const t = throttleIssues(s.throttled);
        const a = archiveSummary(s, now);
        if (t.now.includes('Not enough power right now')) {
          state = 'bad'; ico = 'alert'; title = 'Power problem';
          detail = "The Pi isn't getting enough power. Try a different USB cable or port.";
        } else if (s.drives_active !== 'yes') {
          state = 'warn'; ico = 'alert'; title = 'Drives disconnected from the car';
          detail = "The car can't record dashcam or Sentry clips until they're reconnected.";
          action = 'reconnect';
        } else if (a.problem) {
          state = 'warn'; ico = 'alert'; title = "Last archive didn't finish";
          detail = a.problem + ' The activity log has the details.';
          action = 'log';
        } else {
          state = 'ok'; ico = 'ok'; title = 'Ready';
          detail = 'The car can record to TeslaUSB.';
          if (a.lastCheck) detail += ' Last archive check ' + relativeTime(a.lastCheck, now) + '.';
        }
      }
      hero.classList.remove('state-ok', 'state-warn', 'state-bad');
      if (state) hero.classList.add('state-' + state);
      $('.hero-icon', hero).innerHTML = icon(ico);
      setText('#hero-title', title);
      setText('#hero-detail', detail);
      $$('.hero-action', hero).forEach(b => { b.hidden = b.dataset.action !== action; });
    }

    if (!s) return;

    // recordings
    if (clips) {
      const events = clips.saved + clips.sentry;
      const newest = fromClipName(clips.newestName);
      const kind = { SavedClips: 'Saved clip', SentryClips: 'Sentry event', RecentClips: 'Recent driving' }[clips.newestGroup] || 'Clip';
      card('card-clips', null,
           events === 1 ? '1 event' : events + ' events',
           (clips.saved + ' saved · ' + clips.sentry + ' Sentry') + (newest ? ' · Latest: ' + kind.toLowerCase() + ', ' + relativeTime(newest, now) : ''));
    } else {
      card('card-clips', null, '…', 'Loading clips');
    }

    // archive
    const a = archiveSummary(s, now);
    if (a.problem) {
      card('card-archive', 'warn', a.lastCopy ? relativeTime(a.lastCopy, now) : 'Not yet', a.problem, { state: 'warn', text: 'Problem' });
    } else if (a.lastCopy) {
      const files = Number.isFinite(a.files) ? (a.files === 1 ? '1 file copied' : a.files + ' files copied') : 'Clips copied';
      card('card-archive', 'ok', relativeTime(a.lastCopy, now),
           files + (a.lastCheck && a.lastCheck > a.lastCopy ? ' · Checked again ' + relativeTime(a.lastCheck, now) : ''),
           { state: 'ok', text: 'OK' });
    } else if (a.lastCheck) {
      card('card-archive', 'ok', 'Up to date', 'Nothing new to copy · Checked ' + relativeTime(a.lastCheck, now), { state: 'ok', text: 'OK' });
    } else {
      card('card-archive', null, 'Not yet', 'Clips are copied automatically whenever the car is home.');
    }

    // storage
    const total = num(s.total_space), free = num(s.free_space);
    const used = total - free;
    const pct = total > 0 ? Math.round((used / total) * 100) : NaN;
    const oldest = fromEpoch(s.snapshot_oldest);
    let storageDetail = 'of ' + formatBytes(total) + ' · ' + formatBytes(free) + ' free';
    if (oldest) storageDetail += ' · History back to ' + dateFormat.format(oldest);
    const storageState = pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : null;
    card('card-storage', storageState, formatBytes(used) + ' used', storageDetail,
         Number.isFinite(pct) ? { state: storageState || '', text: pct + '%' } : null);
    const meter = $('#card-storage .meter');
    if (meter) {
      meter.className = 'meter' + (storageState ? ' ' + storageState : '');
      meter.firstElementChild.style.width = (Number.isFinite(pct) ? Math.max(2, pct) : 0) + '%';
    }

    // wi-fi
    const f = signalFraction(s.wifi_strength);
    if (s.wifi_ssid) {
      const ghz = num(s.wifi_freq) / 1e9;
      card('card-wifi', null, s.wifi_ssid,
           [signalWord(f), s.wifi_ip || 'No IP address', Number.isFinite(ghz) ? ghz.toFixed(1) + ' GHz' : ''].filter(Boolean).join(' · '));
    } else if (s.ether_ip) {
      card('card-wifi', null, 'Ethernet', s.ether_ip);
    } else {
      card('card-wifi', 'warn', 'Not connected', 'Clips are copied once the Pi is back on Wi-Fi.');
    }
    const bars = $$('#card-wifi .signalbars i');
    const lit = Number.isFinite(f) && s.wifi_ssid ? Math.max(1, Math.round(f * 4)) : 0;
    bars.forEach((b, i) => b.classList.toggle('on', i < lit));

    // pi health
    const t = throttleIssues(s.throttled);
    const temp = num(s.cpu_temp) / 1000;
    const healthState = t.now.length ? 'bad' : (temp >= 75 || t.past.length ? 'warn' : null);
    const healthDetail = ['Running ' + formatDuration(num(s.uptime))].concat(t.now, t.past).join(' · ');
    card('card-health', healthState, Number.isFinite(temp) ? temp.toFixed(0) + '°C' : 'OK', healthDetail);

    // keep-awake
    if (config) {
      if (config.uses_ble === 'yes') {
        card('card-ble', 'ok', 'On', 'Bluetooth keeps the car awake while clips are copied.');
      } else {
        card('card-ble', null, 'Off', 'Without it, the car can fall asleep in the middle of copying clips.');
      }
    }
  }

  // ---------- actions ----------

  function toggleDrives() {
    const connected = status ? status.drives_active === 'yes' : true;
    const ask = connected
      ? confirmDialog({
          title: 'Disconnect the drives from the car?',
          body: "The car can't record dashcam or Sentry clips until you reconnect them.",
          ok: 'Disconnect', danger: true })
      : Promise.resolve(true);
    return ask.then(yes => {
      if (!yes) return;
      window.toggledrivesfunc();
      toast(connected ? 'Disconnecting the drives…' : 'Reconnecting the drives…');
    });
  }

  // selects the newest clip in the player the same way picking it from its menu does
  function watchLatest() {
    if (latest) {
      const item = $$('.subnav-content .dropdownitem').find(el => el.sequence === latest);
      if (item) {
        item.click();
      } else if (typeof latest.select === 'function') {
        latest.select();
      }
    }
    go('clips', 'player');
  }

  function archiveNow() {
    window.callcgi('cgi-bin/trigger_sync.sh');
    toast('Archive started. New clips will be copied in a moment.');
  }

  function restart(button) {
    return confirmDialog({
      title: 'Restart the Pi?',
      body: "It takes about a minute. The car can't record while it restarts.",
      ok: 'Restart', danger: true,
    }).then(yes => { if (yes) window.realrebootfunc(button); });
  }

  // ---------- startup ----------

  function decorate() {
    $$('[data-icon]').forEach(el => { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); });
  }

  function start() {
    decorate();
    window.addEventListener('hashchange', () => { const h = parseHash(); show(h.view, h.sub); });
    const h = parseHash();
    show(h.view, h.sub);
    renderHome();
    renderLive();
    setInterval(() => { renderLive(); if (current.view === 'home') renderHome(); }, 15000);

    // first paint shouldn't wait for the clip list, which the page loads first
    fetch('cgi-bin/status.sh', { cache: 'no-store' })
      .then(r => r.json())
      .then(s => { if (!status) onStatus(s); })
      .catch(() => {});
  }

  window.App = {
    onStatus, onConfig, onClips, wantsStatus, setAvailable,
    go, show, confirm: confirmDialog, toast,
    toggleDrives, archiveNow, restart, watchLatest,
    // exposed for tests
    _fmt: { relativeTime, formatBytes, formatDuration, fromClipName, signalFraction, throttleIssues, archiveSummary },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
