---
name: agentv-install-scripts
description: Use when working on AgenTV's install, first boot or system setup, under install/tv/, system/, config/hypr/tv.lua or the agentv-iso repo. Builds on Omarchy's install-scripts guide and adds AgenTV's rules.
paths:
  - "install/tv/**"
  - "system/**"
  - "config/hypr/tv.lua"
  - "config/omarchy/**"
---

# AgenTV install scripts

Read Omarchy's `agents/skills/install-scripts.md` first. Every rule in it holds for AgenTV's scripts too:
- leaf scripts are sourced through `run_logged` and have no shebang;
- no `exit` in sourced scripts;
- use `$OMARCHY_INSTALL` and `$OMARCHY_PATH`, never hard-coded paths;
- per-user leaves sit apart from root-scoped ones.

## What's different for AgenTV

- **Our leaves live under `install/tv/`** and never inside Omarchy's own folders. Don't add a line to Omarchy's `all.sh` files or any other upstream script to call ours. How our install hooks in without editing upstream is a stage 0 question (`HANDOFF.md`, "Next: stage 0"). Until it's answered, ask before inventing a hook.
- **The ISO still owns orchestration.** Omarchy's installer questions run unchanged (ADR-007). AgenTV takes over at first boot through `agentv-firstboot.service`. That unit goes online, installs the TV runtime and opens the TV setup welcome screen.
- **System units** are named `agentv-*.service` and live in `system/`. The daemon runs as its own service. The builder runs as the `agentv-builder` user, with no sudo, writing only to its build folder.
- **Secrets** go in `/etc/agentv/env`: root-only, written by setup, never echoed or logged. Sign-ins live in `/var/lib/agentv/chromium/`. Neither ever lands in the repo or in a fixture.
- **No disk encryption by default** (ADR-007). If the ISO can't default to that without editing upstream files, the install guide says to press Ctrl+C at the disk confirm.
- **Branding** goes through Omarchy's own commands, not through edited files (ADR-021):
  - `omarchy plymouth set` for the boot splash;
  - `~/.config/omarchy/branding/` for the screensaver and About art.
- **Agent CLIs** come from Omarchy's mise wrappers (`install/user/mise.sh`) and download on first use. AgenTV shows the provider's terms in setup and runs a CLI for the first time only after an adult accepts them (ADR-023).

## Testing it

You can't run the x86_64 install on the Mac. Push, then let the image layer in `agentv-iso` CI do the unattended install and the boot (see `agentv-acceptance-tests`). Check the screenshots it attaches before saying it works. Hardware checks, such as the hotspot and HDMI, wait for the NUC.
