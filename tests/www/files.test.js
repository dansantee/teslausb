// Browser tests for Files: lock sounds, Boombox and light shows on the Extras drive.
// Run with `npm test` in this folder (see README.md).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { findChromium, open: openWith, visibleTab, text } = require('./helpers');

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findChromium() }); });
after(async () => { if (browser) await browser.close(); });

const open = (t, opts) => openWith(browser, t, opts);

// a minimal FSEQ header: "PSEQ", version major at byte 7, step time at 18, compression at 20
function fseq({ major = 2, step = 20, compression = 0, size = 64 } = {}) {
  const b = Buffer.alloc(size);
  b.write('PSEQ', 0, 'latin1');
  b[4] = 32;
  b[7] = major;
  b[8] = 32;
  b[18] = step;
  b[20] = compression;
  return b;
}

// a WAV header with the given sample rate
function wav(rate = 44100, size = 2048) {
  const b = Buffer.alloc(size);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(size - 8, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.write('data', 36, 'latin1');
  return b;
}

async function openFiles(t, sub, opts = {}) {
  const r = await open(t, { ...opts, hash: '#files/' + sub });
  await r.page.waitForSelector('#files-' + sub + ' .files-title');
  return r;
}

const rowNames = (page, sub) => page.locator('#files-' + sub + ' .filelist .filerow-name').allInnerTexts();

function rowFor(page, sub, name) {
  return page.locator('#files-' + sub + ' .filerow').filter({ has: page.locator('.filerow-name', { hasText: new RegExp('^' + name + '$') }) });
}

// runs `action` and waits until the Files operation it starts has finished and the lists re-read
async function did(page, action) {
  const before = await page.evaluate(() => Files._opsDone());
  await action();
  await page.waitForFunction(n => Files._opsDone() > n, before);
}

async function choose(page, action, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), action()]);
  await chooser.setFiles(files);
}

async function sheet(page, label) {
  await page.locator('.filesdialog .sheetaction', { hasText: label }).click();
}

async function typeName(page, name) {
  const input = page.locator('.filesdialog .textinput');
  await input.fill(name);
  await page.locator('.filesdialog button[type="submit"]').click();
}

async function confirm(page) {
  await page.locator('#appdialog-ok').click();
}

// runs `action` and returns the toast it shows (ignoring any earlier one)
async function nextToast(page, action) {
  await page.evaluate(() => { const el = document.querySelector('#toast'); el.textContent = ''; el.classList.remove('shown'); });
  await action();
  await page.waitForFunction(() => document.querySelector('#toast').textContent !== '');
  return text(page, '#toast');
}

test('the Files section replaces Drives and creates the folders the car expects', async t => {
  const { page, server, errors } = await openFiles(t, 'lock');
  assert.equal(await page.locator('.navitem[data-view="files"]').innerText(), 'Files');
  assert.equal(await page.locator('.navitem[data-view="drives"]').count(), 0);
  assert.ok(server.drive.has('LockSounds/'), 'LockSounds folder created');
  const mkdirs = server.calls.filter(r => r.startsWith('mkdir.sh'));
  assert.deepEqual(mkdirs, ['mkdir.sh fs/Boombox&LockSounds'], 'only the missing folder is created');
  assert.deepEqual(errors, []);
  for (const sub of ['lock', 'boombox', 'shows']) {
    await page.evaluate(h => { location.hash = h; }, '#files/' + sub);
    await page.waitForSelector('#files-' + sub + ' .files-title');
    assert.doesNotMatch(await text(page, '#files-' + sub), /\bnull\b|\bundefined\b/, sub + ' shows no stray null/undefined');
  }
});

