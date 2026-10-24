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

/** Cursor (and cloud-agent) transcripts wrap prompts in XML; peel them for the phone chat. */
function unwrapAgentPrompt(text, timestamp) {
  let t = String(text || '');
  let ts = timestamp;
  const tm = t.match(/<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/i);
  if (tm) {
    const raw = tm[1].replace(/\s+/g, ' ').trim();
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) ts = new Date(parsed).toISOString();
    else if (ts == null || ts === '') ts = raw;
    t = t.replace(/<timestamp>\s*[\s\S]*?\s*<\/timestamp>\s*/gi, '');
  }
  const uq = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (uq) t = uq[1];
  else t = t.replace(/<\/?(?:user_query|timestamp)(?:\s[^>]*)?>/gi, '');
  return { text: t.replace(/^\s+|\s+$/g, ''), timestamp: ts };
}

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
    // Filenames are usually session-<timestamp>-<id>.jsonl; also accept any *.jsonl under chats/.
    'find "$home/tmp" "$HOME/.cache/.gemini/tmp" -type f \\( -path \'*/chats/session-*.jsonl\' -o -path \'*/chats/*.jsonl\' \\) -mtime -30 2>/dev/null | head -60 | while IFS= read -r f; do',
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
    'echo "cwd $cwd"',
    'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true); [ -n "$root" ] || root=$cwd',
    'base="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"',
    // Current OpenCode: SQLite at opencode.db (session → message → part). Prefer the active DB.
    'db=$(command -v opencode >/dev/null && opencode db path 2>/dev/null || true)',
    'for candidate in "$db" "$OPENCODE_DB" "$base/opencode.db" "$base/db.sqlite"; do',
    '  [ -n "$candidate" ] && [ -f "$candidate" ] || continue',
    '  echo "f $(stat -c \'%Y %s\' "$candidate") $candidate"',
    'done',
    // Legacy storage_v2 JSON sessions (pre-SQLite).
    'find "$base" -type f \\( -path \'*/session/*/*.json\' -o -name \'ses_*.json\' \\) 2>/dev/null | head -40 | while IFS= read -r f; do',
    '  echo "f $(stat -c \'%Y %s\' "$f") $f"',
    'done',
    'true',
  ].join('\n');
}

/** Prefer SQLite DBs over legacy JSON; then newest mtime. */
function pickOpencodeStorage(out) {
  const cwd = /^cwd (.+)$/m.exec(out)?.[1]?.trim() || '';
  const seen = new Map();
  for (const [, mtime, size, p] of out.matchAll(/^f (\d+) (\d+) (\S+)$/gm)) {
    seen.set(p, { path: p, mtime: +mtime, size: +size });
  }
  const files = [...seen.values()];
  if (!files.length) return { file: null, cwd };
  const score = (f) => {
    const db = /\.(?:db|sqlite)$/i.test(f.path) ? 2 : 0;
    return db * 1e15 + f.mtime;
  };
  files.sort((a, b) => score(b) - score(a));
  return { file: files[0], files, cwd };
}

