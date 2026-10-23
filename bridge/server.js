#!/usr/bin/env node
// tmux-pocket bridge: tiny HTTP <-> SSH relay that drives tmux with plain CLI commands.
// Zero framework: node:http + ssh2. Serves ../web as static files.
//
//   POST /api/<op>  { conn: {...}, ...args }  ->  JSON
//   ops: list, capture, send, keys, new, kill, resize
//
// conn.transport = "ssh" (default) uses ssh2; "local" runs tmux on this machine
// (useful when the bridge itself runs on the server, or for tests).
//
// Secrets: the bridge never receives a private key. It generates its own SSH key in
// STATE_DIR on first start (mode 600, never leaves this machine) and only shows the
// public key, which you add to authorized_keys on your servers. Host keys are pinned
// on first use (known_hosts.json). The browser keeps no secret: login sets an
// HttpOnly cookie, and SSH passwords (if used) stay in memory on the phone.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT || 8022);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const WEB_DIR = path.join(__dirname, '..', 'web');
const ALLOW_LOCAL = process.env.ALLOW_LOCAL !== '0';
const STATE_DIR = process.env.STATE_DIR || path.join(require('node:os').homedir(), '.tmux-pocket');
const crypto = require('node:crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// ---------- secrets on disk (STATE_DIR, 700/600) ----------
function stateFile(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return path.join(STATE_DIR, name);
}

let bridgeKey = null;
// A usable ed25519 key: parses, and its public blob is the full 51 bytes (4+11 type, 4+32 key).
function keyOk(priv) {
  const { utils } = require('ssh2');
  const k = utils.parseKey(priv);
  return !(k instanceof Error) && k.getPublicSSH().length === 51;
}
// ssh2's generator drops a leading zero byte in about 1 key out of 256, which yields a key that
// can't be parsed back. Generate until the key is valid.
function generateKey() {
  const { utils } = require('ssh2');
  const comment = `tmux-pocket@${require('node:os').hostname()}`;
  for (;;) {
    const k = utils.generateKeyPairSync('ed25519', { comment });
    if (keyOk(k.private)) return k;
  }
}
function getBridgeKey() {
  if (bridgeKey) return bridgeKey;
  const file = stateFile('id_ed25519');
  if (fs.existsSync(file) && !keyOk(fs.readFileSync(file, 'utf8'))) {
    // Left by an older version hit by the bug above; it never worked, so set it aside and make a new one.
    const aside = `${file}.invalid-${Date.now()}`;
    fs.renameSync(file, aside);
    fs.rmSync(`${file}.pub`, { force: true });
    console.warn(`Unusable bridge key moved to ${aside}; generated a new one: authorize it again on your servers.`);
  }
  if (!fs.existsSync(file)) {
    const k = generateKey();
    fs.writeFileSync(file, k.private, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(`${file}.pub`, k.public + '\n', { mode: 0o644 });
  }
  bridgeKey = { private: fs.readFileSync(file, 'utf8'), public: fs.readFileSync(`${file}.pub`, 'utf8').trim() };
  return bridgeKey;
}

// Trust on first use: remember each server's host key fingerprint, refuse if it changes.
function knownHosts() {
  try { return JSON.parse(fs.readFileSync(stateFile('known_hosts.json'), 'utf8')); } catch { return {}; }
}
function verifyHost(id, key) {
  const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const hosts = knownHosts();
  if (!hosts[id]) {
    hosts[id] = fp;
    fs.writeFileSync(stateFile('known_hosts.json'), JSON.stringify(hosts, null, 2), { mode: 0o600 });
    return null;
  }
  return hosts[id] === fp ? null : `host key of ${id} changed (expected ${hosts[id]}, got ${fp}). ` +
    `If this is expected, remove ${id} from ${path.join(STATE_DIR, 'known_hosts.json')}.`;
}

// ---------- shell helpers ----------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const target = (t) => q(`${t.session}:${t.window}`);

// ---------- transports ----------
const pool = new Map(); // key -> { client, ready: Promise, lastUsed }

// The password (if any) is part of the key: a pooled connection is only reused with the same secret.
function connKey(c) {
  return [c.user, c.host, c.port || 22, sha(c.password || '').toString('hex')].join('|');
}

function sshConnect(c) {
  const { Client } = require('ssh2');
  const key = connKey(c);
  const hit = pool.get(key);
  if (hit) { hit.lastUsed = Date.now(); return hit.ready; }

  const client = new Client();
  const entry = { client, lastUsed: Date.now() };
  const hostId = `${c.host}:${Number(c.port || 22)}`;
  let hostError = null;
  entry.ready = new Promise((resolve, reject) => {
    client
      .on('ready', () => resolve(client))
      .on('error', (e) => { pool.delete(key); reject(hostError ? new Error(hostError) : e); })
      .on('close', () => pool.delete(key));
    try {
      client.connect({
        host: c.host,
        port: Number(c.port || 22),
        username: c.user,
        ...(c.password ? { password: c.password } : { privateKey: getBridgeKey().private }),
        hostVerifier: (hostKey) => !(hostError = verifyHost(hostId, hostKey)),
        keepaliveInterval: (Number(c.keepalive) || 15) * 1000,
        readyTimeout: 15000,
      });
    } catch (e) {
      pool.delete(key); reject(e);
    }
  });
  pool.set(key, entry);
  return entry.ready;
}

// Drop idle SSH connections after 10 minutes.
setInterval(() => {
  for (const [k, e] of pool) {
    if (Date.now() - e.lastUsed > 600_000) { e.client.end(); pool.delete(k); }
  }
}, 60_000).unref();

async function run(c, cmd) {
  if (c.transport === 'local') {
    if (!ALLOW_LOCAL) throw new Error('local transport disabled');
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-lc', cmd], { maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, stdout, stderr }));
    });
  }
  const client = await sshConnect(c);
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream
        .on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
        .on('data', (d) => { stdout += d; })
        .stderr.on('data', (d) => { stderr += d; });
    });
  });
}

