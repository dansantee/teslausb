// Serves the web UI from teslausb-www/html with canned CGI responses, for the UI tests.
//
// startServer({ status, config }) -> { url, requests, close }
//   status: fields that override fixtures/status-ok.json ("NOW-600" means 600 seconds ago)
//   config: name of a fixtures/config-*.json file
//   requests: every CGI script called, in order, e.g. "toggledrives.sh"
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = path.resolve(__dirname, '../../teslausb-www/html');
const FIXTURES = path.join(__dirname, 'fixtures');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function resolveTimes(obj) {
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const m = /^NOW-(\d+)$/.exec(v);
    out[k] = m ? String(now - Number(m[1])) : v;
  }
  return out;
}

function startServer({ status = {}, config = 'config-full.json' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (p.startsWith('/cgi-bin/')) {
      const name = p.slice('/cgi-bin/'.length);
      requests.push(name);
      switch (name) {
        case 'status.sh':
          return send(200, 'application/json',
            JSON.stringify(resolveTimes({ ...JSON.parse(fixture('status-ok.json')), ...status })));
        case 'config.sh':
          return send(200, 'application/json', fixture(config));
        case 'videolist.sh':
          return send(200, 'text/plain', fixture('videolist.txt'));
        case 'ls.sh':
          return send(200, 'text/plain', fixture('ls-extras.txt'));
        default:
          return send(200, 'text/plain', '');
      }
    }
    if (p === '/archiveloop.log' || p === '/teslausb-headless-setup.log' || p === '/diagnostics.txt') {
      return send(200, 'text/plain', 'Fri 23 Oct 11:34:22 CDT 2026: Finished archiving.\n');
    }
    if (p === '/TeslaCam/') {
      // shaped like nginx's fancyindex listing, which the Recordings frame tidies up
      return send(200, 'text/html', '<html><body><table id="list"><tbody>' +
        '<tr><td><a href="../">Parent directory/</a></td></tr>' +
        '<tr><td><a href="SavedClips/">SavedClips/</a></td></tr>' +
        '</tbody></table></body></html>');
    }
    if (p.startsWith('/TeslaCam/') || p.startsWith('/fs/')) {
      return send(404, 'text/plain', 'not found');
    }
    const file = path.join(HTML, p === '/' ? 'index.html' : p);
    if (!file.startsWith(HTML) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(404, 'text/plain', 'not found');
    }
    send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

module.exports = { startServer };