/** Cursor Agent CLI (`agent` / `cursor-agent`): Anthropic-style JSONL under ~/.cursor/projects/<id>/agent-transcripts/. */
function locateCursor(tm, t) {
  return [
    `pp=$(${tm} display -p -t ${t} '#{pane_pid}') || exit 1`,
    `cwd=$(${tm} display -p -t ${t} '#{pane_current_path}')`,
    'pid=$(pgrep -P "$pp" -x agent | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" -x cursor-agent | head -1); [ -n "$pid" ] || pid=$(pgrep -P "$pp" agent | head -1); [ -n "$pid" ] || pid=$pp',
    'echo "now $(date +%s) age $(ps -o etimes= -p "$pid" 2>/dev/null | tr -d \' \')"',
    'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true); [ -n "$root" ] || root=$cwd',
    'home="${CURSOR_HOME:-$HOME/.cursor}"',
    // Project folder name is the cwd with separators → dashes (lossy, matches Cursor CLI).
    'enc() { printf %s "$1" | sed \'s#//*#/#g; s#/$##; s#[/]#-#g\'; }',
    'for base in "$root" "$cwd"; do',
    '  e=$(enc "$base"); dir="$home/projects/$e/agent-transcripts"',
    '  [ -d "$dir" ] || continue',
    '  find "$dir" -type f -name \'*.jsonl\' ! -path \'*/subagents/*\' -mtime -30 2>/dev/null | head -40 | while IFS= read -r f; do',
    '    echo "f $(stat -c \'%Y %s\' "$f") $f"',
    '  done',
    'done',
    // Fallback: any recent transcript (mtime pick) when cwd encoding mismatches.
    'find "$home/projects" -type f -path \'*/agent-transcripts/*/*.jsonl\' ! -path \'*/subagents/*\' -mtime -7 2>/dev/null | head -40 | while IFS= read -r f; do',
    '  echo "f $(stat -c \'%Y %s\' "$f") $f"',
    'done',
    'true',
  ].join('\n');
}

const LOCATE = {
  claude: locateClaude,
  codex: locateCodex,
  gemini: locateGemini,
  opencode: locateOpencode,
  cursor: locateCursor,
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
  // Cursor Agent CLI JSONL uses top-level `role` (same Anthropic message shape).
  if (!e.type && (e.role === 'user' || e.role === 'assistant')) e = { ...e, type: e.role, uuid: e.uuid || e.id };
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
    const raw = textOf(blocks.filter((b) => b.type === 'text' || !b.type));
    const { text, timestamp } = unwrapAgentPrompt(raw, e.timestamp);
    if (!text.trim()) return;
    pushMsg(cache, { id: e.uuid || undefined, role: 'user', text, timestamp });
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
  cursor: ingestClaude,
};

async function readOpencodeChat(ctx) {
  const { c, t, run, q, connKey, tmuxPath, target, caches } = ctx;
  const script = locateOpencode(tmuxPath || 'tmux', target(t));
  const r = await run(c, script);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'opencode session lookup failed');
  const { files, cwd } = pickOpencodeStorage(r.stdout);
  if (!files?.length) return { found: false };
  for (const file of files) {
    let hit = null;
    if (/\.(?:db|sqlite)$/i.test(file.path)) {
      hit = await readOpencodeDb({ c, run, q, file, caches, connKey, cwd });
    } else if (file.path.endsWith('.json') && !file.path.includes('transcript')) {
      hit = await readOpencodeSessionJson({ c, run, q, file, caches, connKey });
    }
    if (hit?.found) return hit;
  }
  return { found: false };
}

