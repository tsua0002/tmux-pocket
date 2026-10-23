# Self-hosting tmux-pocket — agent running on your computer

Use this guide when your coding agent runs **on your computer** and reaches the server over SSH.
The install on the server is exactly the one in [`INSTALL-SERVER.md`](INSTALL-SERVER.md): same files, same checks, same
stop conditions. This guide only adds how to run it remotely, and the rules that come with SSH.

1. **You** read [What this install touches](INSTALL-SERVER.md#what-this-install-touches),
   [Privileges](INSTALL-SERVER.md#privileges-what-the-agent-can-do-as-root) and [On your computer](#on-your-computer) below.
2. If the account the agent SSHes in as has sudo, nothing to do by hand: the agent installs the audited installer itself.
   Otherwise do the [restricted setup](INSTALL-SERVER.md#restricted-setup-agent-without-sudo) once for that account.
3. **You** give the [prompt](#prompt-for-your-agent) to your agent.
4. **The agent** runs each server step over SSH and checks the result from your computer. It stops and asks you on **STOP**.
5. **You** read the token yourself on the server and log in from your iPhone.

## What changes compared to an agent on the server

| | Agent on the server | Agent on your computer |
|---|---|---|
| Where commands run | Its own shell | `ssh` to the server, one step at a time |
| DNS and HTTPS checks | From the server | From your computer, which is a real outside check |
| Secrets | Created on the server, never printed | Same, and they never reach your computer: the token is generated on the server and stays there |
| sudo | Step S only, then `sudo -n /usr/local/sbin/tmux-pocket-install …` | Same, over SSH, never a password prompt |

## On your computer

The agent writes no files and changes no settings on your computer. It uses your existing SSH access (`~/.ssh/config`,
ssh-agent) as is, never copies a key, and disables agent and port forwarding for every connection.

---

## Prompt for your agent

```text
Install tmux-pocket on my server by following deploy/INSTALL-FROM-COMPUTER.md from
https://github.com/tsua0002/tmux-pocket at commit <REF>, exactly.
SERVER=<ssh destination, e.g. deploy@203.0.113.10 or a Host alias from my ~/.ssh/config>
DOMAIN=pocket.example.com
REF=<REF>
On the server: if you have sudo, start with step S; after it, use sudo only as: sudo -n /usr/local/sbin/tmux-pocket-install <command>.
Follow the rules. Stop and ask me whenever the guide says STOP.
Never show me or log BRIDGE_TOKEN or the private key.
```

---

## Steps for the agent

### Rules

1. All rules of [`INSTALL-SERVER.md`, "Rules"](INSTALL-SERVER.md#rules) apply. Read them first.
2. Reach the server **only** through the `remote` helper below. Never use `ssh -A`, port forwarding, `scp`, `rsync` or `ssh-copy-id`.
3. Never copy anything from the server to this computer, except command output and the bridge **public** key.
4. Never run a command that reads `/etc/tmux-pocket.env` or `/var/lib/tmux-pocket/id_ed25519`, even to "check" them.
5. Don't write files on this computer and don't change its SSH configuration.

### Setup

```bash
SERVER='me@203.0.113.10'      # from the human
DOMAIN='pocket.example.com'   # from the human
REF='<REF>'                   # from the human

# Runs a script on the server, like a shell opened there: no agent forwarding, no port forwarding,
# never prompts (BatchMode). DOMAIN, REF and I (the installer command) are set on the server side.
remote() {
  ssh -T -o ForwardAgent=no -o ClearAllForwardings=yes -o BatchMode=yes "$SERVER" \
    "DOMAIN='$DOMAIN' REF='$REF' I='sudo -n /usr/local/sbin/tmux-pocket-install' bash -s"
}
```

Always pass server steps with a **quoted** heredoc (`<<'STEP'`): variables like `$I` then expand on the server, never on
this computer.

### Step A — Connection

```bash
remote <<'STEP'
echo "connected to $(hostname) as $(id -un)"
sudo -n true 2>/dev/null && echo sudo-ok || sudo -n -l 2>/dev/null | grep -F /usr/local/sbin/tmux-pocket-install
STEP
```

**Verify:** `sudo-ok` (run step S next) or the installer rule (skip step S). If SSH asks for a password or neither line
appears, **STOP**: the human must give this account key-based SSH and sudo, or do the
[restricted setup](INSTALL-SERVER.md#restricted-setup-agent-without-sudo).

### Step B — DNS, checked from this computer

```bash
echo "domain:"; dig +short A "$DOMAIN" 2>/dev/null || getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u
H=$(ssh -G "$SERVER" | awk '/^hostname /{print $2}')
echo "server: $H"; dig +short A "$H" 2>/dev/null || getent ahostsv4 "$H" | awk '{print $1}' | sort -u
```

**Verify:** the domain's IPv4 is the server's IPv4 (the `server:` value itself when it is an IP, or what it resolves to). Otherwise **STOP** and ask the human to confirm that the
DNS A record of `$DOMAIN` points to this server.

### Steps S, 0 to 6 — Run the server guide remotely

Open [`INSTALL-SERVER.md`](INSTALL-SERVER.md) and run its step S (only if step A printed `sudo-ok`), then steps 0 to 6, in order. For each code block of a step,
send it unchanged through `remote`:

```bash
remote <<'STEP'
# paste the step's code block here, unchanged
STEP
```

- Skip the `DOMAIN=` / `REF=` / `I=` block of the server guide: `remote` already sets them on the server.
- Check each step's **Verify** block against the output, exactly as the server guide says. Same **STOP** rules.
- In step 0, the DNS check is already done (step B): if the IPs differ there only because of NAT, that's expected.

### Step C — Outside check, from this computer

```bash
curl -sI "https://$DOMAIN" | grep -iE '^HTTP|strict-transport'
curl -s -o /dev/null -w '%{http_code}\n' "http://$DOMAIN"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "https://$DOMAIN/api/list"
curl -s -o /dev/null -w '%{http_code}\n' -m 5 "http://$DOMAIN:8022/health" || true
```

**Verify**
- `HTTP/2 200` and `strict-transport-security: max-age=31536000`
- `308`
- `401`
- last line `000`: the bridge port is not reachable from outside. Anything else, **STOP** and report.

### Step D — Report to the human

```bash
remote <<'STEP'
$I status | head -6
$I pubkey
STEP
```

Send exactly this, filled in. Do not include the token.

```text
tmux-pocket is installed on <SERVER>.
- URL: https://<DOMAIN>
- Commit: <from step 3>
- Bridge public key: <output of pubkey>
- Caddy: <the part after the domain in the "site: OK" line of step 6>
- Checked from outside: HTTPS + HSTS, HTTP redirects, API needs the token, port 8022 closed.
- To log in, read the token yourself: ssh <SERVER> sudo grep BRIDGE_TOKEN /etc/tmux-pocket.env
- Next: authorize each server you want to reach (deploy/INSTALL-SERVER.md, "Authorize a server").
- You can now remove /etc/sudoers.d/tmux-pocket on the server, or keep it for updates.
```

## Authorize servers from your computer

Only when the human explicitly asks, for the servers and users they name. One target at a time, through the same kind of
connection (`TARGET` is the SSH destination of the server to authorize, as the user the app will use):

```bash
TARGET='me@198.51.100.7'
LINE='restrict ssh-ed25519 AAAA… tmux-pocket@yourhost'   # exact line from step D
ssh -T -o ForwardAgent=no -o ClearAllForwardings=yes -o BatchMode=yes "$TARGET" "LINE='$LINE' bash -seu" <<'STEP'
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qxF "$LINE" ~/.ssh/authorized_keys || echo "$LINE" >> ~/.ssh/authorized_keys
grep -cxF "$LINE" ~/.ssh/authorized_keys
STEP
```

**Verify:** prints `1`. Update, token rotation and uninstall: run the matching commands of
[`INSTALL-SERVER.md`, "Operate"](INSTALL-SERVER.md#operate) through `remote`.
