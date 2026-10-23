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
// tmux reads an argument ending in ";" as a command separator, and drops one backslash before a final ";".
const tmuxArg = (s) => q(String(s).endsWith(';') ? `${String(s).slice(0, -1)}\\;` : s);
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

// Output is collected as bytes and decoded once, so multi-byte characters split across
// chunks stay intact. { raw: true } returns stdout as a Buffer.
async function run(c, cmd, { raw = false } = {}) {
  const done = (code, out, err) => ({ code, stdout: raw ? out : out.toString('utf8'), stderr: err.toString('utf8') });
  if (c.transport === 'local') {
    if (!ALLOW_LOCAL) throw new Error('local transport disabled');
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-lc', cmd], { maxBuffer: 32 << 20, encoding: 'buffer' }, (err, stdout, stderr) =>
        resolve(done(err ? err.code || 1 : 0, stdout, stderr)));
    });
  }
  const client = await sshConnect(c);
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const out = [], errs = [];
      stream
        .on('close', (code) => resolve(done(code ?? 0, Buffer.concat(out), Buffer.concat(errs))))
        .on('data', (d) => out.push(d))
        .stderr.on('data', (d) => errs.push(d));
    });
  });
}

const tmux = (c, args) => run(c, `${c.tmuxPath || 'tmux'} ${args}`);

