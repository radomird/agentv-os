<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../branding/logo.svg">
    <img alt="AgenTV" src="../branding/logo-light.svg" width="520">
  </picture>
</p>

<p align="center">
  <b>A TV OS whose own agent builds the apps it is missing.</b><br>
  Powered by <a href="https://omarchy.org">Omarchy</a>.
</p>

---

AgenTV turns an x86_64 mini PC (the reference box is an Intel NUC) into a TV. Install it from a USB stick, finish setup from your phone, and it boots to a couch-sized home screen. Ask it for an app it doesn't have, say "add Disney+", and its agent builds and tests that app in the background, then installs it once an adult approves.

**Status:** early. Phase 1 is being built, and there is nothing to install yet.

## Powered by Omarchy

AgenTV is an Omarchy variant. It installs [Omarchy](https://omarchy.org) 4 and adds a TV mode on top. When you need a full desktop, switch from the TV to the Omarchy desktop and back.

- **This repo** is a fork of [omacom/omarchy](https://github.com/omacom/omarchy), pinned to a release tag.
- **Omarchy's files are never edited here.** AgenTV only adds its own, under `install/tv/`, `config/hypr/tv.lua`, `daemon/`, `launcher/`, `setup/`, `builder/`, `apps/`, `branding/` and `bin/agentv`.
- **Omarchy's own README** is [`../README.md`](../README.md).
- **Omarchy is made by David Heinemeier Hansson and its contributors.** It is MIT-licensed, and its [licence](../LICENSE) is kept as it is. AgenTV's additions use the same licence.
- **Not official:** AgenTV isn't made or endorsed by the Omarchy project.

The AgenTV wordmark is drawn in the letterforms of Omarchy's logo, as a thank-you, and its "a" is Omarchy's own. `branding/build.py` makes every logo file from one set of letters.

## The AgenTV repos

| Repo | What it is |
| --- | --- |
| `agentv-os` (this one) | The TV OS: Omarchy plus TV mode, the daemon, the launcher, setup, the builder and the app contract |
| [`agentv-iso`](https://github.com/radomird/agentv-iso) | The installer ISO, a fork of `omacom/omarchy-iso` that installs `agentv-os` |
| `agentv-index` | The signed index of apps (coming) |
| `agentv-app-*` | Official apps: Jellyfin, Plex, Immich, Steam (coming) |
| `agentv-plugin` | An Omarchy shell plugin with a "Back to TV" button for the desktop (coming) |