const tmux = (c, args) => run(c, `${c.tmuxPath || 'tmux'} ${args}`);

// ---------- tmux operations ----------
// tmux escapes control chars in -F output, so use a printable separator and keep
// the free-form window name last.
const SEP = '|:|';
const WIN_FMT = ['#{session_name}', '#{window_index}', '#{window_active}', '#{pane_current_command}',
  '#{window_activity}', '#{session_attached}', '#{pane_width}', '#{pane_height}', '#{window_name}'].join(SEP);

const ops = {
  // Equivalent of `tmux ls`, but one line per window so the phone can list everything.
  async list(c) {
    const r = await tmux(c, `list-windows -a -F ${q(WIN_FMT)}`);
    if (r.code !== 0) {
      if (/no server running|no sessions|error connecting/i.test(r.stderr)) return { windows: [] };
      throw new Error(r.stderr.trim() || 'tmux list-windows failed');
    }
    const windows = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [session, window, active, command, activity, attached, w, h, ...name] = l.split(SEP);
      return { session, window: Number(window), name: name.join(SEP), active: active === '1', command,
        activity: Number(activity), attached: Number(attached), width: Number(w), height: Number(h) };
    });
    return { windows };
  },

  // Screen snapshot with ANSI colours (-e). history=N adds N scrollback lines.
  async capture(c, { target: t, history = 0 }) {
    const start = history ? `-S -${Number(history)}` : '';
    const r = await tmux(c,
      `display -p -t ${target(t)} '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_current_command}'` +
      ` \\; capture-pane -p -e ${start} -t ${target(t)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'capture failed');
    const nl = r.stdout.indexOf('\n');
    const [w, h, cx, cy, command] = r.stdout.slice(0, nl).split(' ');
    return { width: +w, height: +h, cursor: [+cx, +cy], command, screen: r.stdout.slice(nl + 1) };
  },

  // Literal text, optionally followed by Enter.
  async send(c, { target: t, text, enter = true }) {
    let cmd = `send-keys -t ${target(t)} -l -- ${q(text)}`;
    if (enter) cmd += ` \\; send-keys -t ${target(t)} Enter`;
    const r = await tmux(c, cmd);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },

  // Named keys: Escape, Tab, C-c, Up, Down, BTab, Enter...
  async keys(c, { target: t, keys }) {
    const safe = keys.filter((k) => /^[A-Za-z0-9\-]+$/.test(k));
    const r = await tmux(c, `send-keys -t ${target(t)} ${safe.join(' ')}`);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },

  // New window running `command` inside a shell (window survives when the agent exits).
  async new(c, { session, name, command, cwd }) {
    const has = await tmux(c, `has-session -t ${q(session)}`);
    const dir = cwd ? `-c ${q(cwd)}` : '';
    const nm = name ? `-n ${q(name)}` : '';
    const r = has.code === 0
      ? await tmux(c, `new-window -P -F '#{window_index}' -t ${q(session + ':')} ${nm} ${dir}`)
      : await tmux(c, `new-session -d -P -F '#{window_index}' -s ${q(session)} ${nm} ${dir} -x 120 -y 40`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'new-window failed');
    const window = Number(r.stdout.trim());
    if (command) await ops.send(c, { target: { session, window }, text: command });
    return { session, window };
  },

  async kill(c, { target: t }) {
    const r = await tmux(c, `kill-window -t ${target(t)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },

  // Fit the window to the phone (tmux >= 2.9). cols=0 restores automatic sizing.
  async resize(c, { target: t, cols, rows }) {
    const cmd = cols
      ? `resize-window -t ${target(t)} -x ${Number(cols)} -y ${Number(rows)}`
      : `set-window-option -t ${target(t)} window-size latest`;
    const r = await tmux(c, cmd);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },
};

// ---------- transport security ----------
// The API only answers over HTTPS (via a reverse proxy on this machine) or from this machine itself.
// X-Forwarded-Proto is only trusted from a loopback peer, i.e. the local reverse proxy.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function channel(req) {
  if (req.socket.encrypted) return { ok: true, https: true };
  if (!LOOPBACK.has(req.socket.remoteAddress)) return { ok: false };
  const proto = req.headers['x-forwarded-proto'];
  if (!proto) return { ok: true, https: false }; // direct local use (dev)
  return { ok: proto === 'https', https: proto === 'https' };
}

