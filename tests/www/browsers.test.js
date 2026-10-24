// Browser tests for the two "All files" screens: the file browser (Files > All files) and the
// nginx listing of the clips (Clips > All files). Run with `npm test` in this folder (see README.md).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { findChromium, open: openWith, text } = require('./helpers');

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findChromium() }); });
after(async () => { if (browser) await browser.close(); });

const open = (t, opts) => openWith(browser, t, opts);
const PHONE = { width: 390, height: 844 };

async function openBrowser(t, opts = {}) {
  const r = await open(t, { hash: '#files/all', ...opts });
  await r.page.waitForSelector('#filebrowser .fb-fileslist .fb-fileentry');
  return r;
}

const entry = (page, name) => page.locator('#filebrowser .fb-fileslist > div', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') });
const pseudo = (loc, which, prop) => loc.evaluate((el, [w, p]) => getComputedStyle(el, w).getPropertyValue(p), [which, prop]);

test('file rows are full-width, touch-sized, with an icon and a readable size', async t => {
  const { page } = await openBrowser(t);
  const row = entry(page, 'michael-myers.wav');
  const box = await row.boundingBox();
  const list = await page.locator('#filebrowser .fb-fileslist').boundingBox();
  assert.ok(box.height >= 40, 'at least 40 px tall (' + box.height + ')');
  assert.ok(box.width > list.width * 0.9, 'spans the list');
  assert.equal(await pseudo(row, '::after', 'content'), '"232 KB"');
  assert.match(await pseudo(row, '::before', 'mask-image'), /M9 18V5l11-2v13/, 'audio icon for a .wav');
  assert.match(await pseudo(entry(page, 'Boombox'), '::before', 'mask-image'), /M3 7\.5A2\.5/, 'folder icon');
  assert.match(await pseudo(entry(page, 'notes.txt'), '::before', 'mask-image'), /M14 3H7/, 'plain file icon');
});

test('small files are shown in KB, not raw bytes', async t => {
  const { page } = await openBrowser(t, { drive: { 'small.wav': 54134 } });
  assert.equal(await pseudo(entry(page, 'small.wav'), '::after', 'content'), '"53 KB"');
});

test('the folder path reads "Extras › Boombox", without brackets', async t => {
  const { page } = await openBrowser(t);
  await entry(page, 'Boombox').dblclick();
  await page.waitForFunction(() => document.querySelector('#filebrowser .fb-dirpath').textContent.includes('Boombox'));
  const path = await page.locator('#filebrowser .fb-dirpath').textContent();
  assert.equal(path, 'Extras›Boombox');
  assert.equal(await page.locator('#filebrowser .fb-dirpath .fb-crumbsep').count(), 1);
});

test('on a phone the tree is hidden, the list is full width, and a tap opens a folder', async t => {
  const { page } = await openBrowser(t, { viewport: PHONE, hasTouch: true });
  assert.equal(await page.locator('#filebrowser .fb-tree').isVisible(), false);
  assert.equal(await page.locator('#filebrowser .fb-splitterflag').isVisible(), false);
  const list = await page.locator('#filebrowser .fb-fileslist').boundingBox();
  assert.ok(list.width >= PHONE.width - 2, 'list is full width (' + list.width + ')');
  await entry(page, 'LightShow').tap();
  await page.waitForFunction(() => document.querySelector('#filebrowser .fb-dirpath').textContent.includes('LightShow'));
  await entry(page, 'Holiday.fseq').waitFor({ timeout: 5000 });
});

test('tapping a folder name while renaming it doesn’t open the folder', async t => {
  const { page } = await openBrowser(t, { viewport: PHONE, hasTouch: true });
  await page.locator('#filebrowser .fb-newfolderbutton').tap();
  const editing = page.locator('#filebrowser .fb-direntry[contenteditable="true"]');
  await editing.waitFor({ timeout: 5000 });
  await editing.tap();
  await page.waitForTimeout(400);
  assert.equal(await editing.count(), 1, 'still editing');
  assert.equal(await page.locator('#filebrowser .fb-dirpath').textContent(), 'Extras', 'still in the same folder');
});

test('the free-space tooltip is fully visible', async t => {
  for (const viewport of [PHONE, { width: 1280, height: 800 }]) {
    const { page } = await openBrowser(t, { viewport });
    await page.waitForFunction(() => document.querySelector('#filebrowser .fb-diskinfo').textContent.includes('free'));
    await page.locator('#filebrowser .fb-diskinfo-outer').hover();
    const r = await page.locator('#filebrowser .fb-diskinfo').evaluate(el => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { left: b.x, right: b.x + b.width, top: b.y, visible: getComputedStyle(el).visibility, onTop: el.contains(hit) };
    });
    assert.equal(r.visible, 'visible');
    assert.ok(r.onTop, 'nothing clips or covers it at ' + viewport.width + ' px');
    assert.ok(r.left >= 0 && r.right <= viewport.width, 'inside the screen at ' + viewport.width + ' px (' + r.left + '-' + r.right + ')');
  }
});

test('a mouse click on a folder still just selects it', async t => {
  const { page } = await openBrowser(t);
  await entry(page, 'Boombox').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#filebrowser .fb-dirpath').textContent(), 'Extras');
  assert.ok(await entry(page, 'Boombox').evaluate(e => e.classList.contains('fb-selected')));
});

test('the action bar fits on a phone and has labels on a computer', async t => {
  const { page } = await openBrowser(t, { viewport: PHONE, hasTouch: true });
  const bar = await page.locator('#filebrowser .fb-buttonbar').boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= PHONE.width, 'inside the screen');
  const nav = await page.locator('.appnav').boundingBox();
  assert.ok(bar.y + bar.height <= nav.y, 'above the tab bar');

  const desk = await openBrowser(t);
  assert.equal(await pseudo(desk.page.locator('#filebrowser .fb-uploadbutton'), '::after', 'content'), '"Upload"');
});

test('the clips listing is styled: icons, touch-sized rows, a Back row, no date column', async t => {
  const { page } = await open(t, { hash: '#clips/files' });
  const frame = page.frameLocator('iframe.recordings');
  await frame.locator('a', { hasText: 'SentryClips/' }).waitFor();
  const link = frame.locator('td.link a', { hasText: 'SentryClips/' });
  assert.ok((await link.boundingBox()).height >= 44);
  assert.match(await pseudo(link, '::before', 'mask-image'), /M3 7\.5A2\.5/, 'folder icon');
  assert.equal(await frame.locator('td.date').first().isVisible(), false);

  await link.click();
  const back = frame.locator('td.link a[href="../"]');
  await back.waitFor();
  assert.equal(await pseudo(back, '::after', 'content'), '"Back"');
  await frame.locator('a', { hasText: '2026-10-22_18-40-44/' }).click();
  const video = frame.locator('td.link a', { hasText: '2026-10-22_18-39-43-front.mp4' });
  await video.waitFor();
  assert.match(await pseudo(video, '::before', 'mask-image'), /m16 10\.5/, 'video icon');
});
