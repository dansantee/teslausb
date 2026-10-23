/*
 * Clips: the clip library and the player around the existing playback engine
 * (VideoSequence / VideoSegment in index.html, which syncs the camera videos,
 * stitches the one-minute files and draws the event markers).
 *
 * - Library: Saved and Sentry events and days of Recent clips as cards grouped
 *   by day, with the car's thumbnail and, as each card scrolls into view, the
 *   place and cause from its event.json. Filters: All / Sentry / Saved / Recent.
 * - Player: a header saying what the event was, the cameras, and a control bar
 *   that is always visible (no hover needed). Tapping a camera enlarges it.
 * - Deep links: #clips/player/<group>/<name> opens that event.
 *
 * App (app.js) calls Clips.onClips(videos, newest) once the clip list is built
 * and Clips.show() when the player tab is shown.
 */
(function () {
  'use strict';

  const GROUPS = ['SentryClips', 'SavedClips', 'RecentClips'];
  const KIND = { SentryClips: 'Sentry event', SavedClips: 'Saved clip', RecentClips: 'Recent driving' };
  const FILTERS = [['all', 'All'], ['SentryClips', 'Sentry'], ['SavedClips', 'Saved'], ['RecentClips', 'Recent']];
  const CAMERAS = ['frontview', 'backview', 'leftrepeaterview', 'rightrepeaterview', 'leftpillarview', 'rightpillarview'];
  const CAMERA_NAME = {
    frontview: 'Front', backview: 'Rear', leftrepeaterview: 'Left', rightrepeaterview: 'Right',
    leftpillarview: 'Left pillar', rightpillarview: 'Right pillar',
  };
  const LAYOUTS = [
    [3, 'Front on top, rear and sides below'],
    [1, 'Sides beside the front, mirrored like the car’s mirrors'],
    [2, 'Front on top, sides and rear below, mirrored'],
    [4, 'Stacked for phones, mirrored'],
    [5, 'Stacked for phones'],
    [6, 'Pillar cameras on the sides'],
  ];

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- time and text ----------

  // "2026-10-08_12-42-56" or "2026-10-08" (local time) -> Date
  function parseName(name) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})-(\d{2})-(\d{2}))?$/.exec(name || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  function dayKey(d) {
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabel(d, now) {
    now = now || new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return 'Today';
    if (dayKey(d) === dayKey(y)) return 'Yesterday';
    if (now - d < 300 * 86400000) return dayFmt.format(d);
    return dateFmt.format(d);
  }

  function minutes(n) {
    return n === 1 ? '1 min' : n + ' min';
  }

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // turns the car's event.json "reason" into words
  function reasonText(reason) {
    if (!reason) return '';
    const r = String(reason);
    if (r === 'user_interaction_honk') return 'Saved with the horn';
    if (r.startsWith('user_interaction')) return 'Saved from the screen';
    if (r.includes('emergency_braking')) return 'Automatic emergency braking';
    if (r.includes('collision')) return 'Collision warning';
    if (r.includes('object_detection')) return 'Something came close';
    if (r.includes('accel') || r.includes('bump')) return 'The car was bumped';
    if (r.includes('handle')) return 'A door handle was pulled';
    if (r.includes('tilt') || r.includes('glass') || r.includes('intrusion')) return 'Break-in alert';
    if (r.startsWith('sentry')) return 'Sentry was triggered';
    return r.replace(/_/g, ' ');
  }

  function place(info) {
    if (!info) return '';
    return [info.street, info.city].filter(Boolean).join(', ');
  }

  // ---------- state ----------

  let videos = null;
  let latest = null;
  let selected = null;     // the VideoSequence shown in the player
  let filter = 'all';
  let playing = false;     // phone: player shown instead of the library
  let focus = null;        // enlarged camera id, or null
  const info = new Map();  // "group/name" -> parsed event.json, or 'pending' / 'none'
  let observer = null;

  function key(seq) {
    return seq.sequencegroup + '/' + seq.sequencename;
  }

  function sequences() {
    const out = [];
    for (const g of GROUPS) {
      for (const [name, seq] of Object.entries((videos && videos[g]) || {})) {
        if (!parseName(name) || !seq.getSegmentByIndex(0)) continue;
        out.push(seq);
      }
    }
    // newest first; a day of Recent clips is named for the day (midnight), so it lists below that day's events
    const when = s => parseName(s.sequencename).getTime();
    return out.sort((a, b) => when(b) - when(a));
  }

  function find(group, name) {
    return (videos && videos[group] && videos[group][name]) || null;
  }

  // ---------- event.json (place and cause) ----------

  // the engine blanks jsonfile[0] while it reads the file itself, so fall back to the usual name
  function jsonPath(seq) {
    if (seq.sequencegroup === 'RecentClips' || !seq.jsonfile || !seq.jsonfile.length) return null;
    return typeof seq.jsonfile[0] === 'string' ? seq.jsonfile[0] : key(seq) + '/event.json';
  }

  function loadInfo(seq) {
    const k = key(seq);
    if (info.has(k)) return;
    if (seq.jsonparsed && seq.jsonparsed[0] && seq.sequencegroup !== 'RecentClips') {
      info.set(k, seq.jsonparsed[0]);
      return;
    }
    const p = jsonPath(seq);
    if (!p) { info.set(k, 'none'); return; }
    info.set(k, 'pending');
    fetch('TeslaCam/' + p.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { info.set(k, j || 'none'); updateCard(seq); if (seq === selected) renderHeader(); })
      .catch(() => { info.set(k, 'none'); });
  }

  function infoFor(seq) {
    const v = info.get(key(seq));
    return v && typeof v === 'object' ? v : null;
  }

  // ---------- library ----------

  function thumbURL(seq) {
    if (!seq.thumb) return null;
    return ['TeslaCam', seq.sequencegroup, seq.sequencename, seq.thumb].map(encodeURIComponent).join('/');
  }

  function cardFor(seq) {
    const d = parseName(seq.sequencename);
    const recent = seq.sequencegroup === 'RecentClips';
    const events = recent ? seq.jsonfile.length : 0;
    const thumb = thumbURL(seq);
    const card = h('button', {
      class: 'clipcard' + (seq === selected ? ' selected' : ''),
      'data-key': key(seq), 'data-group': seq.sequencegroup,
      onclick: () => open(seq),
    },
      h('span', { class: 'clipthumb' + (thumb ? '' : ' empty') },
        thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'clipthumb-icon' })),
      h('span', { class: 'clipcard-text' },
        h('span', { class: 'clipcard-top' },
          h('span', { class: 'clipkind ' + seq.sequencegroup, text: KIND[seq.sequencegroup] }),
          h('span', { class: 'clipcard-time', text: recent ? '' : timeFmt.format(d) })),
        h('span', { class: 'clipcard-meta', text: minutes(seq.length()) + (events ? ' · ' + events + (events === 1 ? ' Sentry event' : ' Sentry events') : '') }),
        h('span', { class: 'clipcard-place' })));
    fillCard(card, seq);
    return card;
  }

  function fillCard(card, seq) {
    const i = infoFor(seq);
    const el = card.querySelector('.clipcard-place');
    if (el) el.textContent = i ? [place(i), reasonText(i.reason)].filter(Boolean).join(' · ') : '';
  }

  function updateCard(seq) {
    const card = document.querySelector('.clipcard[data-key="' + CSS.escape(key(seq)) + '"]');
    if (card) fillCard(card, seq);
  }

  function renderLibrary() {
    const lib = document.getElementById('cliplib');
    if (!lib) return;
    const all = sequences();
    const shown = all.filter(s => filter === 'all' || s.sequencegroup === filter);
    const chips = h('div', { class: 'clipfilters', role: 'tablist' },
      FILTERS.map(([k, label]) => {
        const count = k === 'all' ? all.length : all.filter(s => s.sequencegroup === k).length;
        return h('button', {
          class: 'filterchip' + (filter === k ? ' active' : ''), role: 'tab', 'aria-selected': filter === k ? 'true' : 'false',
          'data-filter': k, onclick: () => { filter = k; renderLibrary(); },
        }, label, h('span', { class: 'filtercount', text: String(count) }));
      }));

    const list = h('div', { class: 'cliplist' });
    if (!videos) {
      list.append(h('div', { class: 'clipempty', text: 'Loading clips…' }));
    } else if (!shown.length) {
      list.append(h('div', { class: 'clipempty', text: all.length
        ? 'No ' + FILTERS.find(f => f[0] === filter)[1].toLowerCase() + ' clips on the drive.'
        : 'No clips yet. Saved clips and Sentry events show up here once the car records them.' }));
    } else {
      let lastDay = null;
      for (const seq of shown) {
        const d = parseName(seq.sequencename);
        if (dayKey(d) !== lastDay) {
          lastDay = dayKey(d);
          list.append(h('div', { class: 'clipday', text: dayLabel(d) }));
        }
        list.append(cardFor(seq));
      }
    }
    lib.replaceChildren(chips, list);

    if (observer) observer.disconnect();
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const [g, n] = e.target.dataset.key.split('/');
          const seq = find(g, n);
          if (seq) loadInfo(seq);
          observer.unobserve(e.target);
        }
      }, { root: list, rootMargin: '200px' });
      list.querySelectorAll('.clipcard').forEach(c => observer.observe(c));
    } else {
      shown.forEach(loadInfo);
    }
  }

  function markSelected() {
    document.querySelectorAll('.clipcard').forEach(c => c.classList.toggle('selected', !!selected && c.dataset.key === key(selected)));
  }

  // ---------- player ----------

  function renderHeader() {
    const head = document.getElementById('clipheader');
    if (!head) return;
    if (!selected) {
      head.replaceChildren(h('div', { class: 'cliptitle', text: 'No clip selected' }));
      return;
    }
    const d = parseName(selected.sequencename);
    const recent = selected.sequencegroup === 'RecentClips';
    const i = infoFor(selected);
    const when = recent ? dayLabel(d) : dayLabel(d) + ', ' + timeFmt.format(d);
    head.replaceChildren(
      h('div', { class: 'cliptitle' },
        h('span', { class: 'clipkind ' + selected.sequencegroup, text: KIND[selected.sequencegroup] }),
        h('span', { class: 'clipwhen', text: when })),
      h('div', { class: 'clipsub', text: [i ? reasonText(i.reason) : '', i ? place(i) : '', minutes(selected.length())].filter(Boolean).join(' · ') }));
  }

  function setPlaying(on) {
    playing = on;
    const root = document.querySelector('.clips');
    if (root) root.classList.toggle('playing', on);
  }

  // shows a sequence in the player; `fromHash` avoids rewriting the hash it came from
  function open(seq, fromHash) {
    if (!seq) return;
    if (seq !== window.currentsequence) {
      if (window.currentsequence && window.currentsequence.isPlaying()) window.currentsequence.pause();
      seq.select();
    }
    selected = seq;
    loadInfo(seq);
    markSelected();
    renderHeader();
    setFocus(null);
    setPlaying(true);
    const hash = '#clips/player/' + key(seq);
    if (!fromHash && location.hash !== hash) {
      if (document.querySelector('.content7.active')) {
        history.replaceState(null, '', hash);
      } else {
        // the router shows the player tab, and Clips.show() finds this clip in the hash
        location.hash = hash;
      }
    }
  }

  function back() {
    setPlaying(false);
    if (location.hash.startsWith('#clips/player/')) history.replaceState(null, '', '#clips/player');
  }

  function openFromHash() {
    const m = /^#clips\/player\/(RecentClips|SavedClips|SentryClips)\/([^/]+)$/.exec(location.hash);
    if (!m) return false;
    const seq = find(m[1], decodeURIComponent(m[2]));
    if (seq) open(seq, true);
    return !!seq;
  }

  // the clock time at the current playback position, from the segment's start time
  function tick() {
    const el = document.getElementById('clipclock');
    const slider = document.getElementById('position');
    const seq = window.currentsequence;
    if (!el || !slider || !seq) return;
    const pos = Number(slider.value) || 0;
    const idx = seq.currentSegmentIdx() >= 0 ? seq.currentSegmentIdx() : Math.floor(pos / 60000);
    const seg = seq.getSegmentByIndex(Math.min(seq.length() - 1, idx));
    const start = seg ? parseName(seg.datetime) : null;
    // the timeline pads segments shorter than a minute, so the time of day comes from the video's own
    // position within its file (named for when it started), not from the slider
    const v = seg && seg.longestvideoelem;
    const within = v && Number.isFinite(v.currentTime) ? v.currentTime * 1000 : pos % 60000;
    const total = seq.length() * 60000;
    el.textContent = (start ? clockFmt.format(new Date(start.getTime() + within)) + ' · ' : '') +
      clock(pos) + ' / ' + clock(total);
  }

  // ---------- camera focus ----------

  // the cameras this clip has: the four standard ones, plus the pillars on cars that record them
  function camerasPresent() {
    const pillars = !!(selected && selected.segments.some(s => s.leftpillar || s.rightpillar));
    return CAMERAS.filter(c => pillars || !c.includes('pillar'));
  }

  // enlarges one camera across the top with the others in a row below; null shows the normal layout.
  // Uses inline grid styles on top of the engine's layout class, so setLayout() (which resets the
  // class list) must be preceded by setFocus(null).
  function setFocus(cam) {
    const holder = document.querySelector('.videoholder');
    if (!holder) return;
    focus = cam;
    holder.classList.toggle('focus', !!cam);
    const present = camerasPresent();
    // cameras the clip doesn't have (e.g. pillars) must leave the grid, or they add empty columns
    holder.querySelectorAll('video, canvas').forEach(el => {
      const c = CAMERAS.find(name => el.classList.contains(name));
      el.toggleAttribute('data-focushide', !!cam && !present.includes(c));
    });
    if (cam) {
      const others = present.filter(c => c !== cam);
      holder.style.gridTemplateColumns = 'repeat(' + others.length + ', minmax(0, 1fr))';
      // some layouts (pillars) set fixed rows; focus mode always has the big camera over one row
      holder.style.gridTemplateRows = 'auto auto';
      holder.style.gridTemplateAreas = '"' + others.map(() => cam).join(' ') + '" "' + others.join(' ') + '"';
    } else {
      holder.style.gridTemplateAreas = '';
      holder.style.gridTemplateColumns = '';
      holder.style.gridTemplateRows = '';
    }
    holder.dataset.focus = cam || '';
    const label = document.getElementById('clipfocus');
    if (label) label.textContent = cam ? CAMERA_NAME[cam] + ' camera · tap it again to see all' : '';
  }

  function onVideoTap(e) {
    const v = e.target.closest('video, canvas');
    if (!v) return;
    const cam = CAMERAS.find(c => v.classList.contains(c));
    if (!cam) return;
    setFocus(focus === cam ? null : cam);
  }

  // ---------- layout menu and full screen ----------

  async function chooseLayout() {
    const dlg = h('dialog', { class: 'appdialog filesdialog' });
    const done = n => { dlg.close(); dlg.remove(); if (n) { setFocus(null); window.setLayout(n); } };
    dlg.append(
      h('div', { class: 'appdialog-body' }, h('h2', { text: 'Camera layout' }),
        h('p', { text: 'Tip: tap any camera to make it big.' })),
      h('div', { class: 'sheetactions' }, LAYOUTS.map(([n, label]) => h('button', {
        class: 'sheetaction' + (window.currentLayout === n ? ' current' : ''),
        'data-layout': String(n), onclick: () => done(n),
      }, label))),
      h('div', { class: 'appdialog-actions' }, h('button', { class: 'btn', onclick: () => done(null), text: 'Cancel' })));
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function fullscreen() {
    const el = document.querySelector('.clipplayer');
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }

  // ---------- hooks ----------

  function onClips(v, newest) {
    videos = v || {};
    latest = newest || null;
    // the engine has already selected the newest clip
    selected = window.currentsequence || latest;
    if (selected) loadInfo(selected);
    renderLibrary();
    renderHeader();
    if (!openFromHash()) markSelected();
  }

  function show() {
    if (videos) {
      if (!openFromHash() && !location.hash.startsWith('#clips/player/')) {
        // plain #clips: the library on phones, library + player on wide screens
        setPlaying(false);
      }
    }
  }

  function start() {
    const holder = document.querySelector('.videoholder');
    if (holder) holder.addEventListener('click', onVideoTap);
    const b = document.getElementById('clipback');
    if (b) b.addEventListener('click', back);
    const l = document.getElementById('cliplayout');
    if (l) l.addEventListener('click', chooseLayout);
    const f = document.getElementById('clipfullscreen');
    if (f) f.addEventListener('click', fullscreen);
    window.addEventListener('hashchange', () => { if (videos) openFromHash(); });
    setInterval(tick, 500);
    renderLibrary();
    renderHeader();
  }

  window.Clips = {
    onClips, show, open, back,
    latest: () => latest,
    // exposed for tests
    _fmt: { reasonText, parseName, dayLabel, clock },
    _focus: () => focus,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
