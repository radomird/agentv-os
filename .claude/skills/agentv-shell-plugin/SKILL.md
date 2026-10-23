---
name: agentv-shell-plugin
description: Use when building AgenTV's Omarchy shell plugin (the Back to TV bar widget and the TV-mode toggle, in the agentv-plugin repo) or anything else that touches the Quickshell desktop. Builds on Omarchy's shell-dev guide.
---

# AgenTV shell plugin

Read Omarchy's `agents/skills/shell-dev.md` and `docs/omarchy-shell.md` first. AgenTV doesn't change the shell: it adds one third-party plugin.

## What's different for AgenTV

- **Never edit `shell/` in this repo.** It's Omarchy's. AgenTV's desktop pieces live in their own public repo, `agentv-plugin`, installed with `omarchy plugin add <git-url>` and listed on plugins.omarchy.org (ADR-010).
- **The plugin follows the third-party contract:**
  - `manifest.json` at the root, with `schemaVersion`, a namespaced `id` (`agentv.*`), `name`, `version`, `kinds` and `entryPoints`;
  - installed at `~/.config/omarchy/plugins/<id>/`.
  - It has to pass `omarchy plugin validate` (S1.4).
- **It gets the narrow facades** Omarchy gives third-party plugins, and nothing more. Never reach up the parent hierarchy for host objects, and never touch authentication services.
- **What it does:** a "Back to TV" bar widget, and a TV-mode toggle that does the same. Both end Omarchy's session, and the login manager logs back in to AgenTV's TV session (ADR-031): they run `agentv tv`. The TV session has no bar at all, so the plugin never hides anything. Until the plugin exists, Super+Ctrl+Home on the desktop runs `agentv tv` (`session/desktop.lua`).
- **Talk to the shell through `omarchy-shell`,** never with direct socket calls. Register the plugin's IPC target under its own name.
- **Palette:** import `qs.Commons as Commons` and use `Commons.Color`, so the widget follows the Omarchy theme like the rest of the bar.
- **Icons:** don't add glyphs to Omarchy's icon font (`default/fonts/omarchy/omarchy.ttf` is upstream). Ship the AgenTV mark inside the plugin. Draw it from `branding/build.py` in `agentv-os`, so it matches the logo (ADR-021).

## Testing it

On the Omarchy desktop: install it from a local path, run `omarchy-restart-shell`, click Back to TV, then check desktop to TV and back each take under 10 s (S1.3). Screenshot the bar per `agentv-visual-verification`.
