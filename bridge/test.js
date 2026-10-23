// Integration test against a real tmux, through the "local" transport.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-state-'));
const {
  ops, q, getBridgeKey, verifyHost, server, generateKey, keyOk,
  pickPiSession, pickCodeafSession, encodeCodeafWorkspace, codeafIngest, codeafConversation,
  agentChat,
} = require('./server');

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

test('rename window and session', async () => {
  const w = await ops.new(conn, { session: 'ren-src', name: 'old', command: '' });
  await ops.rename(conn, { target: w, name: 'new-win' });
  assert.strictEqual((await ops.list(conn)).windows.find((x) => x.session === 'ren-src' && x.window === w.window).name, 'new-win');
  await ops.renameSession(conn, { session: 'ren-src', name: 'ren-dst' });
  const listed = await ops.list(conn);
  assert.ok(listed.windows.some((x) => x.session === 'ren-dst' && x.name === 'new-win'));
  assert.ok(!listed.windows.some((x) => x.session === 'ren-src'));
  await ops.kill(conn, { target: { session: 'ren-dst', window: w.window } });
});

test('agents probes which CLIs are on PATH', async () => {
  const { agents } = await ops.agents(conn, { bins: ['bash', 'definitely-not-an-agent-xyz', 'codeaf', 'pi'] });
  assert.strictEqual(agents.bash.present, true);
  assert.ok(agents.bash.path);
  assert.strictEqual(agents['definitely-not-an-agent-xyz'].present, false);
  assert.ok('codeaf' in agents);
  assert.ok('pi' in agents);
});

test('pickPiSession prefers the newest created file after /new', () => {
  const now = 1_700_000_000;
  const out = [
    `now ${now} age 120`,
    // Older session still touched (mtime newer) — must NOT win after /new.
    `f ${now - 5} 900 /home/u/.pi/agent/sessions/--tmp--/2023-11-14T10-00-00-000Z_old.jsonl`,
    `f ${now - 40} 40 /home/u/.pi/agent/sessions/--tmp--/2023-11-14T10-01-40-000Z_new.jsonl`,
  ].join('\n');
  const picked = pickPiSession(out);
  assert.ok(picked, 'should pick a session');
  assert.match(picked.path, /_new\.jsonl$/);
});

test('encodeCodeafWorkspace matches codeaf encodeWorkspace', () => {
  assert.strictEqual(encodeCodeafWorkspace('/home/p/code'), '-home-p-code');
  assert.strictEqual(encodeCodeafWorkspace('/home/dev/work/codeaf-checkout'), '-home-dev-work-codeaf-checkout');
});

test('pickCodeafSession prefers transcript touched after process start', () => {
  const now = 1_700_000_000;
  const out = [
    `now ${now} age 60`,
    `f ${now - 120} 800 /home/u/.codeaf/v3/projects/-tmp/aaaaaaaaaaaaaaaa/transcript.jsonl`,
    `f ${now - 20} 40 /home/u/.codeaf/v3/projects/-tmp/bbbbbbbbbbbbbbbb/transcript.jsonl`,
  ].join('\n');
  const picked = pickCodeafSession(out);
  assert.ok(picked);
  assert.match(picked.path, /bbbbbbbbbbbbbbbb/);
});

test('codeafIngest maps thinking, tools and rewind like the phone chat expects', () => {
  const cache = { offset: 0, entries: new Map(), order: [], header: null, name: null, seq: 0 };
  const lines = [
    JSON.stringify({ type: 'session', version: 1, id: 'aaaaaaaaaaaaaaaa', cwd: '/tmp', model: 'deepseek/flash', timestamp: 't' }),
    JSON.stringify({ type: 'title', title: 'greeting the start' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'hello', timestamp: 't' }),
    JSON.stringify({
      type: 'message', role: 'assistant', content: 'on it', reasoning: 'plan the check', timestamp: 't',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'uname -a' }) } }],
    }),
    JSON.stringify({ type: 'message', role: 'tool', toolCallId: 'c1', content: 'Linux demo', timestamp: 't' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.', timestamp: 't' }),
    JSON.stringify({ type: 'rewind', dropped: 1 }),
  ];
  for (const line of lines) codeafIngest(cache, line);
  const conv = codeafConversation(cache);
  assert.strictEqual(conv.name, 'greeting the start');
  assert.strictEqual(conv.model, 'deepseek/flash');
  assert.strictEqual(conv.messages.length, 2); // rewind dropped the last assistant
  assert.strictEqual(conv.messages[0].role, 'user');
  assert.strictEqual(conv.messages[1].role, 'assistant');
  assert.strictEqual(conv.messages[1].thinking, 'plan the check');
  assert.strictEqual(conv.messages[1].tools.length, 1);
  assert.strictEqual(conv.messages[1].tools[0].name, 'bash');
  assert.strictEqual(conv.messages[1].tools[0].done, true);
  assert.strictEqual(conv.messages[1].tools[0].output, 'Linux demo');
});

