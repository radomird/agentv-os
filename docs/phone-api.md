# The phone API

This is how a paired phone talks to an OrigaiTV box. The phone's page in `companion-web/` speaks it today. If you're writing another client, this is what you build against.

It's written from the code as it is. The TV's side is `daemon/phone-channel.ts`, `daemon/phones.ts`, `daemon/pin.ts` and the phone routes in `daemon/server.ts` and `daemon/routes/`. Game mode's is `daemon/pad-wire.ts`, `daemon/pads.ts` and `daemon/routes/pad.ts`. The phone's side is `companion-web/channel.ts`, and `daemon/phone-client.ts` is the same thing in Node for tests, with game mode.

There are test vectors in `test/origaitv/fixtures/phone-channel/vectors.json`: fixed keys, nonces and counters, and the exact bytes they give. The fast gate replays them through the daemon and through the phone's page, so a client that reproduces them agrees with both. See [Test vectors](#test-vectors).

## The shape of it

- The TV listens for phones on port 3001, on every interface, over plain HTTP. There's no TLS on the home network, so the phone protects what it sends itself.
- Pairing gives the phone a 32-byte key of its own. It never crosses the network: each side makes an X25519 pair, and the key comes from what the pairs share and from a secret the TV showed on its screen.
- After that the phone says hello to open a session, and both sides derive three session keys.
- Every request past that is signed with HMAC-SHA256. JSON bodies and JSON answers are sealed with ChaCha20-Poly1305. A photo or a video goes as it is, with its length signed.
- Sessions live in the daemon's memory. When the daemon restarts, the phone says hello again and carries on. It doesn't pair again.
- One thing isn't a request each time. [Game mode](#game-mode) is a WebSocket that a signed request opens, and each message on it is sealed with the session's keys.

Two conventions for the rest of this doc:

- Bytes in JSON and in headers are base64url with no padding (`A-Z a-z 0-9 - _`). The TV refuses a value with `=` in it, and one longer than 4096 characters.
- `a || b` means the bytes of `a` followed by the bytes of `b`, with nothing between. Text is UTF-8.

## Port, HTTP and the Origin rule

The port is 3001 unless the daemon was started with `ORIGAITV_LAN_PORT` set to something else. `off` turns the listener off.

The phone listener doesn't check the `Host` header, so the TV's address or its mDNS name both work.

For every method but `GET`: if the request has an `Origin` header, it has to be `http://` followed by the request's own `Host` header. Anything else gets a plain `403` with `{"ok":false,"error":"not from the phone companion's page"}`. A request with no `Origin` header passes, which is what a native app sends.

There are no CORS headers, so a page from anywhere else can't read an answer.

A few things on this port need no pairing: `GET /` (the phone's page), `GET /companion-web/...` and a few files under `/launcher/` (its code, styles and fonts), and `GET /api/theme.css` (the TV's theme colours as CSS).

## Pairing

### 1. The TV shows a code

The TV's own page starts a pairing. This is on the TV's port (3000, bound to `127.0.0.1`), so only the box itself can call it:

```
POST /api/phones/pair
```

It answers `{"ok":true,"pairing":{"code":"JHFRFW","until":"<ISO time>","url":"http://192.168.1.20:3001/"}}`. Once setup is done it needs an adult and the PIN grant, when a PIN is set. A phone never calls this. It's here because it's where the code comes from.

Each call makes two things, and replaces any pairing before it:

- A **code** of six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. There's no `0`, `O`, `1`, `I` or `L`, which look alike on a TV. The TV shows it as text.
- A **secret** of 16 random bytes. It's only ever in the QR code.

Both last 10 minutes and pair one phone. Five wrong tries end them, and the TV has to show a new code.

### 2. The QR code's address

`GET /api/phones/qr` on the TV's port draws the QR code. What it holds is:

```
http://<the TV's address>:<port>/#pair=<the secret, base64url>
```

The secret is after the `#`, so a browser that opens the address never sends it. A native app that scans the code reads the host and port from the address and the secret from `pair=`.

### 3. The typed code

Without a camera, the person types the six characters. The phone drops spaces and dashes and makes it upper case before using it. The TV doesn't do that for you: it compares against the code exactly as it shows it.

### 4. `POST /api/phone/pair`

Call `k` the thing the phone has: the secret's 16 bytes, or the code's six characters as ASCII bytes.

The phone makes an X25519 key pair for this pairing only, then sends plain JSON with `Content-Type: application/json`:

```json
{ "key": "<the phone's X25519 public key, 32 bytes>", "name": "Ana's iPhone", "proof": "<32 bytes>" }
```

```
proof = HMAC-SHA256(key: k, message: "origaitv pair v1" || phonePublic)
```

So the phone proves it has the secret or the code without sending either. `name` is what Settings shows for the phone. The TV strips control characters, trims it and keeps the first 30 characters, or calls it "a phone".

The TV checks the proof against both the secret and the code, makes its own X25519 pair, and answers:

```json
{
  "ok": true,
  "id": "p-6bc96675",
  "key": "<the TV's X25519 public key, 32 bytes>",
  "confirm": "<32 bytes>",
  "phone": { "id": "p-6bc96675", "name": "Ana's iPhone", "pairedAt": "2026-01-01T00:00:00.000Z" }
}
```

