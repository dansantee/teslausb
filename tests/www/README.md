# Web UI tests

Browser tests for the web UI in `teslausb-www/html`. They load the real page in headless
Chromium against `fixture-server.js`, which serves the HTML, CSS and JS from the repo and
answers the CGI calls with the canned data in `fixtures/`. Nothing talks to a real Pi.

- `ui.test.js`: navigation, the Home dashboard, confirmations.
- `files.test.js`: Files (lock sounds, Boombox, light shows). The fixture server keeps an
  in-memory Extras drive, seeded from `fixtures/extras-drive.json`, and the file scripts
  (`ls`, `upload`, `mkdir`, `mv`, `cp`, `rm`) act on it, so tests can check what ended up on
  the drive.

Needs Node 18 or newer and a Chromium build:

```
cd tests/www
npm install
npx playwright install chromium   # skip if one is already installed
npm test
```

The tests look for Chromium under the Playwright browser cache. Set `CHROMIUM_PATH` to point
at a different binary.

These tests run on a development machine, not on the Pi. `tests/archive-status-test.sh`
covers the status data the Home screen reads, and runs on the Pi.