test('creates every folder on an empty drive', async t => {
  const empty = { 'LockChime.wav': null, 'LockChime_Zelda.wav': null, 'michael-myers.wav': null, 'notes.txt': null,
                  'Boombox/': null, 'Boombox/airhorn.mp3': null, 'LightShow/': null, 'LightShow/Holiday.fseq': null,
                  'LightShow/Holiday.wav': null, 'LightShow/Halfdone.fseq': null };
  const { page, server } = await openFiles(t, 'lock', { drive: empty });
  for (const d of ['LockSounds/', 'Boombox/', 'LightShow/']) assert.ok(server.drive.has(d), d + ' created');
  assert.equal(await text(page, '#files-lock .currentlock-name'), 'The car’s built-in sound');
});

test('offers loose sound files at the top of the drive and moves them into the library', async t => {
  const { page, server } = await openFiles(t, 'lock');
  assert.equal(await text(page, '#files-lock .currentlock-name'), 'A custom sound');
  const loose = await page.locator('#files-lock .filelist').last().locator('.filerow-name').allInnerTexts();
  assert.deepEqual(loose, ['LockChime_Zelda.wav', 'michael-myers.wav'], 'only audio files, not LockChime.wav, notes or dot files');

  await did(page, () => page.locator('button', { hasText: 'Move all to lock sounds' }).click());
  assert.ok(server.drive.has('LockSounds/LockChime_Zelda.wav') && server.drive.has('LockSounds/michael-myers.wav'));
  assert.ok(!server.drive.has('michael-myers.wav'));
  assert.ok(server.drive.has('LockChime.wav'), 'the active lock sound stays where the car reads it');
  // LockChime.wav has the same size as michael-myers.wav, so that's the one in use
  assert.equal(await text(page, '#files-lock .currentlock-name'), 'michael-myers');
  assert.equal(await rowFor(page, 'lock', 'michael-myers').locator('.chip.ok').innerText(), 'In use');
});

test('moves a single loose file to Boombox', async t => {
  const { page, server } = await openFiles(t, 'lock');
  await rowFor(page, 'lock', 'LockChime_Zelda.wav').locator('button', { hasText: 'Move' }).click();
  await did(page, () => sheet(page, 'To Boombox'));
  assert.ok(server.drive.has('Boombox/LockChime_Zelda.wav') && !server.drive.has('LockChime_Zelda.wav'));
  assert.ok(server.drive.has('michael-myers.wav'), 'the other loose file stays put');
});

test('makes a library sound the lock sound', async t => {
  const { page, server } = await openFiles(t, 'lock', { drive: { 'LockSounds/': 0, 'LockSounds/Zelda.wav': 349844, 'LockSounds/Kpop.wav': 451688 } });
  await did(page, () => rowFor(page, 'lock', 'Zelda').locator('button', { hasText: 'Use' }).click());
  assert.equal(server.drive.get('LockChime.wav').length, 349844);
  assert.equal(server.drive.get('LockSounds/.active').toString(), 'Zelda.wav');
  assert.equal(await text(page, '#files-lock .currentlock-name'), 'Zelda');
  assert.equal(await rowFor(page, 'lock', 'Zelda').locator('.chip.ok').innerText(), 'In use');
  assert.equal(await rowFor(page, 'lock', 'Kpop').locator('button', { hasText: 'Use' }).count(), 1);
  assert.match(await text(page, '#files-lock .files-strip'), /next time the drives reconnect/);
});

test('flags lock sounds over 1 MB and won’t use them', async t => {
  const { page } = await openFiles(t, 'lock', { drive: { 'LockSounds/': 0, 'LockSounds/Long.wav': 2000000 } });
  const r = rowFor(page, 'lock', 'Long');
  assert.equal(await r.locator('.chip.bad').innerText(), 'Over 1 MB');
  assert.equal(await r.locator('button', { hasText: 'Use' }).isDisabled(), true);
});