Both sides now work out the phone's key:

```
shared   = X25519(own private key, the other side's public key)
phoneKey = HKDF-SHA256(ikm: shared, salt: k, info: "origaitv phone key v1" || phonePublic || tvPublic, length: 32)
```

The phone then checks that the TV came to the same key:

```
confirm = HMAC-SHA256(key: phoneKey, message: "origaitv pair box v1" || phonePublic || tvPublic)
```

If `confirm` doesn't match, whoever answered didn't see the secret. Throw the key away and treat it as the TV not answering. If it matches, keep `id` and `phoneKey`. That's the whole pairing.

When it doesn't work, the answer is `403` with one of two sentences in `error`:

- `That isn't the code on your TV`: the proof matched neither, the key or the proof wasn't 32 bytes, or the body wasn't JSON. Each of these counts as a wrong try.
- `That code ran out. Pair again from your TV.`: there's no code on show, it's past its 10 minutes, or it's had its five wrong tries.

Neither answer is signed, since there's no key yet, so anyone on the network could write one. The phone's page matches those two sentences and shows its own words for anything else.

### 5. `POST /api/phone/hello`

A session's keys come from the phone's key and a fresh number from each side. The phone sends plain JSON:

```json
{ "id": "p-6bc96675", "nonce": "<16 random bytes>" }
```

The TV answers:

```json
{ "ok": true, "session": "<16 bytes, base64url>", "nonce": "<16 random bytes>", "proof": "<32 bytes>" }
```

Check the proof before you trust the answer. It says the TV holds this phone's key:

```
proof = HMAC-SHA256(key: phoneKey, message: "origaitv hello box v1" || phoneNonce || tvNonce)
```

Then derive 96 bytes and cut them in three:

```
keys = HKDF-SHA256(ikm: phoneKey, salt: phoneNonce || tvNonce, info: "origaitv session v1", length: 96)
sign = keys[0..32]    signs every request
up   = keys[32..64]   seals what the phone sends
down = keys[64..96]   seals what the TV answers
```

`session` is the text you send back in `X-OrigaiTV-Session`. Send it exactly as you got it.

A phone the TV doesn't know, or a nonce that isn't 16 bytes, gets `401` with `{"ok":false,"error":"This phone isn't paired. Pair it from your TV.","pair":true}`.

Nothing in a hello is secret, and a session is worth nothing without the key. A few limits:

- A session ends 24 hours after its last signed request.
- A phone has up to eight sessions. Past that, the TV drops one that never carried a signed request first, then the one used longest ago.
- Forgetting the phone in Settings ends all of its sessions.
- Sessions aren't written to disk, so a daemon restart ends them all.

## The channel

Everything under `/api/phone` except `pair` and `hello` goes through the channel.

### The headers

| Header | What it is |
| --- | --- |
| `X-OrigaiTV-Session` | The `session` from the hello. |
| `X-OrigaiTV-Counter` | A whole number in decimal, 1 or more, with no `0` in front, 15 digits at most. Start at 1 for a new session and add one for each request. |
| `X-OrigaiTV-Sig` | The signature, 32 bytes in base64url. |
| `X-OrigaiTV-Grant` | The PIN grant, when the request needs one. Leave the header out otherwise. |

### What's signed

```
sig = HMAC-SHA256(key: sign, message: method + "\n" + address + "\n" + counter + "\n" + grant + "\n" + digest)
```

- `method` is the HTTP method in capitals.
- `address` is the path and the query exactly as they go on the wire, so `/api/phone/state?since=7`. Sign what your HTTP library sends, after it has escaped anything. A browser turns `?credit=ana's día` into `?credit=ana%27s%20d%C3%ADa`, and the TV checks the signature against that.
- `counter` is the same text as the header.
- `grant` is the same text as the grant header, or empty when there's none. The line is still there.
- `digest` is one of three things:
  - for a sealed body, the SHA-256 of the sealed bytes as sent, in lower-case hex;
  - for an upload, `length:` and its `Content-Length`, so `length:32`;
  - with no body, the SHA-256 of nothing: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

The TV picks which by the request. `Content-Type: application/origaitv-sealed`, exactly that and nothing after it, means sealed. Otherwise a `Content-Length` other than `0` means an upload. Otherwise there's no body.

### The counter and its window

The TV remembers the newest counter it took in a session, and every counter it took within 128 of it. It takes a request only if its counter:

- is above `newest - 128`, and
- hasn't been taken before.

So requests don't have to arrive in order. The long poll and the taps on the remote overlap, and that's fine. But a counter never works twice, and one that's 128 or more behind the newest is too old. With 200 the newest, 72 is refused and 73 is taken.

A counter is used up once the signature checks out, even if the route then says no. A request that fails the signature doesn't use its counter.

### Sealed bodies

A JSON body always goes sealed. The TV refuses JSON that isn't.

```
Content-Type: application/origaitv-sealed
body = nonce (12 random bytes) || ciphertext || tag (16 bytes)
```

The cipher is ChaCha20-Poly1305 as in RFC 8439. The plaintext is the JSON text. The key and the extra data (the AAD) depend on the direction:

