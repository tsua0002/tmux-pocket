// Unified native-chat readers for coding-agent CLIs.
// Returns the same message contract as ops.pi / ops.codeaf:
//   { found, file, model?, name?, total, messages: [{ id, role, text, thinking?, tools? }] }
//
// Kinds: claude, codex, gemini, opencode (+ aliases handled by server for pi/codeaf).

'use strict';

const path = require('node:path');

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    return b.text || b.thinking || b.input_text || b.output_text || '';
  }).filter(Boolean).join('\n');
};

function encodeClaudeProject(ws) {
  // Claude Code: /Users/me/proj → -Users-me-proj
  let e = String(ws || '').replace(/\/+/g, '/');
  if (e.length > 1) e = e.replace(/\/$/, '');
  e = e.replace(/[/\\:]/g, '-');
  if (!e.startsWith('-')) e = `-${e}`;
  return e;
}

function encodeDashWorkspace(ws) {
  return encodeClaudeProject(ws);
}

function pickByMtime(out, { preferCreated = false } = {}) {
  const head = /^now (\d+) age (\d*)/m.exec(out);
  const seen = new Map();
  for (const [, mtime, size, p, created] of out.matchAll(/^f (\d+) (\d+) (\S+)(?: (\d+))?$/gm)) {
    seen.set(p, {
      path: p,
      mtime: +mtime,
      size: +size,
      created: created ? +created : +mtime,
    });
  }
  const files = [...seen.values()];
  if (!files.length) return null;
  const started = head && head[2] ? +head[1] - +head[2] : 0;
  const own = files.filter((f) => started && (preferCreated ? f.created : f.mtime) >= started - 15);
  const pool = own.length ? own : files;
  return pool.sort((a, b) => (preferCreated ? (b.created - a.created) : 0) || (b.mtime - a.mtime))[0];
}

function emptyCache() {
  return { offset: 0, entries: new Map(), order: [], header: null, name: null, model: null, seq: 0, results: new Map() };
}

