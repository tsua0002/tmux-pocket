# tmux-pocket

**Your agents, in your pocket, from tmux and your infra.**

An iPhone-first manager for remote **tmux** sessions, with a **native chat view** for terminal coding agents
(pi, claude, codex, aider, gemini, opencode…). You save an SSH server once, see every tmux window, and start a new agent in two taps.

> 🚧 **Building in public.** This is an early prototype and the repo shows how it's built, commit by commit.

![tmux-pocket: window list, agent chat, terminal view](docs/hero.png)

## Demo

<table>
<tr>
<td width="34%"><img src="docs/demo.gif" alt="Two taps to start pi, then chat with it"></td>
<td>

**Live dashboard:** every tmux window shows the last lines of its screen and what it's doing: *working* (pulsing),
*waiting for you* (a question or confirmation), or idle. You see where your agents are without opening anything.

**Two taps to start an agent:** tap ＋ New window, then **pi**. The window is created on the server, the command
starts and the window opens.

**The real TUI, comfortable on a phone:** pi (1.x, fullscreen by default) is shown as pi draws it, so it stays right
whatever pi ships next. Your swipe scrolls pi itself, with inertia, and a tap is a click. Programs with a normal
scrollback (a shell, pi in `regular` mode) scroll natively over their whole history. While the agent works, the send
button becomes ■ stop. Fold the key dock away to give the terminal the full height.