| | Key | Extra data |
| --- | --- | --- |
| The phone's request | `up` | `method + "\n" + address + "\n" + counter` |
| The TV's answer | `down` | `method + "\n" + address + "\n" + counter + "\n" + status` |

`method`, `address` and `counter` are the request's, the same text that was signed. `status` is the answer's HTTP status in decimal, so `200` or `403`.

That ties each answer to the one request it answers and to its own status. An answer can't be moved to another request, a `200` can't be turned into a `403`, and a request can't be played back as an answer, since the two directions use different keys.

A sealed request can be up to 64 KiB of JSON, plus the 28 bytes around it.

Every answer the TV writes as `application/json` to a signed request comes back sealed, with `Content-Type: application/origaitv-sealed`, whatever its status. That includes a `403`, a `404` and the PIN refusal. Anything else, such as a picture or a .zip, comes as it is with its own content type.

If the signature is right but the body won't open, the TV answers `400` with `{"ok":false,"error":"that request couldn't be opened"}`, sealed, and the counter is used up.

### Uploads

A photo or a video isn't sealed and isn't hashed. Hashing a few gigabytes on the phone first would mean reading the file twice. The signature covers its length in place of its hash:

```
digest = "length:" + Content-Length
```

Send the file's own `Content-Type` and a `Content-Length`. The TV refuses an upload that's chunked, that has no `Content-Length`, or whose content type starts with `application/json`.

What this buys: someone in the middle can't send an upload of their own, change where it goes, or send it twice. What it doesn't: they could swap the bytes for others of the same length, and they can see the picture. The answer to an upload is JSON, so it comes back sealed.

### The 401s that aren't sealed

When the TV can't check a request it answers `401` in plain JSON, since there may be no key to seal with. There are two, and the field that's `true` says which:

**`"pair": true`**: the TV doesn't know this phone.

```json
{ "ok": false, "error": "This phone isn't paired. Pair it from your TV.", "pair": true }
```

- The request has no `X-OrigaiTV-Session` header.
- The session's phone has been forgotten in Settings.
- A hello named a phone the TV doesn't know.

**`"session": true`**: say hello again.

```json
{ "ok": false, "error": "this phone has to say hello again", "session": true }
```

- The TV doesn't know the session: the daemon restarted, the session sat for a day, or it was dropped for a newer one.
- The counter isn't a number in the right form, was used before, or is behind the window.
- The signature doesn't fit.
- A body that isn't sealed came chunked, without a `Content-Length`, or as JSON.

Anyone on the network can write an unsealed answer, so be careful what you do with one. What the phone's page does, and what I'd copy:

- On either `401`, drop the session, say hello again, sign the request again with the new session and send it once more. If it fails a second time, give up on that request.
- Only the hello decides whether the phone is still paired. If the hello itself answers `401`, show "pair again".
- Never delete the phone's key because of an unsealed answer. Only a new pairing that worked replaces it.
- Take no other unsealed JSON, whatever its status. A `200` or a `403` that isn't sealed isn't the TV's.
- Take an unsealed non-JSON body only for a `GET` that asked for a file, with status `200`.

One more plain answer to know about: if a sealed body is bigger than the limit, or something breaks before the signature is checked, the TV answers a plain `500` with `{"ok":false,"error":"Something went wrong"}`.

## The PIN grant

Some routes are an adult's, and need the PIN once one is set. The flow:

1. Send the request. Without a good grant, the answer is `403`, sealed: `{"ok":false,"error":"That needs the PIN","pin":true}`.
2. Ask for the PIN on the phone and send it: `POST /api/phone/pin` with `{"pin":"1234"}`. Four digits, as text.
3. The answer is `200` with `{"ok":true,"grant":"<32 characters>","until":"<ISO time>"}`.
4. Send the first request again with `X-OrigaiTV-Grant` set to that grant. It needs a new counter and a new signature, and the grant is part of what's signed.

About grants:

- A grant lasts 5 minutes. Keep it and reuse it until `until`, or until a request answers `pin: true` again.
- It belongs to the phone that entered the PIN. Another phone can't use it, and neither can the TV's own pages.
- Locking the TV or removing the PIN ends every grant. Changing the PIN ends every grant but the one that changed it.
- With no PIN set, guarded routes just work, and `POST /api/phone/pin` answers `403` with `There's no PIN yet`.
- The right PIN also unlocks a locked TV.

A wrong PIN is `403` with `"ok": false` and a sentence in `error`, such as `Wrong PIN`. After five wrong tries in a row the answer also has `"wait": 30`, the seconds before the TV takes another try. Each wrong try after that doubles the wait, up to 15 minutes. Each phone has its own count, so one phone's wrong tries don't lock out another or the TV.

"State" below has `pin.set`, so a client knows up front whether a PIN exists.

## Who may call what

Three things decide it, and the tables below use these words:

- **Anyone**: any paired phone.
- **Adult**: the profile that's watching on the TV is an adult's. That's about who's on the TV, not about the phone. On a child's profile these answer `403` with a sentence in `error` and no `pin` field.
- **Grant**: needs the PIN grant once a PIN is set, as above.

