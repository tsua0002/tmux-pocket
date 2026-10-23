# Self-hosting tmux-pocket — agent running on the server

This guide installs tmux-pocket on one of your servers, behind your own domain over HTTPS.
It is written to be **read by you, then executed by a coding agent running on that server**.
It is self-contained: the agent needs nothing else.

> **Agent:** this guide assumes your shell runs on the target server. If you run on the human's computer and reach the
> server over SSH, use [`INSTALL-FROM-COMPUTER.md`](INSTALL-FROM-COMPUTER.md) instead.

| Who | What | Time |
|---|---|---|
| You | Read [What this install touches](#what-this-install-touches) and [Privileges](#privileges-what-the-agent-can-do-as-root) | 3 min |
| You | [Human setup](#human-setup-once): install the audited installer and its single sudo rule, create the DNS record | 2 min |
| You | Give the [prompt](#prompt-for-your-agent) to your agent | — |
| Agent | Runs the [steps](#steps-for-the-agent), stops and asks you on **STOP** | 5 min |
| You | Read the token yourself on the server and log in from your iPhone | 1 min |

Supported: Ubuntu 20.04, 22.04, 24.04 or newer, and Debian 12 or newer, on x86_64 or arm64, with systemd.

---

## What this install touches

Everything is done by one script, [`tmux-pocket-install`](tmux-pocket-install). Run
`deploy/tmux-pocket-install print-files your.domain` (no sudo) to see every file it writes as root.

| Created or changed | Purpose | Owner, mode |
|---|---|---|
| System user `tmuxpocket` | Runs the bridge. No login shell, no home, no sudo | — |
| `/opt/tmux-pocket/` | The app code, at the commit you choose | `root`, not writable by the service |
| `/opt/tmux-pocket-node/` | Node.js v24.21.0 for the bridge only. The system's own `node` is not touched | `root` |
| `/etc/tmux-pocket.env` | `BRIDGE_TOKEN` (random, never displayed) and `ALLOW_LOCAL=0` | `root`, `600` |
| `/var/lib/tmux-pocket/` | Bridge SSH key (generated on first start) and pinned host keys | `tmuxpocket`, dir `700`, key `600` |
| `/etc/systemd/system/tmux-pocket.service` | Sandboxed service (no capabilities, read-only system, no home access) | `root`, `644` |
| `/etc/caddy/tmux-pocket.caddy` | HTTPS site for your domain, HSTS | `root`, `644` |
| `/etc/caddy/Caddyfile` | One line added: `import /etc/caddy/tmux-pocket.caddy`. Backup kept; other sites kept | — |
| Caddy, only if absent | From apt when available (Debian 12+, Ubuntu 24.04+), else the official v2.11.7 binary in `/usr/local/bin/caddy` with a `caddy` user and the official unit | — |
| apt packages, only if missing | `git`, `curl`, `ca-certificates`, `xz-utils`, `iproute2` | — |

**Network:** Caddy listens on ports 80 and 443 and gets a Let's Encrypt certificate. The bridge listens on
`127.0.0.1:8022` only, and its API refuses plain HTTP.

**Downloads:** the code from `github.com/tsua0002/tmux-pocket` (fixed in the installer), Node.js from `nodejs.org` and,
if needed, Caddy from its GitHub releases. Both archives are checked against SHA-256 values written in the installer;
nothing is extracted if they differ.

**This install never:** changes the firewall, sshd or any `authorized_keys`; removes or edits other Caddy sites;
adds package repositories or pipes a download into a shell; runs npm install scripts; prints `BRIDGE_TOKEN` or the
private key.

---

## Privileges: what the agent can do as root

The agent gets **one** sudo right: running the installer, `/usr/local/sbin/tmux-pocket-install`, which you install
root-owned after reviewing it. It gets no shell and no generic command (`sed`, `tee`, `cp`, `git`, `npm`, `apt`,
`systemctl`), because any of those, allowed through sudo, is equivalent to full root.

| Operation as root | Installer command | Arguments accepted |
|---|---|---|
| Check OS, architecture, glibc, systemd, ports 80/443/8022 (changes nothing) | `preflight` | none |
| Install missing apt packages from the list above | `deps` | none |
| Install Node.js (and Caddy if absent), checksums pinned | `runtime` | none |
| Create user `tmuxpocket`, clone or update `/opt/tmux-pocket`, install dependencies with scripts disabled | `code <ref>` | commit hash, `master` or `vX.Y.Z` |
| Create `/etc/tmux-pocket.env` with a random token, `600 root` | `secrets` | none |
| Write the systemd unit (embedded in the installer), daemon-reload, enable, restart, check health and permissions | `service` | none |
| Write the Caddy site, add the import, validate (restore on error), reload Caddy | `site <domain>` | lowercase domain name |
| Show service state, permissions and last logs; print the **public** key | `status`, `pubkey` | none |
| Update the code and restart; new token (logs every phone out); uninstall | `update <ref>`, `rotate-token`, `uninstall [--remove-caddy]` | as above |

Why this is safe to delegate:
- The installer is owned by root and not writable by the agent, so the agent can't change what runs as root.
- Every file that runs or is configured as root (systemd units, Caddy site, env template) is **embedded in the
  installer**. The repository only provides the app code, which runs as `tmuxpocket` in a sandbox.
- Arguments are validated against strict patterns (domain name, git ref). Anything else is refused.
- sudo resets the environment and the `PATH` for this command.

**What the agent does without root:** reading this guide, DNS lookups, `curl` checks against your domain and, only if
you give it access, creating the DNS record (for example through your registrar's API).

**The sudo rule** ([`sudoers.tmux-pocket`](sudoers.tmux-pocket)), `DEPLOY_USER` being the account your agent uses:

```text
Defaults!/usr/local/sbin/tmux-pocket-install env_reset, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/tmux-pocket-install
```

If your agent already has full sudo, skip the rule: it runs the same installer commands, nothing else changes.

---

## Human setup (once)

Run this yourself, with your own sudo. Pick the commit you review; the installer at that commit is what runs as root.

```bash
REF=<commit you reviewed>                 # e.g. the latest commit hash on GitHub
AGENT_USER=<account your agent uses>      # e.g. deploy
git clone https://github.com/tsua0002/tmux-pocket /tmp/tmux-pocket-review
git -C /tmp/tmux-pocket-review checkout "$REF"
less /tmp/tmux-pocket-review/deploy/tmux-pocket-install                       # review it
/tmp/tmux-pocket-review/deploy/tmux-pocket-install print-files pocket.example.com   # every file it writes as root

sudo install -m 755 -o root -g root /tmp/tmux-pocket-review/deploy/tmux-pocket-install /usr/local/sbin/tmux-pocket-install
sed "s/DEPLOY_USER/$AGENT_USER/" /tmp/tmux-pocket-review/deploy/sudoers.tmux-pocket > /tmp/tmux-pocket.sudoers
sudo visudo -cf /tmp/tmux-pocket.sudoers && sudo install -m 440 -o root -g root /tmp/tmux-pocket.sudoers /etc/sudoers.d/tmux-pocket
sudo -l -U "$AGENT_USER"                   # must list /usr/local/sbin/tmux-pocket-install, and nothing new besides
rm -rf /tmp/tmux-pocket-review /tmp/tmux-pocket.sudoers
```

Then create a DNS **A** record for your domain (for example `pocket.example.com`) pointing to this server, or allow
your agent to do it.

When the install is done, you can remove `/etc/sudoers.d/tmux-pocket`; keep it if you want the agent to run updates.

---

## Prompt for your agent

```text
Install tmux-pocket on this server by following deploy/INSTALL-SERVER.md from
https://github.com/tsua0002/tmux-pocket at commit <REF>, section "Steps for the agent", exactly.
DOMAIN=pocket.example.com
REF=<REF>
You may only use sudo as: sudo -n /usr/local/sbin/tmux-pocket-install <command>.
Stop and ask me whenever the guide says STOP. Never show me or log BRIDGE_TOKEN or the private key.
```

---

## Steps for the agent

### Rules

1. Use sudo **only** as `sudo -n /usr/local/sbin/tmux-pocket-install <command>`. Never try another sudo command,
   never edit files under `/etc`, `/opt` or `/var/lib` yourself. If a sudo call is refused, **STOP**.
2. Run the steps in order. Every installer command ends with `<step>: OK` or prints `ERROR: …` and stops. On `ERROR`
   or any result different from **Verify**, **STOP**: report the command and its output. Do not improvise a fix.
3. Never read, print or log `/etc/tmux-pocket.env` or `/var/lib/tmux-pocket/id_ed25519` (you can't, by design).
4. Never change firewall rules, sshd configuration or `authorized_keys`, and never add package repositories.
5. Set the inputs from the human first:

```bash
DOMAIN=pocket.example.com
REF=<REF>
I="sudo -n /usr/local/sbin/tmux-pocket-install"
```

### Step 0 — Access and preflight

```bash
sudo -n -l | grep -F /usr/local/sbin/tmux-pocket-install
$I preflight
getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u
hostname -I
```

**Verify**
- The first command prints the rule. Otherwise **STOP**: the human setup isn't done.
- `preflight: OK`. On `preflight: STOP (…)`, **STOP** and report the reasons. A line saying ports were not checked is
  fine at this point: step 1 installs the tool, then checks again.
- `$DOMAIN` resolves to an IPv4 address. If it doesn't match one of this machine's addresses (common behind NAT or on
  clouds), **STOP** and ask the human to confirm the DNS A record points to this server.

### Step 1 — Packages

```bash
$I deps
$I preflight
```

**Verify:** `deps: OK (…)`, then `preflight: OK` with ports 80/443 free or used by `caddy`, and 8022 free.

### Step 2 — Node.js and Caddy

```bash
$I runtime
```

**Verify:** `node: …`, `caddy: …`, then `runtime: OK`. On `CHECKSUM MISMATCH`, **STOP** and never retry from another
source. On `DOWNLOAD FAILED`, **STOP** and report (outbound HTTPS to `nodejs.org` or `github.com` is blocked).

### Step 3 — Code

```bash
$I code "$REF"
```

**Verify:** `code: OK (<commit>)`. Note the commit for the report.

### Step 4 — Token

```bash
$I secrets
```

**Verify:** `secrets: OK (600 root, token set, not displayed)`.

### Step 5 — Service

```bash
$I service
```

**Verify:** `service: OK (active, listening on 127.0.0.1:8022, key 600 tmuxpocket)`. On `ERROR`, run `$I status`,
include its output in your report and **STOP**.

### Step 6 — HTTPS site

```bash
$I site "$DOMAIN"
sleep 20
curl -sI "https://$DOMAIN" | grep -iE '^HTTP|strict-transport'
curl -s -o /dev/null -w '%{http_code}\n' "http://$DOMAIN"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "https://$DOMAIN/api/list"
```

**Verify**
- `site: OK (<domain>; …)`. Note the part after the domain for the report. On `ERROR: Caddy rejected the
  configuration`, nothing was changed: **STOP** and report.
- `HTTP/2 200` and `strict-transport-security: max-age=31536000`, then `308`, then `401`.

The certificate can take up to a minute. If HTTPS fails after 2 minutes, run `$I status` and **STOP**: the usual causes
are the DNS record or ports 80/443 blocked upstream, which only the human can fix.

### Step 7 — Report to the human

```bash
$I status | head -6
$I pubkey
```

Send exactly this, filled in. Do not include the token.

```text
tmux-pocket is installed.
- URL: https://<DOMAIN>
- Commit: <from step 3>
- Bridge public key: <output of pubkey>
- Caddy: <the part after the domain in step 6>
- Checked: service active, HTTPS + HSTS, HTTP redirects, API needs the token.
- To log in, read the token yourself on the server: sudo grep BRIDGE_TOKEN /etc/tmux-pocket.env
- Next: authorize each server you want to reach (deploy/INSTALL-SERVER.md, "Authorize a server").
- You can now remove /etc/sudoers.d/tmux-pocket, or keep it for updates.
```

---

## Authorize a server

This step gives the bridge access to one of your servers. It needs no root. **An agent only does it when the human
explicitly asks**, for the servers and users the human names.

On each server, as the user the app will connect with, run the command shown in the app (server form, "Clé du pocket").
It only adds one line, once, and changes nothing else:

```bash
LINE='restrict ssh-ed25519 AAAA… tmux-pocket@yourhost'   # exact line from the app, or "restrict " + the pubkey output
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qxF "$LINE" ~/.ssh/authorized_keys || echo "$LINE" >> ~/.ssh/authorized_keys
```

`restrict` forbids port, agent and X11 forwarding and terminals for this key: the bridge can only run commands (tmux).
To revoke access, delete that line.

The first connection pins the server's host key in `/var/lib/tmux-pocket/known_hosts.json`. If a server is reinstalled,
its key changes and the bridge refuses to connect: remove its entry there (as root).

## Operate

```bash
I="sudo -n /usr/local/sbin/tmux-pocket-install"
$I status                      # service state, permissions, last logs
$I update <ref>                # new code at <ref>, restart
$I rotate-token                # new BRIDGE_TOKEN, every phone has to log in again
$I uninstall                   # removes everything listed above, keeps Caddy and your other sites
$I uninstall --remove-caddy    # also removes Caddy, only if this installer had installed it
```

After uninstalling, remove the `tmux-pocket@…` line from `~/.ssh/authorized_keys` on each server you authorized, then
`/usr/local/sbin/tmux-pocket-install` and `/etc/sudoers.d/tmux-pocket`.