// ---------- locate scripts ----------
function locateClaude(tm, t) {
  return [
    `pp=$(${tm} display -p -t ${t} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${t} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x claude | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" claude | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true); [ -n "$root" ] || root=$cwd',
    'enc() { printf %s "$1" | sed \'s#//*#/#g; s#/$##; s#[/\\\\:]#-#g; s#^\\([^-]\\)#-\\1#\'; }',
    'home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'for base in "$root" "$cwd"; do',
    '  e=$(enc "$base"); dir="$home/projects/$e"',
    '  for f in "$dir"/*.jsonl; do',
    '    [ -f "$f" ] || continue',
    '    case "$f" in */subagents/*) continue ;; esac',
    '    echo "f $(stat -c \'%Y %s\' "$f") $f"',
    '  done',
    'done',
    'true',
  ].join('\n');
}

function locateCodex(tm, t) {
  return [
    `pp=$(${tm} display -p -t ${t} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${t} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x codex | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" codex | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'home="${CODEX_HOME:-$HOME/.codex}"',
    // Recent dated shards under sessions/YYYY/MM/DD/rollout-*.jsonl
    'find "$home/sessions" -type f -name \'rollout-*.jsonl\' -mtime -14 2>/dev/null | head -40 | while IFS= read -r f; do',
    '  echo "f $(stat -c \'%Y %s\' "$f") $f"',
    'done',
    'true',
  ].join('\n');
}

function locateGemini(tm, t) {
  return [
    `pp=$(${tm} display -p -t ${t} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${t} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x gemini | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" gemini | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true); [ -n "$root" ] || root=$cwd',
    'home="${GEMINI_DIR:-$HOME/.gemini}"',
    // Prefer project tmp folders; hash matching is best-effort via listing all recent chats.
    'find "$home/tmp" "$HOME/.cache/.gemini/tmp" -type f -path \'*/chats/session-*.jsonl\' -mtime -30 2>/dev/null | head -40 | while IFS= read -r f; do',
    '  echo "f $(stat -c \'%Y %s\' "$f") $f"',
    'done',
    'true',
  ].join('\n');
}

function locateOpencode(tm, t) {
  return [
    `pp=$(${tm} display -p -t ${t} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${t} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x opencode | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" opencode | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true); [ -n "$root" ] || root=$cwd',
    'base="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"',
    // storage_v2 / legacy session JSON markers (path itself is the session id key)
    'find "$base" -type f \\( -path \'*/session/*/*.json\' -o -name \'ses_*.json\' \\) 2>/dev/null | head -60 | while IFS= read -r f; do',
    '  echo "f $(stat -c \'%Y %s\' "$f") $f"',
    'done',
    // SQLite db as a synthetic "file" — reader will detect .db
    'for db in "$base/opencode.db" "$base/db.sqlite"; do',
    '  [ -f "$db" ] || continue',
    '  echo "f $(stat -c \'%Y %s\' "$db") $db"',
    'done',
    'true',
  ].join('\n');
}

const LOCATE = {
  claude: locateClaude,
  codex: locateCodex,
  gemini: locateGemini,
  opencode: locateOpencode,
};

// ---------- ingest ----------
function pushMsg(cache, slim) {
  const id = slim.id || `m${cache.seq++}`;
  slim.id = id;
  cache.entries.set(id, slim);
  cache.order.push(id);
}

function ingestClaude(cache, line) {
  if (!line.trim()) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'custom-title' && e.customTitle) cache.name = e.customTitle;
  if (e.type === 'ai-title' && e.aiTitle && !cache.name) cache.name = e.aiTitle;
  if (e.type === 'agent-name' && e.agentName && !cache.name) cache.name = e.agentName;
  if (e.type !== 'user' && e.type !== 'assistant') return;
  if (e.isMeta && e.type === 'user' && !e.toolUseResult && !(e.message?.content || []).some((b) => b.type === 'tool_result')) return;

  const m = e.message || {};
  const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);

  // Tool result carried as a user message
  if (e.type === 'user' && (e.toolUseResult || blocks.some((b) => b.type === 'tool_result'))) {
    const toolId = e.sourceToolUseID || e.toolUseResult?.tool_use_id || `tool-${e.uuid || cache.seq}`;
    let output = '';
    if (e.toolUseResult) {
      output = e.toolUseResult.stdout || e.toolUseResult.output || e.toolUseResult.content
        || (typeof e.toolUseResult === 'string' ? e.toolUseResult : JSON.stringify(e.toolUseResult));
    }
    if (!output) output = textOf(blocks.filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : textOf(b.content))));
    cache.results.set(toolId, { output: clip(String(output), 3000), isError: !!(e.toolUseResult?.is_error || blocks.some((b) => b.is_error)) });
    // Also key by parent assistant uuid for fixtures without tool ids
    if (e.sourceToolAssistantUUID) cache.results.set(`asst:${e.sourceToolAssistantUUID}`, cache.results.get(toolId));
    return;
  }

  if (e.type === 'user') {
    const text = textOf(blocks.filter((b) => b.type === 'text' || !b.type));
    if (!text.trim()) return;
    pushMsg(cache, { id: e.uuid || undefined, role: 'user', text, timestamp: e.timestamp });
    return;
  }

  if (e.type === 'assistant') {
    const text = textOf(blocks.filter((b) => b.type === 'text'));
    const thinking = clip(blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('\n'), 4000);
    const tools = [];
    blocks.filter((b) => b.type === 'tool_use').forEach((b, i) => {
      const id = b.id || e.sourceToolUseID || `${e.uuid || 'a'}-tool-${i}`;
      tools.push({
        id,
        name: b.name || 'tool',
        args: clip(JSON.stringify(b.input ?? b.arguments ?? {}), 400),
        _asst: e.uuid,
      });
    });
    pushMsg(cache, {
      id: e.uuid || undefined,
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      tools,
      timestamp: e.timestamp,
      model: e.message?.model || e.model,
    });
    if (e.message?.model || e.model) cache.model = e.message?.model || e.model;
  }
}

