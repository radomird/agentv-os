# Desk

A stand-in web app made for a desktop, for the phone's d-pad (ADR-008, `daemon/remote-page.ts`). It's made up and loads nothing from anywhere. Layer 3 runs its contract checks, which press the d-pad in its pages, and layer 4's `remote-page.test.mts` uses the same pages.

- `desktop.html` has links along the top, a row of tiles that scrolls sideways, a search field and a dialog. It hides every focus outline and doesn't touch the arrow keys, like many streaming sites.
- `next.html` is the page its links open, so Back has somewhere to go.
- `own-keys.html` moves its own highlight with the arrows, like an app made for a TV, and calls preventDefault on them.
