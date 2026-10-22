---
name: agentv-commands
description: Use when adding or changing an AgenTV command in bin/ (the agentv CLI and its agentv-* helpers). Builds on Omarchy's command-metadata guide.
paths:
  - "bin/agentv*"
---

# AgenTV commands

Read Omarchy's `agents/skills/command-metadata.md` and the style section of `AGENTS.md` first. AgenTV commands follow the same shape, so they feel like Omarchy's.

## Naming

- The router is `bin/agentv`: `agentv app validate`, `agentv app install`, `agentv app export`, `agentv selftest` and so on.
- Helpers are `bin/agentv-<group>-<name>`, for example `bin/agentv-app-validate`, and `bin/agentv` routes `agentv app validate` to it. That's the same pattern `bin/omarchy` uses for `omarchy-*`.
- Never add, rename or wrap an `omarchy-*` command, and never add AgenTV entries to Omarchy's `GROUP_DESCRIPTIONS`. The `omarchy` CLI stays exactly as upstream ships it.

## Metadata

- Mirror Omarchy's metadata keys with an `agentv:` prefix, in the first 80 lines:
  - `# agentv:summary=...`
  - `# agentv:args=...`
  - `# agentv:examples=...` (only when the args need explaining)
  - `# agentv:hidden=true`
  - `# agentv:requires-sudo=true`
- `bin/agentv` reads these the way `bin/omarchy` reads its own.

```bash
#!/bin/bash

# agentv:summary=Check an app package against the AgenTV app contract
# agentv:args=<package-dir>
```

## Style and runtime

- `#!/bin/bash`, two spaces, `[[ ]]` for string and file tests, `(( ))` for numbers, and quoted paths instead of escaped spaces.
- Use `$OMARCHY_PATH` for Omarchy's files, as `AGENTS.md` says. Don't derive paths from `$HOME`.
- Privileged steps follow the privilege section that `AGENTS.md` points to. A command that needs root says so with `agentv:requires-sudo=true`.
- Run `test/all` after adding a command, to prove `bin/omarchy` didn't start picking it up.