function ingestCodex(cache, line) {
  if (!line.trim()) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }

  if (e.type === 'session_meta' && e.payload) {
    cache.header = { cwd: e.payload.cwd, id: e.payload.id || e.payload.session_id };
    if (e.payload.model_provider) cache.model = e.payload.model_provider;
    return;
  }
  if (e.type === 'turn_context' && e.payload?.model) cache.model = e.payload.model;

  if (e.type === 'event_msg' && e.payload) {
    const p = e.payload;
    if (p.type === 'user_message' && p.message) {
      pushMsg(cache, { role: 'user', text: String(p.message), timestamp: e.timestamp });
    }
    if (p.type === 'agent_reasoning' && p.text && p.text !== '[trimmed for fixture]') {
      // Attach to pending assistant or store as note of thinking stream — keep last assistant
      const last = cache.order.length ? cache.entries.get(cache.order[cache.order.length - 1]) : null;
      if (last?.role === 'assistant' && !last.thinking) last.thinking = clip(p.text, 4000);
    }
    if (p.type === 'agent_message' && p.message) {
      pushMsg(cache, { role: 'assistant', text: String(p.message), tools: [], timestamp: e.timestamp });
    }
    return;
  }

  if (e.type !== 'response_item' || !e.payload) return;
  const p = e.payload;

  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = textOf(p.content);
    if (!text.trim() && p.role === 'user') return;
    pushMsg(cache, {
      id: p.id,
      role: p.role,
      text,
      tools: p.role === 'assistant' ? [] : undefined,
      timestamp: e.timestamp,
    });
    return;
  }

  if (p.type === 'reasoning') {
    const summary = Array.isArray(p.summary) ? p.summary.map((s) => s.text || '').join('\n') : '';
    if (!summary || summary.includes('[trimmed')) return;
    const last = cache.order.length ? cache.entries.get(cache.order[cache.order.length - 1]) : null;
    if (last?.role === 'assistant') last.thinking = clip((last.thinking ? `${last.thinking}\n` : '') + summary, 4000);
    else pushMsg(cache, { role: 'assistant', text: '', thinking: clip(summary, 4000), tools: [] });
    return;
  }

  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const callId = p.call_id || p.id;
    const args = p.arguments || p.input || '';
    const tool = {
      id: callId,
      name: p.name || 'tool',
      args: clip(typeof args === 'string' ? args : JSON.stringify(args), 400),
    };
    let last = cache.order.length ? cache.entries.get(cache.order[cache.order.length - 1]) : null;
    if (!last || last.role !== 'assistant') {
      pushMsg(cache, { role: 'assistant', text: '', tools: [tool] });
    } else {
      last.tools = last.tools || [];
      last.tools.push(tool);
    }
    return;
  }

  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const callId = p.call_id || p.id;
    let output = p.output;
    if (Array.isArray(output)) output = textOf(output);
    else if (output && typeof output === 'object') output = output.text || textOf([output]);
    cache.results.set(callId, { output: clip(String(output || ''), 3000), isError: false });
  }
}

function ingestGemini(cache, line) {
  if (!line.trim()) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.$set || e.$patch || e.$rewindTo) return;
  if (e.sessionId && e.projectHash && !e.type) {
    cache.header = { id: e.sessionId, projectHash: e.projectHash };
    return;
  }
  if (e.type === 'user') {
    const text = textOf(e.content);
    if (!text.trim()) return;
    pushMsg(cache, { id: e.id, role: 'user', text, timestamp: e.timestamp });
    return;
  }
  if (e.type === 'gemini') {
    if (e.model) cache.model = e.model;
    const thoughts = Array.isArray(e.thoughts)
      ? e.thoughts.map((t) => (typeof t === 'string' ? t : t.text || t.subject || '')).filter(Boolean).join('\n')
      : '';
    const tools = (e.toolCalls || []).map((t) => {
      let output = t.resultDisplay || '';
      if (!output && Array.isArray(t.result)) {
        output = t.result.map((r) => r?.functionResponse?.response?.output || JSON.stringify(r)).join('\n');
      }
      return {
        id: t.id,
        name: t.displayName || t.name || 'tool',
        args: clip(JSON.stringify(t.args ?? {}), 400),
        output: clip(String(output), 3000),
        done: t.status === 'success' || t.status === 'error' || !!output,
        isError: t.status === 'error',
      };
    });
    const text = textOf(e.content);
    if (!text && !tools.length && !thoughts) return;
    pushMsg(cache, {
      id: e.id,
      role: 'assistant',
      text,
      thinking: thoughts ? clip(thoughts, 4000) : undefined,
      tools,
      timestamp: e.timestamp,
    });
  }
}