// ---------- pi sessions ----------
// pi stores sessions in ~/.pi/agent/sessions/--<cwd with / \\ : replaced by ->--/<time>_<id>.jsonl.
// The pane's pi process start time tells which session it created; a resumed session is the
// most recently written one.
function piLocateScript(c, t) {
  const tm = c.tmuxPath || 'tmux';
  return [
    `pp=$(${tm} display -p -t ${target(t)} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${target(t)} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x pi | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" node | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/--$(printf %s "$cwd" | sed \'s#^/##; s#[/\\\\:]#-#g\')--"',
    'ls -t "$dir"/*.jsonl 2>/dev/null | head -20 | while IFS= read -r f; do echo "f $(stat -c \'%Y %s\' "$f") $f"; done',
    'true',
  ].join('\n');
}

function pickPiSession(out) {
  const head = /^now (\d+) age (\d*)/m.exec(out);
  const files = [...out.matchAll(/^f (\d+) (\d+) (.+)$/gm)].map(([, mtime, size, p]) => {
    const m = /(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+)Z_[^/]*\.jsonl$/.exec(p);
    const created = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) / 1000 : 0;
    return { path: p, mtime: +mtime, size: +size, created };
  });
  if (!files.length) return null;
  const started = head && head[2] ? +head[1] - +head[2] : 0;
  // Sessions created after this pi process started (±10s). Prefer newest *created*
  // so /new (fresh jsonl) wins over an older file that still gets occasional mtime bumps.
  const own = files.filter((f) => started && f.created >= started - 10);
  const pool = own.length ? own : files;
  return pool.sort((a, b) => (b.created - a.created) || (b.mtime - a.mtime))[0];
}

const piCache = new Map(); // conn|file -> { offset, entries, order, header }
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const textOf = (content) => typeof content === 'string' ? content
  : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

function piIngest(cache, line) {
  if (!line.trim()) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'session') { cache.header = { cwd: e.cwd, id: e.id }; return; }
  if (!e.id) return;
  // Keep only what the phone shows, so long sessions stay small in memory.
  const slim = { type: e.type, id: e.id, parentId: e.parentId, timestamp: e.timestamp };
  const m = e.message;
  if (e.type === 'message' && m) {
    if (m.role === 'system') return void (slim.skip = true, cache.entries.set(e.id, slim), cache.order.push(e.id));
    slim.role = m.role;
    if (m.role === 'user') slim.text = textOf(m.content);
    if (m.role === 'assistant') {
      const blocks = m.content || [];
      slim.text = textOf(blocks);
      slim.thinking = clip(blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('\n'), 4000);
      slim.tools = blocks.filter((b) => b.type === 'toolCall')
        .map((b) => ({ id: b.id, name: b.name, args: clip(JSON.stringify(b.arguments ?? {}), 400) }));
      slim.model = m.model;
      if (m.stopReason === 'error' || m.errorMessage) slim.error = m.errorMessage || 'error';
      if (m.stopReason === 'aborted') slim.aborted = true;
    }
    if (m.role === 'toolResult') { slim.toolCallId = m.toolCallId; slim.output = clip(textOf(m.content), 3000); slim.isError = !!m.isError; }
    if (m.role === 'bashExecution') { slim.role = 'bash'; slim.text = m.command; slim.output = clip(m.output, 3000); }
  } else if (e.type === 'custom_message' && e.display) {
    slim.role = 'note'; slim.text = clip(textOf(e.content), 2000);
  } else if (e.type === 'compaction') {
    slim.role = 'note'; slim.text = 'Conversation compacted';
  } else if (e.type === 'model_change') {
    slim.model = e.modelId;
  } else if (e.type === 'session_info') {
    slim.name = e.name;
  }
  cache.entries.set(e.id, slim);
  cache.order.push(e.id);
}

// The active branch is the path from the last appended entry back to the root.
function piConversation(cache) {
  const path = [];
  const seen = new Set();
  for (let id = cache.order[cache.order.length - 1]; id && !seen.has(id); id = cache.entries.get(id)?.parentId) {
    seen.add(id);
    const e = cache.entries.get(id);
    if (!e) break;
    path.push(e);
  }
  path.reverse();
  let model = null, name = null;
  for (const e of cache.order.map((id) => cache.entries.get(id))) if (e.name) name = e.name;
  const results = new Map();
  for (const e of path) if (e.role === 'toolResult') results.set(e.toolCallId, e);
  const messages = [];
  for (const e of path) {
    if (e.model) model = e.model;
    if (e.skip || !e.role || e.role === 'toolResult') continue;
    const msg = { id: e.id, role: e.role, text: e.text, ts: e.timestamp };
    if (e.role === 'assistant') {
      if (e.thinking) msg.thinking = e.thinking;
      if (e.error) msg.error = e.error;
      if (e.aborted) msg.aborted = true;
      msg.tools = e.tools.map((t) => ({ ...t, output: results.get(t.id)?.output, isError: results.get(t.id)?.isError, done: results.has(t.id) }));
    }
    if (e.role === 'bash') msg.output = e.output;
    messages.push(msg);
  }
  return { model, name, total: messages.length, messages: messages.slice(-200) };
}

const SCREEN_MARK = '@@tmux-pocket-screen@@';
const KEY_RE = /^(?:[CMS]-){0,3}(?:[A-Za-z][A-Za-z0-9]{0,10}|[0-9]|[!-~])$/;

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

  // Window list: the last non-empty lines of every window, in one command, for live previews.
  async previews(c, { lines = 8 } = {}) {
    const tm = c.tmuxPath || 'tmux';
    const n = Math.max(1, Math.min(Math.floor(Number(lines) || 8), 30));
    const r = await run(c, `${tm} list-windows -a -F '#{session_name}:#{window_index}' 2>/dev/null | while IFS= read -r t; do `
      + `echo "${SCREEN_MARK}$t"; ${tm} capture-pane -p -J -t "$t" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n ${n}; done; true`);
    const previews = {};
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith(SCREEN_MARK)) previews[cur = line.slice(SCREEN_MARK.length)] = [];
      else if (cur && line) previews[cur].push(line);
    }
    return { previews };
  },

  // Terminal view: the visible screen plus the last `tail` lines of tmux history (none on the alternate
  // screen), with what the phone needs to scroll natively or forward the mouse to the app.
  async screen(c, { target: t, tail = 0 }) {
    const tm = c.tmuxPath || 'tmux', T = target(t);
    const n = Math.max(0, Math.min(Math.floor(Number(tail) || 0), 5000));
    const r = await run(c, [
      `info=$(${tm} display -p -t ${T} '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{mouse_any_flag} #{mouse_sgr_flag} #{history_size} #{cursor_flag} #{pane_current_command}') || exit 1`,
      'echo "$info"',
      `set -- $info; n=${n}; [ "$5" = 1 ] && n=0; [ "$n" -gt "$8" ] && n=$8`,
      `if [ "$n" -gt 0 ]; then ${tm} capture-pane -p -e -S -"$n" -E -1 -t ${T}; fi`,
      `echo '${SCREEN_MARK}'`,
      `${tm} capture-pane -p -e -t ${T}`,
    ].join('\n'));
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'capture failed');
    const nl = r.stdout.indexOf('\n');
    const [w, h, cx, cy, alt, any, sgr, hs, cur, ...cmd] = r.stdout.slice(0, nl).split(' ');
    const rest = r.stdout.slice(nl + 1);
    const at = rest.indexOf(`${SCREEN_MARK}\n`);
    const lines = (x) => (x ? x.replace(/\n$/, '').split('\n') : []);
    return {
      width: +w, height: +h, cursor: [+cx, +cy], cursorVisible: cur === '1', alt: alt === '1',
      mouse: { any: any === '1', sgr: sgr === '1' }, historySize: +hs, command: cmd.join(' '),
      history: lines(rest.slice(0, at)), screen: lines(rest.slice(at + SCREEN_MARK.length + 1)),
    };
  },

  // Mouse events for apps that track the mouse (pi fullscreen, WeeChat, htop...): wheel and click,
  // written to the pane as xterm SGR (or legacy) mouse sequences. Coordinates are 1-based cells.
  async mouse(c, { target: t, events, sgr = true }) {
    const cell = (v) => Math.max(1, Math.min(Math.floor(Number(v) || 1), 1000));
    const bytes = [];
    for (const e of (Array.isArray(events) ? events : []).slice(0, 60)) {
      const x = cell(e.x), y = cell(e.y);
      const seq = e.t === 'wheel' ? [[e.up ? 64 : 65, 'M']] : e.t === 'click' ? [[0, 'M'], [0, 'm']] : [];
      for (const [b, f] of seq) {
        if (!sgr && (x > 223 || y > 223)) continue;
        const s = sgr ? `\x1b[<${b};${x};${y}${f}` : `\x1b[M${String.fromCharCode(32 + (f === 'm' ? 3 : b), 32 + x, 32 + y)}`;
        for (const byte of Buffer.from(s, 'latin1')) bytes.push(byte.toString(16).padStart(2, '0'));
      }
    }
    if (!bytes.length) return { ok: true };
    const r = await tmux(c, `send-keys -t ${target(t)} -H ${bytes.join(' ')}`);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },

  // Literal text, optionally followed by Enter.
  async send(c, { target: t, text, enter = true }) {
    let cmd = `send-keys -t ${target(t)} -l -- ${tmuxArg(text)}`;
    if (enter) cmd += ` \\; send-keys -t ${target(t)} Enter`;
    const r = await tmux(c, cmd);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    return { ok: true };
  },

  // Named keys: Escape, Tab, C-c, Up, Down, BTab, Enter...
  // Named keys with optional modifiers (C- M- S-): Escape, C-c, M-Left, S-Up, C-M-x, M-<, F5...
  async keys(c, { target: t, keys }) {
    const safe = (Array.isArray(keys) ? keys : []).filter((k) => KEY_RE.test(k)).slice(0, 32);
    if (!safe.length) throw new Error('no valid key');
    const r = await tmux(c, `send-keys -t ${target(t)} ${safe.map(tmuxArg).join(' ')}`);
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

  // Rename a window (tmux rename-window). Does not change the pocket display label.
  async rename(c, { target: t, name }) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('empty name');
    const r = await tmux(c, `rename-window -t ${target(t)} ${q(n)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'rename-window failed');
    return { ok: true, name: n };
  },

  // Rename a session (tmux rename-session). Window indices stay; the session name in targets changes.
  async renameSession(c, { session, name }) {
    const from = String(session ?? '').trim();
    const n = String(name ?? '').trim();
    if (!from || !n) throw new Error('empty name');
    if (n.includes(':') || n.includes('.')) throw new Error('session name cannot contain : or .');
    const r = await tmux(c, `rename-session -t ${q(from)} ${q(n)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'rename-session failed');
    return { ok: true, session: n };
  },

  // Which coding-agent CLIs are installed. Non-interactive SSH skips most of .bashrc
  // (nvm early-return), so we load version managers explicitly and probe known dirs.
  async agents(c, { bins } = {}) {
    const list = (Array.isArray(bins) ? bins : [])
      .map((b) => String(b || '').trim())
      .filter((b) => /^[A-Za-z0-9._+-]+$/.test(b))
      .slice(0, 32);
    if (!list.length) return { agents: {} };
    const probes = list.map((b) => `probe ${b}`).join('\n');
    const body = `
set +e
export PATH="$HOME/.local/bin:$HOME/.codeaf/bin:$HOME/.pi/bin:$HOME/.pi/agent/bin:$HOME/.claude/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
for d in "$HOME/.nvm/versions/node"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
if [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1; fi
if [ -x "$HOME/.local/share/fnm/fnm" ]; then eval "$("$HOME/.local/share/fnm/fnm" env)" >/dev/null 2>&1; fi
for d in "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
[ -d "$HOME/.volta/bin" ] && PATH="$HOME/.volta/bin:$PATH"
[ -s "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1
[ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
if command -v npm >/dev/null 2>&1; then
  gb=$(npm bin -g 2>/dev/null)
  [ -z "$gb" ] && gb=$(npm prefix -g 2>/dev/null)/bin
  [ -d "$gb" ] && PATH="$gb:$PATH"
fi
probe() {
  b="$1"; p=$(command -v "$b" 2>/dev/null || true)
  if [ -z "$p" ]; then
    for d in "$HOME/.codeaf/bin" "$HOME/.local/bin" "$HOME/.pi/bin" "$HOME/.pi/agent/bin" \\
             "$HOME/.claude/bin" "$HOME/bin" /usr/local/bin /opt/homebrew/bin; do
      [ -x "$d/$b" ] && { p="$d/$b"; break; }
    done
  fi
  if [ -z "$p" ]; then
    for f in "$HOME/.nvm/versions/node"/*/bin/"$b" \\
             "$HOME/.local/share/fnm/node-versions"/*/installation/bin/"$b" \\
             "$HOME/.volta/bin/$b"; do
      [ -x "$f" ] && { p="$f"; break; }
    done
  fi
  if [ -z "$p" ] && command -v pgrep >/dev/null 2>&1 && pgrep -x "$b" >/dev/null 2>&1; then
    p="(running)"
  fi
  # Official pi installer / npm leave state under ~/.pi even when PATH is incomplete over SSH.
  if [ -z "$p" ] && [ "$b" = pi ] && [ -d "$HOME/.pi/agent" -o -x "$HOME/.pi/bin/pi" ]; then
    p="~/.pi"
  fi
  if [ -n "$p" ]; then printf 'present\\t%s\\t%s\\n' "$b" "$p"
  else printf 'missing\\t%s\\n' "$b"; fi
}
${probes}
`;
    const r = await run(c, `bash -lc ${q(body)}`);
    const agents = {};
    for (const line of r.stdout.split('\n')) {
      const [st, bin, p] = line.split('\t');
      if (!bin) continue;
      agents[bin] = st === 'present' ? { present: true, path: p || bin } : { present: false };
    }
    for (const b of list) if (!agents[b]) agents[b] = { present: false };
    return { agents };
  },

  // Native view of a pi (https://pi.dev) conversation: reads pi's own session file instead of
  // scraping the screen. Only bytes appended since the last call are transferred.
  async pi(c, { target: t }) {
    const r = await run(c, piLocateScript(c, t));
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'pi session lookup failed');
    const file = pickPiSession(r.stdout);
    if (!file) return { found: false };
    const key = `${connKey(c)}|${c.transport || 'ssh'}|${file.path}`;
    let cache = piCache.get(key);
    if (!cache || file.size < cache.offset) cache = { offset: 0, entries: new Map(), order: [], header: null };
    if (file.size > cache.offset) {
      const want = Math.min(file.size - cache.offset, 16 << 20);
      const d = await run(c, `tail -c +${cache.offset + 1} ${q(file.path)} | head -c ${want}`, { raw: true });
      const end = d.stdout.lastIndexOf(0x0a);
      if (end >= 0) {
        for (const line of d.stdout.subarray(0, end).toString('utf8').split('\n')) piIngest(cache, line);
        cache.offset += end + 1;
      }
    }
    piCache.set(key, cache);
    return { found: true, file: path.basename(file.path), ...piConversation(cache) };
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
module.exports = { ops, server, q, getBridgeKey, verifyHost, generateKey, keyOk, pickPiSession };