"Adult + grant" needs both. "Grant on a child's profile" means an adult's profile passes without one.

Unless a row says otherwise, a body is sealed JSON and an answer is sealed JSON with `"ok": true`. When something's wrong the answer has `"ok": false` and a sentence in `error`. A status the table doesn't list means the obvious thing: `400` for a body that doesn't fit, `404` for something that isn't there. `503` with `Your TV isn't ready yet` means the TV's screen session isn't running to take the request. An address that isn't in these tables is a sealed `404`.

## Routes

### Pairing and the session

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/pair` | Plain JSON `{key, name, proof}` | Plain JSON `{ok, id, key, confirm, phone}`. `403` when it didn't work. | Anyone on the network with the code |
| `POST /api/phone/hello` | Plain JSON `{id, nonce}` | Plain JSON `{ok, session, nonce, proof}`. `401` with `pair`. | A paired phone |
| `POST /api/phone/pin` | `{pin}` | `{ok, grant, until}`. `403` with `error` and sometimes `wait`. | Anyone |

### State

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/state?since=<version>` | None | The state. See [The long poll](#the-long-poll). | Anyone |
| `GET /api/phone/features` | None | Every feature switch and whether it's on, such as `{"remote2":true,"askbuilds":true}`. There's no `ok` field. | Anyone |
| `GET /api/phone/box` | None | `{ok, line, box}`: what the box check found, as a line and in full. | Anyone |

### The remote

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/remote` | One of: `{key}`, `{hold, ms}`, `{text}`, `{move:[dx,dy]}`, `{click}`, `{scroll}`, `{wheel:[x,y], at}`. See below. | `{ok}`. `400`, `503`. | Anyone |
| `POST /api/phone/text` | `{value, caret}` on each change, or `{done:true}` for Enter | `{ok, by, why, value, kept}`, only the fields that apply. `503`. | Anyone |
| `POST /api/phone/playback` | `{action}`: `"toggle"` or `"next"` | `{ok:true, by}` where `by` is `"app"`, `"page"` or `"key"`, or `{ok:false, why}` with status `200`. `503`. | Anyone |
| `POST /api/phone/apps` | None | `{ok}`. Opens Apps on the TV. `503`. | Anyone |
| `POST /api/phone/settings` | None | `{ok}`. Opens Settings on the TV. | Adult |
| `POST /api/phone/viewer` | `{id}`: a profile's id | `{ok, viewer}`. `404`. | Anyone. Grant to switch from a child's profile to an adult's, or to a locked profile. |
| `POST /api/phone/sign-in` | `{username, password}`, up to 200 characters each | `{ok}`. `409` when nothing is signing in on the TV. `503`. | Anyone |

What `POST /api/phone/remote` takes, one per request:

- `{"key":"up"}`: a key press. The name is 1 to 12 characters of `a-z`, `0-9` and `-`.
- `{"hold":"enter","ms":1200}`: a held key. `ms` is kept between 100 and 3000, and is 1200 when left out.
- `{"text":"hello"}`: text to type, 1 to 500 characters.
- `{"move":[dx,dy]}`: a trackpad move. Whole numbers, each within 2000 either way.
- `{"click":"left"}`: or `"right"` or `"middle"`.
- `{"scroll":3}`: a whole number within 50 either way, not 0.
- `{"wheel":[x,y]}`: a two-finger scroll, right and down. Whole numbers within 4000, not both 0. Add `"at":"pointer"` to scroll under the pointer, not the middle of the page.

`POST /api/phone/text` keeps a field on the TV in step with one on the phone. `value` is the whole text, up to 500 characters, and `caret` is where the cursor is. Only the newest change waits to go: one that's overtaken is answered `{"ok":true}` straight away.

### Game mode

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/pad` | None. It's a WebSocket's opening request. | `101`, then the controller's messages. See [Game mode](#game-mode). `404` while the `phonepad` switch is off. | Anyone |

### Asking the TV

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/say` | `{sentence}` | `{ok, said}`. `409` while setup isn't done or the TV is locked. | Anyone |
| `POST /api/phone/say/pick` | `{n, choice}`: the sentence's number, and which of the choices | `{ok, said}`. `409` with why not. | Anyone |
| `POST /api/phone/say/live` | `{open:true}`, `{text}` with the words so far, or `{open:false}` | `{ok}`. `409` as for `say`. | Anyone |
| `POST /api/phone/say/dismiss` | `{n}` | `{ok}`, which is `false` when there was nothing to dismiss | Anyone |
| `GET /api/phone/ask` | None | `{ok, ask}`: what the Ask box is waiting on, or `null`. Always `null` on a child's profile. | Anyone |
| `POST /api/phone/ask/confirm` | `{n, model}`. `model` is optional. | `{ok, ask}`. `409` when it isn't waiting any more. | Adult |
| `POST /api/phone/ask/cancel` | `{n}` | `{ok, ask:null}`. `409`. | Adult |

`say/live` shows the words on the TV as they're dictated. The TV keeps none of them. The three `ask` routes answer `404` while the `askbuilds` switch is off.

### Home

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/home` | None | `{ok, viewer, appsTile, apps, layout, pinned, look}` | Anyone |
| `PUT /api/phone/layout` | `{layout, pinned}`. `pinned` is optional. | `{ok, layout, pinned}` | Grant on a child's profile |
| `PUT /api/phone/pinned` | `{pinned}`: app ids | `{ok, pinned}` | Grant on a child's profile |

`apps` is a list of `{id, name, category, sizes}`. `layout` is a list of tiles, each `{id, x, y, size}` with `size` one of `"s"`, `"m"` or `"l"`. `daemon/home.ts` and `launcher/layout.ts` have the rules a layout has to keep.

### Updates

These act on the update in the state's `update` field. It's `null` when there's nothing to install.

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/updates/tonight` | `{version}`: the `version` from the state's `update`, to install it tonight, or `null` to turn that off | `{ok, update}`. `400` with why not. | Grant, unless `version` is `null` |
| `POST /api/phone/updates/install` | None | `{ok}`. Starts the install now. `503`. | Grant |
| `POST /api/phone/updates/later` | None | `{ok, update}`. `404` when there's no update. | Anyone |

`update` in the answers is the same object as in the state, after the change. `later` also turns tonight's install off, and the state's `update.later` is `true` from then on.

### Sharing

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/share/link` | `{url}` | `{ok, share, waits}` | Anyone, unless a child is watching whose profile doesn't accept shares (`403`) |
| `POST /api/phone/share/photo?credit=<text>` | An upload: the photo, up to 15 MB | `{ok, share, waits}`. `413`. | The same |
| `POST /api/phone/share/video?name=<file name>` | An upload: the video, up to 4 GB | `{ok, share, waits}`. `413`. | The same |
| `POST /api/phone/background?credit=<text>` | An upload: a photo, up to 15 MB | `{ok, background}`. `413`. | Adult |

`waits` is `true` when something's playing, so the TV will ask about the share later. `credit` and `name` are optional.

### Setup

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/zone` | `{zone}`: the phone's time zone, such as `"Europe/Amsterdam"` | `{ok, zone}`. `409` once setup is done. | Anyone |
| `GET /api/phone/location` | None | `{ok, start, phoneZone, countries}` | Anyone |
| `GET /api/phone/zones?code=<country>` | None | `{ok, code, name, called, zones}` | Anyone |
| `PUT /api/phone/location` | `{code, zone}`. `zone` is optional. | `{ok, location}`, with `setup` when it finished the step, or `{ok, ask}` when the country has more than one time zone to pick from | Grant |
| `POST /api/phone/setup-music` | `{muted}`: `true` or `false` | `{ok, muted}`. `409` once setup is done. | Anyone |

### AI

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/terms` | `{provider, path}`. `path` is `"key"` or `"plan"`. | `{ok, accepted}` | Adult + grant |
| `POST /api/phone/key` | `{key}`: the provider's API key | `{ok, provider}`. `409` before the terms are accepted. | Adult + grant |
| `GET /api/phone/ai/icon/<provider>` | None | The provider's icon, as a picture, not sealed. `404` (sealed) when there's none. | Anyone |
| `GET /api/phone/ai/sign-in` | None | `{ok, signIn}`: how the plan's sign-in stands, or `null` | Anyone |
| `POST /api/phone/ai/sign-in/code` | `{code}`: the code the provider's page gave | `{ok}` | Grant |

### Builds and export

Every route under `/api/phone/builds` answers `403` on a child's profile.

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/builds` | None | `{ok, builds, settings, spend, warnings, wishes, themes}` | Adult |
| `GET /api/phone/builds/<build>/shot` | None | A PNG, not sealed. `404` (sealed) when there's no screenshot. | Adult |
| `POST /api/phone/builds/<build>/plan` | None | `{ok, build}`: approves a build's plan | Adult + grant |
| `POST /api/phone/builds/<build>/approve` | None | `{ok, build}`: approves the built app | Adult + grant |
| `POST /api/phone/builds/<build>/code` | `{code}`: the code a plan's sign-in page gave | `{ok, build}` | Adult + grant |
| `GET /api/phone/apps/<app id>/export` | None | A .zip, not sealed, with a `Content-Disposition`. `403` unless the TV is offering that app right now. | Adult |
| `POST /api/phone/apps/<app id>/push` | `{repo}`: a GitHub repo of the person's own | `{ok, url, pushed}`. `502` when the push failed. | Adult + grant |

Export only works for the app the TV is offering in the state's `export` field, and the .zip can be fetched once. `<app id>` starts with `local.`.

### What's on the network

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/discover?kinds=<a,b>` | None | `{ok, found, looking}`. Leave `kinds` out for every kind. | Anyone |
| `GET /api/phone/discover/shares?host=<name>` | None | `{ok, ...}` with the folders a NAS shares, or `404` with `ok:false` | Anyone |
| `POST /api/phone/discover/shares` | `{host, user, password}` | The same, for a NAS that lists its folders only for a user | Anyone |
| `POST /api/phone/discover/pick` | `{key}`: a row of the list the TV is showing | `{ok}`. `409` when the TV isn't showing a list. | Anyone |

`found` is a list of `{kind, name, url, host, via}`. The kinds are in `daemon/discover.ts`.

## The long poll

```
GET /api/phone/state?since=<version>
```

This is how the phone follows the TV. The state has a `version`. Send the last one you got as `since`:

- If `since` isn't the TV's current version, or you left it out, the answer comes at once.
- If it is, the answer waits until something changes, or 25 seconds go by. Then it comes with whatever the state is, which may be the same version.

So the loop is: ask, draw what came back, ask again with its `version`. What changes on the TV reaches the phone within a second. Give the request a timeout longer than 25 seconds.

A few things to know:

- `version` is only compared for being the same. It's a count that starts at 1 when the daemon starts and goes up on every change, so after a restart it can be lower than the one you hold. Don't compare with less-than.
- The waiting request has used its counter. Other requests go out with later counters while it waits, and that's what the window is for.
- The query is part of the signed address, so `?since=7` and `?since=8` each need their own signature.

### The state's fields

| Field | What it is |
| --- | --- |
| `ok` | `true`. |
| `version` | The count described above. |
| `phone` | This phone, as the TV knows it: `{id, name, pairedAt}`. |
| `features` | The two switches the remote draws by: `{remote2, askbuilds}`. |
| `ask` | What the Ask box is waiting on for an adult's OK, or `null`. Only there while `askbuilds` is on, and always `null` on a child's profile. `daemon/routes/ask.ts` has its shape. |
| `look` | The id of the look the TV is in, such as `"terminal"`, or `null` while the looks switch is off. |
| `viewer` | Who's watching: `{id, name, role, avatar, locked}`. `role` is `"adult"` or `"child"`. `locked` means the profile asks for the PIN to open. |
| `viewers` | Every profile, each in the same shape. |
| `pin` | `{set, locked}`: whether there's a PIN, and whether the TV is locked now. |
| `signIn` | `{name}` while an app's sign-in screen is up on the TV, for `POST /api/phone/sign-in`. Otherwise `null`. |
| `update` | An update that's ready or going in: `{version, installed, omarchy, notes, tonight, later, installing}`. `null` with nothing to install. |
| `tv` | What's on the TV. See below. |
| `nowPlaying` | `{title, app, left}` while something plays and the `remote2` switch is on. `left` is minutes, and may be missing. Otherwise `null`. |
| `setup` | While setup is on: `{step, part, n, of, muted}`. `n` and `of` may be missing. `null` once setup is done. |
| `ai` | What the AI step asks of the phone, or `null`. See below. |
| `discover` | The list of what's on the network that the TV is showing: `{kinds, machines}` or `{host}`. `null` with no list, or with the discover switch off. |
| `notices` | The last five notices from apps: `[{app, name, text, at}]`, newest first. |
| `builds` | The builds an adult follows: `[{build, id, name, provider, state, phase, done, steps}]`, with `signIn`, `ranOut` and `reason` when they apply. Empty on a child's profile. |
| `export` | An app the TV is offering to save a copy of: `{id, name, version, github}`. `github` is who the TV is signed in to GitHub as, or `null`. `null` with no offer, and on a child's profile. |
| `said` | The last sentence said to the TV and what came of it, for ten minutes: `{n, sentence, from, viewer, state, outcome, at}`. `state` is `"routing"` or `"done"`, and `outcome` is missing until it's done. Then `null`. |
| `controllers` | `{phones, most}`: how many phones are game controllers right now, and how many can be. Only there while `phonepad` is on. See [Game mode](#game-mode). |

`tv` has:

| Field | What it is |
| --- | --- |
| `view` | The page the remote should open on: `"trackpad"`, `"pin"`, `"keyboard"`, `"playback"` or `"remote"`. It's worked out from the fields below, in that order. |
| `pin` | The PIN pad on the TV, when it's up: `{title, for, digits, error}`. `digits` is how many are typed so far. Otherwise `null`. |
| `field` | The text field in front, or `null`. With `remote2` on it's `{kind, label, value}`, plus `app` and `name` for a field in an app. A password never has `value`. With `remote2` off it's `{kind}`, for home's own fields only. `kind` is `text`, `search`, `email`, `password`, `number` or `url`. |
| `screen` | `"home"`, `"menu"` or `"ambient"`. |
| `details` | `true` while the focus is on an app's tile, where a hold opens its details. |
| `front` | `"home"` or `"app"`. |
| `playing` | Whether something is playing. |
| `desktop` | `true` while the Omarchy desktop is on, where the remote is a trackpad. |
| `game` | The game in front, `{id, name}`, or `null`. Only there while `phonepad` is on. See [Game mode](#game-mode). |

`ai`, when it isn't `null`, is `{ask, provider, path, name, maker, plan, terms, summary, keyUrl}`. `ask` says what the phone should show: `"terms"` to accept with `POST /api/phone/terms`, `"key"` to paste with `POST /api/phone/key`, or `"sign-in"`, which adds `signIn: {url, code, pastes}` for the plan's sign-in.

`outcome` in `said` has a `kind` and a sentence in `say`. The kinds are `opened`, `choose`, `told`, `build`, `change` and `none`, and `daemon/executors/index.ts` has what each carries. For `choose`, `candidates` are what `POST /api/phone/say/pick` picks from.

## Game mode

A phone in game mode is a game controller. The TV makes it an input device that games see as an ordinary one: one stick, A, B, X and Y, two shoulders on each side, View, Menu and the guide button. A request for each press is too slow to play on, so game mode has the one thing in this API that isn't a request each time: a connection that stays open.

All of it is behind the `phonepad` switch, which is off for now. While it's off, `/api/phone/pad` answers like any address that isn't there, and the state has neither of the fields in [In the state](#in-the-state). `GET /api/phone/features` says whether it's on.

The phone's own page doesn't have game mode. This part is for an app.

### Opening it

```
GET /api/phone/pad
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <16 random bytes, in base64>
X-OrigaiTV-Session: <the session>
X-OrigaiTV-Counter: <the next counter>
X-OrigaiTV-Sig: <the signature>
```

It's a WebSocket's opening request (RFC 6455) with the channel's three headers on it. Sign it like any request with no body: the method is `GET`, the address is `/api/phone/pad`, the grant is empty and the digest is the SHA-256 of nothing. It uses up its counter like any other request. Keep that counter, since every message on the connection is tied to it.

A page in a browser can't put headers on a WebSocket, so no page can open one. If the request has an `Origin` header anyway, it has to be the phone's own page's, as for a `POST`.

What comes back:

| Status | What it means |
| --- | --- |
| `101` | The connection is open. Don't believe it yet: wait for the TV's first message. |
| `401`, plain | The same two as for any request, `pair` and `session`. Say hello again and open it again. |
| `403`, plain | The `Origin` isn't the phone's page. |
| `404`, sealed | The switch is off. |
| `409`, sealed | Four phones are controllers already: `{"ok":false,"error":"Four phones are playing already"}`. |
| `426`, sealed | The request didn't ask for a WebSocket. |
| `503`, sealed | `Your TV isn't ready yet`: nothing is there to make a controller, because the TV's screen session isn't running. Try again in a few seconds. |

Most WebSocket clients give you the status of a refusal and not its body. The status is enough to act on.

The TV makes the controller before it answers `101`, so a phone that's told yes has one. One phone has one controller. If the same phone opens game mode again, the new connection gets a controller of its own, and the old connection is closed with `4001` and its controller goes.

### Messages

Everything after the `101` is binary WebSocket messages, each one sealed and numbered:

```
message = n (8 bytes, big end first) || nonce (12 random bytes) || ciphertext || tag (16 bytes)
```

- `n` is the message's number. Each direction counts from 1 and adds one for each message.
- What follows it is ChaCha20-Poly1305, put together exactly as a sealed body is. The phone's messages use the session's `up` key and the TV's use `down`.
- The extra data is four lines:

```
"pad up" or "pad down" + "\n" + address + "\n" + counter + "\n" + n
```

`address` is `/api/phone/pad`. `counter` is the counter of the request that opened this connection, the same text as its header. `n` is the message's number in decimal. So the phone's first message on a connection that counter 201 opened has `pad up\n/api/phone/pad\n201\n1`.

A message is taken only if it opens, and only if its number is above the last one taken from that side. That's the counter's rule for requests without the window: on one connection nothing arrives out of order.

What that buys:

- A message can't be sent twice, since its number is used.
- It can't be moved to another connection or another session, since the extra data names the one request that opened this one, and each session has its own keys.
- It can't be turned around, since the two directions have their own key and their own first line.
- A request's body can't be passed off as a message, or a message as a body. No HTTP method has a space in it, so the two never have the same extra data.

#### What the phone sends

The controller's whole state, 6 bytes, big end first:

| Bytes | What it is |
| --- | --- |
| 0 and 1 | The buttons that are down, a bit each. A is bit 0, the lowest. Then B, X, Y, L1, R1, L2, R2, View and Menu, and Home is bit 10. The top five bits are 0. |
| 2 and 3 | The stick's x, signed. -32767 is all the way left and 32767 all the way right. |
| 4 and 5 | The stick's y, signed. -32767 is all the way up and 32767 all the way down. |

L1 and R1 are the shoulders in front, and L2 and R2 are the ones behind them. Home is the guide button. With A down and the stick at rest, the six bytes are `00 01 00 00 00 00`.

Send the state when it changes. It's always the whole state: not "A went down", but "A is down and the stick is here". While nothing changes, send it again at least every 2 seconds. A phone that sends nothing for 5 seconds loses its controller, and the same state again is how it says it's still there. It writes nothing to the controller.

Nothing else fits in a message. One that isn't exactly these 6 bytes is dropped, and so is one with a bit set that no button has, or -32768 for the stick. There's no way to send a key, text, or anything but a controller's state down this connection.

#### What the TV sends

9 bytes:

| Bytes | What it is |
| --- | --- |
| 0 | Which controller this phone is, 1 to 4. |
| 1 to 8 | The number of the newest message from the phone that the controller has taken, big end first. |

The first one comes as the connection opens, with 0 for the number. It's the TV saying the controller is there. Anyone on the network can write a `101`, so count game mode as open only once this message has opened with the session's `down` key.

After that there's one for each state the controller took, sent once the state has been written to the input device. That makes it a stopwatch. The time from sending message `n` to hearing that `n` was taken is the trip there and back, and the press reached the game in less than that.

#### What the TV drops

A message that doesn't open, a number that isn't above the last one, a text message, and a state that isn't one. The TV says nothing back, and the connection stays open. One exception: a message that opens and isn't a state has used its number up.

The TV puts up with 16 of those on one connection and closes it at the next. It also closes it when more than 500 messages come in one second, which isn't somebody playing.

#### The WebSocket itself

The TV speaks as little of it as game mode needs:

- A frame is whole and holds 125 bytes at most. A message is 42, so a client library does this without being asked.
- The phone's frames are masked, as the RFC says a client's are. No extensions, and no message split over frames.
- The TV answers a ping with a pong. A ping isn't the phone saying it's still there: only a state is.

Anything else ends the connection with `1002`.

### Closing it

Close the WebSocket and the controller is gone at once. The same goes for a connection that breaks.

When the TV closes it, the close frame's code says why:

| Code | Why |
| --- | --- |
| `1000` | The phone closed it. |
| `1001` | The TV is going away: it's stopping, or the switch was turned off. |
| `1002` | Something that isn't a WebSocket as above. |
| `4000` | Nothing came for 5 seconds. |
| `4001` | The same phone opened game mode again. |
| `4002` | The session ended, or the phone was forgotten in Settings. |
| `4003` | Too many messages that weren't a controller's, or far too many at once. |
| `4004` | The TV lost the controller. Open game mode again in a few seconds. |

A close frame isn't sealed, so someone who can write into the connection could send one. All it does is end game mode, which they could do by cutting the connection.

### What a game sees

One more controller, named "OrigaiTV phone controller". It has the layout and the ids of the wired controller nearly every game already knows, so Steam, an emulator and a browser's gamepad support all map it with nothing to set up.

- The stick is the left stick. Once it's half way out, its direction is the d-pad's too, so a game or a menu that only reads a d-pad still moves.
- L2 and R2 are that controller's triggers. The phone's are buttons, so they're all the way in or all the way out.
- Home held for a second goes home from a game. A short press is the game's own. That's the rule a real controller's guide button has.
- The right stick and the two stick clicks are there, because the layout has them, and they never move.

### In the state

Two fields, there only while the switch is on:

| Field | What it is |
| --- | --- |
| `tv.game` | The game in front: `{id, name}`, the app's id and its name. `null` when what's in front isn't a game. What makes an app a game is its category. |
| `controllers` | `{phones, most}`: how many phones are controllers right now, and how many can be, which is 4. A real controller plugged into the TV isn't counted. |

Both change the state's `version`, so the long poll hears a game coming in front and a controller coming or going.

## Test vectors

`test/origaitv/fixtures/phone-channel/vectors.json` has one run of everything above with fixed values:

- `pairings`: one by the QR code's secret and one by a typed code. Each has the TV's code and secret, both X25519 pairs, `k`, the request and the answer as they go on the wire, the shared X25519 value, and `phoneKey`. The TV's part is under `tv`, with the QR code's secret as `tv.secret`.
- `session.hello`: the request, both nonces and the answer. `session.derived` has `sign`, `up` and `down`.
- `session.requests`: six requests the TV takes, counters 1 to 6. A sealed `POST`, a `GET` with a query, the PIN, a request with a grant, an upload with an address the wire escapes, and a `403` that comes back sealed. Each has the nonce, the extra data, the digest, the signed text, the headers and the body, and the answer's nonce, extra data and sealed bytes.
- `session.refused`: requests the TV refuses, with the plain `401` each gets. A replayed counter, a body changed on the way, JSON that isn't sealed, a counter of 0. One of them has a good signature over a body with a bad tag, which gets the sealed `400`.
- `session.window`: counters 200, 72 and 73, for the edge of the window.
- `session.answersToRefuse`: answers to the first request that a phone has to refuse. A bad tag, the wrong status, another request's answer, the phone's own request played back, and two that aren't sealed.
- `session.pad`: game mode. `open` is the request that opens the connection, with its headers and the `101`. `up` is two states from the phone and `down` the TV's messages, each with its number, its plain bytes, its nonce, its extra data and the whole message. `dropped` is what the TV drops after those two: a replay, a used number, a state that isn't sealed, one sealed by another session (`otherSession` has its key), one for another connection, one with the wrong key, a changed tag, and one that opens and isn't a state. `after` is the next message it takes. `downToRefuse` is what a phone has to drop.

The file says which fields are plain text. Everything else is base64url.

To check a client against it, feed it the file's "random" values in place of its own: the phone's X25519 private key, the hello's nonce and each request's nonce. It should produce the file's requests byte for byte, and open the file's answers.

The file is made by `make-vectors.mts` next to it, which uses only Node's crypto and none of the daemon's channel code:

```bash
node test/origaitv/fixtures/phone-channel/make-vectors.mts
```

`test/origaitv/unit/phone-channel-vectors.test.mts` replays it, and fails if the file isn't what the script makes. `test/origaitv/unit/phonepad-vectors.test.mts` replays game mode's part, through the TV's side and the phone's.