function conversationFromCache(cache) {
  const messages = [];
  for (const id of cache.order) {
    const e = cache.entries.get(id);
    if (!e || e.role === 'tool') continue;
    const msg = { id: e.id, role: e.role, text: e.text || '', ts: e.timestamp };
    if (e.role === 'assistant') {
      if (e.thinking) msg.thinking = e.thinking;
      msg.tools = (e.tools || []).map((t) => {
        const hit = cache.results.get(t.id) || (t._asst ? cache.results.get(`asst:${t._asst}`) : null);
        const { _asst, ...rest } = t;
        return {
          ...rest,
          output: t.output || hit?.output,
          isError: t.isError ?? hit?.isError,
          done: t.done ?? !!(t.output || hit),
        };
      });
    }
    if (e.model) cache.model = e.model;
    messages.push(msg);
  }
  return {
    model: cache.model || cache.header?.model || null,
    name: cache.name || null,
    total: messages.length,
    messages: messages.slice(-200),
  };
}

const INGEST = {
  claude: ingestClaude,
  codex: ingestCodex,
  gemini: ingestGemini,
};

async function readJsonlChat({ kind, c, t, run, q, connKey, tmuxPath, target, caches }) {
  const locate = LOCATE[kind];
  if (!locate) return { found: false };
  const script = locate(tmuxPath || 'tmux', target(t));
  const r = await run(c, script);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${kind} session lookup failed`);
  const file = pickByMtime(r.stdout);
  if (!file) return { found: false };

  // OpenCode SQLite path handled separately
  if (kind === 'opencode' && /\.db$|\.sqlite$/i.test(file.path)) {
    return readOpencodeDb({ c, run, q, file, caches, connKey });
  }
  if (kind === 'opencode' && file.path.endsWith('.json') && !file.path.includes('transcript')) {
    return readOpencodeSessionJson({ c, run, q, file, caches, connKey });
  }

  const key = `${connKey(c)}|${c.transport || 'ssh'}|${kind}|${file.path}`;
  let cache = caches.get(key);
  if (!cache || file.size < cache.offset) cache = emptyCache();
  if (file.size > cache.offset) {
    const want = Math.min(file.size - cache.offset, 16 << 20);
    const d = await run(c, `tail -c +${cache.offset + 1} ${q(file.path)} | head -c ${want}`, { raw: true });
    const end = d.stdout.lastIndexOf(0x0a);
    if (end >= 0) {
      const ingest = INGEST[kind];
      for (const line of d.stdout.subarray(0, end).toString('utf8').split('\n')) ingest(cache, line);
      cache.offset += end + 1;
    }
  }
  caches.set(key, cache);
  return { found: true, file: path.basename(file.path), ...conversationFromCache(cache) };
}

async function readOpencodeSessionJson({ c, run, q, file, caches, connKey }) {
  // storage_v2: .../session/<proj>/ses_xxx.json + .../message/<sid>/msg_*.json
  const key = `${connKey(c)}|opencode|${file.path}`;
  const cache = emptyCache();
  const sessDir = path.dirname(file.path);
  const base = sessDir.replace(/\/session\/[^/]+$/, '');
  const sid = path.basename(file.path, '.json').replace(/^ses_/, '');
  // Try message folder variants
  const tryDirs = [
    path.join(base, 'message', sid),
    path.join(base, 'message', `s_${sid}`),
    path.join(path.dirname(sessDir), '..', 'message', sid),
  ];
  const list = await run(c, tryDirs.map((d) => `for f in ${q(d)}/msg_*.json ${q(d)}/*.json; do [ -f "$f" ] && echo "$f"; done`).join('\n'));
  const files = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  for (const f of files) {
    const d = await run(c, `cat ${q(f)}`, { raw: true });
    let msg;
    try { msg = JSON.parse(d.stdout.toString('utf8')); } catch { continue; }
    ingestOpencodeMessage(cache, msg);
  }
  // Also try session_message JSON fixtures style
  if (!cache.order.length) {
    const raw = await run(c, `cat ${q(file.path)}`, { raw: true });
    try {
      const sess = JSON.parse(raw.stdout.toString('utf8'));
      if (sess.title) cache.name = sess.title;
      if (sess.model) cache.model = sess.model;
    } catch { /* ignore */ }
  }
  caches.set(key, cache);
  if (!cache.order.length) return { found: false };
  return { found: true, file: path.basename(file.path), ...conversationFromCache(cache) };
}

