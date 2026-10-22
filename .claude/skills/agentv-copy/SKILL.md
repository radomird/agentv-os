---
name: agentv-copy
description: Use when writing or editing any AgenTV text people read, such as READMEs, docs, UI strings, setup screens, repo descriptions or commit messages. Sets Omarchy's voice, the no-em-dash rule and AgenTV's naming.
---

# AgenTV copy

AgenTV should read like an indie project in Omarchy's spirit. Omarchy's README and its manual (`manual/` in this repo) are the tone to match: plain, confident and personal, with a bit of fun.

## Voice

- Plain words, contractions and short paragraphs.
- First person where it fits ("Tested on an Intel NUC").
- No hype or corporate verbs (seamless, powerful, leverage, unlock, empower).
- Say "will" for anything that isn't built yet.
- In READMEs, mark planned features and repos "coming soon". Never write just "coming".
- Name a brand only when you need to. Say "a streaming service or a game" rather than a specific one.
- Don't list safety or approval steps in public copy unless Radomir asks for them.

## Hard rules

- **No em dashes anywhere, ever,** and no en dashes used as dashes either. Use a comma, colon, period or parentheses. Search the text for the em dash character (U+2014) before you finish.
- **Names:**
  - the product is **AgenTV**;
  - repos are `agentv-*`;
  - the command is `agentv`.
  - Never call it Omarchy, and never suggest Basecamp endorses it.
- **Credit:** public taglines and repo descriptions say "Powered by Omarchy". The current tagline is "The world's first open-source agentic TV OS. Powered by Omarchy."
- **Fork READMEs** live in `.github/README.md`, which GitHub shows ahead of Omarchy's own `README.md`. Never edit Omarchy's.

## Process

For anything public (READMEs, release notes, store text), run the `ai-de-slopifier` skill:
1. a fact guard against `PHASE-1-PLAN.md` and the ADRs;
2. two passes;
3. a score of at least 85.

For UI strings, follow the look's limits: one headline and at most one line of text per screen (ADR-014).
