// Integration test against a real tmux, through the "local" transport.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-state-'));
const { ops, q, getBridgeKey, verifyHost, server, generateKey, keyOk } = require('./server');

const conn = { transport: 'local', tmuxPath: `tmux -L pocket-test-${process.pid}` };
const session = "it's a test";

test.after(() => {
  require('node:child_process').execSync(`${conn.tmuxPath} kill-server || true`);
  fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
});

test('bridge key is generated once, private part stays 0600 on disk', () => {
  const k = getBridgeKey();
  assert.match(k.public, /^ssh-ed25519 /);
  const file = path.join(process.env.STATE_DIR, 'id_ed25519');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(process.env.STATE_DIR).mode & 0o777, 0o700);
  assert.strictEqual(getBridgeKey().public, k.public);
});

test('generated keys are always usable (ssh2 drops a leading zero byte ~1/256)', () => {
  const { utils } = require('ssh2');
  let raw = 0;
  for (let i = 0; i < 2000; i++) {
    if (!keyOk(utils.generateKeyPairSync('ed25519').private)) raw++;
    assert.ok(keyOk(generateKey().private));
  }
  console.log(`# raw ssh2 keys unusable: ${raw}/2000`);
});

test('an unusable key left on disk is set aside and replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-bad-'));
  const { utils } = require('ssh2');
  let bad;
  do { bad = utils.generateKeyPairSync('ed25519'); } while (keyOk(bad.private));
  fs.writeFileSync(path.join(dir, 'id_ed25519'), bad.private, { mode: 0o600 });
  const out = require('node:child_process').execFileSync(process.execPath,
    ['-e', "console.log(require('./server').getBridgeKey().public)"],
    { cwd: __dirname, env: { ...process.env, STATE_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('id_ed25519.invalid-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('host keys are pinned on first use', () => {
  assert.strictEqual(verifyHost('h:22', Buffer.from('key-a')), null);
  assert.strictEqual(verifyHost('h:22', Buffer.from('key-a')), null);
  assert.match(verifyHost('h:22', Buffer.from('key-b')), /changed/);
});

test('api requires json and never exposes the private key', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/pubkey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await r.text();
  assert.match(body, /ssh-ed25519/);
  assert.doesNotMatch(body, /PRIVATE KEY/);
  assert.strictEqual((await fetch(`${base}/api/list`, { method: 'POST', body: '{}' })).status, 404); // no form posts (CSRF)
  assert.strictEqual((await fetch(`${base}/id_ed25519`)).status, 404);
  const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const viaProxy = (proto) => fetch(`${base}/api/pubkey`, { ...json, headers: { ...json.headers, 'x-forwarded-proto': proto } });
  assert.strictEqual((await viaProxy('http')).status, 403); // proxy says plain HTTP: refused
  assert.strictEqual((await viaProxy('https')).status, 200);
  server.close();
});

test('quote escapes single quotes', () => {
  assert.strictEqual(q("a'b"), `'a'\\''b'`);
});

test('list with no server is empty', async () => {
  assert.deepStrictEqual(await ops.list(conn), { windows: [] });
});

test('new window, list, send, capture, keys, resize, kill', async () => {
  const w = await ops.new(conn, { session, name: 'agent', command: 'echo hello-$((40+2))' });
  const w2 = await ops.new(conn, { session, name: 'second', command: '' });
  assert.notStrictEqual(w.window, w2.window);

  const { windows } = await ops.list(conn);
  assert.deepStrictEqual(windows.map((x) => x.name).sort(), ['agent', 'second']);

  await new Promise((r) => setTimeout(r, 400));
  let cap = await ops.capture(conn, { target: w });
  assert.match(cap.screen, /hello-42/);
  assert.ok(cap.width > 0 && cap.height > 0);

  await ops.send(conn, { target: w, text: `printf '%s\\n' "quote'ok"` });
  await new Promise((r) => setTimeout(r, 400));
  cap = await ops.capture(conn, { target: w, history: 100 });
  assert.match(cap.screen, /quote'ok/);

  await ops.keys(conn, { target: w, keys: ['C-c', 'Enter; rm -rf /', '$(id)'] }); // unsafe keys are dropped
  await ops.keys(conn, { target: w, keys: ['M-<', 'C-M-Left', 'S-Up', 'F5', '~', "'"] }); // modifiers and symbols pass
  await assert.rejects(ops.keys(conn, { target: w, keys: ['; ls'] }), /no valid key/);
  await ops.resize(conn, { target: w, cols: 50, rows: 30 });
  cap = await ops.capture(conn, { target: w });
  assert.strictEqual(cap.width, 50);

  // screen: history lines and screen separately; history only grows from the bottom
  for (let i = 0; i < 40; i++) await ops.send(conn, { target: w2, text: `echo line-${i}` });
  await new Promise((r) => setTimeout(r, 600));
  const sc = await ops.screen(conn, { target: w2, tail: 500 });
  assert.ok(sc.historySize > 0 && sc.history.length === Math.min(500, sc.historySize));
  assert.strictEqual(sc.screen.length, sc.height);
  assert.ok(!sc.alt && typeof sc.mouse.sgr === 'boolean');
  assert.match([...sc.history, ...sc.screen].join('\n'), /line-0[\s\S]*line-39/);
  assert.strictEqual((await ops.screen(conn, { target: w2, tail: 0 })).history.length, 0);
  await ops.mouse(conn, { target: w2, events: [{ t: 'wheel', up: true, x: 5, y: 5 }, { t: 'click', x: 'x;rm', y: -3 }] });

  const pv = await ops.previews(conn, { lines: 3 });
  assert.ok(pv.previews[`${session}:${w2.window}`].length <= 3);
  assert.match(pv.previews[`${session}:${w2.window}`].join('\n'), /line-39/);

  await ops.kill(conn, { target: w2 });
  assert.strictEqual((await ops.list(conn)).windows.length, 1);
});

test('text and keys ending in ";" or "\\;" reach the pane intact', async () => {
  const w = await ops.new(conn, { session, name: 'semi', command: 'cat' });
  await new Promise((r) => setTimeout(r, 300));
  for (const text of [';', 'a;', '\\;', 'b\\', ' ']) await ops.send(conn, { target: w, text, enter: false });
  await ops.keys(conn, { target: w, keys: [';', 'z'] });
  await new Promise((r) => setTimeout(r, 300));
  const cap = await ops.capture(conn, { target: w });
  assert.ok(cap.screen.includes(';a;\\;b\\ ;z'), cap.screen);
  await ops.kill(conn, { target: w });
});
