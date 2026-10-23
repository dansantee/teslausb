// Browser tests for the web UI shell: navigation, the Home dashboard and confirmations.
// Run with `npm test` in this folder (see README.md).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { startServer } = require('./fixture-server');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = path.join(root, dir, exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH or install one with `npx playwright install chromium`.');
}

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findChromium() }); });
after(async () => { if (browser) await browser.close(); });

// opens the UI against a fixture server and collects page errors
async function open(t, { status, config, hash = '', viewport = { width: 1280, height: 800 } } = {}) {
  const server = await startServer({ status, config });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.close(); await server.close(); });
  await page.goto(server.url + hash);
  await page.waitForFunction(() => document.querySelector('#hero-title').textContent !== 'Connecting to TeslaUSB…');
  return { page, server, errors };
}

const visibleTab = page => page.evaluate(() =>
  Array.from(document.querySelectorAll('.tab'))
    .filter(t => getComputedStyle(t).visibility === 'visible')
    .map(t => t.dataset.view + (t.dataset.sub ? '/' + t.dataset.sub : '')));

const text = (page, sel) => page.locator(sel).first().innerText();

// clicks a link and waits until the router has shown `expected` ("view" or "view/sub")
async function clickTo(page, selector, expected) {
  await page.locator(selector).click();
  await page.waitForFunction(want => {
    const shown = Array.from(document.querySelectorAll('.tab.active'))
      .map(t => t.dataset.view + (t.dataset.sub ? '/' + t.dataset.sub : ''));
    return shown.length === 1 && shown[0] === want;
  }, expected, { timeout: 3000 }).catch(() => {});
}

test('opens on Home with a Ready banner and filled-in cards', async t => {
  const { page, errors } = await open(t);
  assert.deepEqual(await visibleTab(page), ['home']);
  assert.equal(await text(page, '#hero-title'), 'Ready');
  assert.match(await text(page, '#card-storage .card-value'), /^\d+(\.\d)? (MB|GB) used$/);
  assert.match(await text(page, '#card-storage .chip'), /^1%$/);
  assert.equal(await text(page, '#card-wifi .card-value'), 'Santee IoT');
  assert.match(await text(page, '#card-wifi .card-detail'), /Strong signal · 192\.168\.11\.81 · 2\.4 GHz/);
  assert.equal(await text(page, '#card-health .card-value'), '47°C');
  assert.equal(await text(page, '#card-ble .card-value'), 'On');
  assert.equal(await text(page, '#card-archive .card-value'), '2 h ago');
  assert.match(await text(page, '#card-archive .card-detail'), /^12 files copied · Checked again 10 min ago$/);
  assert.deepEqual(errors, []);
});

test('counts recordings once the clip list loads', async t => {
  const { page } = await open(t);
  await page.waitForFunction(() => document.querySelector('#card-clips .card-value').textContent !== '…');
  assert.equal(await text(page, '#card-clips .card-value'), '3 events');
  assert.match(await text(page, '#card-clips .card-detail'), /^1 saved · 2 Sentry · Latest: sentry event, /);
  assert.equal(await page.locator('#watchlatest').isVisible(), true);
});

test('"Watch latest clip" selects the newest clip even after another one was picked', async t => {
  const { page } = await open(t);
  await page.waitForFunction(() => document.querySelector('#card-clips .card-value').textContent !== '…');
  await page.evaluate(() => videos.SavedClips['2026-10-20_14-05-31'].select());
  assert.equal(await page.evaluate(() => currentsequence.sequencename), '2026-10-20_14-05-31');
  await page.locator('#watchlatest').click();
  await page.waitForFunction(() => document.querySelector('.content7').classList.contains('active'));
  assert.equal(await page.evaluate(() => currentsequence.sequencename), '2026-10-22_18-40-44');
  assert.deepEqual(await visibleTab(page), ['clips/player']);
});

test('keeps saying Connected on screens that pause status polling', async t => {
  const server = await startServer({});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(async () => { await page.close(); await server.close(); });
  await page.clock.install();
  await page.goto(server.url + '#clips/player');
  await page.clock.runFor(3000);
  await page.waitForFunction(() => document.querySelector('#livepill').textContent === 'Connected');
  await page.clock.runFor(40000);
  assert.equal(await page.locator('#livepill').innerText(), 'Connected');
});

test('warns when the drives are disconnected and offers to reconnect', async t => {
  const { page } = await open(t, { status: { drives_active: 'no' } });
  assert.equal(await text(page, '#hero-title'), 'Drives disconnected from the car');
  assert.equal(await page.locator('.hero-action[data-action="reconnect"]').isVisible(), true);
  assert.equal(await page.locator('.hero-action[data-action="log"]').isVisible(), false);
});

