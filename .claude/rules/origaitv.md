# OrigaiTV

This repo is `origaitv-os`: OrigaiTV, a TV OS whose own agent builds the apps it's missing, built on top of Omarchy. It's a fork of `omacom/omarchy` that follows Omarchy's stable releases (ADR-026). The release it's on is in `.github/omarchy-base`. Omarchy's own `AGENTS.md` still applies to everything here: its style, its runtime environment rules and its privilege rules. This file adds what's different for OrigaiTV, and when the two disagree, this file wins.

The plan lives next door in `../agentic-tv-os`. Read its `HANDOFF.md` first, then the ADRs in `DECISION-RECORD.md`, then `PHASE-1-PLAN.md`. The ADRs are decisions, so don't re-open one without asking Radomir.

## Never edit Omarchy's files

- Only add files. Every file that exists at the base in `.github/omarchy-base` stays byte-for-byte as it is, so merging each new Omarchy release stays mechanical. The daily Omarchy sync does that merge and moves the base.
- OrigaiTV's own code goes under `install/tv/`, `session/` (the TV session, ADR-031), `config/omarchy/`, `system/`, `daemon/`, `launcher/`, `setup/`, `companion-web/`, `builder/`, `apps/`, `branding/`, `test/origaitv/`, `.claude/` and `bin/origaitv*`.
- Check before every commit with `bin/origaitv-check`. Its first check is the same as `git diff --diff-filter=MDR --name-only "$(cat .github/omarchy-base)"...HEAD` printing nothing.
- If you think an upstream file has to change, stop and ask. ADR-021 leaves one possible exception, `logo.txt`, and only if no overlay works.
- Omarchy's commands all start with `omarchy-`. OrigaiTV's own commands start with `origaitv` instead (see the `origaitv-commands` skill), and they never add, rename or wrap an `omarchy-*` command.

## Public repo rules

- No adapter code, service selectors or anything that automates a streaming service (Disney+, Netflix, Prime Video, HBO Max, YouTube, YouTube Kids, SkyShowtime or Spotify). The official streaming apps live in `origaitv-apps`, each in its own folder, and the pages they're written against stay in the private `origaitv-adapters` repo (ADR-066). Spotify is never in a repo.
- No secrets. Keys live on the box in `/etc/origaitv/env`, and sign-ins in `/var/lib/origaitv/chromium/`. Fixtures never hold sign-in material.
- Agent-built apps stay on the box that built them.

## Copy

- Write docs, UI text, commit messages and READMEs the way an indie dev talks about their own project: first to the person who'll use it, then to another dev. Straightforward, grounded and easy to read the first time. Short sentences, plain words before project words, what actually happens in order, "you" and "I", and no inside references (ADRs, grilling numbers, acceptance ids) in public text. Omarchy's README is the spirit to match, and origaitv-apps' README is the reference.
- Say "will" for what isn't built yet, and mark planned features "coming soon" in READMEs.
- No em dashes anywhere, ever. That includes code comments and commit messages.
- Public lines say "Powered by Omarchy". Never call OrigaiTV Omarchy itself or suggest Basecamp endorses it.
- The `origaitv-copy` skill has the details.

## Before you commit

- Run the fast gate from the `origaitv-quality-gates` skill. A task isn't done until it's green.
- Commit with this repo's own git identity (already set). Leave out any AI attribution: no Co-Authored-By or session trailers in commit messages, and no "Generated with" line in pull requests.
- Log progress with a date in `../agentic-tv-os/LOG.md`. Mark an acceptance check as passed in `PHASE-1-PLAN.md` only when the skill says it has passed.

## Which guide to read

Omarchy's task guides in `agents/skills/` still apply. The OrigaiTV skills build on them:

| Work | Read first (Omarchy) | Then (OrigaiTV skill) |
| --- | --- | --- |
| Install, first boot, system units | `agents/skills/install-scripts.md` | `origaitv-install-scripts` |
| Commands in `bin/` | `agents/skills/command-metadata.md` | `origaitv-commands` |
| Tests | `agents/skills/acceptance-tests.md` | `origaitv-acceptance-tests` |
| Anything you can see or hear | `agents/skills/visual-verification.md` | `origaitv-visual-verification` |
| The Omarchy shell plugin (Back to TV) | `agents/skills/shell-dev.md` | `origaitv-shell-plugin` |
| Docs, READMEs, UI text | none | `origaitv-copy` |
| Before any commit or "done" | none | `origaitv-quality-gates` |
