// Shared helpers for the web UI tests.
'use strict';

const fs = require('fs');
const path = require('path');
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

// opens the UI against a fixture server, waits for the first status, and collects page errors
async function open(browser, t, { status, config, drive, failUpload, videolist, hash = '', viewport = { width: 1280, height: 800 } } = {}) {
  const server = await startServer({ status, config, drive, failUpload, videolist });
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

module.exports = { findChromium, open, visibleTab, text, clickTo };
