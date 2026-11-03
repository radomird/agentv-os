# A streaming service's app

A streaming app is a TypeScript module the TV's daemon loads in a worker of its own, with one page of the service's site in the TV's browser, on the app's declared origins only. It exports a `TvApp`; `@contract/contract.ts` has every type.

- `launch(ctx)` opens the service's home address in `ctx.page`.
- `signIn.isSignedIn(ctx)` tells from the page whether it's signed in. False puts "Sign in" on the tile, and AgenTV's sign-in screen opens over the service's own page, where the household signs in with the phone's password manager. AgenTV never stores a password.
- `signIn.open(ctx)` brings the page to the service's sign-in form.
- `search(ctx, query)` finds titles with the site's own search: `[{ id, kind, title, season, episode, poster }]`.
- `playback.open(ctx, item)` starts an item and resolves once it plays. It may use the site's search, never its continue watching row.
- `playback.readPlaybackState(ctx)` reads the title, season and episode from the address and the page, and the position, duration and playing from the `<video>` element. Never from pixels. Null when nothing plays.
- `playback.next(ctx)` uses the site's own next episode control.
- `profiles.list(ctx)` and `profiles.select(ctx, name)`: the service's own profiles, so a child lands on the profile for children.

`ctx.page` has what an app needs of a browser page: `url`, `title`, `goto`, `evaluate`, `waitForSelector`, `click`, `fill` and `press`. It answers only while the page is on the app's origins. Every read has a timeout and fails with a message, never a retry loop.

The app's checks are in `fixtures/contract.json`: the saved pages each address answers with (`routes`), and the calls with what they should give back (`checks`):

```json
{
  "routes": [{ "url": "https://service.example/browse", "file": "pages/browse.html" }],
  "checks": [
    { "name": "it says it's signed in", "page": "https://service.example/browse", "call": "signIn.isSignedIn", "expect": true },
    { "name": "search finds a known title", "call": "search", "args": ["a word"], "expect": [{ "title": "A Title" }] }
  ]
}
```

`look` keeps a page it opened as a fixture when you give it `save`, like `fixtures/pages/home.html`: the page as it was, without its scripts, styles or images, so a check reads it with nothing else to fetch. `contract_tests` runs every check in a worker, with every request answered from the saved pages, so nothing signs in. Saved pages never hold a password or a session.
