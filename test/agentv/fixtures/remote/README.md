# The phone remote's stand-in pages

Hand-made pages that act like a streaming site's, for the phone remote's checks in `test/agentv/ui/`. They're not copies of any real site.

- `stream.html` has a search field that keeps its own state the way a web framework does, so it only takes typing it hears about. It also has a sign-in form inside a shadow root, and a name field inside a frame (`frame.html`).
