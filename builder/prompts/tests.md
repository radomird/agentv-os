# Tests for a page app

Tests are `.js` files in `tests/`. `run_tests` runs each one in the app's own frame, after the app has started, on a test TV that plays the remote, a gamepad and Back, and holds the app's storage. The recipe's own tests run beside yours. A photo app's test TV has one source with a few photos in two folders.

```js
test("ok drops the piece to the floor", async (t) => {
  await t.press("ok");
  await t.frames(5);
  t.ok(document.querySelector("#score").textContent !== "", "the score shows");
});
```

What `t` has:

- `await t.press(button, { source: "remote" | "gamepad", pad })`: pressed, then let go.
- `await t.down(button, options)` and `await t.up(button, options)`: hold and let go.
- `await t.back()`: Back, as the TV offers it. True when the app kept it.
- `await t.wait(ms)` and `await t.frames(n)`.
- `t.storage()`: what the app keeps, as a plain object.
- `t.tile()`: what it last set on its tile, or null.
- `t.listening()`: `{ input, back, pause }`, how many listeners it has given the kit.
- `t.ready()`: whether it called `agentv.ready()`.
- `t.left()`: whether it has left (Back not kept, or `agentv.exit()`).
- `t.calls(name, filter)`: how many times it made one of the kit's calls, like `"photos.image"`, with an optional filter on its arguments.
- `t.requests()`: what it asked the network for, each `{ url, declared }`.
- `t.errors()`: what it threw, as messages.
- `t.ok(value, message)` and `t.equal(actual, expected, message)`.

The page itself is right there: read the DOM, the canvas or your own globals.
