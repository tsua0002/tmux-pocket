// One-click tmux session persistence: TPM + tmux-resurrect + tmux-continuum.
// Idempotent install into ~/.tmux.conf between pocket markers.

'use strict';

const BEGIN = '# >>> tmux-pocket persist >>>';
const END = '# <<< tmux-pocket persist <<<';

const CONF_LINES = [
  BEGIN,
  '# Managed by tmux-pocket — sessions survive server restarts.',
  '# Layout + cwd + commands are restored; live agent RAM state is not.',
  "set -g @plugin 'tmux-plugins/tpm'",
  "set -g @plugin 'tmux-plugins/tmux-resurrect'",
  "set -g @plugin 'tmux-plugins/tmux-continuum'",
  "set -g @resurrect-capture-pane-contents 'off'",
  "set -g @continuum-restore 'on'",
  "set -g @continuum-save-interval '15'",
  "run-shell '~/.tmux/plugins/tpm/tpm'",
  END,
];

function statusScript() {
  return [
    'set +e',
    'conf="$HOME/.tmux.conf"',
    'tpm="$HOME/.tmux/plugins/tpm"',
    'res="$HOME/.tmux/plugins/tmux-resurrect"',
    'con="$HOME/.tmux/plugins/tmux-continuum"',
    'save="$HOME/.tmux/resurrect/last"',
    'echo "tpm $([ -f "$tpm/tpm" ] && echo yes || echo no)"',
    'echo "resurrect $([ -d "$res" ] && echo yes || echo no)"',
    'echo "continuum $([ -d "$con" ] && echo yes || echo no)"',
    `echo "block $(grep -qF ${JSON.stringify(BEGIN)} "$conf" 2>/dev/null && echo yes || echo no)"`,
    'echo "restore $(grep -E "@continuum-restore" "$conf" 2>/dev/null | grep -q on && echo yes || echo no)"',
    'if [ -f "$save" ]; then echo "lastSave $(stat -c %Y "$save" 2>/dev/null || stat -f %m "$save" 2>/dev/null || echo 0)"; else echo "lastSave 0"; fi',
    'echo "tmux $(command -v tmux >/dev/null && echo yes || echo no)"',
    'true',
  ].join('\n');
}

function installScript() {
  const b64 = Buffer.from(`${CONF_LINES.join('\n')}\n`, 'utf8').toString('base64');
  return [
    'set -e',
    'export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
    'command -v tmux >/dev/null || { echo "ERR tmux missing" >&2; exit 2; }',
    'command -v git >/dev/null || { echo "ERR git missing" >&2; exit 2; }',
    'mkdir -p "$HOME/.tmux/plugins" "$HOME/.tmux/resurrect"',
    'if [ ! -d "$HOME/.tmux/plugins/tpm/.git" ]; then',
    '  rm -rf "$HOME/.tmux/plugins/tpm"',
    '  git clone --depth 1 https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"',
    'fi',
    'if [ ! -d "$HOME/.tmux/plugins/tmux-resurrect/.git" ]; then',
    '  rm -rf "$HOME/.tmux/plugins/tmux-resurrect"',
    '  git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect "$HOME/.tmux/plugins/tmux-resurrect"',
    'fi',
    'if [ ! -d "$HOME/.tmux/plugins/tmux-continuum/.git" ]; then',
    '  rm -rf "$HOME/.tmux/plugins/tmux-continuum"',
    '  git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum "$HOME/.tmux/plugins/tmux-continuum"',
    'fi',
    'conf="$HOME/.tmux.conf"',
    'touch "$conf"',
    `block=$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 --decode)`,
    'tmp=$(mktemp)',
    `if grep -qF ${JSON.stringify(BEGIN)} "$conf" 2>/dev/null; then`,
    `  awk -v b=${JSON.stringify(BEGIN)} -v e=${JSON.stringify(END)} '$0==b{skip=1;next} $0==e{skip=0;next} !skip{print}' "$conf" > "$tmp"`,
    '  printf "%s" "$block" >> "$tmp"',
    '  mv "$tmp" "$conf"',
    'else',
    '  printf "\\n%s" "$block" >> "$conf"',
    '  rm -f "$tmp"',
    'fi',
    // Don't source full conf (continuum restore can duplicate sessions). Install plugins + one save.
    'tmux run-shell "$HOME/.tmux/plugins/tpm/bin/install_plugins" >/dev/null 2>&1 || true',
    'tmux run-shell "$HOME/.tmux/plugins/tmux-resurrect/scripts/save.sh" >/dev/null 2>&1 || true',
    'echo OK',
  ].join('\n');
}

function parseStatus(stdout) {
  const map = {};
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    map[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const yn = (k) => map[k] === 'yes';
  const last = Number(map.lastSave || 0) || 0;
  const ready = yn('tmux') && yn('tpm') && yn('resurrect') && yn('continuum') && yn('block') && yn('restore');
  return {
    tmux: yn('tmux'),
    tpm: yn('tpm'),
    resurrect: yn('resurrect'),
    continuum: yn('continuum'),
    block: yn('block'),
    restore: yn('restore'),
    lastSave: last || null,
    ready,
  };
}

module.exports = { statusScript, installScript, parseStatus, BEGIN, END, CONF_LINES };
