---
name: agentv-quality-gates
description: Use before every AgenTV commit, before opening a pull request, and before saying a task is done. Runs the fast gate (ADR-019 layers 1 to 4), says when the slow image layer is needed, and how to mark an acceptance check as passed.
---

# AgenTV quality gates

The full rules are ADR-019 in `../agentic-tv-os/DECISION-RECORD.md` and the "Quality gates" section of `../agentic-tv-os/PHASE-1-PLAN.md`. This is the working version.

Main is always installable. Nothing merges while a required check is red, and nothing is "done" while the fast gate fails.

## The fast gate, before every commit

Run `bin/agentv-check` (layer 1) and `test/agentv/unit/run` (layer 2). In agentv-os, `test/agentv/omarchy-tests` covers item 2 below; it needs Linux and bash 5, so it runs in CI. The gate checks:

1. **Omarchy's files are untouched** since the base in `.github/omarchy-base`: `git diff --diff-filter=MDR --name-only "$(cat .github/omarchy-base)"...HEAD` prints nothing.
2. **Omarchy's own tests still pass.** `test/all` (its CLI and shell suites). AgenTV adds files only, so a failure here means something of ours leaked into Omarchy's world, for example a command `bin/omarchy` now picks up.
3. **No em dashes** in anything you added or changed: `git diff --cached | grep -n $'\u2014'` prints nothing. (The pattern is written as an escape so this file doesn't contain the character either.)
4. **No secrets:** gitleaks, on the files and on every AgenTV commit since the base.
5. **Shell style:** `shellcheck` on every shell file you added. Follow Omarchy's `AGENTS.md` style too: two spaces, `[[ ]]` and `(( ))`, `#!/bin/bash`.
6. **No service automation in public:** nothing that names selectors or automates Disney+, Prime Video, Netflix or Spotify.
7. **Every manifest validates:** `agentv app validate <dir>` once it exists.

Layers 2 to 4 (unit, contract, UI) join the gate as their code lands. They should run in seconds on the Mac against the fake platform, with no VM.

## Pull requests

- Layers 1 to 4 must be green, and the target is under 10 minutes.
- A pull request runs only the checks its files can affect. Lint, secrets and house rules always run. One that only changes `.claude/`, the README in `.github/` or the image and nightly workflows skips the unit, contract, screen and Omarchy tests. One that only touches AgenTV's own folders (`daemon/`, `launcher/`, `setup/`, `companion-web/`, `apps/`, `builder/`, `branding/`, `session/`, `test/agentv/`, `.github/`) skips Omarchy's own tests, unless it adds or changes a `.service` or `.conf` file. A push to `agentv` runs everything.
## The image layer, once per change

Layer 5, the image test, builds the ISO, installs it in a VM and runs every image check. That takes about 50 minutes, so a pull request gets it once, when it's ready. It runs in GitHub Actions on `ubuntu-26.04` with KVM, because the Mac can't run the x86_64 ISO. See `agentv-acceptance-tests`.

- **Which pull requests get it.** In agentv-os, one that touches `install/`, `system/`, `config/hypr/`, `migrations/`, `session/` or the screen daemon's Hyprland and input files (`daemon/screen.ts`, `daemon/hyprland.ts`, `daemon/input.py`). So does one with a branch of the same name in agentv-iso or agentv-pkgs. In agentv-iso, every pull request that touches the build or its tests. Everything else gets it from the nightly run once it's merged, and from agentv-iso on every release tag.
- **Drafts get no image run.** Open your pull request as a draft, and keep it one while you work. The "image" label runs the whole thing on a draft anyway. Add it again to run it again.
- **While you fix, rerun only the checks that fail.** Run them by name, with `image.yml` and `checks` on your branch (below). Don't push to a ready pull request to see if a fix works.
- **Mark it ready once they pass.** That starts the one full run. Each push after that runs it again. So if the full run fails, turn the pull request back into a draft while you fix it.
- **A paired change runs it once, in agentv-os.** When your change has a branch of the same name in agentv-iso or agentv-pkgs, agentv-os's VM test builds the ISO from those branches. agentv-iso's pull request skips its own run and links to agentv-os's. Push agentv-iso and agentv-pkgs first, then agentv-os, so its run picks them up.
- **After pushing only the agentv-iso or agentv-pkgs branch, rerun the agentv-os pull request's Check run.** Nothing else starts it. Its VM test lists the agentv-iso and agentv-pkgs commits it built in its summary. Before a merge, check they're still the heads of those branches.
- **Nothing merges red.** A pull request that gets the image layer needs a green full run on its last commit before it merges.
- **To rerun one image check,** run the Image workflow (`image.yml`) by hand on your branch, with `ref` set to your branch, `checks` set to the check's file name in agentv-iso's `test/agentv/image/` without `-test.sh` (`s5.6-setup`, or several with spaces between them), and `from-disk` and `own-repo` on. It starts from the night's box with your packages on it, so you get the answer in minutes. Set `iso-ref` to your agentv-iso branch if the check changed there, and `pkgs-ref` to your agentv-pkgs branch if a package did. Leave `from-disk` off if your change touches `install/`, `config/` or `branding/`, and for `s0.4-branding`, which needs the ISO.

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
