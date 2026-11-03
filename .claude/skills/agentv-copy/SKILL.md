---
name: agentv-copy
description: Use when writing or editing any AgenTV text people read, such as READMEs, docs, UI strings, setup screens, repo descriptions or commit messages. Sets AgenTV's voice (an indie dev explaining their project plainly), the no-em-dash rule and AgenTV's naming.
---

# AgenTV copy

AgenTV should read like an indie dev explaining their own project to another dev: straightforward, grounded and easy to read the first time through. Omarchy's README and its manual (`manual/` in this repo) are the spirit to match: plain, confident and personal, with a bit of fun.

## Voice

Write the way you'd explain it to a friend who codes, over coffee.

- **Lead with what it is and why someone would care.** The first sentence of a README says what this is in plain words. Then how to use it. Details come last.
- **One idea per sentence.** Keep sentences short. Split anything held together by semicolons, a run of "and", or a clause hanging off another clause.
- **Plain words before project words.** Say "the list of apps" before "the index", "test data" before "fixtures", and "the rules every app follows" before "the app contract". If you need the project word, explain it once, the first time it comes up.
- **Concrete, with someone doing it.** Say what actually happens, in order: "Your box downloads the list, checks it really came from AgenTV, then installs the app." Not "A box reads it and checks the signature against the key it already has."
- **"You" for the reader, "I" for the maker.** "Your box" and "your TV" rather than "a box".
- **Headings people would look for,** such as "What's in an app", "How your box gets an app" and "Running the tests", rather than bare labels like "Checks" or "Fixtures".
- **No inside references in public text.** No ADR or grilling numbers, no acceptance ids like S3.1, no session or planning names. If someone needs the background, link to a doc.
- **Leave out what a reader doesn't need.** A README says what something is, why it's there and how to use it. Edge cases belong in comments and code.
- Contractions, first person where it fits ("Tested on my Intel NUC"), and a bit of personality.
- No hype or corporate verbs (seamless, powerful, leverage, unlock, empower).
- Say "will" for anything that isn't built yet. In READMEs, mark planned features and repos "coming soon". Never write just "coming".
- Name a brand only when you need to. Say "a streaming service or a game" rather than a specific one.
- Don't list safety or approval steps in public copy unless Radomir asks for them.
- **Read it out loud.** If it sounds like a spec or a legal clause, rewrite it.

## Lean on Omarchy's manual

Omarchy's manual is the model, so read a page or two before you write a README or a doc. `manual/30-updates.md`, `manual/32-shell-plugins.md` and `manual/43-making-your-own-theme.md` are good ones. What it does that AgenTV copies:

- **Prose first.** Paragraphs carry the explanation. Bullets are for real lists of things, and they stay plain, without a bold lead-in on every item. Numbered steps are only for something you actually do in order.
- **Say why it matters, in a line.** "That's not just an implementation detail. It means you can turn pieces of the desktop off." Or: "Installing someone's theme should change what your desktop looks like, never what it runs."
- **Commands where you'd type them.** A short code block under a task heading, then a line on what it does: "That prints every discovered plugin."
- **Task headings,** like "Seeing what you have", "Turning them on and off" and "Rolling back bad updates", or a question in a FAQ: "How do I switch between keyboard layouts?"
- **Mixed rhythm.** Short lines that land ("The bar is a plugin." "Take that seriously.") next to a longer sentence that runs through a list with commas.
- **Honest about who it's for and what can go wrong:** "You should only do this if you're experienced with Linux."
- **A bit of opinion and fun where it fits,** like "tweak to your delight". Don't force it.
- **Menu paths in italics,** like _Settings > Look_, and keys in backticks, like `Super + Space`.
- **One difference:** Omarchy's manual uses em dashes. AgenTV never does.

## Before and after

| Don't write | Write |
| --- | --- |
| AgenTV's official apps, one folder each, and the signed index a box installs them from. | The official apps for AgenTV. There are four so far, each in its own folder under `apps/`. This repo also publishes the signed list your box installs them from. |
| How a box gets them | How your box gets an app |
| The index is published as the `index` release here. | Then it signs the list with AgenTV's key (the same one the packages are signed with) and publishes it as the `index` release here. |
| Steam has nothing to record, so its checks are the contract's own and that it does nothing more. | Steam doesn't talk to a server, so there's nothing to record. Its tests just check that it follows the app rules and doesn't try to do anything else. |
| Each app's `fixtures/README.md` says what's in them. | Each app's `fixtures` folder has a short README that explains what's in it. |

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

Then read it once more against the Voice list above, sentence by sentence.

For UI strings, follow the look's limits: one headline and at most one line of text per screen (ADR-014).
