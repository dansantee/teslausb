// Serves the web UI from teslausb-www/html with canned CGI responses, for the UI tests.
//
// startServer({ status, config, drive }) -> { url, requests, calls, drive, close }
//   status: fields that override fixtures/status-ok.json ("NOW-600" means 600 seconds ago)
//   config: name of a fixtures/config-*.json file
//   drive:  extra entries merged over fixtures/extras-drive.json (path -> size, text, or null to remove)
//   requests: every CGI script called, in order, e.g. "toggledrives.sh"
//   calls: the same with decoded arguments, e.g. "mkdir.sh fs/Boombox&LockSounds"
//   drive: the in-memory Extras drive, a Map of path -> Buffer (directories end in "/")
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = path.resolve(__dirname, '../../teslausb-www/html');
const FIXTURES = path.join(__dirname, 'fixtures');
const DRIVE_ROOT = 'fs/Boombox';

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

function makeDrive(overrides) {
  const entries = { ...JSON.parse(fixture('extras-drive.json')).files, ...overrides };
  const drive = new Map();
  for (const [p, v] of Object.entries(entries)) {
    if (v === null) continue;
    drive.set(p, typeof v === 'string' ? Buffer.from(v) : Buffer.alloc(p.endsWith('/') ? 0 : v));
  }
  return drive;
}

// mimics cgi-bin/ls.sh: direct children of `dir` ("" = top), then "s:free:total"
function lsOutput(drive, dir) {
  const prefix = dir ? dir + '/' : '';
  const lines = [];
  for (const [p, buf] of drive) {
    if (!p.startsWith(prefix) || p === prefix) continue;
    const rest = p.slice(prefix.length);
    const isDir = rest.endsWith('/');
    const name = isDir ? rest.slice(0, -1) : rest;
    if (name.includes('/')) continue;
    lines.push(isDir ? `d:${prefix}${name}` : `f:${prefix}${name}:${buf.length}`);
  }
  lines.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  lines.push('s:100000000:104857600');
  return lines.join('\n') + '\n';
}

// a 1x1 PNG, for clip thumbnails
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

function startServer({ status = {}, config = 'config-full.json', drive: driveOverrides = {}, failUpload = null, videolist = null } = {}) {
  const teslacam = JSON.parse(fixture('teslacam.json')).files;
  const requests = [];
  const calls = [];
  const drive = makeDrive(driveOverrides);
  // toggledrives.sh flips this, like the real gadget, unless the test pins drives_active
  let drivesActive = status.drives_active || 'yes';
  // FAT: names are case-insensitive
  const find = p => {
    const l = p.toLowerCase();
    for (const k of drive.keys()) if (k.toLowerCase() === l || k.toLowerCase() === l + '/') return k;
    return null;
  };

  // cgi args after the root, decoded like the scripts do; the root must be the Extras drive
  const args = url => {
    const parts = url.search.replace(/^\?/, '').split('&').map(a => decodeURIComponent(a.replace(/\+/g, ' ')));
    const root = parts.shift();
    if (root !== DRIVE_ROOT && !root.startsWith(DRIVE_ROOT + '/')) return null;
    const sub = root.slice(DRIVE_ROOT.length + 1);
    return { sub, raw: parts, list: parts.map(a => (sub ? sub + '/' : '') + a) };
  };

  // the real scripts run mkdir/cp/mv/rm with the decoded args; GNU tools take "-x" as an option
  function fileOp(name, a) {
    const raw = a.raw;
    if (raw.some(r => r.startsWith('-'))) return false;
    const list = a.list.map(p => p.replace(/(^|\/)\.\//g, '$1'));
    const [from, to] = list;
    switch (name) {
      case 'mkdir.sh':
        if (find(from)) return false;
        drive.set(from + '/', Buffer.alloc(0));
        return true;
      case 'cp.sh': {
        const src = find(from);
        if (!src || src.endsWith('/')) return false;
        const dest = find(to) || to;
        drive.set(dest, Buffer.from(drive.get(src)));
        return true;
      }
      case 'mv.sh': {
        const src = find(from);
        if (!src) return false;
        const old = find(to);
        if (old && old !== src) drive.delete(old);   // mv replaces an existing file
        if (src.endsWith('/')) {
          for (const k of [...drive.keys()]) {
            if (k.startsWith(src)) { const v = drive.get(k); drive.delete(k); drive.set(to + '/' + k.slice(src.length), v); }
          }
        } else {
          const v = drive.get(src);
          drive.delete(src);
          drive.set(to, v);
        }
        return true;
      }
      case 'rm.sh':
        for (const p of list) {
          const k = find(p);
          if (!k) return false;
          for (const key of [...drive.keys()]) if (key === k || (k.endsWith('/') && key.startsWith(k))) drive.delete(key);
        }
        return true;
    }
    return false;
  }

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
      calls.push(name + (url.search ? ' ' + decodeURIComponent(url.search.slice(1)) : ''));
      switch (name) {
        case 'status.sh':
          return send(200, 'application/json',
            JSON.stringify(resolveTimes({ ...JSON.parse(fixture('status-ok.json')), ...status, drives_active: drivesActive })));
        case 'toggledrives.sh':
          drivesActive = drivesActive === 'yes' ? 'no' : 'yes';
          return send(200, 'application/json', '');
        case 'config.sh':
          return send(200, 'application/json', fixture(config));
        case 'videolist.sh':
          return send(200, 'text/plain', videolist !== null ? videolist : fixture('videolist.txt'));
        case 'ls.sh': {
          const a = args(url);
          if (!a) return send(200, 'text/plain', '');
          const dir = a.list[0] !== undefined ? a.list[0].replace(/\/$/, '') : a.sub;
          return send(200, 'text/plain', lsOutput(drive, dir === '.' ? '' : dir));
        }
        case 'mkdir.sh': case 'cp.sh': case 'mv.sh': case 'rm.sh': {
          const a = args(url);
          return send(200, 'text/plain', a && fileOp(name, a) ? 'OK\n' : 'FAILED\n');
        }
        case 'upload.sh': {
          const a = args(url);
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            if (!a || (failUpload && a.list[0].includes(failUpload))) return send(413, 'text/plain', '');
            drive.set(a.list[0], Buffer.concat(chunks));
            send(200, 'text/plain', '');
          });
          return;
        }
        case 'download.sh': case 'downloadzip.sh':
          return send(200, 'application/octet-stream', 'download');
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
    if (p.startsWith('/' + DRIVE_ROOT + '/')) {
      const rel = p.slice(DRIVE_ROOT.length + 2);
      return drive.has(rel) ? send(200, 'application/octet-stream', drive.get(rel)) : send(404, 'text/plain', 'not found');
    }
    if (p.startsWith('/TeslaCam/')) {
      const rel = p.slice('/TeslaCam/'.length);
      if (teslacam[rel]) return send(200, 'application/json', JSON.stringify(teslacam[rel]));
      if (rel.endsWith('/thumb.png')) return send(200, 'image/png', PNG);
      return send(404, 'text/plain', 'not found');
    }
    if (p.startsWith('/fs/')) {
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
        calls,
        drive,
        // drop the browser's keep-alive connections too, or close() can wait forever
        close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startServer };
