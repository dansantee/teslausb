// Browser tests for Clips: the library, opening events, the control bar, camera focus and layouts.
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
const PHONE = { width: 390, height: 844 };

async function openClips(t, opts = {}) {
  const r = await open(t, { hash: '#clips', ...opts });
  await r.page.waitForSelector('.clipcard, .clipempty:not(:empty)');
  await r.page.waitForFunction(() => !document.querySelector('.clipempty') || !document.querySelector('.clipempty').textContent.startsWith('Loading'));
  return r;
}

const cards = page => page.locator('.clipcard').evaluateAll(els => els.map(e => e.dataset.key));
const card = (page, k) => page.locator('.clipcard[data-key="' + k + '"]');

test('lists events newest first, grouped by day, with filter counts', async t => {
  const { page, errors } = await openClips(t);
  assert.deepEqual(await cards(page), [
    'SentryClips/2026-10-22_18-40-44', 'RecentClips/2026-10-22',
    'SentryClips/2026-10-21_09-12-03', 'SavedClips/2026-10-20_14-05-31',
  ]);
  assert.equal(await page.locator('.clipday').count(), 3);
  const chips = await page.locator('.filterchip').allInnerTexts();
  assert.deepEqual(chips.map(c => c.replace(/\s+/g, ' ').trim()), ['All 4', 'Sentry 2', 'Saved 1', 'Recent 1']);
  assert.deepEqual(errors, []);
});

test('filters the library', async t => {
  const { page } = await openClips(t);
  await page.locator('.filterchip[data-filter="SentryClips"]').click();
  assert.deepEqual(await cards(page), ['SentryClips/2026-10-22_18-40-44', 'SentryClips/2026-10-21_09-12-03']);
  await page.locator('.filterchip[data-filter="RecentClips"]').click();
  assert.deepEqual(await cards(page), ['RecentClips/2026-10-22']);
  assert.match(await card(page, 'RecentClips/2026-10-22').innerText(), /Recent driving[\s\S]*2 min · 1 Sentry event/);
});

test('cards show the place and cause from event.json, and the car’s thumbnail', async t => {
  const { page } = await openClips(t);
  const c = card(page, 'SentryClips/2026-10-21_09-12-03');
  await page.waitForFunction(() => {
    const el = document.querySelector('.clipcard[data-key="SentryClips/2026-10-21_09-12-03"] .clipcard-place');
    return el && el.textContent !== '';
  });
  assert.equal(await c.locator('.clipcard-place').innerText(), 'E 63rd St, Kansas City · Something came close');
  assert.equal(await card(page, 'SavedClips/2026-10-20_14-05-31').locator('img').count(), 1);
  assert.equal(await c.locator('.clipthumb.empty').count(), 1, 'no thumbnail file means a placeholder');
});

test('opening an event selects it, updates the link and fills the header', async t => {
  const { page } = await openClips(t);
  await card(page, 'SentryClips/2026-10-21_09-12-03').click();
  assert.equal(await page.evaluate(() => currentsequence.sequencename), '2026-10-21_09-12-03');
  assert.equal(await page.evaluate(() => location.hash), '#clips/player/SentryClips/2026-10-21_09-12-03');
  assert.ok(await card(page, 'SentryClips/2026-10-21_09-12-03').evaluate(e => e.classList.contains('selected')));
  await page.waitForFunction(() => document.querySelector('#clipheader .clipsub').textContent.includes('Kansas City'));
  assert.match(await text(page, '#clipheader'), /Sentry event[\s\S]*9:12[\s\S]*Something came close · E 63rd St, Kansas City · 1 min/);
  await page.waitForFunction(() => /9:11:0\d AM · 0:00 \/ 1:00/.test(document.querySelector('#clipclock').textContent));
});

test('a deep link opens that event straight away', async t => {
  const { page } = await openClips(t, { hash: '#clips/player/SavedClips/2026-10-20_14-05-31' });
  await page.waitForFunction(() => window.currentsequence && currentsequence.sequencename === '2026-10-20_14-05-31');
  assert.deepEqual(await visibleTab(page), ['clips/player']);
  await page.waitForFunction(() => document.querySelector('#clipheader').textContent.includes('Saved with the horn'));
});

test('on a phone the library comes first, and an event opens full screen with a way back', async t => {
  const { page } = await openClips(t, { viewport: PHONE });
  assert.equal(await page.locator('.cliplib').isVisible(), true);
  assert.equal(await page.locator('.clipplayer').isVisible(), false);
  await card(page, 'SavedClips/2026-10-20_14-05-31').click();
  assert.equal(await page.locator('.clipplayer').isVisible(), true);
  assert.equal(await page.locator('.cliplib').isVisible(), false);
  const controls = await page.locator('#videocontrols').boundingBox();
  const nav = await page.locator('.appnav').boundingBox();
  assert.ok(controls.y + controls.height <= nav.y + 1, 'the controls sit above the tab bar');
  await page.locator('#clipback').click();
  assert.equal(await page.locator('.cliplib').isVisible(), true);
  assert.equal(await page.evaluate(() => location.hash), '#clips/player');
});

test('the controls are always visible, with no hover needed', async t => {
  const { page } = await openClips(t);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(5500);   // the old controls faded out after 5 s without mouse movement
  const style = await page.locator('#videocontrols').evaluate(e => ({ opacity: getComputedStyle(e).opacity, position: getComputedStyle(e).position }));
  assert.deepEqual(style, { opacity: '1', position: 'static' });
  for (const id of ['#playpause', '#skipback', '#skipforward', '#cliplayout', '#clipfullscreen', '#position']) {
    assert.equal(await page.locator(id).isVisible(), true, id + ' visible');
  }
  assert.equal(await page.locator('.navbar').isVisible(), false, 'the old hover menus are gone');
});