// ---------- auth: BRIDGE_TOKEN once, then an HttpOnly session cookie ----------
const tokenOk = (t) => crypto.timingSafeEqual(sha(t || ''), sha(TOKEN));
const sessions = new Map(); // id -> expiry (in memory: a restart logs everyone out)
const SESSION_MS = 30 * 24 * 3600 * 1000;
function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && tokenOk(h.slice(7))) return true; // scripts / curl
  const id = /(?:^|;\s*)pocket=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  return !!id && (sessions.get(id) || 0) > Date.now();
}
function login(req, res, token) {
  if (!TOKEN) return send(res, 200, { ok: true });
  if (!tokenOk(token)) return send(res, 401, { error: 'bad token' });
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_MS);
  const secure = channel(req).https ? '; Secure' : '';
  send(res, 200, { ok: true }, 'application/json',
    { 'set-cookie': `pocket=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png' };

// Same-origin only: no CORS headers, so other sites cannot drive the bridge from a browser.
function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    if (!channel(req).ok) return send(res, 403, { error: 'HTTPS required: put the bridge behind a reverse proxy (see deploy/INSTALL-SERVER.md)' });
    if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) {
      return send(res, 404, { error: 'unknown op' });
    }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1 << 20) return send(res, 413, { error: 'too large' }); }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
    const name = url.pathname.slice(5);
    if (name === 'login') return login(req, res, body.token);
    if (!authed(req)) return send(res, 401, { error: 'login required' });
    if (name === 'pubkey') return send(res, 200, { publicKey: getBridgeKey().public });
    const op = Object.hasOwn(ops, name) && ops[name];
    if (!op) return send(res, 404, { error: 'unknown op' });
    try {
      if (!body.conn) throw new Error('missing conn');
      send(res, 200, await op(body.conn, body));
    } catch (e) {
      send(res, 500, { error: e.message || String(e) });
    }
    return;
  }

  if (url.pathname === '/health') return send(res, 200, { ok: true, local: ALLOW_LOCAL });

  // static
  const file = path.normalize(path.join(WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

if (require.main === module) {
  if (!TOKEN && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.error(`Refusing to listen on ${HOST} without BRIDGE_TOKEN: this bridge relays SSH logins.`);
    process.exit(1);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn(`Listening on ${HOST}: the API will only answer through an HTTPS reverse proxy on this machine.`);
  }
  const { public: pub } = getBridgeKey();
  server.listen(PORT, HOST, () => console.log(`tmux-pocket bridge on http://${HOST}:${PORT}\nPublic key: ${pub}`));
}
module.exports = { ops, server, q, getBridgeKey, verifyHost, generateKey, keyOk };
