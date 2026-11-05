---
name: agentv-copy
description: Use when writing or editing any AgenTV text people read, such as READMEs, docs, UI strings, setup screens, repo descriptions or commit messages. Sets AgenTV's voice (an indie dev talking to the person who uses it, then to other devs), the no-em-dash rule and AgenTV's naming.
---

# AgenTV copy

AgenTV should read like an indie dev talking about their own project: first to the person who'll use it, then to another dev. Straightforward, grounded and easy to read the first time through. Omarchy's README is the spirit to match: plain, confident and personal, with a bit of fun.

## Voice

Write the way you'd explain it to a friend who codes, over coffee.

- **Lead with what it is and why someone would care.** The first sentence of a README says what this is in plain words. Then how to use it. Details come last.
- **One idea per sentence.** Keep sentences short. Split anything held together by semicolons, a run of "and", or a clause hanging off another clause.
- **Plain words before project words.** Say "the list of apps" before "the index", "test data" before "fixtures", and "the rules every app follows" before "the app contract". If you need the project word, explain it once, the first time it comes up.
- **Concrete, with someone doing it.** Say what actually happens, in order: "Your box downloads the list, checks it really came from AgenTV, then installs the app." Not "A box reads it and checks the signature against the key it already has."
- **"You" for the reader, "I" for the maker.** "Your box" and "your TV" rather than "a box".
- **Headings people would look for,** such as "What you get", "How your box gets the apps" and "For developers", rather than bare labels like "Checks" or "Fixtures".
- **No inside references in public text.** No ADR or grilling numbers, no acceptance ids like S3.1, no session or planning names. If someone needs the background, link to a doc.
- **Leave out what a reader doesn't need.** A README says what something is, why it's there and how to use it. Edge cases belong in comments and code.
- Contractions, first person where it fits ("Tested on my Intel NUC"), and a bit of personality.
- No hype or corporate verbs (seamless, powerful, leverage, unlock, empower).
- Say "will" for anything that isn't built yet. In READMEs, mark planned features and repos "coming soon". Never write just "coming".
- Name a brand only when you need to. Say "a streaming service or a game" rather than a specific one.
- Don't list safety or approval steps in public copy unless Radomir asks for them.
- **Read it out loud.** If it sounds like a spec or a legal clause, rewrite it.

## Dev to user, then dev to dev

Radomir picked this over a manual-like tone (2026-11-03). Picture one indie dev telling someone about their project. First that's a person who'll use it, then another dev who wants to know how it works.

- **Start with the person using it.** What they get, and how to start ("To add one, open _Apps_ on the TV and pick it. That's it.").
- **Then how it works,** in a paragraph or two they can follow without knowing the code.
- **Then a "For developers" part** with the folders, commands and tests. Keep script names and pinned commits out of the parts above it.
- **Friendly headings that say something:** "What you get", "Your passwords stay yours", "How your box gets the apps", "What you won't find here".
- **Talk to them.** "Your box", "you sign in", "I". Short lines that land are fine: "Steam is just Steam." "That's it."
- **Plain bullets for lists of things.** A bold name at the start of an item is fine when the list is a set of named things, like apps. Not a bold lead-in on every point.
- **Commands in a code block, then a line on what they do.** Menu paths in italics, like _Settings > Look_.
- **Grounded, never salesy.** No hype, no promises about the future beyond "coming soon".

Omarchy's README is still the spirit (plain, confident, personal), but not its manual's formality. And never its em dashes.

The agentv-apps README is the reference: it's written exactly this way.

## Before and after

| Don't write | Write |
| --- | --- |
| AgenTV's official apps, one folder each, and the signed index a box installs them from. | The apps that come with AgenTV. If you run AgenTV, this is where the apps in _Apps_ on your TV come from. |
| How a box gets them | How your box gets the apps |
| The index is published as the `index` release here. | Every time an app changes here, CI builds a fresh list of apps, signs it with AgenTV's key, and puts it in this repo's `index` release. |
| Steam has nothing to record, so its checks are the contract's own and that it does nothing more. | Steam doesn't talk to a server, so there's nothing to record for it. Its tests just make sure it follows the rules and doesn't try anything else. |
| Each app's `fixtures/README.md` says what's in them. | Each app's `fixtures` folder has a short README about what's in it. |

## Commit messages and pull request titles

The same voice, kept short. Write them dev to dev.

- **The subject says what changed, in plain words,** as a short sentence in the imperative. Keep it to about 60 characters, and leave off the full stop.
- **The body says why,** in a sentence or two, plus anything a reviewer should know. Leave out a blow-by-blow of the diff.
- **No inside references in a public repo's subject or title:** no ADR or grilling numbers, and no acceptance ids. Put them in the body if a reviewer needs them. agentv-planning is private, so its commits may use them.
- **No em dashes,** and no AI attribution: no Co-Authored-By or session trailers, and no "Generated with" line in a pull request.

| Don't write | Write |
| --- | --- |
| S3.8 and S3.9: ask MET again when the tiles match neither forecast | Ask the weather service again when the tiles don't match |
| The router on the box: the key the router's alone, and a plan's CLI as the builder (S7.3, S7.4) | Run the voice router on the box, apart from the daemon |
| Update GitHub funding configuration | Add a Sponsor button that opens the Stripe page |

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