test('uploads lock sounds, refusing anything that isn’t a WAV under 1 MB', async t => {
  const { page, server } = await openFiles(t, 'lock');
  const up = () => page.locator('#files-lock .files-head button').click();

  assert.match(await nextToast(page, () => choose(page, up, [{ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(100) }])), /have to be \.wav files/);

  assert.match(await nextToast(page, () => choose(page, up, [{ name: 'big.wav', mimeType: 'audio/wav', buffer: wav(44100, 1200000) }])), /under 1 MB/);

  await did(page, () => choose(page, up, [{ name: 'Chirp.wav', mimeType: 'audio/wav', buffer: wav() }]));
  assert.equal(server.drive.get('LockSounds/Chirp.wav').length, 2048);
  assert.ok(!server.drive.has('LockSounds/big.wav') && !server.drive.has('LockSounds/song.mp3'));
  assert.ok((await rowNames(page, 'lock')).includes('Chirp'));
});

test('renames and deletes a lock sound, keeping the in-use marker in step', async t => {
  const { page, server } = await openFiles(t, 'lock', { drive: { 'LockSounds/': 0, 'LockSounds/Zelda.wav': 349844, 'LockSounds/.active': 'Zelda.wav', 'LockChime.wav': 349844 } });
  await rowFor(page, 'lock', 'Zelda').locator('.more').click();
  await sheet(page, 'Rename');
  await did(page, () => typeName(page, 'Hyrule'));
  assert.ok(server.drive.has('LockSounds/Hyrule.wav') && !server.drive.has('LockSounds/Zelda.wav'));
  assert.equal(server.drive.get('LockSounds/.active').toString(), 'Hyrule.wav');
  assert.equal(await text(page, '#files-lock .currentlock-name'), 'Hyrule');

  await rowFor(page, 'lock', 'Hyrule').locator('.more').click();
  await sheet(page, 'Delete');
  await did(page, () => confirm(page));
  assert.ok(!server.drive.has('LockSounds/Hyrule.wav'));
});

test('shows which Boombox sounds the car offers (the first five, alphabetically)', async t => {
  const drive = { 'Boombox/airhorn.mp3': null };
  for (const n of ['g', 'B', 'a', 'f', 'C', 'e', 'd']) drive['Boombox/' + n + '.mp3'] = 1000;
  const { page } = await openFiles(t, 'boombox', { drive });
  assert.deepEqual(await rowNames(page, 'boombox'), ['a', 'B', 'C', 'd', 'e', 'f', 'g']);
  const chips = await page.locator('#files-boombox .filerow .chip').allInnerTexts();
  assert.deepEqual(chips, ['In the car', 'In the car', 'In the car', 'In the car', 'In the car', 'Not offered', 'Not offered']);
  assert.match(await text(page, '#files-boombox'), /only offers the first five/);
});

