# AgenTV's app kit

A page app is its own HTML, CSS and JavaScript. AgenTV serves it from an origin of its own and shows it full screen (1920 x 1080) in a sandboxed frame on the TV. It reaches the box only through `window.agentv`, which `/_agentv/kit.js` sets. Load that first:

```html
<script src="/_agentv/kit.js"></script>
<script src="main.js"></script>
```

## What the frame allows

- Scripts, a canvas, WebGL, Web Audio and `<audio>`, all from the app's own files.
- No inline scripts or `onclick=` attributes, no `eval()` or `new Function()`, and no scripts from other sites: put code in `.js` files in the app.
- No cookies, `localStorage` or IndexedDB: keep things with `agentv.storage`.
- Requests only to the origins in the manifest's `tv.origins`, and to the app's own files. Anything else is refused.
- The app's files are up to 10 MB each and 25 MB in all.

## Starting

- `agentv.ready()`: call it once the first frame is drawn. The TV shows a cover until then.
- `agentv.exit()`: leave the app and go back to home.
- `agentv.viewer()`: who's watching, `{ id, name, role }`, with role `adult` or `child`.

## Input

```js
agentv.input.on((event) => {
  // event.button: "up", "down", "left", "right", "ok", "play",
  //   and from a gamepad also "x", "y", "lb", "rb", "lt", "rt", "start", "view"
  // event.down: true when pressed, false when let go
  // event.source: "remote" or "gamepad"; event.pad: which gamepad, for two players
});
```

There are no key repeats: keep each button's pressed state yourself. A gamepad's d-pad and left stick are directions, A is ok, B is Back. The phone's remote sends the same as the remote. Home is never sent: it always goes home.

## Back, Home's pause

```js
agentv.onBack(() => {
  if (photoOpen) { closePhoto(); return true; } // kept: the app handles it
  return false;                                 // anything else: the TV leaves the app
});
agentv.onPause(() => pauseTheGame());  // Home was pressed; the app waits behind home
agentv.onResume(() => {});             // it's back in front
```

Without an `onBack`, or with no answer within 300 ms, Back leaves the app. Holding Back always goes home.

## Storage

```js
await agentv.storage.set("best", [12400, 9800]);
const best = (await agentv.storage.get("best")) ?? [];
await agentv.storage.remove("best");
const keys = await agentv.storage.keys();
```

Values are anything JSON. An app keeps up to 5 MB in all, and it stays across new versions of the app.

## The box's photos and music (declared)

With `"media": ["photos"]` in the manifest's `tv` block:

```js
const sources = await agentv.photos.sources();       // [{ id, name, kind: "folder" | "usb" | "share" }]
const page = await agentv.photos.list(sources[0].id, { folder: "", offset: 0, limit: 60 });
// page: { folders: ["2024", ...], photos: [{ id, name, folder, modified }], total }
img.src = await agentv.photos.url(page.photos[0].id, { width: 400 }); // a blob: address
```

Ask for a photo at the width it's shown: 400 or so in a grid, 1920 full screen. With `"media": ["music"]`: `agentv.music.albums()` gives `[{ id, title, artist, tracks: [{ id, title, artist, seconds }] }]`, and `agentv.music.url(trackId)` a blob: address for `<audio>`. Both are read-only.

## A tile on home (declared)

With `"tile"` in `tv.capabilities` and the sizes in `tv.tiles` (`{ "s": "logo", "m": "best score" }`):

```js
await agentv.tile.set({ headline: { label: "best", value: "12,400" }, entries: [{ label: "yesterday", value: "9,800" }] });
```

The tile keeps showing what was set last, also when the app is closed.

## A notice (declared)

With `"notices": true`: `await agentv.notify("the timer is done")` shows a short line on the TV and the phone, at most once a minute.

## The manifest

`app/manifest.json`. The builder sets its id, name, version and author, and keeps what it reaches inside the recipe's bounds. You fill in `description`, `tv.category`, `tv.capabilities` (`"launch"`, and `"tile"` for a tile), `tv.tiles`, `tv.origins`, `tv.media`, `tv.notices` and `tv.childSafe`.