test('agent-chat AUTH exposes login CLIs for Claude, Codex, Gemini, OpenCode', () => {
  assert.deepStrictEqual(agentChat.KINDS.slice().sort(), ['claude', 'codex', 'gemini', 'opencode']);
  assert.match(agentChat.AUTH.claude.login, /claude/);
  assert.match(agentChat.AUTH.codex.login, /codex/);
  assert.match(agentChat.AUTH.gemini.login, /gemini/);
  assert.match(agentChat.AUTH.opencode.login, /opencode/);
});

test('ingestClaude maps user/assistant/thinking/tools like the phone chat', () => {
  const cache = agentChat.emptyCache();
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, timestamp: 't' }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', message: {
        role: 'assistant', model: 'claude-sonnet',
        content: [
          { type: 'thinking', thinking: 'look around' },
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
        ],
      }, timestamp: 't',
    }),
    JSON.stringify({
      type: 'user', uuid: 'u2', sourceToolUseID: 't1', sourceToolAssistantUUID: 'a1',
      toolUseResult: { stdout: '/tmp', is_error: false },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '/tmp' }] },
      timestamp: 't',
    }),
  ];
  for (const line of lines) agentChat.ingestClaude(cache, line);
  const conv = agentChat.conversationFromCache(cache);
  assert.strictEqual(conv.model, 'claude-sonnet');
  assert.strictEqual(conv.messages.length, 2);
  assert.strictEqual(conv.messages[0].role, 'user');
  assert.strictEqual(conv.messages[1].thinking, 'look around');
  assert.strictEqual(conv.messages[1].tools[0].name, 'Bash');
  assert.strictEqual(conv.messages[1].tools[0].done, true);
  assert.strictEqual(conv.messages[1].tools[0].output, '/tmp');
});

test('ingestCodex maps event_msg and function_call tools', () => {
  const cache = agentChat.emptyCache();
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp', model_provider: 'openai' }, timestamp: 't' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'list files' }, timestamp: 't' }),
    JSON.stringify({
      type: 'response_item', payload: {
        type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":"ls"}',
      }, timestamp: 't',
    }),
    JSON.stringify({
      type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'c1', output: 'a.txt\nb.txt',
      }, timestamp: 't',
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'two files' }, timestamp: 't' }),
  ];
  for (const line of lines) agentChat.ingestCodex(cache, line);
  const conv = agentChat.conversationFromCache(cache);
  assert.ok(conv.messages.some((m) => m.role === 'user' && m.text === 'list files'));
  const withTool = conv.messages.find((m) => m.role === 'assistant' && m.tools?.length);
  assert.ok(withTool);
  assert.strictEqual(withTool.tools[0].name, 'shell');
  assert.strictEqual(withTool.tools[0].output, 'a.txt\nb.txt');
  assert.ok(conv.messages.some((m) => m.role === 'assistant' && m.text === 'two files'));
});

test('ingestGemini maps thoughts and toolCalls', () => {
  const cache = agentChat.emptyCache();
  const lines = [
    JSON.stringify({ type: 'user', id: 'u1', content: [{ text: 'ping' }], timestamp: 't' }),
    JSON.stringify({
      type: 'gemini', id: 'g1', model: 'gemini-2.5-pro',
      thoughts: [{ text: 'reply briefly' }],
      content: [{ text: 'pong' }],
      toolCalls: [{
        id: 'tc1', displayName: 'run_shell', name: 'run_shell', args: { cmd: 'echo hi' },
        status: 'success', resultDisplay: 'hi',
      }],
      timestamp: 't',
    }),
  ];
  for (const line of lines) agentChat.ingestGemini(cache, line);
  const conv = agentChat.conversationFromCache(cache);
  assert.strictEqual(conv.model, 'gemini-2.5-pro');
  assert.strictEqual(conv.messages[1].thinking, 'reply briefly');
  assert.strictEqual(conv.messages[1].tools[0].output, 'hi');
  assert.strictEqual(conv.messages[1].tools[0].done, true);
});

test('ops.agentAuth and per-kind chat ops are registered', async () => {
  const auth = await ops.agentAuth(conn, {});
  assert.ok(auth.auth.claude.login);
  assert.ok(auth.kinds.includes('codex'));
  for (const kind of ['claude', 'codex', 'gemini', 'opencode']) {
    assert.equal(typeof ops[kind], 'function');
  }
});

test('agents detects pi via ~/.pi/agent when PATH is incomplete', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-pi-'));
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const { agents } = await ops.agents({ transport: 'local', tmuxPath: conn.tmuxPath }, { bins: ['pi'] });
    assert.strictEqual(agents.pi.present, true, 'pi should be detected via ~/.pi/agent');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
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