test('tapping a camera enlarges it, and tapping again goes back', async t => {
  const { page } = await openClips(t);
  await page.locator('#frontview').click({ force: true });
  const on = await page.evaluate(() => {
    const g = document.querySelector('.videoholder');
    return { focus: g.classList.contains('focus'), areas: g.style.gridTemplateAreas, hiddenPillars: document.getElementById('leftpillarview').hasAttribute('data-focushide') };
  });
  assert.deepEqual(on, {
    focus: true,
    areas: '"frontview frontview frontview" "backview leftrepeaterview rightrepeaterview"',
    hiddenPillars: true,
  });
  assert.equal(await text(page, '#clipfocus'), 'Front camera · tap it again to see all');
  await page.locator('#frontview').click({ force: true });
  assert.equal(await page.evaluate(() => document.querySelector('.videoholder').classList.contains('focus')), false);
  assert.equal(await page.evaluate(() => document.querySelector('.videoholder').style.gridTemplateAreas), '');
});

test('every control fits on screen at in-between widths', async t => {
  for (const width of [825, 900, 1024, 1199]) {
    const { page } = await openClips(t, { viewport: { width, height: 800 } });
    for (const id of ['#cliplayout', '#clipfullscreen', '#playpause', '#skipforward', '#clipclock']) {
      const b = await page.locator(id).boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= width + 0.5, id + ' fits at ' + width + ' px (x=' + (b && b.x) + ', w=' + (b && b.width) + ')');
    }
  }
});

test('focus mode enlarges the camera in the pillar layout too', async t => {
  const { page } = await openClips(t);
  await page.evaluate(() => setLayout(6));
  await page.locator('#frontview').click({ force: true });
  const r = await page.evaluate(() => {
    const g = document.querySelector('.videoholder');
    return { rows: getComputedStyle(g).gridTemplateRows.split(' ').length,
             front: document.getElementById('frontview').getBoundingClientRect().width, holder: g.clientWidth };
  });
  assert.equal(r.rows, 2, 'two rows: the big camera and the strip');
  assert.ok(r.front > r.holder * 0.9, 'the front camera spans the player (' + r.front + ' of ' + r.holder + ')');
  await page.locator('#frontview').click({ force: true });
  assert.equal(await page.evaluate(() => document.querySelector('.videoholder').style.gridTemplateRows), '');
});

test('the clock uses the video’s own position, not the padded timeline', async t => {
  const { page } = await openClips(t);
  await card(page, 'SentryClips/2026-10-21_09-12-03').click();
  // a 40-second file: the engine pads the timeline by 20 s, so the slider reads 25 s at 5 s into the video
  await page.evaluate(() => {
    const seg = currentsequence.getSegmentByIndex(0);
    currentsequence.currentsegmentidx = 0;
    seg.longestvideoelem = { currentTime: 5, duration: 40 };
    document.getElementById('position').value = 25000;
  });
  await page.waitForFunction(() => document.querySelector('#clipclock').textContent.startsWith('9:11:07'), null, { timeout: 3000 });
});

test('picks a camera layout from a tap-friendly menu and remembers it', async t => {
  const { page } = await openClips(t);
  await page.locator('#cliplayout').click();
  assert.equal(await page.locator('.filesdialog .sheetaction').count(), 6);
  assert.equal(await page.locator('.filesdialog .sheetaction.current').count(), 1);
  await page.locator('.filesdialog .sheetaction[data-layout="5"]').click();
  assert.equal(await page.evaluate(() => currentLayout), 5);
  assert.equal(await page.evaluate(() => localStorage.getItem('layout')), '5');
  assert.ok(await page.evaluate(() => document.querySelector('.videoholder').classList.contains('layout5')));
});

test('phones start with the stacked layout', async t => {
  const { page } = await openClips(t, { viewport: PHONE });
  assert.equal(await page.evaluate(() => currentLayout), 4);
});

test('"Watch latest clip" on Home opens the newest event in the player', async t => {
  const { page } = await open(t, { viewport: PHONE });
  await page.waitForFunction(() => !document.querySelector('#watchlatest').hidden && !document.querySelector('#watchlatest').classList.contains('noclips'));
  await page.locator('#watchlatest').click();
  await page.waitForFunction(() => location.hash === '#clips/player/SentryClips/2026-10-22_18-40-44');
  await page.waitForFunction(() => document.querySelector('.clipplayer') && getComputedStyle(document.querySelector('.clipplayer')).display !== 'none');
  assert.equal(await page.evaluate(() => currentsequence.sequencename), '2026-10-22_18-40-44');
  assert.deepEqual(await visibleTab(page), ['clips/player']);
});

test('says so when there are no clips', async t => {
  const { page } = await openClips(t, { videolist: '' });
  assert.match(await text(page, '.clipempty'), /No clips yet/);
});

test('turns the car’s event codes into words', async t => {
  const { page } = await openClips(t);
  const r = await page.evaluate(() => ['user_interaction_honk', 'user_interaction_dashcam_icon_tapped', 'sentry_aware_object_detection',
    'sentry_aware_accel_0.42', 'sentry_locked_handle_pulled', 'vehicle_auto_emergency_braking', 'sentry_panic'].map(Clips._fmt.reasonText));
  assert.deepEqual(r, ['Saved with the horn', 'Saved from the screen', 'Something came close', 'The car was bumped',
    'A door handle was pulled', 'Automatic emergency braking', 'Sentry was triggered']);
});