function ingestOpencodeMessage(cache, msg) {
  // session_message rows: { type, data } or legacy { role, parts }
  const type = msg.type || msg.role;
  const data = msg.data || msg;
  if (type === 'user' || data.role === 'user') {
    const text = data.text || textOf(data.content) || textOf(data.parts);
    if (text) pushMsg(cache, { id: msg.id || data.id, role: 'user', text });
    return;
  }
  if (type === 'assistant' || data.role === 'assistant') {
    const parts = data.content || data.parts || [];
    const text = textOf(parts.filter?.((p) => p.type === 'text') || parts);
    const thinking = clip(textOf((parts.filter?.((p) => p.type === 'reasoning' || p.type === 'thinking') || [])), 4000);
    const tools = (parts.filter?.((p) => p.type === 'tool' || p.type === 'tool_use' || p.type === 'tool-invocation') || []).map((p, i) => ({
      id: p.id || `t${i}`,
      name: p.name || p.tool || 'tool',
      args: clip(JSON.stringify(p.input || p.args || p.state || {}), 400),
      output: clip(String(p.output || p.result || ''), 3000),
      done: true,
    }));
    pushMsg(cache, { id: msg.id || data.id, role: 'assistant', text, thinking: thinking || undefined, tools });
    return;
  }
  if (type === 'shell') {
    pushMsg(cache, { id: msg.id, role: 'bash', text: data.command || data.text || '', output: clip(String(data.output || ''), 3000) });
  }
}

async function readOpencodeDb({ c, run, q, file, caches, connKey }) {
  const key = `${connKey(c)}|opencode-db|${file.path}`;
  // Pick newest session id, then dump last messages as JSON lines
  const sql = [
    `sqlite3 -json ${q(file.path)} "SELECT id, title, project_id, time_updated FROM session_v2 ORDER BY time_updated DESC LIMIT 1;" 2>/dev/null`,
    `sqlite3 -json ${q(file.path)} "SELECT id, title, directory as project_id, time_updated FROM session ORDER BY time_updated DESC LIMIT 1;" 2>/dev/null`,
  ].join('\n');
  const sessOut = await run(c, sql);
  let sess;
  try {
    const rows = JSON.parse(sessOut.stdout.trim().split('\n').filter(Boolean).pop() || 'null');
    sess = Array.isArray(rows) ? rows[0] : rows;
  } catch { sess = null; }
  if (!sess?.id) return { found: false };

  const msgSql = `sqlite3 -json ${q(file.path)} "SELECT id, type, seq, data FROM session_message WHERE session_id='${String(sess.id).replace(/'/g, "''")}' ORDER BY seq ASC LIMIT 400;" 2>/dev/null`;
  const msgOut = await run(c, msgSql);
  const cache = emptyCache();
  cache.name = sess.title || null;
  try {
    const rows = JSON.parse(msgOut.stdout.trim() || '[]');
    for (const row of rows) {
      let data = row.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = { text: data }; }
      }
      ingestOpencodeMessage(cache, { id: row.id, type: row.type, data });
    }
  } catch { return { found: false }; }
  caches.set(key, cache);
  if (!cache.order.length) return { found: false };
  return { found: true, file: sess.id, ...conversationFromCache(cache) };
}

async function readChat(kind, ctx) {
  if (kind === 'opencode') return readJsonlChat({ kind: 'opencode', ...ctx });
  if (!INGEST[kind]) return { found: false };
  return readJsonlChat({ kind, ...ctx });
}

const AUTH = {
  claude: { login: 'claude auth login', status: 'claude auth status', hint: 'Connexion Anthropic (Claude Code)' },
  codex: { login: 'codex login', status: 'codex login status', hint: 'Connexion OpenAI (Codex CLI)' },
  gemini: { login: 'gemini', status: null, hint: 'Au premier lancement, Gemini ouvre /auth (Google)' },
  opencode: { login: 'opencode auth login', status: 'opencode auth list', hint: 'Connexion OpenCode (fournisseur)' },
  codeaf: { login: 'codeaf', status: null, hint: 'CodeAF demande le modèle / la clé au premier lancement' },
  pi: { login: 'pi', status: null, hint: 'pi configure le modèle au premier lancement (/model)' },
  aider: { login: null, status: null, hint: 'Aider utilise OPENAI_API_KEY / ANTHROPIC_API_KEY dans l’environnement' },
};

module.exports = {
  readChat,
  pickByMtime,
  encodeClaudeProject,
  encodeDashWorkspace,
  ingestClaude,
  ingestCodex,
  ingestGemini,
  conversationFromCache,
  emptyCache,
  AUTH,
  KINDS: Object.keys(LOCATE),
};
