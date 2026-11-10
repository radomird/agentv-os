---
name: agentv-copy
description: Use when writing or editing any AgenTV text people read or hear, such as UI strings on the TV, the phone or the USB stick, spoken answers, setup screens, READMEs, docs, repo descriptions or commit messages. Sets the two voices (what someone on the couch reads, and an indie dev talking about their project), the never-say list, the glossary, the capitals rule, the no-em-dash rule and AgenTV's naming.
---

# AgenTV copy

AgenTV has two voices, and which one you write in depends on who reads it.

- **On the TV, the phone and the USB stick,** and in anything the TV says aloud, write for the person on the couch. Say what they get or do, not how the TV works.
- **In READMEs, docs, commit messages and pull requests,** write like an indie dev talking about their own project: first to the person who'll use it, then to another dev. Omarchy's README is the spirit to match: plain, confident and personal, with a bit of fun.

Both are straightforward, grounded and easy to read the first time through. Neither uses an em dash, ever.

## What people read on the TV, the phone and the USB stick

Radomir's direction (2026-11-10): the words are user centric and down to earth. A label like "agent builds" should read "build your own". The full page is `D8-VOICE.md` in the planning repo, and `COPY-SHEET.md` there has every string, before and after.

### The twelve rules

1. **Say what you get or do, not how it works.** "Build your own", not "agent builds". "Couldn't open Music", not "the daemon didn't answer". If a word names a part of the system, it's the wrong word.
2. **Two people in the room: you and your TV.** It's "your TV", "your phone", "your apps". Nobody else speaks: no "your agent", no "the builder", no "the box", no "the system". On screen the TV has no "I". Aloud it may say "I" ("I couldn't find that").
3. **One headline, at most one line under it.** The headline is the thing to do or the question to answer: "Pick your apps", "Who's watching?". If the line needs a second sentence, cut the first one.
4. **Buttons are a verb, one to three words.** "Add", "Install now", "Try again", "Not now". No key names or arrows in the words ("↵", "esc", "del", "→"). The look draws those if it wants them.
5. **Sentence case, with real names.** AgenTV, Omarchy, Wi-Fi, PIN, TV, AI, 4K, TMDB, MET Norway, GitHub. No title case.
6. **Full stops only between two sentences.** No full stop on a headline, a label, a button, a tile or a one-sentence notice. Three dots ("Installing…") only while something is happening right now.
7. **One verb per job.** Make (an app, a game, a theme). Add (an app that exists). Remove (never "take off", "forget", "unpin" or "is gone"). Save (never "keep" or "is kept"). Change. Sign in. Send (from the phone to the TV). "Build your own" is the one label that starts making an app, and "make" is the verb everywhere after it.
8. **An error says what didn't happen, then what to do, in one line.** "Couldn't open that folder. Check the password." Never the cause in system words, never a raw reason ("exit 1", "PUT /api/key failed"), never "that didn't work" on its own, never blame ("you typed").
9. **An empty screen says what goes here.** "No music yet. Add a folder or a drive." Not "nothing yet".
10. **Waiting says what's happening and that you can leave.** "Making Blocks. You can keep watching." Give a time only when the code knows one.
11. **Numbers, money and places are plain.** Digits always. "$5", "4K", "1080p", "5 GB", "about 3 minutes", "2 of 5". Versions only in Updates and About. A place in Settings is written "in Settings, under AI", never "settings → ai".
12. **Aloud, the TV answers like a person on the sofa.** The answer comes first ("Yes, a new episode came out on Friday"). Short sentences, no colons, no arrows, no names of the plumbing. If it would sound odd read out by a friend, rewrite it.

### Less text, always

These are Radomir's notes on the rules, and they win where the two differ.

- **The shorter line wins.** One thing to do, one headline, and as little under it as the screen can carry. If your new line is longer than the one it replaces, cut it or keep the old words. A few characters more for a real name ("Wi-Fi") or a glossary word is fine.
- **Friendly before short.** The shorter line wins only when it's as kind. "What do you want?" reads as a demand, so Ask says "What would you like?". A question to the person never sounds like an order.
- **Never "type here".** The phone is what types. Where a screen wants words from someone, show an example of what to ask, in the field itself, and no line of instructions.
- **A suggestion is a whole thing you could say.** "Continue my show" and "What's new this week?", not "Continue" and "What's new".
- **A tile that adds something has a "+" for its icon,** where an app has its logo. The plus is never in the words.
- **Nothing is explained twice.** In Settings a row is one line: its name, then its value. A line of text shows only on the page a row opens.
- **One way in.** Two labels for nearly the same thing never sit on one screen. Apps has one way to more apps, the app library, and "Can't find it? Build your own" is the last thing in it.
- **It's "location",** never "country" or "region": "Pick your location", "Another location", "Change location".
- **"Screen saver"** is the pictures the TV shows when it's idle. It's never "ambient screen".

### Never say

To someone on the couch, AgenTV never says: agent, builder, a build, recipe, provider, daemon, box, session, edge, stable channel, nightly run, tier, contract, capability, adapter, index, router, relay, sandbox, safeguards, cap, origin, manifest, package, snapshot, migration, mount, share (for a network folder), source (for where music is), ambient, the system, root, country, region.

