---
name: origaitv-commands
description: Use when adding or changing an origaiTV command in bin/ (the origaitv CLI and its origaitv-* helpers). Builds on Omarchy's command-metadata guide.
paths:
  - "bin/origaitv*"
---

# origaiTV commands

Read Omarchy's `agents/skills/command-metadata.md` and the style section of `AGENTS.md` first. origaiTV commands follow the same shape, so they feel like Omarchy's.

## Naming

- The router is `bin/origaitv`: `origaitv app validate`, `origaitv app install`, `origaitv app export`, `origaitv selftest` and so on.
- Helpers are `bin/origaitv-<group>-<name>`, for example `bin/origaitv-app-validate`, and `bin/origaitv` routes `origaitv app validate` to it. That's the same pattern `bin/omarchy` uses for `omarchy-*`.
- Never add, rename or wrap an `omarchy-*` command, and never add origaiTV entries to Omarchy's `GROUP_DESCRIPTIONS`. The `omarchy` CLI stays exactly as upstream ships it.

## Metadata

- Mirror Omarchy's metadata keys with an `origaitv:` prefix, in the first 80 lines:
  - `# origaitv:summary=...`
  - `# origaitv:args=...`
  - `# origaitv:examples=...` (only when the args need explaining)
  - `# origaitv:hidden=true`
  - `# origaitv:requires-sudo=true`
- `bin/origaitv` reads these the way `bin/omarchy` reads its own.

```bash
#!/bin/bash

# origaitv:summary=Check an app package against the origaiTV app contract
# origaitv:args=<package-dir>
```

## Style and runtime

- `#!/bin/bash`, two spaces, `[[ ]]` for string and file tests, `(( ))` for numbers, and quoted paths instead of escaped spaces.
- Use `$OMARCHY_PATH` for Omarchy's files, as `AGENTS.md` says. Don't derive paths from `$HOME`.
- Privileged steps follow the privilege section that `AGENTS.md` points to. A command that needs root says so with `origaitv:requires-sudo=true`.
- Run `test/all` after adding a command, to prove `bin/omarchy` didn't start picking it up.
