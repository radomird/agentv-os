---
name: agentv-quality-gates
description: Use before every AgenTV commit, before opening a pull request, and before saying a task is done. Runs the fast gate (ADR-019 layers 1 to 4), says when the slow image layer is needed, and how to mark an acceptance check as passed.
---

# AgenTV quality gates

The full rules are ADR-019 in `../agentic-tv-os/DECISION-RECORD.md` and the "Quality gates" section of `../agentic-tv-os/PHASE-1-PLAN.md`. This is the working version.

Main is always installable. Nothing merges while a required check is red, and nothing is "done" while the fast gate fails.

## The fast gate, before every commit

Once `bin/agentv-check` exists, run it. Until then, run these by hand on what you changed:

1. **Omarchy's files are untouched.** `git diff --diff-filter=MDR --name-only v4.0.6...HEAD` prints nothing.
2. **Omarchy's own tests still pass.** `test/all` (its CLI and shell suites). AgenTV adds files only, so a failure here means something of ours leaked into Omarchy's world, for example a command `bin/omarchy` now picks up.
3. **No em dashes** in anything you added or changed: `git diff --cached | grep -n $'\u2014'` prints nothing. (The pattern is written as an escape so this file doesn't contain the character either.)
4. **No secrets:** `gitleaks protect --staged`.
5. **Shell style:** `shellcheck` on every shell file you added. Follow Omarchy's `AGENTS.md` style too: two spaces, `[[ ]]` and `(( ))`, `#!/bin/bash`.
6. **No service automation in public:** nothing that names selectors or automates Disney+, Prime Video, Netflix or Spotify.
7. **Every manifest validates:** `agentv app validate <dir>` once it exists.

Layers 2 to 4 (unit, contract, UI) join the gate as their code lands. They should run in seconds on the Mac against the fake platform, with no VM.

## Pull requests

- Layers 1 to 4 must be green, and the target is under 10 minutes.
- Add layer 5, the image test, when the change touches `install/`, `system/`, `config/hypr/` or anything in `agentv-iso`. It runs in GitHub Actions on `ubuntu-26.04` with KVM, because the Mac can't run the x86_64 ISO. See `agentv-acceptance-tests`.

## Acceptance ids

- Every acceptance check in `PHASE-1-PLAN.md` has an id (S0.1, S2.5 and so on).
- A test that automates one carries the id in its name, for example `S2.5 resize takes only the sizes the manifest lists`.
- A CI run reports each id as pass, fail or manual.

## Marking something as passed

Edit `PHASE-1-PLAN.md` only when all three are true:
- every automated id for that stage is green on main;
- the NUC checks for it have passed (`agentv selftest` and the short human checklist);
- Radomir has signed off.

Then write the date and what you saw next to the id, and add a dated line to `../agentic-tv-os/LOG.md`.

## Never loosen a gate on your own

Changes to the app contract, the builder sandbox, the spend caps or the index's Official list need Radomir. So does skipping a check or marking a flaky test as allowed to fail.