What stays, because it's someone else's word or a name: "API key" and "plan" (the AI companies' own terms), their plan names and terms, "Powered by Omarchy", "Omarchy's desktop", the TMDB, JustWatch and MET Norway credits, trademark notices, and GitHub.

### The glossary

| System word | What a person reads |
| --- | --- |
| your agent, your TV's agent, the agent | Dropped. The sentence is about you or your TV: "It's made in the background", "You approve it on your phone" |
| your agent's builds | Your own |
| agent builds, make one, add your own | Build your own |
| made by your agent | Made on this TV (details), Your own app (phone), "made by you" (themes) |
| a build, builds (the noun) | your app, a new app. "Building" only as a verb |
| build it, building X, couldn't build X | Make it, Making X, Couldn't make X |
| recipe, "no recipe fits" | Dropped. "A game", or "This one's new, so you check the steps first" |
| a plan for X (what will be made) | The steps for X |
| plan (an AI subscription) | Stays, with its name: "your Claude plan" |
| provider | Its name (Claude, ChatGPT), or "your AI" |
| key, api key | API key the first time, then "key" |
| the box, this box | your TV, this TV, or no noun at all ("Restart?") |
| your box (setup's step, and its "box" row) | Your setup (the step), Computer (the row) |
| the daemon, the TV session | AgenTV, or "your TV": "Your TV isn't ready yet" |
| the router, "the provider didn't answer" | "Can't answer right now" |
| edge | Early updates |
| the nightly run, tonight's tests | "still being tested", "tested before it reaches you" |
| snapshot | backup |
| migrations | Finishing up |
| packages (an update's) | Installing, system updates |
| tier: official, community, local | From AgenTV, From the community, Made on this TV |
| the app contract's checks | "This app is broken, so it's hidden" |
| can reach, reaches, origins | Connects to. "Nothing online" when it's none |
| app index | the app list: "Couldn't load the apps" |
| usage | Spending |
| a build may spend, a month may spend, cap | Limit per app, Limit per month, "never more than $5" |
| npm safeguards | Extra safety checks |
| packages (an app's) | Uses: (then the names) |
| its checks passed, the test TV | Tested and working. "It didn't pass the safety checks" |
| ambient screen | Screen saver |
| sources (music) | Your music (the page), Add music (the button) |
| share, mount (a network folder) | network folder, Connecting…, "Couldn't open that folder" |
| nas | network drive, or just "drive" |
| shared, a share (from a phone) | From your phones, "Sent from Ana's phone" |
| pin, unpin (a tile) | Add to home, Remove from home. "PIN" is only the adult PIN |
| take X off, forget, is gone | Remove, Removed |
| is kept, keep it, kept for later | Saved, Save, Saved for later |
| didn't set, didn't take it, didn't mount | Couldn't (verb) (thing) |
| that didn't work, it stopped | Something went wrong, or the thing that didn't happen |
| isn't here (a feature that's off) | isn't available |
| ui sounds | Menu sounds |
| ethernet | cable |
| wifi | Wi-Fi |
| country, region | location |
| services | apps |
| what's new (new titles) | New this week. "What's new" stays for an update's notes |
| look, colours, theme | Look (Terminal, Glass, Cinema), Theme (the colours) |
| themes and backgrounds | Appearance |
| export | Save a copy |
| sudo and ssh | admin tasks |
| a step's id (design, api, packages, tests) | Its label: Designing, Connecting, Adding parts, Testing |

### Capitals

Write the source in sentence case with real names. The words are the same in every look, and only the case differs:

- **Terminal** shows them in lower case, as part of its look. It lowers them in CSS. Never write a string in lower case for Terminal's sake.
- **Glass and Cinema** show them as written.
- **The phone** is sentence case. It isn't a look.
- **Setup** follows the look that's picked.
- **The USB stick's console** stays lower case, since it is a terminal.

A line Terminal draws over a headline ("tv apps add") is decoration. It never carries meaning the headline lacks.

### Before and after, on screen

| Don't write | Write |
| --- | --- |
| your agent's builds | Your own |
| + add your own | Can't find it? Build your own |
| what should i make? | What do you want to build? |
| what do you want? | What would you like? |
| type here, or on your phone. | (an example in the field: "make me a puzzle game") |
| continue | Continue my show |
| pick the country. | Pick your location |
| restart the box? | Restart? |
| ambient screen | Screen saver |
| a build may spend | Limit per app |
| on edge: every green build | Early updates: less tested |
| nothing yet | Nothing on home yet |
| that share didn't mount | Couldn't open that folder |
| PUT /api/key failed | Couldn't save the key |
| the agent stopped (exit 1) | Something went wrong |
| that's not the pin. 2 more tries before a wait | Wrong PIN. 2 tries left. |
| your agent built it, and its checks passed. approve it on your phone, with the pin, to put it on your home. | Tested and ready. Approve on your phone to add it to home. |
| ↵ install now | Install now |
| no: you've seen the newest episode (aloud) | No, you've seen the newest episode |

## READMEs and docs

Write the way you'd explain it to a friend who codes, over coffee. A README may still say "your box" where it means the computer. On screen it never does.

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
- **Streaming services** are named only inside `agentv-apps`, in words and in pictures. Everywhere else say "six streaming apps" and link to the list.
- **Credit:** public taglines and repo descriptions say "Powered by Omarchy". The current tagline is "The world's first open-source agentic TV OS. Powered by Omarchy."
- **Fork READMEs** live in `.github/README.md`, which GitHub shows ahead of Omarchy's own `README.md`. Never edit Omarchy's.

## Process

For anything public (READMEs, release notes, store text), run the `ai-de-slopifier` skill:
1. a fact guard against `PHASE-1-PLAN.md` and the ADRs;
2. two passes;
3. a score of at least 85.

Then read it once more against the Voice list above, sentence by sentence.

For UI strings and spoken answers, follow "What people read on the TV, the phone and the USB stick" above: one headline, at most one line of text, and no word from the never-say list. Then check the new line isn't longer than the one it replaces.