test('warns when the last archive could not reach the server', async t => {
  const { page } = await open(t, { status: { last_check_result: 'unreachable' } });
  assert.equal(await text(page, '#hero-title'), "Last archive didn't finish");
  assert.match(await text(page, '#hero-detail'), /^Couldn't connect to the archive 10 min ago\./);
  assert.equal(await text(page, '#card-archive .chip'), 'Problem');
  assert.equal(await page.locator('.hero-action[data-action="log"]').isVisible(), true);
});

test('says when nothing has been archived yet', async t => {
  const { page } = await open(t, { status: { last_check: '', last_check_result: '', last_copy: '', last_copy_files: '', last_copy_result: '' } });
  assert.equal(await text(page, '#hero-title'), 'Ready');
  assert.equal(await text(page, '#card-archive .card-value'), 'Not yet');
});

test('flags a power problem ahead of everything else', async t => {
  const { page } = await open(t, { status: { throttled: '0x50005', drives_active: 'no' } });
  assert.equal(await text(page, '#hero-title'), 'Power problem');
  assert.match(await text(page, '#card-health .card-detail'), /Not enough power right now/);
});

test('navigates between sections, sub-sections and deep links', async t => {
  const { page } = await open(t);
  await clickTo(page, '.navitem[data-view="clips"]', 'clips/player');
  assert.deepEqual(await visibleTab(page), ['clips/player']);
  assert.equal(await page.locator('.subnavbar[data-view="clips"]').isVisible(), true);

  await clickTo(page, '.subnavitem[data-sub="files"]', 'clips/files');
  assert.deepEqual(await visibleTab(page), ['clips/files']);

  await clickTo(page, '.navitem[data-view="system"]', 'system/status');
  assert.deepEqual(await visibleTab(page), ['system/status']);
  assert.equal(await page.locator('.subnavbar[data-view="clips"]').isVisible(), false);

  await page.evaluate(() => { location.hash = '#system/activity'; });
  await page.waitForFunction(() => document.querySelector('.content2').classList.contains('active'));
  assert.deepEqual(await visibleTab(page), ['system/activity']);

  // going back to Clips returns to the sub-section that was open last
  await clickTo(page, '.navitem[data-view="clips"]', 'clips/files');
  assert.deepEqual(await visibleTab(page), ['clips/files']);

  await page.evaluate(() => { location.hash = '#nonsense'; });
  await page.waitForFunction(() => document.querySelector('.content0').classList.contains('active'));
  assert.deepEqual(await visibleTab(page), ['home']);
});

test('opens straight into a deep link', async t => {
  const { page } = await open(t, { hash: '#system/diagnostics' });
  await page.waitForFunction(() => document.querySelector('.content1').classList.contains('active'));
  assert.deepEqual(await visibleTab(page), ['system/diagnostics']);
});

test('hides Clips when there is no dashcam drive', async t => {
  const { page } = await open(t, { config: 'config-nocam.json', hash: '#clips' });
  await page.waitForFunction(() => document.querySelector('.navitem[data-view="drives"]').hidden === false);
  assert.equal(await page.locator('.navitem[data-view="clips"]').isVisible(), false);
  assert.equal(await page.locator('#card-clips').isVisible(), false);
  assert.deepEqual(await visibleTab(page), ['home']);
  assert.equal(await text(page, '#card-ble .card-value'), 'Off');
  assert.equal(await page.locator('#pairingdiv').isVisible(), false);
});

test('labels the Boombox drive as Extras', async t => {
  const { page } = await open(t, { hash: '#drives' });
  await page.waitForSelector('.fb-treerootpath');
  assert.match(await text(page, '.fb-treerootpath'), /Extras/);
});

test('asks before disconnecting the drives, and only acts on confirm', async t => {
  const { page, server } = await open(t, { hash: '#system/status' });
  await page.locator('#toggledrives').click();
  assert.equal(await page.locator('#appdialog').isVisible(), true);
  assert.equal(await text(page, '#appdialog-title'), 'Disconnect the drives from the car?');
  await page.locator('#appdialog button[value="cancel"]').click();
  assert.equal(server.requests.includes('toggledrives.sh'), false);

  await page.locator('#toggledrives').click();
  await page.locator('#appdialog-ok').click();
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('shown'));
  await page.waitForTimeout(200);
  assert.equal(server.requests.filter(r => r === 'toggledrives.sh').length, 1);
});

test('asks before restarting the Pi', async t => {
  const { page, server } = await open(t, { hash: '#system/status' });
  await page.locator('#rebootbutton').click();
  assert.equal(await text(page, '#appdialog-title'), 'Restart the Pi?');
  await page.locator('#appdialog button[value="cancel"]').click();
  await page.waitForTimeout(200);
  assert.equal(server.requests.includes('reboot.sh'), false);
});

test('archive now triggers a sync and says so', async t => {
  const { page, server } = await open(t);
  await page.locator('.quickactions button', { hasText: 'Archive now' }).click();
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('shown'));
  await page.waitForTimeout(200);
  assert.ok(server.requests.includes('trigger_sync.sh'));
});

test('uses a bottom tab bar on phones', async t => {
  const { page } = await open(t, { viewport: { width: 390, height: 844 } });
  const box = await page.locator('.appnav').boundingBox();
  assert.equal(Math.round(box.y + box.height), 844);
  assert.equal(Math.round(box.width), 390);
  const tab = await page.locator('.content0').boundingBox();
  assert.ok(tab.y + tab.height <= box.y + 1, 'content ends above the tab bar');
});

test('formats times and sizes for people', async t => {
  const { page } = await open(t);
  const r = await page.evaluate(() => {
    const f = App._fmt;
    const now = new Date(2026, 9, 23, 15, 0, 0);
    return {
      justNow: f.relativeTime(new Date(2026, 9, 23, 14, 59, 30), now),
      minutes: f.relativeTime(new Date(2026, 9, 23, 14, 15, 0), now),
      yesterday: f.relativeTime(new Date(2026, 9, 22, 9, 5, 0), now).startsWith('yesterday '),
      gb: f.formatBytes(1610612736),
      mb: f.formatBytes(52428800),
      clip: f.fromClipName('2026-10-20_14-05-31').getHours(),
      badclip: f.fromClipName('event.json'),
      signal: f.signalFraction('35/70'),
      badsignal: Number.isNaN(f.signalFraction('')),
    };
  });
  assert.deepEqual(r, { justNow: 'just now', minutes: '45 min ago', yesterday: true, gb: '1.5 GB', mb: '50 MB',
                        clip: 14, badclip: null, signal: 0.5, badsignal: true });
});
