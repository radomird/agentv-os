# Desk

This is a stand-in web app made for a desktop, for testing the phone's d-pad (`daemon/remote-page.ts`). It's made up, and it loads nothing from anywhere.

Its contract tests press the d-pad in its pages. The UI test `remote-page.test.mts` uses the same pages.

- `desktop.html` has links along the top, a row of tiles that scrolls sideways, a search field and a dialog. Like many streaming sites, it hides every focus outline and doesn't touch the arrow keys.
- `next.html` is the page its links open, so Back has somewhere to go.
- `own-keys.html` moves its own highlight with the arrows, like an app made for a TV, and calls preventDefault on them.
