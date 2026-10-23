# Self-hosting tmux-pocket

Pick the guide that matches where your coding agent runs. Both install exactly the same thing on the server,
through the same audited installer.

| Your agent runs… | Guide |
|---|---|
| **on the server** (you SSH in and start the agent there) | [`INSTALL-SERVER.md`](INSTALL-SERVER.md), self-contained, give it as is |
| **on your computer** (it reaches the server with your SSH access) | [`INSTALL-FROM-COMPUTER.md`](INSTALL-FROM-COMPUTER.md) |

Before handing either one over:
1. Read [What this install touches](INSTALL-SERVER.md#what-this-install-touches) and
   [Privileges](INSTALL-SERVER.md#privileges-what-the-agent-can-do-as-root).
2. Do the [human setup](INSTALL-SERVER.md#human-setup-once): install [`tmux-pocket-install`](tmux-pocket-install)
   root-owned and allow only that command in sudoers ([`sudoers.tmux-pocket`](sudoers.tmux-pocket)).
   The agent needs no other root right.