**Native pi chat, one tap away:** the conversation read from [pi](https://pi.dev)'s session file (documented format):
messages, tool calls with their output, thinking folded, errors, the model, and the reply streaming live.

**WeeChat at your fingertips:** your buffers become buttons (current one highlighted, activity marked), plus
previous / next buffer, jump to activity and scrolling.

**Every key:** sticky `ctrl` / `alt` / `⇧` for the next key (from the bar or the keyboard), per-program shortcuts
(pi: stop, new, compact, model…), arrows, `home`/`end`, `pgup`/`pgdn`, F1–F12 and symbols.

The demo runs entirely in the browser with a built-in simulator. No server needed.

</td>
</tr>
</table>

| Live window list | New window in 2 taps | pi 1.4 TUI | Native pi chat | WeeChat buffers |
|:-:|:-:|:-:|:-:|:-:|
| ![](docs/live-list.png) | ![](docs/new-window.png) | ![](docs/pi-tui.png) | ![](docs/chat.png) | ![](docs/weechat.png) |

## How it works

```
iPhone (web app / PWA) ──HTTP JSON──▶ bridge (Node + ssh2) ──SSH──▶ your server
                                                                     tmux list-windows -a
                                                                     tmux capture-pane -p -e
                                                                     tmux send-keys -l
                                                                     tmux new-window / resize-window / kill-window
```

It's plain tmux on your server. The app adds no daemon or agent wrapper there.

- **Window list**: `tmux ls`, one row per window, grouped by session and refreshed every 3 s. Agent windows get a badge.
- **Terminal**: the app polls `capture-pane -e` and renders the lines as HTML, with no terminal library. It never attaches
  as a tmux client, so your desktop client keeps its size.
- **Scrolling**: for regular programs (a shell, pi in its default mode) the tmux history is loaded once, then only the new
  lines; you scroll it natively, with inertia and selectable text, and new output never moves what you're reading. Programs
  on the alternate screen (pi fullscreen, WeeChat, htop…) get your swipes as mouse-wheel events and your taps as clicks
  (`send-keys -H`), or Page keys when they don't use the mouse.
- **Fit to iPhone**: the app resizes the window to about 50 columns so TUIs reflow for the phone. It restores automatic sizing when you leave the window.
- **Chat**: the app strips borders, the input box and hard wraps from the TUI, then shows the rest as bubbles. Your message is sent with `send-keys`.
- **New window**: the command runs inside a shell, so the window survives when the agent exits.

Under the hood: a single `web/index.html` file with no build step, and a bridge of about 200 lines that depends only on [ssh2](https://github.com/mscdex/ssh2).

## Try it

**Demo only:** open `web/index.html` in a browser. On a desktop it shows inside a phone frame.

**With your own server:**

```bash
cd bridge
npm install
npm start                     # http://127.0.0.1:8022
```

Open that URL and add a server: host, port, user, default session, start directory and quick commands
(or paste a `~/.ssh/config` block). The app shows the bridge's **public key**: add it once to `~/.ssh/authorized_keys`
on that server, and you're connected. No private key is ever pasted into the app.

### Self-host on your own domain (use it from your iPhone)

The bridge runs on one of your servers, behind HTTPS on your domain. It serves the app and opens the SSH connections
to your other servers (plain IPv4 or hostnames). Its API refuses plain HTTP from anywhere but the machine itself.

The install guides are written to be **checked by you, then run by your coding agent**. They list everything they touch
and what they never do, with a verify step and stop conditions after every command:

- [`deploy/INSTALL-SERVER.md`](deploy/INSTALL-SERVER.md): your agent runs **on the server** (self-contained, give it as is).
- [`deploy/INSTALL-FROM-COMPUTER.md`](deploy/INSTALL-FROM-COMPUTER.md): your agent runs **on your computer** and deploys over SSH.

Every root operation goes through one audited script, [`deploy/tmux-pocket-install`](deploy/tmux-pocket-install): every
file it writes as root is embedded in it, and its arguments are validated. An agent with sudo installs it itself; an
agent without sudo gets a single sudo rule for it.

1. Read [What this install touches](deploy/INSTALL-SERVER.md#what-this-install-touches) and
   [Privileges](deploy/INSTALL-SERVER.md#privileges-what-the-agent-can-do-as-root).
2. If your agent has no sudo, do the [restricted setup](deploy/INSTALL-SERVER.md#restricted-setup-agent-without-sudo)
   (2 minutes). Otherwise there is nothing to do by hand.
3. Give this to an agent running on that server (for an agent on your computer, use the prompt in the other guide):

```text
Install tmux-pocket on this server by following deploy/INSTALL-SERVER.md from
https://github.com/tsua0002/tmux-pocket at commit <REF>, section "Steps for the agent", exactly.
DOMAIN=pocket.your-domain.tld
REF=<REF>
If you have sudo, start with step S. After it, use sudo only as: sudo -n /usr/local/sbin/tmux-pocket-install <command>.
If the DNS record for DOMAIN is missing and you have DNS API access, create the A record to this server's public IPv4.
Stop and ask me whenever the guide says STOP. Never show me or log BRIDGE_TOKEN or the private key.
```

4. Read the token yourself on the server (`sudo grep BRIDGE_TOKEN /etc/tmux-pocket.env`), open `https://pocket.your-domain.tld`
   on your iPhone, log in, then *Share → Add to Home Screen*.
5. For each server, run the one-line command shown in the app: it adds the bridge's public key to `authorized_keys`.

## Security: where the secrets live

| Secret | Where it lives | Never |
|---|---|---|
| SSH private key | Generated by the bridge on first start in `STATE_DIR` (`/var/lib/tmux-pocket`, dir `0700`, file `0600`) | Sent over the network, shown in the app, stored on the phone, committed |
| Your servers' host keys | Pinned on first connection in `STATE_DIR/known_hosts.json`; a changed key is refused | Silently accepted |
| `BRIDGE_TOKEN` | `/etc/tmux-pocket.env` (`0600`) on the bridge host | Stored on the phone: login opens an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie that JavaScript can't read |
| SSH password (optional) | Phone memory while the app is open | Saved anywhere |

- The phone's storage only holds addresses and preferences. Secrets saved by older versions are purged on load.
- Everything travels over HTTPS (HSTS on), and the API refuses plain HTTP from anywhere but the machine itself.
- The bridge only answers same-origin JSON requests (no CORS) and refuses to listen on a public address without `BRIDGE_TOKEN`.
- On your servers the key is installed with `restrict`: no port, agent or X11 forwarding, no terminal, only commands.
- `.gitignore` blocks `*.env`, keys and `known_hosts*`, and the bridge keeps its state outside the repo.
- Installing needs one sudo rule for one audited script, never general root. The service then runs as an unprivileged,
  sandboxed user.
- To revoke access, remove the `tmux-pocket@…` line from a server's `authorized_keys`, or rotate the key by deleting `STATE_DIR/id_ed25519`.
- Prefer keeping the bridge behind a VPN (WireGuard, Tailscale) in addition to HTTPS.

Bridge tests run against a real tmux: `cd bridge && npm test`.

## Roadmap

- [x] Saved SSH servers, tmux window list, terminal view, key bar
- [x] Agent chat view and new window in two taps
- [x] In-browser simulator for working on TUI rendering
- [x] Native pi conversation from its session file; WeeChat buffer navigation; sticky modifiers and full key set
- [x] Live window previews and agent status; real TUI with native scrolling, swipe-to-wheel with inertia, tap-to-click
- [x] Tested against pi 1.4 (fullscreen by default) on a real model
- [ ] Native pickers for pi (`/model`, `/resume`, `/tree`) instead of switching to the terminal
- [ ] Native conversation for claude and codex (their session files)
- [ ] Native iOS app: [Capacitor](https://capacitorjs.com) around `web/`, plus a Swift SSH plugin
      ([Citadel](https://github.com/orlandos-nl/Citadel)) to replace the bridge, with credentials in the iOS Keychain
- [ ] Native app: SSH key generated in the iPhone's Secure Enclave (never exportable), no bridge needed
- [ ] Optional Tailscale SSH (no key to manage at all)
- [ ] ProxyJump, push notifications when an agent waits for input

Everything goes through one function, `api(srv, op, args)`, with the ops `list`, `capture`, `send`, `keys`, `new`, `kill`,
`resize`, `screen`, `mouse`, `previews` and `pi`.
Swapping the transport doesn't touch the UI.

## License

[MIT](LICENSE)
