/*
 * Files: manages the sounds and light shows the car reads from the Extras
 * (Boombox) drive, laid out the way Tesla expects:
 *
 *   LockChime.wav            the active lock sound (one at a time, WAV under 1 MB)
 *   LockSounds/              library of lock sounds; one gets copied to LockChime.wav
 *   LockSounds/.active       name of the library file that was last made active
 *   Boombox/                 Boombox sounds (.wav/.mp3); the car offers the first five, alphabetically
 *   LightShow/NAME.fseq      a light show: the sequence...
 *   LightShow/NAME.wav|mp3   ...and its audio, with the same name
 *
 * Uses the existing cgi-bin scripts (ls, upload, mkdir, mv, cp, rm, download, downloadzip).
 * App (app.js) calls Files.onConfig(config) and Files.show(sub).
 */
(function () {
  'use strict';

  const LOCK = 'LockChime.wav';
  const LOCK_DIR = 'LockSounds';
  const LOCK_MARKER = LOCK_DIR + '/.active';
  const BOOMBOX_DIR = 'Boombox';
  const SHOW_DIR = 'LightShow';
  const LOCK_MAX_BYTES = 1048576;
  const BOOMBOX_SHOWN = 5;
  const AUDIO = /\.(wav|mp3)$/i;

  // ---------- small DOM helper (text only, never innerHTML for file names) ----------

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

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  function ext(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function base(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  // a name that is safe to pass to the cgi scripts as a single path element
  function cleanName(name) {
    return String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '').replace(/^[\s.-]+/, '').trim();
  }

  // ---------- cgi wrappers ----------

  function q(...args) {
    return args.map(a => encodeURIComponent(a)).join('&');
  }

  // no cache-busting parameter: the cgi scripts treat every &-separated part of the query as an argument
  async function get(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    return r.text();
  }

  async function op(script, root, ...args) {
    // a name starting with "-" would be read as an option by mv/cp/rm/mkdir
    const safe = args.map(a => (a.startsWith('-') ? './' + a : a));
    const text = await get('cgi-bin/' + script + '?' + q(root, ...safe));
    if (text.trim() !== 'OK') throw new Error(script + ' failed');
  }

  // every name in a folder as the drive has it now, for collision checks right before a change
  async function namesIn(root, dir) {
    const l = await ls(root, dir);
    return l.files.map(f => f.name).concat(l.dirs);
  }

  // FAT names are case-insensitive, so a rename that only changes case goes through a temporary name
  async function rename(root, from, to) {
    if (from.toLowerCase() === to.toLowerCase()) {
      const slash = from.lastIndexOf('/');
      const tmp = from.slice(0, slash + 1) + '.renaming-' + Date.now();
      await op('mv.sh', root, from, tmp);
      await op('mv.sh', root, tmp, to);
    } else {
      await op('mv.sh', root, from, to);
    }
  }

  // makes sure `wanted` exists with exactly that capitalization; returns true if it changed anything
  async function ensureDir(root, dirs, wanted) {
    const found = dirs.find(d => d.toLowerCase() === wanted.toLowerCase());
    if (found === wanted) return false;
    if (found) await rename(root, found, wanted);
    else await op('mkdir.sh', root, wanted);
    return true;
  }

  function clashes(name, names, except) {
    const n = name.toLowerCase();
    return names.some(o => o.toLowerCase() === n && (!except || o.toLowerCase() !== except.toLowerCase()));
  }

  // lists one directory: { dirs: [name], files: [{ name, size }] } (dot files left out)
  async function ls(root, path) {
    const text = await get('cgi-bin/ls.sh?' + q(root, path || ''));
    const prefix = path ? path + '/' : '';
    const out = { dirs: [], files: [] };
    for (const line of text.split('\n')) {
      const type = line.slice(0, 2);
      if (type !== 'd:' && type !== 'f:') continue;
      let rest = line.slice(2);
      let size = NaN;
      if (type === 'f:') {
        const i = rest.lastIndexOf(':');
        size = Number(rest.slice(i + 1));
        rest = rest.slice(0, i);
      }
      if (prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length);
      if (!rest || rest.includes('/') || rest.startsWith('.')) continue;
      if (type === 'd:') out.dirs.push(rest);
      else out.files.push({ name: rest, size });
    }
    return out;
  }

  function upload(root, destpath, blob, onprogress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', 'cgi-bin/upload.sh?' + q(root, destpath));
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => { if (onprogress && e.lengthComputable) onprogress(e.loaded / e.total); };
      x.onload = () => (x.status === 200 ? resolve() : reject(new Error('upload failed: HTTP ' + x.status)));
      x.onerror = () => reject(new Error('upload failed'));
      x.send(blob);
    });
  }

  async function readText(root, path) {
    try {
      const r = await fetch(fileURL(root, path) + '?nocache=' + Date.now(), { cache: 'no-store' });
      return r.ok ? (await r.text()).trim() : '';
    } catch (e) {
      return '';
    }
  }

  function fileURL(root, path) {
    return root.split('/').concat(path.split('/')).map(encodeURIComponent).join('/');
  }

  function downloadURL(root, path) {
    return 'cgi-bin/download.sh?' + q(root, path);
  }

  function zipURL(root, dir, names) {
    return 'cgi-bin/downloadzip.sh?' + q(root + '/' + dir, ...names);
  }

  function uniqueName(name, taken) {
    const lower = new Set(taken.map(n => n.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    const b = base(name), e = name.slice(b.length);
    for (let i = 2; ; i++) {
      const candidate = b + ' (' + i + ')' + e;
      if (!lower.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ---------- file checks ----------

  async function head(file, bytes) {
    return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
  }

  // FSEQ header: "PSEQ", minor version at 6, major at 7; v2 keeps the
  // compression type in the low 4 bits of byte 20 and the step time (ms) in byte 18
  async function checkFseq(file) {
    const b = await head(file, 32);
    if (b.length < 28 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'PSEQ') {
      return { error: "This isn't an .fseq light show file." };
    }
    if (b[7] !== 2) {
      return { error: 'This .fseq is version ' + b[7] + '. The car needs version 2 ("V2 Uncompressed" in xLights).' };
    }
    if ((b[20] & 0x0f) !== 0) {
      return { error: 'This .fseq is compressed. Export it from xLights as "V2 Uncompressed".' };
    }
    const step = b[18];
    if (step < 15 || step > 100) {
      return { warning: 'Its frame time is ' + step + ' ms; the car supports 15–100 ms (20 ms is recommended).' };
    }
    return {};
  }

  // returns the sample rate from a WAV header, or 0 if it can't be read
  async function wavSampleRate(file) {
    const b = await head(file, 65536);
    const view = new DataView(b.buffer);
    const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;
    let o = 12;
    while (o + 8 <= b.length) {
      const size = view.getUint32(o + 4, true);
      if (tag(o) === 'fmt ' && o + 16 <= b.length) return view.getUint32(o + 12, true);
      o += 8 + size + (size % 2);
    }
    return 0;
  }

  // ---------- dialogs ----------

  function dialog(build) {
    return new Promise(resolve => {
      const dlg = h('dialog', { class: 'appdialog filesdialog' });
      const close = v => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.append(build(close));
      dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
      document.body.append(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }

  function askName(title, label, value) {
    return dialog(close => {
      const input = h('input', { class: 'textinput', type: 'text', value, 'aria-label': label });
      const form = h('form', { onsubmit: e => { e.preventDefault(); close(cleanName(input.value) || null); } },
        h('div', { class: 'appdialog-body' }, h('h2', { text: title }), h('label', { class: 'fieldlabel', text: label }), input),
        h('div', { class: 'appdialog-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(null), text: 'Cancel' }),
          h('button', { class: 'btn primary', type: 'submit', text: 'Save' })));
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return form;
    });
  }

  // a list of actions for one item; resolves with the chosen action's key
  function actionSheet(title, actions) {
    return dialog(close => h('div', {},
      h('div', { class: 'appdialog-body' }, h('h2', { class: 'sheettitle', text: title })),
      h('div', { class: 'sheetactions' },
        actions.map(a => h('button', { class: 'sheetaction' + (a.danger ? ' danger' : ''), onclick: () => close(a.key), text: a.label }))),
      h('div', { class: 'appdialog-actions' }, h('button', { class: 'btn', onclick: () => close(null), text: 'Cancel' }))));
  }

  function pickFiles(accept, multiple) {
    return new Promise(resolve => {
      const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
      input.addEventListener('change', () => { resolve(Array.from(input.files)); input.remove(); });
      document.body.append(input);
      input.click();
    });
  }

  // ---------- shared playback ----------

  const player = new Audio();
  let playingKey = null;
  player.addEventListener('ended', () => { playingKey = null; renderAll(); });

  function togglePlay(key, url) {
    if (playingKey === key) {
      player.pause();
      playingKey = null;
    } else {
      player.src = url;
      player.play().catch(() => App.toast("Couldn't play that file in this browser."));
      playingKey = key;
    }
    renderAll();
  }

  function playButton(key, url) {
    const playing = playingKey === key;
    return h('button', {
      class: 'iconbtn playbtn' + (playing ? ' playing' : ''),
      title: playing ? 'Stop' : 'Play', 'aria-label': playing ? 'Stop' : 'Play',
      onclick: () => togglePlay(key, url),
    }, h('span', { class: playing ? 'stopglyph' : 'playglyph' }));
  }

  // ---------- state ----------

  const state = {
    root: null,         // drive holding lock sounds and Boombox, e.g. "fs/Boombox"
    showRoot: null,     // drive holding LightShow/ (a separate LightShow drive if there is one)
    ready: false,
    loading: false,
    error: null,
    rootFiles: [],
    lock: null,         // { size } of LockChime.wav, or null
    library: [],        // [{ name, size }] in LockSounds/
    marker: '',
    boombox: [],
    shows: [],          // [{ name, fseq, audio: [{name,size}], size }]
    pending: false,     // changes the car hasn't picked up yet
    busy: null,         // text shown while an operation runs
  };

  let current = null;   // the sub-view on screen
  let configured = false;

  function onConfig(config) {
    if (configured) return;
    configured = true;
    if (config.has_boombox === 'yes') state.root = 'fs/Boombox';
    else if (config.has_lightshow === 'yes') state.root = 'fs/LightShow';
    else if (config.has_music === 'yes') state.root = 'fs/Music';
    state.showRoot = config.has_lightshow === 'yes' ? 'fs/LightShow' : state.root;
    if (current) refresh();
  }

  function show(sub) {
    current = sub;
    if (!configured) return;
    // always re-read: the drive can change from All files, the car or another phone
    if (!state.loading) refresh();
    else renderAll();
  }

  // creates any folder the car expects that's missing, then reads everything
  async function refresh() {
    if (!state.root) { renderAll(); return; }
    state.loading = true;
    state.error = null;
    renderAll();
    try {
      let top = await ls(state.root);
      const wanted = [LOCK_DIR, BOOMBOX_DIR].concat(state.showRoot === state.root ? [SHOW_DIR] : []);
      let changed = false;
      for (const d of wanted) changed = (await ensureDir(state.root, top.dirs, d)) || changed;
      if (state.showRoot !== state.root) {
        await ensureDir(state.showRoot, (await ls(state.showRoot)).dirs, SHOW_DIR);
      }
      if (changed) top = await ls(state.root);

      const [lib, boom, shows, marker] = await Promise.all([
        ls(state.root, LOCK_DIR), ls(state.root, BOOMBOX_DIR), ls(state.showRoot, SHOW_DIR), readText(state.root, LOCK_MARKER),
      ]);
      state.rootFiles = top.files;
      const lock = top.files.find(f => f.name === LOCK);
      state.lock = lock ? { size: lock.size } : null;
      state.library = lib.files.filter(f => AUDIO.test(f.name)).sort(byName);
      state.marker = marker;
      state.boombox = boom.files.filter(f => AUDIO.test(f.name)).sort(byName);
      state.shows = groupShows(shows.files);
      state.ready = true;
    } catch (e) {
      state.error = e.message;
    }
    state.loading = false;
    renderAll();
  }

  function byName(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

  function groupShows(files) {
    const groups = new Map();
    for (const f of files) {
      const e = ext(f.name);
      if (e !== 'fseq' && e !== 'wav' && e !== 'mp3') continue;
      const name = base(f.name);
      if (!groups.has(name)) groups.set(name, { name, fseq: null, audio: [], size: 0 });
      const g = groups.get(name);
      if (e === 'fseq') g.fseq = f; else g.audio.push(f);
      g.size += Number.isFinite(f.size) ? f.size : 0;
    }
    return Array.from(groups.values()).sort(byName);
  }

  // which library file LockChime.wav came from: the recorded one if it still
  // matches in size, otherwise the only library file of that size
  function activeLockName() {
    if (!state.lock) return null;
    const match = state.library.filter(f => f.size === state.lock.size);
    if (state.marker && match.some(f => f.name === state.marker)) return state.marker;
    return match.length === 1 ? match[0].name : null;
  }

  function looseSounds() {
    return state.rootFiles.filter(f => f.name !== LOCK && AUDIO.test(f.name)).sort(byName);
  }

  let opsDone = 0;

  async function run(busyText, fn, doneText) {
    if (state.busy) return;
    state.busy = busyText;
    renderAll();
    try {
      await fn();
      state.pending = true;
      if (doneText) App.toast(doneText);
    } catch (e) {
      App.toast('Something went wrong: ' + e.message);
    }
    state.busy = null;
    await refresh();
    opsDone++;
  }

  // ---------- actions ----------

  function isWav(name) {
    return ext(name) === 'wav';
  }

  function makeActive(f) {
    if (!isWav(f.name)) {
      App.toast('The lock sound has to be a .wav file.');
      return;
    }
    if (f.size > LOCK_MAX_BYTES) {
      App.toast('That file is over 1 MB, which the car won’t play.');
      return;
    }
    run('Setting the lock sound…', async () => {
      await op('cp.sh', state.root, LOCK_DIR + '/' + f.name, LOCK);
      await upload(state.root, LOCK_MARKER, new Blob([f.name], { type: 'text/plain' }));
    }, base(f.name) + ' is now the lock sound.');
  }

  function saveCurrentLock() {
    run('Saving…', async () => {
      const name = uniqueName('Current lock sound.wav', await namesIn(state.root, LOCK_DIR));
      await op('cp.sh', state.root, LOCK, LOCK_DIR + '/' + name);
      await upload(state.root, LOCK_MARKER, new Blob([name], { type: 'text/plain' }));
    }, 'Saved to your lock sounds.');
  }

  function moveLoose(files, dir) {
    const label = dir === LOCK_DIR ? 'lock sounds' : 'Boombox';
    run('Moving…', async () => {
      const taken = await namesIn(state.root, dir);
      for (const f of files) {
        const name = uniqueName(f.name, taken);
        taken.push(name);
        await op('mv.sh', state.root, f.name, dir + '/' + name);
      }
    }, (files.length === 1 ? 'Moved 1 file' : 'Moved ' + files.length + ' files') + ' to ' + label + '.');
  }

  async function uploadSounds(dir, accept, check) {
    const files = await pickFiles(accept, true);
    if (!files.length) return;
    const ok = [];
    for (const file of files) {
      const problem = check(file);
      if (problem) { App.toast(file.name + ': ' + problem); continue; }
      ok.push(file);
    }
    if (!ok.length) return;
    run('Uploading…', async () => {
      const taken = await namesIn(state.root, dir);
      for (let i = 0; i < ok.length; i++) {
        const name = uniqueName(cleanName(ok[i].name) || 'sound.' + ext(ok[i].name), taken);
        taken.push(name);
        await upload(state.root, dir + '/' + name, ok[i], p => {
          state.busy = 'Uploading ' + (ok.length > 1 ? (i + 1) + ' of ' + ok.length + ' ' : '') + Math.round(p * 100) + '%';
          renderBusy();
        });
      }
    }, ok.length === 1 ? 'Uploaded ' + ok[0].name + '.' : 'Uploaded ' + ok.length + ' files.');
  }

  function checkLockFile(file) {
    if (!isWav(file.name)) return 'lock sounds have to be .wav files.';
    if (file.size > LOCK_MAX_BYTES) return 'it’s ' + formatSize(file.size) + '; lock sounds have to be under 1 MB.';
    return null;
  }

  function checkBoomboxFile(file) {
    return AUDIO.test(file.name) ? null : 'Boombox sounds have to be .wav or .mp3 files.';
  }

  async function soundMenu(dir, f, extra) {
    const key = await actionSheet(base(f.name), (extra || []).concat([
      { key: 'rename', label: 'Rename' },
      { key: 'download', label: 'Download' },
      { key: 'delete', label: 'Delete', danger: true },
    ]));
    if (!key) return;
    if (key === 'rename') {
      const name = await askName('Rename', 'New name', base(f.name));
      if (!name || name === base(f.name)) return;
      const target = name + '.' + ext(f.name);
      run('Renaming…', async () => {
        if (clashes(target, await namesIn(state.root, dir), f.name)) {
          throw new Error('there is already a file called ' + target);
        }
        await rename(state.root, dir + '/' + f.name, dir + '/' + target);
        if (dir === LOCK_DIR && state.marker === f.name) {
          await upload(state.root, LOCK_MARKER, new Blob([target], { type: 'text/plain' }));
        }
      }, 'Renamed.');
    } else if (key === 'download') {
      triggerDownload(downloadURL(state.root, dir + '/' + f.name), f.name);
    } else if (key === 'delete') {
      const yes = await App.confirm({ title: 'Delete ' + base(f.name) + '?', body: 'This removes the file from the Pi.', ok: 'Delete', danger: true });
      if (yes) run('Deleting…', () => op('rm.sh', state.root, dir + '/' + f.name), 'Deleted.');
    } else if (extra) {
      const chosen = extra.find(x => x.key === key);
      if (chosen && chosen.run) chosen.run();
    }
  }

  function triggerDownload(url, name) {
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // the files on the drive that belong to the show called `name` (any capitalization)
  function showFiles(names, name) {
    const n = name.toLowerCase();
    return names.filter(f => base(f).toLowerCase() === n && ['fseq', 'wav', 'mp3'].includes(ext(f)));
  }

  async function uploadShow() {
    const files = await pickFiles('.fseq,.wav,.mp3', true);
    if (!files.length) return;
    const fseqs = files.filter(f => ext(f.name) === 'fseq');
    const audios = files.filter(f => AUDIO.test(f.name));
    if (fseqs.length !== 1 || audios.length !== 1 || files.length !== 2) {
      App.toast('Pick two files together: the show’s .fseq and its .wav or .mp3.');
      return;
    }
    const fseq = fseqs[0], audio = audios[0];
    const check = await checkFseq(fseq);
    if (check.error) { App.toast(check.error); return; }
    const notes = [];
    if (check.warning) notes.push(check.warning);
    if (isWav(audio.name)) {
      const rate = await wavSampleRate(audio);
      if (rate && rate !== 44100) notes.push('The audio is ' + (rate / 1000) + ' kHz; the car keeps lights in sync only with 44.1 kHz audio.');
    }
    if (notes.length) {
      const go = await App.confirm({ title: 'Upload anyway?', body: notes.join(' '), ok: 'Upload' });
      if (!go) return;
    }
    const name = await askName('Name this light show', 'Show name', cleanName(base(fseq.name)));
    if (!name) return;
    const existing = state.shows.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const replace = await App.confirm({ title: 'Replace ' + existing.name + '?', body: 'A light show with that name is already on the drive.', ok: 'Replace', danger: true });
      if (!replace) return;
    }
    const audioName = name + '.' + ext(audio.name);
    // upload under temporary hidden names first, so a failed upload never costs the old show
    const stamp = Date.now();
    const tmpFseq = SHOW_DIR + '/.upload-' + stamp + '.fseq';
    const tmpAudio = SHOW_DIR + '/.upload-' + stamp + '.' + ext(audio.name);
    run('Uploading…', async () => {
      const total = fseq.size + audio.size;
      try {
        await upload(state.showRoot, tmpFseq, fseq, p => {
          state.busy = 'Uploading ' + Math.round((p * fseq.size / total) * 100) + '%'; renderBusy();
        });
        await upload(state.showRoot, tmpAudio, audio, p => {
          state.busy = 'Uploading ' + Math.round(((fseq.size + p * audio.size) / total) * 100) + '%'; renderBusy();
        });
      } catch (e) {
        await op('rm.sh', state.showRoot, tmpFseq).catch(() => {});
        await op('rm.sh', state.showRoot, tmpAudio).catch(() => {});
        throw e;
      }
      // only files ever get deleted (rm.sh is recursive); a folder in the way stops the upload
      const listing = await ls(state.showRoot, SHOW_DIR);
      const blocker = [name + '.fseq', audioName].find(t => clashes(t, listing.dirs));
      if (blocker) {
        await op('rm.sh', state.showRoot, tmpFseq, tmpAudio).catch(() => {});
        throw new Error('a folder called ' + blocker + ' is in the way in ' + SHOW_DIR);
      }
      const old = showFiles(listing.files.map(f => f.name), name);
      if (old.length && !existing) {
        await op('rm.sh', state.showRoot, tmpFseq, tmpAudio).catch(() => {});
        throw new Error('a show called ' + name + ' was just added by someone else; try again');
      }
      if (old.length) await op('rm.sh', state.showRoot, ...old.map(f => SHOW_DIR + '/' + f));
      await op('mv.sh', state.showRoot, tmpFseq, SHOW_DIR + '/' + name + '.fseq');
      await op('mv.sh', state.showRoot, tmpAudio, SHOW_DIR + '/' + audioName);
    }, 'Uploaded ' + name + '.');
  }

  async function showMenu(s) {
    const key = await actionSheet(s.name, [
      { key: 'rename', label: 'Rename' },
      { key: 'download', label: 'Download' },
      { key: 'delete', label: 'Delete', danger: true },
    ]);
    const files = [s.fseq, ...s.audio].filter(Boolean);
    if (key === 'rename') {
      const name = await askName('Rename light show', 'Show name', s.name);
      if (!name || name === s.name) return;
      run('Renaming…', async () => {
        const names = await namesIn(state.showRoot, SHOW_DIR);
        if (name.toLowerCase() !== s.name.toLowerCase() && showFiles(names, name).length) {
          throw new Error('there is already a light show called ' + name);
        }
        for (const f of files) await rename(state.showRoot, SHOW_DIR + '/' + f.name, SHOW_DIR + '/' + name + '.' + ext(f.name));
      }, 'Renamed.');
    } else if (key === 'download') {
      triggerDownload(zipURL(state.showRoot, SHOW_DIR, files.map(f => f.name)), s.name + '.zip');
    } else if (key === 'delete') {
      const yes = await App.confirm({ title: 'Delete ' + s.name + '?', body: 'This removes the show and its audio from the Pi.', ok: 'Delete', danger: true });
      if (yes) run('Deleting…', () => op('rm.sh', state.showRoot, ...files.map(f => SHOW_DIR + '/' + f.name)), 'Deleted.');
    }
  }

  async function sendToCar() {
    const yes = await App.confirm({
      title: 'Send changes to the car?',
      body: 'This disconnects and reconnects the drives so the car re-reads them. The car can’t record for those few seconds.',
      ok: 'Send',
    });
    if (!yes) return;
    state.busy = 'Reconnecting the drives…';
    renderAll();
    try {
      // the drives may already be disconnected (from System > Status); then just connect them
      const now = JSON.parse(await get('cgi-bin/status.sh')).drives_active;
      if (now === 'yes') await toggleDrivesTo('no');
      await toggleDrivesTo('yes');
      state.pending = false;
      App.toast('Done. The car will see the changes in a moment.');
    } catch (e) {
      App.toast("Couldn't reconnect the drives: " + e.message + '. Check System > Status.');
    }
    state.busy = null;
    renderAll();
  }

  // toggles the drives, then waits until status.sh reports `want`
  async function toggleDrivesTo(want) {
    await get('cgi-bin/toggledrives.sh');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const s = JSON.parse(await get('cgi-bin/status.sh'));
        if (s.drives_active === want) return;
      } catch (e) { /* keep waiting */ }
    }
    throw new Error('timed out');
  }

  // ---------- rendering ----------

  function panel(sub) {
    return document.getElementById('files-' + sub);
  }

  function renderAll() {
    ['lock', 'boombox', 'shows'].forEach(sub => {
      const el = panel(sub);
      if (el) el.replaceChildren(...render(sub).filter(Boolean));
    });
  }

  function renderBusy() {
    document.querySelectorAll('.files-busy').forEach(el => { el.textContent = state.busy || ''; });
  }

  function header(title, desc, uploadLabel, onUpload) {
    return h('div', { class: 'files-head' },
      h('div', { class: 'files-headtext' }, h('h1', { class: 'files-title', text: title }), h('p', { class: 'files-desc', text: desc })),
      onUpload ? h('button', { class: 'btn primary', onclick: onUpload, disabled: !!state.busy }, uploadLabel) : null);
  }

  function statusStrip() {
    if (state.busy) return h('div', { class: 'files-strip busy' }, h('span', { class: 'spinner' }), h('span', { class: 'files-busy', text: state.busy }));
    if (state.pending) {
      return h('div', { class: 'files-strip' },
        h('span', { text: 'The car picks up changes the next time the drives reconnect.' }),
        h('button', { class: 'btn', onclick: sendToCar }, 'Send to car now'));
    }
    return null;
  }

  function row({ play, name, meta, chips, actions }) {
    return h('div', { class: 'filerow' },
      play || h('span', { class: 'iconbtn placeholder' }),
      h('div', { class: 'filerow-text' },
        h('div', { class: 'filerow-name', text: name }),
        h('div', { class: 'filerow-meta' }, meta, ...(chips || []))),
      h('div', { class: 'filerow-actions' }, ...(actions || [])));
  }

  function chip(text, kind) {
    return h('span', { class: 'chip ' + (kind || ''), text });
  }

  function moreButton(onclick) {
    return h('button', { class: 'iconbtn more', title: 'More', 'aria-label': 'More', onclick, disabled: !!state.busy }, h('span', { class: 'dots' }));
  }

  function empty(text) {
    return h('div', { class: 'files-empty', text });
  }

  function render(sub) {
    if (!state.root && configured) {
      return [empty('There is no sound drive on this TeslaUSB. Add BOOMBOX_SIZE to the setup config to get one.')];
    }
    if (state.error) {
      return [h('div', { class: 'files-strip warn' }, h('span', { text: "Couldn't read the drive: " + state.error }),
        h('button', { class: 'btn', onclick: refresh }, 'Try again'))];
    }
    if (!state.ready) return [empty('Loading…')];
    if (sub === 'lock') return renderLock();
    if (sub === 'boombox') return renderBoombox();
    return renderShows();
  }

  function renderLock() {
    const out = [header('Lock sound', 'The car plays one sound when it locks. Keep as many as you like here and pick the one to use.',
      'Upload', () => uploadSounds(LOCK_DIR, '.wav,audio/wav', checkLockFile)), statusStrip()];

    const active = activeLockName();
    const current = h('div', { class: 'card currentlock' + (state.lock ? '' : ' none') },
      h('div', { class: 'card-label', text: 'In the car now' }),
      h('div', { class: 'currentlock-row' },
        state.lock ? playButton('lock:current', fileURL(state.root, LOCK)) : null,
        h('div', { class: 'currentlock-name', text: state.lock ? (active ? base(active) : 'A custom sound') : 'The car’s built-in sound' }),
        state.lock && !active ? h('button', { class: 'btn', onclick: saveCurrentLock, disabled: !!state.busy }, 'Save to library') : null),
      h('div', { class: 'card-detail', text: 'In the car: Toybox › Boombox › Lock Sound › USB.' }));
    out.push(current);

    out.push(h('h2', { class: 'section-title', text: 'Your lock sounds' }));
    if (!state.library.length) {
      out.push(empty('No lock sounds yet. Upload a .wav file under 1 MB.'));
    } else {
      out.push(h('div', { class: 'card filelist' }, state.library.map(f => {
        const isActive = f.name === active;
        const tooBig = f.size > LOCK_MAX_BYTES;
        const notWav = !isWav(f.name);
        return row({
          play: playButton('lock:' + f.name, fileURL(state.root, LOCK_DIR + '/' + f.name)),
          name: base(f.name),
          meta: ext(f.name).toUpperCase() + ' · ' + formatSize(f.size),
          chips: [isActive ? chip('In use', 'ok') : null, notWav ? chip('Not a WAV', 'bad') : null, tooBig ? chip('Over 1 MB', 'bad') : null],
          actions: [
            isActive ? null : h('button', { class: 'btn small', onclick: () => makeActive(f), disabled: tooBig || notWav || !!state.busy }, 'Use'),
            moreButton(() => soundMenu(LOCK_DIR, f)),
          ],
        });
      })));
    }

    const loose = looseSounds();
    const looseWavs = loose.filter(f => isWav(f.name));
    if (loose.length) {
      out.push(h('h2', { class: 'section-title', text: 'Loose files at the top of the drive' }));
      out.push(h('div', { class: 'card filelist' },
        h('div', { class: 'filelist-note' },
          h('span', { text: 'The car ignores these. Move them into your lock sounds or Boombox to use them.' }),
          looseWavs.length
            ? h('button', { class: 'btn small', onclick: () => moveLoose(looseWavs, LOCK_DIR), disabled: !!state.busy },
                looseWavs.length === loose.length ? 'Move all to lock sounds' : 'Move the .wav files to lock sounds')
            : null),
        loose.map(f => row({
          play: playButton('loose:' + f.name, fileURL(state.root, f.name)),
          name: f.name,
          meta: formatSize(f.size),
          actions: [
            h('button', { class: 'btn small', disabled: !!state.busy, onclick: async () => {
              const to = await actionSheet('Move ' + f.name, [
                isWav(f.name) ? { key: LOCK_DIR, label: 'To lock sounds' } : null,
                { key: BOOMBOX_DIR, label: 'To Boombox' },
              ].filter(Boolean));
              if (to) moveLoose([f], to);
            } }, 'Move'),
          ],
        }))));
    }
    return out;
  }

  function renderBoombox() {
    const out = [header('Boombox', 'Sounds the car can play outside while parked, or instead of the horn. It offers the first five, alphabetically.',
      'Upload', () => uploadSounds(BOOMBOX_DIR, '.wav,.mp3,audio/wav,audio/mpeg', checkBoomboxFile)), statusStrip()];
    if (!state.boombox.length) {
      out.push(empty('No Boombox sounds yet. Upload .wav or .mp3 files.'));
      return out;
    }
    out.push(h('div', { class: 'card filelist' }, state.boombox.map((f, i) => row({
      play: playButton('boombox:' + f.name, fileURL(state.root, BOOMBOX_DIR + '/' + f.name)),
      name: base(f.name),
      meta: ext(f.name).toUpperCase() + ' · ' + formatSize(f.size),
      chips: [i < BOOMBOX_SHOWN ? chip('In the car', 'ok') : chip('Not offered', '')],
      actions: [moreButton(() => soundMenu(BOOMBOX_DIR, f))],
    }))));
    if (state.boombox.length > BOOMBOX_SHOWN) {
      out.push(h('p', { class: 'files-note', text: 'The car only offers the first five. Rename a sound to move it up the list.' }));
    }
    out.push(h('p', { class: 'files-note', text: 'In the car: Toybox › Boombox, then pick USB sounds.' }));
    return out;
  }

  function renderShows() {
    const out = [header('Light shows', 'Each show is an .fseq file plus its audio with the same name. The car lists every complete show to choose from.',
      'Upload a show', uploadShow), statusStrip()];
    if (!state.shows.length) {
      out.push(empty('No light shows yet. Upload the .fseq and the .wav (or .mp3) together.'));
      return out;
    }
    out.push(h('div', { class: 'card filelist' }, state.shows.map(s => {
      let problem = null;
      if (!s.fseq) problem = 'Missing its .fseq';
      else if (!s.audio.length) problem = 'Missing its audio';
      else if (s.audio.length > 1) problem = 'Has both .wav and .mp3';
      const audio = s.audio[0];
      return row({
        play: audio ? playButton('show:' + s.name, fileURL(state.showRoot, SHOW_DIR + '/' + audio.name)) : null,
        name: s.name,
        meta: [s.fseq ? 'FSEQ' : null].concat(s.audio.map(a => ext(a.name).toUpperCase())).filter(Boolean).join(' + ') + ' · ' + formatSize(s.size),
        chips: [problem ? chip(problem, 'warn') : chip('Ready', 'ok')],
        actions: [moreButton(() => showMenu(s))],
      });
    })));
    out.push(h('p', { class: 'files-note', text: 'In the car: Toybox › Light Show › Schedule Show, then pick the show.' }));
    return out;
  }

  window.Files = {
    onConfig, show, refresh,
    // exposed for tests
    _check: { checkFseq, wavSampleRate, groupShows, cleanName, uniqueName },
    _opsDone: () => opsDone,
  };
})();
