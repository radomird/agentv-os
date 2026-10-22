---
name: agentv-visual-verification
description: Use before finishing any AgenTV change people can see or hear, in the TV launcher, the setup screens, the phone companion, motion or sounds. Builds on Omarchy's visual-verification guide and checks against the canvas and the look ADRs.
paths:
  - "launcher/**"
  - "setup/**"
  - "companion-web/**"
---

# AgenTV visual verification

Read Omarchy's `agents/skills/visual-verification.md` first. Its rule holds: a visual change isn't done until you've looked at it running, and an artifact alone doesn't count. For anything on the Omarchy desktop, use its own screenshot and screen-recording commands.

## Where to look

- **On the Mac:** run the launcher, setup and phone companion against the fake platform, and open them at **1920 × 1080** for the TV and **390 × 844** for the phone. Use the browser pane, and screenshot both sizes.
- **On the NUC:** `omarchy capture screenshot fullscreen save` for stills, and `omarchy screenrecord --fullscreen` for motion. Keep recordings short.
- **The reference** is the signed-off canvas, https://claude.ai/artifact/47VM3kaH673gfwGzQuzqK6, page "Terminal · full flow". Its exported images go in `test/agentv/reference/`. Compare against the matching board, not from memory.

## What to check

- **The Terminal look (ADR-014):**
  - JetBrains Mono and colours from the active Omarchy theme, never hard-coded;
  - one headline and at most one line of text per screen;
  - body text at least 28 px, a clear focus ring, a 5% safe area;
  - real posters and stills for films and episodes, pixel art for everything else.
- **Tiles (ADR-015, 016, 018):**
  - only the sizes the app's manifest lists;
  - logo, name and state only, with no "official" or other tier label;
  - the maker shows in app details.
- **Motion (ADR-024):**
  - only transform and opacity animate;
  - the tokens are fast 120 ms, base 200 ms and slow 320 ms, with `cubic-bezier(0.2, 0.8, 0.2, 1)`;
  - focus glides, hover lifts to 1.03, press squeezes to 0.97, and pages slide 24 px;
  - check it again with reduce motion on: everything should become a plain fade.
  - On the NUC, record it and look for dropped frames (S2.10).
- **Sound (ADR-024):**
  - each of the seven sounds plays on its action, at its level;
  - move plays at most once every 60 ms;
  - the Settings switch silences them all (S2.11).
- **Copy:** Omarchy's voice, "coming soon" for planned things, and no em dashes. Run the `agentv-copy` checks on any text you added.

## Finish

Say which boards you compared against and what differed, attach or name the screenshots, and update the reference image only when the change was intended.