test('uploads Boombox sounds as .wav or .mp3 only', async t => {
  const { page, server } = await openFiles(t, 'boombox');
  const up = () => page.locator('#files-boombox .files-head button').click();
  assert.match(await nextToast(page, () => choose(page, up, [{ name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }])), /\.wav or \.mp3/);
  await did(page, () => choose(page, up, [{ name: 'airhorn.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(500) }]));
  assert.ok(server.drive.has('Boombox/airhorn (2).mp3'), 'a name clash gets a number instead of overwriting');
  assert.equal(server.drive.get('Boombox/airhorn.mp3').length, 54134);
});

test('groups light show files into shows and flags incomplete ones', async t => {
  const { page } = await openFiles(t, 'shows');
  assert.deepEqual(await rowNames(page, 'shows'), ['Halfdone', 'Holiday']);
  assert.equal(await rowFor(page, 'shows', 'Holiday').locator('.chip').innerText(), 'Ready');
  assert.equal(await rowFor(page, 'shows', 'Halfdone').locator('.chip').innerText(), 'Missing its audio');
});

test('uploads a light show as a matched pair under one name', async t => {
  const { page, server } = await openFiles(t, 'shows');
  await choose(page, () => page.locator('#files-shows .files-head button').click(), [
    { name: 'export_v2.fseq', mimeType: 'application/octet-stream', buffer: fseq() },
    { name: 'Monster Mash (final).wav', mimeType: 'audio/wav', buffer: wav(44100) },
  ]);
  await page.waitForSelector('.filesdialog .textinput');
  assert.equal(await page.locator('.filesdialog .textinput').inputValue(), 'export_v2');
  await did(page, () => typeName(page, 'Spooky'));
  assert.ok(server.drive.has('LightShow/Spooky.fseq') && server.drive.has('LightShow/Spooky.wav'));
  assert.equal(await rowFor(page, 'shows', 'Spooky').locator('.chip').innerText(), 'Ready');
});

test('refuses compressed or old .fseq files, and warns about 48 kHz audio', async t => {
  const { page, server } = await openFiles(t, 'shows');
  const up = () => page.locator('#files-shows .files-head button').click();

  assert.match(await nextToast(page, () => choose(page, up, [
    { name: 'a.fseq', mimeType: 'application/octet-stream', buffer: fseq({ compression: 1 }) },
    { name: 'a.wav', mimeType: 'audio/wav', buffer: wav() },
  ])), /compressed/);

  assert.match(await nextToast(page, () => choose(page, up, [
    { name: 'b.fseq', mimeType: 'application/octet-stream', buffer: fseq({ major: 1 }) },
    { name: 'b.wav', mimeType: 'audio/wav', buffer: wav() },
  ])), /version 1/);

  assert.match(await nextToast(page, () => choose(page, up, [{ name: 'c.fseq', mimeType: 'application/octet-stream', buffer: fseq() }])), /Pick two files together/);

  await choose(page, up, [
    { name: 'd.fseq', mimeType: 'application/octet-stream', buffer: fseq() },
    { name: 'd.wav', mimeType: 'audio/wav', buffer: wav(48000) },
  ]);
  await page.waitForSelector('#appdialog[open]');
  assert.match(await text(page, '#appdialog-text'), /48 kHz/);
  await page.locator('#appdialog button[value="cancel"]').click();
  await page.waitForTimeout(200);
  assert.deepEqual([...server.drive.keys()].filter(k => k.startsWith('LightShow/')).sort(),
                   ['LightShow/', 'LightShow/Halfdone.fseq', 'LightShow/Holiday.fseq', 'LightShow/Holiday.wav']);
});

test('renames and deletes a light show as a pair', async t => {
  const { page, server } = await openFiles(t, 'shows');
  await rowFor(page, 'shows', 'Holiday').locator('.more').click();
  await sheet(page, 'Rename');
  await did(page, () => typeName(page, 'Xmas 2026'));
  assert.ok(server.drive.has('LightShow/Xmas 2026.fseq') && server.drive.has('LightShow/Xmas 2026.wav'));
  assert.ok(!server.drive.has('LightShow/Holiday.fseq') && !server.drive.has('LightShow/Holiday.wav'));

  await rowFor(page, 'shows', 'Xmas 2026').locator('.more').click();
  await sheet(page, 'Delete');
  await did(page, () => confirm(page));
  assert.ok(!server.drive.has('LightShow/Xmas 2026.fseq') && !server.drive.has('LightShow/Xmas 2026.wav'));
  assert.deepEqual(await rowNames(page, 'shows'), ['Halfdone']);
});

test('sends changes to the car by reconnecting the drives', async t => {
  const { page, server } = await openFiles(t, 'lock', { drive: { 'LockSounds/': 0, 'LockSounds/Zelda.wav': 349844 } });
  await did(page, () => rowFor(page, 'lock', 'Zelda').locator('button', { hasText: 'Use' }).click());
  await page.locator('#files-lock button', { hasText: 'Send to car now' }).click();
  await confirm(page);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Done'), null, { timeout: 15000 });
  assert.equal(server.requests.filter(r => r === 'toggledrives.sh').length, 2);
  assert.equal(await page.locator('#files-lock button', { hasText: 'Send to car now' }).count(), 0);
});

test('a failed upload while replacing a show keeps the old show', async t => {
  const { page, server } = await openFiles(t, 'shows', { failUpload: '.wav' });
  const before = server.drive.get('LightShow/Holiday.wav').length;
  await choose(page, () => page.locator('#files-shows .files-head button').click(), [
    { name: 'new.fseq', mimeType: 'application/octet-stream', buffer: fseq() },
    { name: 'new.wav', mimeType: 'audio/wav', buffer: wav() },
  ]);
  await page.waitForSelector('.filesdialog .textinput');
  await page.locator('.filesdialog .textinput').fill('Holiday');
  await page.locator('.filesdialog button[type="submit"]').click();
  await page.waitForSelector('#appdialog[open]');
  const shown = await nextToast(page, () => did(page, () => confirm(page)));
  assert.match(shown, /Something went wrong/);
  assert.ok(server.drive.has('LightShow/Holiday.fseq'), 'old .fseq kept');
  assert.equal(server.drive.get('LightShow/Holiday.wav').length, before, 'old audio kept');
  assert.deepEqual([...server.drive.keys()].filter(k => k.includes('.upload-')), [], 'temporary files cleaned up');
});

test('replacing a show never deletes a folder that happens to share its name', async t => {
  const { page, server } = await openFiles(t, 'shows', { drive: { 'LightShow/Holiday.mp3/': 0, 'LightShow/Holiday.mp3/backup.txt': 'keep me' } });
  await choose(page, () => page.locator('#files-shows .files-head button').click(), [
    { name: 'new.fseq', mimeType: 'application/octet-stream', buffer: fseq() },
    { name: 'new.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(300) },
  ]);
  await page.waitForSelector('.filesdialog .textinput');
  await page.locator('.filesdialog .textinput').fill('Holiday');
  await page.locator('.filesdialog button[type="submit"]').click();
  await page.waitForSelector('#appdialog[open]');
  const shown = await nextToast(page, () => did(page, () => confirm(page)));
  assert.match(shown, /folder called Holiday\.mp3 is in the way/);
  assert.equal(server.drive.get('LightShow/Holiday.mp3/backup.txt').toString(), 'keep me', 'the folder and its contents survive');
  assert.ok(server.drive.has('LightShow/Holiday.fseq') && server.drive.has('LightShow/Holiday.wav'), 'the old show is untouched');
  assert.deepEqual([...server.drive.keys()].filter(k => k.includes('.upload-')), [], 'temporary files cleaned up');
});

test('rename checks the drive as it is now, not the list from when the tab opened', async t => {
  const { page, server } = await openFiles(t, 'boombox');
  server.drive.set('Boombox/New.mp3', Buffer.alloc(777));   // added from All files, the car, another phone...
  await rowFor(page, 'boombox', 'airhorn').locator('.more').click();
  await sheet(page, 'Rename');
  const shown = await nextToast(page, () => did(page, () => typeName(page, 'new')));
  assert.match(shown, /already a file called new\.mp3/);
  assert.equal(server.drive.get('Boombox/New.mp3').length, 777, 'the other file was not overwritten');
  assert.ok(server.drive.has('Boombox/airhorn.mp3'));
});

test('re-reads the drive every time a Files tab is opened', async t => {
  const { page, server } = await openFiles(t, 'boombox');
  server.drive.set('Boombox/fresh.mp3', Buffer.alloc(10));
  await page.evaluate(() => { location.hash = '#files/lock'; });
  await page.evaluate(() => { location.hash = '#files/boombox'; });
  await page.waitForFunction(() => document.querySelector('#files-boombox').textContent.includes('fresh'));
});

test('only WAV files can become the lock sound', async t => {
  const { page, server } = await openFiles(t, 'lock', { drive: { 'LockSounds/': 0, 'LockSounds/song.mp3': 5000, 'tune.mp3': 4000 } });
  const r = rowFor(page, 'lock', 'song');
  assert.equal(await r.locator('.chip.bad').innerText(), 'Not a WAV');
  assert.equal(await r.locator('button', { hasText: 'Use' }).isDisabled(), true);

  await rowFor(page, 'lock', 'tune.mp3').locator('button', { hasText: 'Move' }).click();
  assert.deepEqual(await page.locator('.filesdialog .sheetaction').allInnerTexts(), ['To Boombox']);
  await page.locator('.filesdialog button', { hasText: 'Cancel' }).click();

  await did(page, () => page.locator('button', { hasText: 'Move the .wav files to lock sounds' }).click());
  assert.ok(server.drive.has('tune.mp3'), 'the mp3 stays where it was');
  assert.ok(server.drive.has('LockSounds/michael-myers.wav') && server.drive.has('LockSounds/LockChime_Zelda.wav'));
});

test('fixes a folder with the wrong capitalization instead of failing', async t => {
  const { page, server, errors } = await openFiles(t, 'boombox', { drive: { 'Boombox/': null, 'Boombox/airhorn.mp3': null, 'boombox/': 0, 'boombox/quack.wav': 300 } });
  assert.ok(server.drive.has('Boombox/') && !server.drive.has('boombox/'));
  assert.ok(server.drive.has('Boombox/quack.wav'), 'its files came along');
  assert.deepEqual(await rowNames(page, 'boombox'), ['quack']);
  assert.deepEqual(errors, []);
});

test('moves loose files whose names start with a dash', async t => {
  const { page, server } = await openFiles(t, 'lock', { drive: { '-horn.wav': 1000 } });
  await did(page, () => page.locator('button', { hasText: 'Move all to lock sounds' }).click());
  assert.ok(server.drive.has('LockSounds/-horn.wav') && !server.drive.has('-horn.wav'));
  assert.ok(server.drive.has('LockSounds/michael-myers.wav'), 'the rest of the batch still moved');
});

test('Send to car just connects the drives if they were already disconnected', async t => {
  const { page, server } = await openFiles(t, 'lock', { status: { drives_active: 'no' }, drive: { 'LockSounds/': 0, 'LockSounds/Zelda.wav': 349844 } });
  await did(page, () => rowFor(page, 'lock', 'Zelda').locator('button', { hasText: 'Use' }).click());
  await page.locator('#files-lock button', { hasText: 'Send to car now' }).click();
  await confirm(page);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Done'), null, { timeout: 15000 });
  assert.equal(server.requests.filter(r => r === 'toggledrives.sh').length, 1);
});

test('works on a phone', async t => {
  const { page } = await openFiles(t, 'shows', { viewport: { width: 390, height: 844 } });
  assert.deepEqual(await visibleTab(page), ['files/shows']);
  const row = await rowFor(page, 'shows', 'Holiday').boundingBox();
  assert.ok(row.width <= 390 && row.x >= 0, 'rows fit the screen');
  const more = await rowFor(page, 'shows', 'Holiday').locator('.more').boundingBox();
  assert.ok(more.x + more.width <= 390, 'the row menu button is on screen');
});

test('cleans names so they are safe to pass to the drive scripts', async t => {
  const { page } = await openFiles(t, 'lock');
  const r = await page.evaluate(() => ({
    traversal: Files._check.cleanName('../../etc/passwd'),
    option: Files._check.cleanName('-rf now'),
    chars: Files._check.cleanName('a:b*c?"d<e>f|g\\h'),
    unique: Files._check.uniqueName('x.wav', ['X.wav', 'x (2).wav']),
  }));
  assert.deepEqual(r, { traversal: 'etcpasswd', option: 'rf now', chars: 'abcdefgh', unique: 'x (3).wav' });
});