async function readJsonlChat({ kind, c, t, run, q, connKey, tmuxPath, target, caches }) {
  if (kind === 'opencode') return readOpencodeChat({ c, t, run, q, connKey, tmuxPath, target, caches });
  const locate = LOCATE[kind];
  if (!locate) return { found: false };
  const script = locate(tmuxPath || 'tmux', target(t));
  const r = await run(c, script);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${kind} session lookup failed`);
  const file = pickByMtime(r.stdout);
  if (!file) return { found: false };

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
  const ts = msg.timestamp || data.timestamp || data.time?.created;
  if (type === 'user' || data.role === 'user') {
    const text = data.text || textOf(data.content) || textOf(data.parts);
    if (text) pushMsg(cache, { id: msg.id || data.id, role: 'user', text, timestamp: ts });
    return;
  }
  if (type === 'assistant' || data.role === 'assistant') {
    const parts = data.content || data.parts || [];
    const text = textOf(parts.filter?.((p) => p.type === 'text') || parts);
    const thinking = clip(textOf((parts.filter?.((p) => p.type === 'reasoning' || p.type === 'thinking') || [])), 4000);
    const tools = (parts.filter?.((p) => p.type === 'tool' || p.type === 'tool_use' || p.type === 'tool-invocation') || []).map((p, i) => {
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      return {
        id: p.id || `t${i}`,
        name: p.name || p.tool || st.name || 'tool',
        args: clip(JSON.stringify(p.input || p.args || st.input || p.state || {}), 400),
        output: clip(String(p.output || p.result || st.output || st.result || ''), 3000),
        done: true,
      };
    });
    pushMsg(cache, {
      id: msg.id || data.id, role: 'assistant', text, thinking: thinking || undefined, tools,
      timestamp: ts, model: data.modelID || data.model,
    });
    return;
  }
  if (type === 'shell') {
    pushMsg(cache, { id: msg.id, role: 'bash', text: data.command || data.text || '', output: clip(String(data.output || ''), 3000), timestamp: ts });
  }
}

/** Build a phone chat from modern OpenCode SQLite rows (message + part). */
function ingestOpencodeDbRows(cache, rows) {
  const byMsg = new Map();
  const order = [];
  for (const row of rows || []) {
    const mid = row.mid || row.message_id || row.id;
    if (!mid) continue;
    let g = byMsg.get(mid);
    if (!g) {
      g = {
        id: mid,
        role: row.role || 'assistant',
        model: row.model || null,
        t: row.t || row.time_created || null,
        texts: [],
        thinking: [],
        tools: [],
      };
      byMsg.set(mid, g);
      order.push(mid);
    }
    if (row.role) g.role = row.role;
    if (row.model) g.model = row.model;
    const ptype = row.ptype || row.part_type || '';
    if (ptype === 'text' && row.text) g.texts.push(String(row.text));
    else if ((ptype === 'reasoning' || ptype === 'thinking') && row.text) g.thinking.push(String(row.text));
    else if (ptype === 'tool' || ptype === 'tool_use') {
      let input = row.tool_input, output = row.tool_output;
      try { if (typeof input === 'string' && input.startsWith('{')) input = JSON.parse(input); } catch { /* keep */ }
      try { if (typeof output === 'string' && (output.startsWith('{') || output.startsWith('['))) output = JSON.parse(output); } catch { /* keep */ }
      g.tools.push({
        id: row.pid || `t${g.tools.length}`,
        name: row.tool_name || row.tool || 'tool',
        args: clip(typeof input === 'string' ? input : JSON.stringify(input ?? {}), 400),
        output: clip(typeof output === 'string' ? output : JSON.stringify(output ?? ''), 3000),
        done: true,
      });
    } else if (!ptype && row.text) {
      g.texts.push(String(row.text));
    }
  }
  for (const mid of order) {
    const g = byMsg.get(mid);
    if (!g) continue;
    const ts = g.t != null ? (Number(g.t) < 1e12 ? Number(g.t) * 1000 : Number(g.t)) : undefined;
    if (g.role === 'user') {
      const text = g.texts.join('\n').trim();
      if (!text) continue;
      cache.entries.set(mid, { id: mid, role: 'user', text, timestamp: ts });
      cache.order.push(mid);
      continue;
    }
    const text = g.texts.join('\n').trim();
    const thinking = clip(g.thinking.join('\n'), 4000);
    if (!text && !thinking && !g.tools.length) continue;
    cache.entries.set(mid, {
      id: mid, role: 'assistant', text, thinking: thinking || undefined, tools: g.tools,
      timestamp: ts, model: g.model || undefined,
    });
    cache.order.push(mid);
    if (g.model) cache.model = g.model;
  }
}

function sqlEsc(s) {
  return String(s || '').replace(/'/g, "''");
}

async function readOpencodeDb({ c, run, q, file, caches, connKey, cwd }) {
  const key = `${connKey(c)}|opencode-db|${file.path}`;
  const db = q(file.path);
  const cwdEsc = sqlEsc(cwd);
  // Modern schema: session + message + part. Prefer session matching the pane cwd.
  const sessSql = [
    `sqlite3 -json ${db} "SELECT s.id AS id, s.title AS title, s.directory AS directory, COALESCE(s.time_updated, s.time_created) AS time_updated FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.parent_id IS NULL ORDER BY CASE WHEN '${cwdEsc}' != '' AND (s.directory = '${cwdEsc}' OR p.worktree = '${cwdEsc}' OR s.directory LIKE '${cwdEsc}/%' OR p.worktree LIKE '${cwdEsc}/%') THEN 0 ELSE 1 END, COALESCE(s.time_updated, s.time_created) DESC LIMIT 1;" 2>/dev/null`,
    // Older / alternate table name
    `sqlite3 -json ${db} "SELECT id, title, project_id, time_updated FROM session_v2 ORDER BY time_updated DESC LIMIT 1;" 2>/dev/null`,
    `sqlite3 -json ${db} "SELECT id, title, directory as project_id, time_updated FROM session ORDER BY time_updated DESC LIMIT 1;" 2>/dev/null`,
  ].join('\n');
  const sessOut = await run(c, sessSql);
  let sess;
  try {
    const rows = JSON.parse(sessOut.stdout.trim().split('\n').filter(Boolean).pop() || 'null');
    sess = Array.isArray(rows) ? rows[0] : rows;
  } catch { sess = null; }
  if (!sess?.id) return { found: false };
  const sid = sqlEsc(sess.id);

  const cache = emptyCache();
  cache.name = sess.title || null;

  // Modern: join message ↔ part
  const partSql = `sqlite3 -json ${db} "SELECT m.id AS mid, m.time_created AS t, json_extract(m.data,'$.role') AS role, COALESCE(json_extract(m.data,'$.modelID'), json_extract(m.data,'$.model')) AS model, pt.id AS pid, json_extract(pt.data,'$.type') AS ptype, COALESCE(json_extract(pt.data,'$.text'), json_extract(pt.data,'$.content')) AS text, COALESCE(json_extract(pt.data,'$.name'), json_extract(pt.data,'$.tool'), json_extract(pt.data,'$.state.name')) AS tool_name, COALESCE(json_extract(pt.data,'$.input'), json_extract(pt.data,'$.state.input')) AS tool_input, COALESCE(json_extract(pt.data,'$.output'), json_extract(pt.data,'$.result'), json_extract(pt.data,'$.state.output')) AS tool_output FROM message m LEFT JOIN part pt ON pt.message_id = m.id WHERE m.session_id='${sid}' ORDER BY m.time_created, pt.time_created LIMIT 800;" 2>/dev/null`;
  const partOut = await run(c, partSql);
  try {
    const rows = JSON.parse(partOut.stdout.trim() || '[]');
    if (Array.isArray(rows) && rows.length) ingestOpencodeDbRows(cache, rows);
  } catch { /* try legacy below */ }

  // Legacy: session_message blob rows
  if (!cache.order.length) {
    const msgSql = `sqlite3 -json ${db} "SELECT id, type, seq, data FROM session_message WHERE session_id='${sid}' ORDER BY seq ASC LIMIT 400;" 2>/dev/null`;
    const msgOut = await run(c, msgSql);
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
  }

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
  cursor: { login: 'agent login', status: 'agent status', hint: 'Connexion Cursor (CLI agent)' },
  aider: { login: null, status: null, hint: 'Aider utilise OPENAI_API_KEY / ANTHROPIC_API_KEY dans l’environnement' },
};

module.exports = {
  readChat,
  readOpencodeDb,
  pickByMtime,
  pickOpencodeStorage,
  encodeClaudeProject,
  encodeDashWorkspace,
  unwrapAgentPrompt,
  ingestClaude,
  ingestCodex,
  ingestGemini,
  ingestOpencodeMessage,
  ingestOpencodeDbRows,
  conversationFromCache,
  emptyCache,
  AUTH,
  KINDS: Object.keys(LOCATE),
};
