# The phone API

This is how a paired phone talks to an OrigaiTV box. The phone's page in `companion-web/` speaks it today. If you're writing another client, this is what you build against.

It's written from the code as it is. The TV's side is `daemon/phone-channel.ts`, `daemon/phones.ts`, `daemon/pin.ts` and the phone routes in `daemon/server.ts` and `daemon/routes/`. How the TV says it's there is `daemon/announce.ts` and `bin/origaitv-announce-set`. Game mode's is `daemon/pad-wire.ts`, `daemon/pads.ts` and `daemon/routes/pad.ts`. The phone's side is `companion-web/channel.ts`, and `daemon/phone-client.ts` is the same thing in Node for tests, with game mode.

There are test vectors in `test/origaitv/fixtures/phone-channel/vectors.json`: fixed keys, nonces and counters, and the exact bytes they give. The fast gate replays them through the daemon and through the phone's page, so a client that reproduces them agrees with both. See [Test vectors](#test-vectors).

## The shape of it

- The TV listens for phones on port 3001, on every interface, over plain HTTP. There's no TLS on the home network, so the phone protects what it sends itself.
- Pairing gives the phone a 32-byte key of its own. It never crosses the network: each side makes an X25519 pair, and the key comes from what the pairs share and from a secret the TV showed on its screen.
- After that the phone says hello to open a session, and both sides derive three session keys.
- Every request past that is signed with HMAC-SHA256. JSON bodies and JSON answers are sealed with ChaCha20-Poly1305. A photo or a video goes as it is, with its length signed.
- Sessions live in the daemon's memory. When the daemon restarts, the phone says hello again and carries on. It doesn't pair again.
- With the `announce` switch on, the TV also says it's there over mDNS, so a phone finds it again when the router gives it a new address. See [Finding the TV](#finding-the-tv).
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

## Finding the TV

The QR code holds the TV's address as it was on the day the phone paired. Routers hand out new addresses, and then that one is wrong. So the TV announces itself on the home network, and a phone looks for it by an id that doesn't change.

This is behind the `announce` switch, which is off for now. While it's off the TV announces nothing, and nothing in this section is in any answer. `GET /api/phone/features` says whether it's on.

### The record

The TV publishes one DNS-SD service over mDNS, through Avahi:

| | |
| --- | --- |
| Type | `_origaitv._tcp`, in `local` |
| Name | The TV's name: `OrigaiTV` until somebody names it, then whatever they typed, such as `Living room`. See [The TV's name](#the-tvs-name). |
| Port | The phones' port, 3001 |
| TXT `id` | The box id: 32 lower-case hex digits |
| TXT `version` | The OrigaiTV version that's installed, such as `1.0.0` or `1.0.0.r12.gabc1234` |

That's all of it. The record is on IPv4 only, because the phones' port answers on IPv4.

To see it from a Mac or from Linux:

```bash
dns-sd -B _origaitv._tcp
avahi-browse --resolve --terminate _origaitv._tcp
```

Anyone on the network can read the record, paired or not. So it has nothing in it that I'd mind a guest on the Wi-Fi reading: a name, a version and a random id. It also proves nothing. Anyone on the network can publish a record with your TV's id in it. What proves a TV is yours is the hello: only the TV you paired with can answer it with the right `proof`. So find the address by the id, say hello there, and if the proof is wrong, it isn't your TV.

### The TV's name

A TV has a name of its own, apart from the machine's name. The machine stays `origaitv` on every TV, so `origaitv.local` and SSH don't move when someone names their TV.

- It's `OrigaiTV` until somebody names it.
- It's 1 to 30 characters, and at most 63 bytes as UTF-8, which is as long as a name on the network can be. Spaces, accents and emoji are fine.
- It's the record's name, as it was typed. Nothing in it is filled in, so a name with `%h` in it stays `%h`.
- `GET /api/phone/state` has it as `boxName`, sealed, while the switch is on. Show that one once you're paired. The record's name is for a list of TVs nobody has paired with yet, and anyone on the network can publish one.
- Nothing stops two TVs having the same name. Both say it in their state, and Avahi announces the second as `Living room #2`. Tell TVs apart by the box id, never by the name.
- Anyone on the network reads it, paired or not. If your client suggests names, suggest rooms, not people.

To change it, an adult sends `POST /api/phone/name` with `{"name": "Living room"}`, and the PIN grant once a PIN is set. The TV trims what it's sent, drops control characters, and cuts a name that's too long between two characters. The answer is `{"ok": true, "name": "Living room"}`, with the name as the TV kept it, so show that and not what was typed. When nothing's left of it the answer is `400` with `Names can be up to 30 characters`. On a child's profile it's `403` with `Only adults can change the name`.

Every phone's state then has a new `version` and the new `boxName`, and the record follows. A phone finds its TV by the id, so nobody pairs again. With the switch off the route is a sealed `404`, like any address that isn't there.

On the TV it's in Settings, under System, as Name.

### The box id

The TV makes the id once, from 16 random bytes, and keeps it. It isn't made from a key, from the hardware or from the network, so it says nothing about the TV but "the same one as before". A TV that's installed again gets a new one, and its phones pair again anyway.

A phone learns the id in two places, both only while the switch is on:

- **When it pairs.** The answer to `POST /api/phone/pair` has `boxId`.
- **In the state.** `GET /api/phone/state` has `boxId`.

The one in the state is sealed. The one in the pairing answer is covered by `confirm`, so someone in the middle can't change it: see [When the TV has a box id](#when-the-tv-has-a-box-id). Once `confirm` matches, keep the pairing's `boxId` as it is. The state's is the same id.

A phone that paired before the switch went on has no id yet. It gets one from the state the next time it reaches the TV at the address it knows.

### Waking the TV

`GET /api/phone/box` has what a phone needs to wake a TV that's asleep. See [State](#state) for the field. It goes to paired phones only, sealed. It's never in the record above, because a hardware address names the machine for good.

A wake packet is 102 bytes: six of `0xFF`, then the hardware address's six bytes sixteen times over. Send it over UDP to `wake.broadcast`, port 9. The TV listens for it on its cable only, so `wake` is `null` when the TV is on Wi-Fi alone. Ask while the TV is awake and keep the answer: a sleeping TV can't tell you.

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

If `shared` is 32 zero bytes, stop there: refuse the answer as the TV not answering, and keep nothing. Some public keys give all zeros whatever your private key is, and the TV refuses a phone's key that does the same.

The phone then checks that the TV came to the same key:

```
confirm = HMAC-SHA256(key: phoneKey, message: "origaitv pair box v1" || phonePublic || tvPublic)
```

If `confirm` doesn't match, whoever answered didn't see the secret. Throw the key away and treat it as the TV not answering. If it matches, keep `id` and `phoneKey`. That's the whole pairing, for a TV with no box id.

#### When the TV has a box id

With the `announce` switch on, the TV has a box id (see [The box id](#the-box-id)). The answer then has one more field, after `phone`:

```json
"boxId": "<32 hex digits>"
```

And the TV makes `confirm` another way, so that it covers the id:

```
confirm = HMAC-SHA256(key: phoneKey, message: "origaitv pair box id v1" || phonePublic || tvPublic || boxId)
```

`boxId` here is the field's text as it came, which is 32 ASCII bytes. It isn't the 16 bytes the digits spell. Everything before it has a fixed length, and the two labels differ, so a message made one way is never a message made the other way.

A phone goes by the answer it got:

- **The answer has `boxId`.** Check `confirm` this way. If it matches, the id is the TV's, and you can keep it with `id` and `phoneKey`.
- **The answer has no `boxId`.** Check `confirm` the first way. If it matches, you're paired with a TV that has no id.
- **Check one way only,** the one that goes with the answer. Never try the other when the first doesn't match.

That's what keeps someone between the phone and the TV from touching the id. They don't have `phoneKey`, so they can't make a `confirm` of either kind. All they can do is change the answer around the one the TV made:

- **Change the id.** The TV's `confirm` covers the id it sent, and no other.
- **Take the id out.** The phone then checks the first way, and the TV made its `confirm` the second way.
- **Put an id in,** when the TV has none. That's the same the other way round.

Each time `confirm` doesn't match, the pairing fails and the phone keeps no key. So a phone can't be talked into a wrong id, or into pairing with no id when the TV has one. That's also why a phone doesn't need to know beforehand whether the TV has an id: a TV with the switch off really has none, and its answer can't be faked from one that has.

What it doesn't do is stop a pairing from failing. Someone in the middle could always do that, by dropping the answer. By then the TV has the phone on its list and the code is used. So pair again with a new code, and remove the phone that nobody holds the key for in Settings, under Phones. And like `confirm` itself, it only holds against someone who doesn't have `k`. Whoever has the code or the secret while it's good can pair as they like.

A `boxId` with a `confirm` made the first way is refused like the rest. No tagged release ever answered that way.

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
| `X-OrigaiTV-Grant` | The PIN grant, when the request needs one. Otherwise leave it out, or send it anyway: a route that doesn't need a grant never looks at it. See [The PIN grant](#the-pin-grant). |

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

### A request with no body

Every `GET` has no body, and neither does a `POST` whose row in the tables below says "None". Send it with nothing at all:

- no `Content-Type`;
- no `Content-Length`, or `Content-Length: 0`. Both are fine, and a browser sends the second with a `POST`;
- the SHA-256 of nothing as the digest.

That's what the phone's page sends. Don't put `{}` there instead:

- A plain `{}` sent as JSON gets the `401` with `session`, like any JSON that isn't sealed.
- A sealed `{}` does work. None of these routes reads its body, so the TV opens it and drops it. It's 30 bytes sent for nothing.

The other way round, a route that takes a body treats a request without one as a body that doesn't fit. That's a `400` on most of them. `POST /api/phone/pin` counts it as a wrong PIN.

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

### The plain 500

One more answer can come unsealed. If something breaks before the TV has checked the signature, it answers a plain `500`:

```json
{ "ok": false, "error": "Something went wrong" }
```

A sealed body over the limit is what does it in practice.

It isn't like the two `401`s. Those ask you to do something: say hello again and send the request once more. The `500` says nothing about the session or the pairing, so:

- Keep the session. Don't say hello again because of it.
- Don't send the same request again by itself. A body that was too big is too big the second time.
- Count the request as failed and show your own words for it. Anyone on the network can write this answer, so its `error` isn't the TV's word.
- Never delete the phone's key over it.
- Give the next request a new counter, as always. The TV never got as far as this one's signature, so it didn't use the counter up, and a gap in the counters costs nothing.

A `500` that comes after the signature is checked is another thing. It's sealed like any other answer, and its `error` is the TV's own. `POST /api/phone/key` sends one when the TV couldn't save the key.

### When the TV says it doesn't know this phone

A client that remembers its TV will one day get the `401` with `pair` from a hello. It can be true: someone forgot the phone in Settings, or the TV was installed again. But the answer isn't sealed, and it can't be, since a TV that has forgotten the phone has no key left to seal it with. So it proves nothing. Anyone on the network can write it. So can another OrigaiTV that the router gave your TV's old address, and that one is telling the truth.

What I'd do with it:

- Keep the phone's key, its id and the TV. An answer anyone can write isn't worth deleting them for.
- Make sure you asked the right TV. With the `announce` switch on, look the TV up by its box id and say hello at the address that gives. See [Finding the TV](#finding-the-tv).
- If that hello answers the same, tell the person in your own words that the TV doesn't know this phone any more, and offer to pair again. Leave forgetting the TV to them.
- Pair again only with a code that's on the TV's screen. A pairing proves itself, since its `confirm` only fits if the TV saw the same secret. Once it has worked, replace the old key and id with the new ones. Until then the old ones stay.
- Don't ask again in a loop. Try when the person opens the app, or when the TV turns up at another address.

Only the `401` with `pair` means this. A hello with no answer, with another status, or with a `proof` that doesn't fit is a TV you couldn't reach, not a TV that forgot you.

## The PIN grant

Some routes are an adult's, and need the PIN once one is set. The flow:

1. Send the request. Without a good grant, the answer is `403`, sealed: `{"ok":false,"error":"That needs the PIN","pin":true}`.
2. Ask for the PIN on the phone and send it: `POST /api/phone/pin` with `{"pin":"1234"}`. Four digits, as text.
3. The answer is `200` with `{"ok":true,"grant":"<32 characters>","until":"<ISO time>"}`.
4. Send the first request again with `X-OrigaiTV-Grant` set to that grant. It needs a new counter and a new signature, and the grant is part of what's signed.

About grants:

- A grant lasts 5 minutes from when the TV made it. Keep it and reuse it until a request answers `pin: true` again.
- `until` is on the TV's clock, which may not be the phone's. Don't compare it with the phone's own time. If you want to ask for the PIN before a request is refused, count the 5 minutes on the phone from when the answer came.
- What to rely on is the refusal. A grant can end before `until`, as below, so a guarded request can always answer `pin: true`. Ask for the PIN then, and send the request again.
- It belongs to the phone that entered the PIN. Another phone can't use it, and neither can the TV's own pages.
- Locking the TV or removing the PIN ends every grant. Changing the PIN ends every grant but the one that changed it. Grants are kept in the daemon's memory, so a daemon restart ends them all too.
- With no PIN set, guarded routes just work, and `POST /api/phone/pin` answers `403` with `There's no PIN yet`.
- The right PIN also unlocks a locked TV.
- Sending a grant to a route that doesn't need one is harmless. Only a guarded route reads the header, so one that's run out or isn't a grant at all changes nothing anywhere else. You can put it on every request while you hold one. It still has to be in the signature, like any grant.
- The grant goes in a header, so it isn't sealed. That's fine: it only works in a request signed by the phone that entered the PIN.

A wrong PIN is `403` with `"ok": false` and a sentence in `error`, such as `Wrong PIN`. After five wrong tries in a row the answer also has `"wait": 30`, the seconds before the TV takes another try. Each wrong try after that doubles the wait, up to 15 minutes. Each phone has its own count, so one phone's wrong tries don't lock out another or the TV.

Anything that isn't the right PIN is a wrong try: three digits, five, or a number where the text should be. Check for four digits on the phone before you send.

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
| `POST /api/phone/pair` | Plain JSON `{key, name, proof}` | Plain JSON `{ok, id, key, confirm, phone}`, and `boxId` with the `announce` switch on. `403` when it didn't work. | Anyone on the network with the code |
| `POST /api/phone/hello` | Plain JSON `{id, nonce}` | Plain JSON `{ok, session, nonce, proof}`. `401` with `pair`. | A paired phone |
| `POST /api/phone/pin` | `{pin}` | `{ok, grant, until}`. `403` with `error` and sometimes `wait`. | Anyone |

### State

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `GET /api/phone/state?since=<version>` | None | The state. See [The long poll](#the-long-poll). | Anyone |
| `GET /api/phone/features` | None | Every feature switch and whether it's on, such as `{"remote2":true,"askbuilds":true}`. There's no `ok` field. | Anyone |
| `GET /api/phone/box` | None | `{ok, line, box}`: what the box check found, as a line and in full. With the `announce` switch on, also `wake`. | Anyone |
| `POST /api/phone/name` | `{name}` | `{ok, name}`: the TV's new name, as it was kept. Only there with the `announce` switch on. See [The TV's name](#the-tvs-name). | Adult + grant |

`wake` is `{"mac": "94:c6:91:1a:2b:3c", "broadcast": "192.168.1.255"}`: the hardware address of the TV's wired port, in lower case, and the broadcast address of the network that port is on. It's `null` when no wired port is on a network. [Waking the TV](#waking-the-tv) has what to send. The TV's own pages get the same `box` from `GET /api/box` on the TV's port, without `wake`.

### The remote

| Route | Body | Answer | Who |
| --- | --- | --- | --- |
| `POST /api/phone/remote` | One of: `{key}`, `{hold, ms}`, `{text}`, `{move:[dx,dy]}`, `{click}`, `{scroll}`, `{wheel:[x,y], at}`. See below. | `{ok}`. `400`, `503`. | Anyone |
| `POST /api/phone/text` | `{value, caret}` on each change, or `{done:true}` for Enter | `{ok, by, why, value, kept}`, only the fields that apply. `503`. | Anyone |
| `POST /api/phone/playback` | `{action}`: `"toggle"` or `"next"`. With the `playing2` switch on, also `"play"`, `"pause"`, `"previous"` and `"seek"`. See [What's playing](#whats-playing). | `{ok:true, by}` where `by` is `"app"`, `"page"` or `"key"`, or `{ok:false, why}` with status `200`. `503`. It can take up to 12 seconds, or 20 with `playing2` on. See [How long an answer can take](#how-long-an-answer-can-take). | Anyone |
| `GET /api/phone/playing/picture` | None | A picture for what's playing, not sealed. `404` (sealed) when there's none, and always while the `playing2` switch is off. | Anyone |
| `POST /api/phone/apps` | None | `{ok}`. Opens Apps on the TV. `503`. | Anyone |
| `POST /api/phone/settings` | None | `{ok}`. Opens Settings on the TV. | Adult |
| `POST /api/phone/viewer` | `{id}`: a profile's id | `{ok, viewer}`. `404`. | Anyone. Grant to switch from a child's profile to an adult's, or to a locked profile. |
| `POST /api/phone/sign-in` | `{username, password}`, up to 200 characters each | `{ok}`. `409` when nothing is signing in on the TV. `503`. | Anyone |

What `POST /api/phone/remote` takes, one per request:

- `{"key":"up"}`: a key press. The name is 1 to 12 characters of `a-z`, `0-9` and `-`, and [The key names](#the-key-names) has every one the TV knows.
- `{"hold":"back","ms":1100}`: a held key, by the same names. `ms` is how long it stays down. It's kept between 100 and 3000, and is 1200 when left out. See [Holds](#holds).
- `{"text":"hello"}`: text typed as key presses, 1 to 500 characters. It can type the letters, digits and signs of a US keyboard, a space, a tab and a new line. With any other character in it, none of it is typed. To fill a field on the TV, use `POST /api/phone/text`.
- `{"move":[dx,dy]}`: a trackpad move, right and down. Whole numbers, each within 2000 either way.
- `{"click":"left"}`: or `"right"` or `"middle"`.
- `{"scroll":3}`: notches of a mouse's wheel, up when it's above 0. A whole number within 50 either way, not 0.
- `{"wheel":[x,y]}`: a two-finger scroll, right and down, in the pixels of the TV's page. Whole numbers within 4000, not both 0. Add `"at":"pointer"` to scroll under the pointer, not the middle of the page.

A body with more than one of these is taken as the first that fits, in this order.

`{"ok":true}` means the TV's screen session has the request, not that the key was pressed. The answer comes at once, for a hold of 3 seconds too. Three things follow from that:

- The TV presses them one at a time, in the order they came. A key sent during a hold waits for the hold to end.
- A name the TV doesn't know still gets `{"ok":true}`, and then nothing happens. So does a text with a character it can't type.
- A `400` means the body is none of the seven: a key's name with a capital in it, a move that isn't two whole numbers, a scroll of 0.

#### The key names

These are all the names `key` and `hold` take. `daemon/input.py` has the list, and a test keeps this table the same as it.

A key goes to whatever is in front on the TV, as a key on a keyboard would. The last column is what OrigaiTV's own screens do with it. An app in front does what it likes.

| Name | The key | On OrigaiTV's screens |
| --- | --- | --- |
| `up`, `down`, `left`, `right` | The arrows | Move the focus. |
| `enter` | Enter | OK. Held for 600 ms on an app's tile, it opens the app's details. |
| `back` | Esc | Back. Held for a second, it goes home, from an app too. |
| `esc` | Esc | The same key as `back`. |
| `home` | A remote's Home button | Home, from anywhere. |
| `home-key` | A keyboard's Home key | Home too. On Omarchy's desktop it's the keyboard's own Home. |
| `backspace` | Backspace | Deletes in a field and on the TV's PIN pad. Anywhere else on home it's Back. |
| `delete` | Delete | In Edit home, removes the tile. On the TV's PIN pad, takes a digit off. |
| `tab` | Tab | The next field. |
| `space` | Space | |
| `pageup`, `pagedown`, `end` | Page Up, Page Down, End | |
| `playpause`, `stop`, `previous`, `next` | The media keys | They go to the app in front. For play and pause use `POST /api/phone/playback`, which asks the app and says whether it worked. |
| `mute`, `volumedown`, `volumeup` | The volume keys | The TV session has nothing bound to them, so they only reach the app in front. On Omarchy's desktop they're Omarchy's volume keys. |
| `f11` | F11 | |
| `a` to `z` | The letters | On home and Apps: `i` opens the details of the app in focus, `e` opens Edit home, `p` adds the app in focus to home or removes it (Apps only), and `q` closes an app that's open behind home. |
| `0` to `9` | The digits | A digit on the TV's PIN pad. See [The TV's PIN pad](#the-tvs-pin-pad). |

There's no key for a capital letter or a sign. Those only go as `text`.

#### Holds

A phone decides what a hold is. The TV is never told a finger is down: it gets a key, or a held key, when the phone sends one. Two holds do something on the TV:

- **Back, held, goes home.** The TV counts a second from when Esc goes down. Send `{"hold":"back","ms":1100}`, which keeps it down that second and a little more.
- **OK, held on an app's tile, opens its details.** Only on home and Apps, where the state's `tv.details` is `true`. `{"key":"i"}` opens the same details at once, and that's what the phone's page sends, since it has already waited out the hold itself. A held `enter` of 600 ms or more does it too, 600 ms later.

Any other key that's held repeats, as it does on a keyboard.

#### What the phone's page sends

This is the remote the page draws with the `remote2` switch on, gesture by gesture, with its timings. Match them and a native remote feels the same. Its pad is a round one in Glass and a plain surface in the other looks. `look` in the state says which.

| On the phone | What's sent | When |
| --- | --- | --- |
| A tap on the pad | `{"key":"enter"}` | As the finger lifts, if it was down for under 600 ms and didn't swipe. |
| A swipe on the pad | An arrow, such as `{"key":"left"}`, for every 44 px the finger goes | As it passes each 44 px. The arrow is the way it has moved most. A long swipe sends several. |
| A hold in the middle of the pad, on an app's tile | `{"key":"i"}` | Once the finger has been down for 600 ms. Nothing more when it lifts. |
| A hold in the middle, anywhere else | Nothing. The pad becomes the pointer, until Done. | The same 600 ms. |
| A press on the round pad's edge | That side's arrow | As the finger lifts. Held still, the arrow goes after 450 ms and then every 150 ms until it lifts. |
| Two fingers on the pad | `{"wheel":[x,y]}`, three times the fingers' way | At most every 30 ms, with what's gathered since the last one. |
| A tap on Back | `{"key":"back"}` | As the finger lifts, if it was down for under 700 ms. |
| Back, held | `{"hold":"back","ms":1100}` | Once it has been down for 700 ms, while it's still down. Nothing more when it lifts. The TV is home a second later. |
| Home | `{"key":"home"}` | |
| Play or pause | `POST /api/phone/playback` with `{"action":"toggle"}` | |
| The pointer: a move | `{"move":[dx,dy]}`, twice the finger's way | At most every 30 ms. |
| The pointer: a tap | `{"click":"left"}` | As the finger lifts, if it was down for under 250 ms and went less than 6 px in all. |
| The pointer: two fingers | `{"wheel":[x,y],"at":"pointer"}` | As on the pad. |

A few things behind the table:

- "On an app's tile" is what the state said when the hold landed: `tv.front` is `"home"`, `tv.screen` isn't `"ambient"` and `tv.details` is `true`. Everywhere else a hold sends the TV nothing.
- A finger counts as still while it's within 12 px of where it went down, adding the way across to the way down. Past that it isn't a hold any more. Past 44 px either way it's a swipe.
- The round pad's edge is the part more than 0.6 of the radius from its middle. A press there that moves is a swipe.
- A second finger ends the first one's tap, hold or arrow. The pad then scrolls until every finger has lifted.
- While `tv.view` is `"trackpad"`, which is Omarchy's desktop, the pad is the pointer from the start, and there's no Done.
- The page with a d-pad has an OK button with the same hold. A tap is `{"key":"enter"}` as it lifts. Held for 600 ms on an app's tile it's `{"key":"i"}`, and then no Enter when it lifts. Anywhere else a long press is still Enter as it lifts.

#### The TV's PIN pad

When the TV asks for the PIN on its own screen, the state's `tv.pin` is there and `tv.view` is `"pin"`. A phone can type into that pad with keys:

- `{"key":"4"}`: a digit. The pad takes four, and checks them by itself at the fourth. There's no OK to send.
- `{"key":"backspace"}`: takes the last digit off. `delete` does the same.
- `{"key":"back"}`: closes the pad, where it can be closed. The pad that unlocks the TV can't.
- The arrows and `enter` move over the pad's own buttons and press them, as anywhere else.

`tv.pin.digits` says how many are in, so draw your boxes from that and not from what you sent. After a wrong PIN it's back to 0, and `tv.pin.error` has the sentence to show.

This isn't `POST /api/phone/pin`. That one is the phone asking for a grant of its own, and it shows nothing on the TV. Here the phone is only a keyboard for the TV's pad, and what the PIN opens is the TV's.

#### Typing into a field

`POST /api/phone/text` keeps a field on the TV in step with one on the phone. Send the whole text as `value` on each change, with `caret` for where the cursor is, and `{"done":true}` for Enter. Only the newest change waits to go: one that's overtaken is answered `{"ok":true}` straight away.

The two are counted differently:

- `value` can be up to 500 characters, counted as Unicode code points. An emoji that's one code point counts once. More than 500 is a `400`.
- `caret` is counted in UTF-16 units from the start of `value`, the way JavaScript counts a string. That same emoji moves it by two. It's a whole number from 0 to the length of `value` in those units.
- A `caret` that doesn't fit is dropped, not refused. Left out, not a whole number, below 0 or past the end: the text goes all the same, and the cursor stays where the change left it.
- The cursor only follows in a page's own text field. A native app is typed into as key presses, and has no cursor to move.

The answer is `200` with `ok`, and only the fields that apply:

| Field | When it's there |
| --- | --- |
| `by` | `"page"` when the text went into a field in a page, which is home and most apps. `"key"` when it was typed as key presses into a native app. Missing when the change was overtaken or reached nothing. |
| `why` | With `"ok": false`, a sentence for the person: `Nothing to type into right now`, `That field is full`, `Couldn't type all of it`, `This app can't take é` or `Your TV isn't ready yet`. |
| `kept` | Only from a field that's full. It's how much of `value` the field took, from the start, in UTF-16 units like `caret`. |
| `value` | Only from a native app, and only when a character couldn't go. Those take plain letters: the letters, digits and signs of a US keyboard. It's the text as the TV has it, which is yours without what couldn't be typed. |

What the phone's page does with them: with `value`, it shows that in its own field. With `kept`, it cuts its field to that length. It does neither if more was typed while the answer was on its way.

`{"done":true}` presses Enter in the field and answers `{ok, by}`.

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

`found` is a list of `{kind, name, url, host, via}`, all text. `kind` is one of `jellyfin`, `emby`, `plex`, `immich`, `smb` and `nfs`, and those are the names `kinds` takes. `url` is where an app or a folder reaches it, `host` is the machine's name or its address, and `via` is how the TV heard of it.

The folders a NAS shares come as `{ok, host, shares}`, where `shares` is a list of `{kind, name, uri}` with a `note` when the NAS gave one. `login: true` in that answer means the NAS wants a user before it lists more.

## Timeouts

Nearly every route answers as fast as the TV can read a file. These are the ones that wait on something, and how long the TV gives it. Set each request's timeout a little above its row.

| Route | The longest it waits | What it waits for |
| --- | --- | --- |
| `GET /api/phone/state` with the current `since` | 25 seconds | A change. See [The long poll](#the-long-poll). |
| `POST /api/phone/playback` | 12 seconds, or 20 seconds for the actions the `playing2` switch adds | The app in front. [How long an answer can take](#how-long-an-answer-can-take) has which action gets which. |
| `POST /api/phone/text` | 3 seconds, or 6 seconds for a change sent while the one before is still on its way | The field on the TV. A change waits its turn behind the one the TV is taking. |
| `POST /api/phone/key` | 10 seconds | The key being saved. |
| `PUT /api/phone/location` | 8 seconds | The TV's clock moving to the new time zone, when the location changes it. |
| `GET` and `POST /api/phone/discover/shares` | 16 seconds | The NAS: 10 seconds for its SMB list, then 3 seconds for each of the two questions NFS takes. |
| `POST /api/phone/say/pick` | 40 seconds, and more for a title from New this week | The app opening what was picked. See below. |
| `POST /api/phone/say` | There's no one number | See below. |
| `POST /api/phone/apps/<app id>/push` | 5 minutes | The push to GitHub. |
| `GET /api/phone/ai/icon/<provider>` | 10 seconds for each address it tries | The provider's own site, the first time. After that the TV has the icon. |
| `GET /api/phone/box` | There's no one number | The TV reads its hardware each time. Each program it runs for that has 5 seconds, and most run side by side. |
| An upload | As long as the bytes take | |

A few things to know:

- **`say` answers when the sentence is done, not when it's heard.** The AI has 45 seconds to read it. Then comes whatever it asked for, one after the other: a search has 15 seconds, or 40 seconds when it's one app's, opening an app has 40 seconds, and a title's own page has 60 seconds. Don't hold the screen for it. The state's `said` has the sentence at once with `state: "routing"`, and then what came of it, so follow that and let the request take as long as it takes.
- **`say/pick` opens what was picked,** which has the same 40 seconds. A title from New this week opens on its own page, which has the 60 seconds, and an app with no such page searches for it and plays it after that.
- **`remote` doesn't wait for the key.** It answers once the TV's screen session has the request, so a hold of 3 seconds answers as fast as a tap.
- **When the wait runs out, the answer still comes.** `text` and `playback` answer `200` with `{"ok":false,"why":"Your TV isn't ready yet"}`. `key` answers a sealed `500` with why. `push` answers `502`.
- **Everything else** reads or writes what the TV already has. I'd give those 10 seconds.

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

[The state's types](#the-states-types) has the type of each.

| Field | What it is |
| --- | --- |
| `ok` | `true`. |
| `version` | The count described above. |
| `phone` | This phone, as the TV knows it: `{id, name, pairedAt}`. |
| `boxId` | The box id, as the TV announces it: 32 hex digits. Only there while the `announce` switch is on. See [The box id](#the-box-id). |
| `boxName` | The TV's name, such as `"Living room"`, or `"OrigaiTV"` until somebody names it. Only there while the `announce` switch is on. See [The TV's name](#the-tvs-name). |
| `features` | The two switches the remote draws by: `{remote2, askbuilds}`. |
| `ask` | What the Ask box is waiting on for an adult's OK, or `null`. Only there while `askbuilds` is on, and always `null` on a child's profile. |
| `look` | The id of the look the TV is in, such as `"terminal"`, or `null` while the looks switch is off. |
| `viewer` | Who's watching: `{id, name, role, avatar, locked}`. `role` is `"adult"` or `"child"`. `avatar` is a colour's name. `locked` means the profile asks for the PIN to open. |
| `viewers` | Every profile, each in the same shape. |
| `pin` | `{set, locked}`: whether there's a PIN, and whether the TV is locked now. |
| `signIn` | `{name}` while an app's sign-in screen is up on the TV, for `POST /api/phone/sign-in`. Otherwise `null`. |
| `update` | An update that's ready or going in: `{version, installed, omarchy, notes, tonight, later, installing}`. `null` with nothing to install. |
| `tv` | What's on the TV. See below. |
| `nowPlaying` | `{title, app, left}` for the remote's card, while the `remote2` switch is on, something plays and its app has said where it is in the last 30 seconds. `left` is minutes, and may be missing. Otherwise `null`, which it can be while `tv.playing` is `true`. See [`nowPlaying`](#nowplaying). With the `playing2` switch on it says more, and it stays while the thing is paused. See [What's playing](#whats-playing). |
| `setup` | While setup is on: `{step, part, n, of, muted}`. `n` and `of` may be missing. `null` once setup is done. |
| `ai` | What the AI step asks of the phone, or `null`. See below. |
| `discover` | The list of what's on the network that the TV is showing: `{kinds, machines}` or `{host}`. `null` with no list, or with the discover switch off. |
| `notices` | The last five notices from apps: `[{app, name, text, at}]`, newest first. |
| `builds` | The builds an adult follows: `[{build, id, name, provider, state, phase, done, steps}]`, with `signIn`, `ranOut` and `reason` when they apply. Empty on a child's profile. |
| `export` | An app the TV is offering to save a copy of: `{id, name, version, github}`. `github` is who the TV is signed in to GitHub as, `{via, login}`, or `null`. `null` with no offer, and on a child's profile. |
| `said` | The last sentence said to the TV and what came of it, for ten minutes: `{n, sentence, from, viewer, state, outcome, at}`. `state` is `"routing"` or `"done"`, and `outcome` is missing until it's done. Then `null`. |
| `controllers` | `{phones, most}`: how many phones are game controllers right now, and how many can be. Only there while `phonepad` is on. See [Game mode](#game-mode). |

`tv` has:

| Field | What it is |
| --- | --- |
| `view` | The page the remote should open on. It's the first of these that fits: `"trackpad"` while `desktop` is `true`, `"pin"` while `pin` is there, `"keyboard"` while `field` is there or the state's `signIn` is, `"playback"` while `playing` is `true`, and `"remote"` otherwise. So it's `"keyboard"` with `field` at `null` while an app's sign-in screen is up, and `POST /api/phone/sign-in` fills that one. |
| `pin` | The PIN pad on the TV, when it's up: `{title, for, digits, error}`. `digits` is how many are typed so far. Otherwise `null`. |
| `field` | The text field in front, or `null`. With `remote2` on it's `{kind, label, value}`, plus `app` and `name` for a field in an app. A password never has `value`. With `remote2` off it's `{kind}`, for home's own fields only. `kind` is `text`, `search`, `email`, `password`, `number` or `url`. |
| `screen` | `"home"`, `"menu"` or `"ambient"`. |
| `details` | `true` while the focus is on an app's tile, where a hold opens its details. |
| `front` | `"home"` or `"app"`. |
| `playing` | Whether something is playing. |
| `desktop` | `true` while the Omarchy desktop is on, where the remote is a trackpad. |
| `game` | The game in front, `{id, name}`, or `null`. Only there while `phonepad` is on. See [Game mode](#game-mode). |

### The state's types

Here's the whole state with every field's type, written the way TypeScript writes them. A `?` after a name means the field can be missing. `| null` means it's there and can be `null`.

```ts
{
  ok: true,
  version: number,
  phone: { id: string, name: string, pairedAt: string },
  boxId?: string,
  boxName?: string,
  features: { remote2: boolean, askbuilds: boolean },
  ask?: Ask | null,
  look: string | null,
  viewer: Viewer,
  viewers: Viewer[],
  pin: { set: boolean, locked: boolean },
  signIn: { name: string } | null,
  update: Update | null,
  tv: {
    view: "trackpad" | "pin" | "keyboard" | "playback" | "remote",
    pin: { title: string, for: string, digits: number, error: string | null } | null,
    field: { kind: string, label?: string, value?: string, app?: string, name?: string } | null,
    screen: "home" | "menu" | "ambient",
    details: boolean,
    front: "home" | "app",
    playing: boolean,
    desktop: boolean
  },
  nowPlaying: { title: string, app: string, left?: number } | null,
  setup: { step: string, part: string, n?: number, of?: number, muted: boolean } | null,
  ai: Ai | null,
  discover: { kinds: string[], machines: boolean } | { host: string } | null,
  notices: { app: string, name: string, text: string, at: string }[],
  builds: Build[],
  export: { id: string, name: string, version: string, github: { via: "gh" | "ssh", login: string } | null } | null,
  said: Said | null
}
```

A few things that hold for all of it:

- Every number here is a whole number.
- A time is text, in UTC, in one of two shapes. `pairedAt` and `said.at` have milliseconds and a `Z`: `2026-11-17T20:15:03.120Z`. A notice's `at` has neither: `2026-11-17T20:15:03+00:00`. Make sure your parser takes both.
- The TV adds fields as it grows, and `boxId` came that way. Skip a field you don't know.
- `look` is `"terminal"`, `"glass"` or `"cinema"` today.
- `setup.step` is one of `welcome`, `ready`, `box`, `country`, `ai`, `people`, `goal`, `apps`, `look`, `theme` and `background`. `part` is the words for it, to show as they are.
- `discover.kinds` holds the kinds from [What's on the network](#whats-on-the-network). `machines` is `true` when the TV's list is one row for each machine, not one for each thing found.

#### `viewer`

```ts
Viewer = { id: string, name: string, role: "adult" | "child", avatar: string, locked: boolean }
```

`avatar` is a colour's name, not a picture: `blue`, `green`, `magenta`, `yellow`, `cyan`, `orange` or `red`. The phone's page draws the first letter of the name on that colour. The colours are the TV's theme's, and `GET /api/theme.css` has them as `--blue` and so on when the theme has them.

#### `update`

```ts
Update = {
  version: string,
  installed: string | null,
  omarchy: string | null,
  notes: string[],
  tonight: boolean,
  later: boolean,
  installing: boolean
}
```

- `version` is the OrigaiTV version there is to install. It's the word `packages` when OrigaiTV itself has no new version and only other packages do. It's what `POST /api/phone/updates/tonight` takes.
- `installed` is the OrigaiTV version on the TV now.
- `omarchy` is the Omarchy version that comes with the update, or `null` when there's none.
- `notes` is What's new, a line each. It can be empty.
- `tonight` is `true` when this version goes in tonight. `later` is `true` once someone said Later to it. `installing` is `true` while it's going in.

#### `nowPlaying`

With the `playing2` switch off, `nowPlaying` isn't "something is playing". It's the last thing an app told the TV about where it is, and it's there only when all of these hold:

- the `remote2` switch is on;
- `tv.playing` is `true`;
- an app has said what's playing and where it is within the last 30 seconds. An app that can says so every 10 seconds.

So `tv.playing` can be `true` with `nowPlaying` still `null`: in the first seconds of something, and for as long as it plays in an app that doesn't say what it plays. Draw play and pause from `tv.playing`, and the card only when `nowPlaying` is there.

`left` is whole minutes. It's missing when the app gave no length.

With `playing2` on, [What's playing](#whats-playing) has the rules.

#### `ai`

```ts
Ai = {
  ask: "terms" | "key" | "sign-in",
  provider: string,
  path: "key" | "plan",
  name: string,
  maker: string,
  plan: string,
  terms: { id: string, name: string, url: string }[],
  summary: string,
  keyUrl: string,
  signIn?: { url: string, code?: string, pastes: boolean }
}
```

- `ask` says what the phone should show: `"terms"` to accept with `POST /api/phone/terms`, `"key"` to paste with `POST /api/phone/key`, or `"sign-in"` for the plan's sign-in.
- `provider` is the AI's id, such as `claude`. `name` is what it's called, `maker` is the company, and `plan` is its plan's name.
- `path` is how the household pays for it: its own API key, or a plan. Send `provider` and `path` back as they are to `POST /api/phone/terms`.
- `terms` are the documents to accept, each with a link. `summary` is one line on what they are.
- `keyUrl` is the page where the provider hands out keys.
- `signIn` is only there with `ask: "sign-in"`, and then `terms` is empty and `summary` is `""`. `url` is the provider's page to open. `code` is a code to type on that page, when it shows one. `pastes` is `true` when the page gives a code back, which goes to `POST /api/phone/ai/sign-in/code`.

#### `ask`

```ts
Ask =
  | {
      kind: "build",
      n: number,
      build: string,
      app: string | null,
      what: string,
      state: string,
      phase: string,
      name: string | null,
      recipe: string | null,
      says: string | null,
      done: number,
      steps: number,
      model: string | null,
      models?: { id: string, name: string, only?: "plan" | "key", costsExtra?: "plan" }[]
    }
  | { kind: "change", n: number, app: string, name: string, what: string, recipe: string | null }
```

- `n` is the sentence's number, the same as `said.n`. `POST /api/phone/ask/confirm` and `ask/cancel` take it, so an OK can't land on a newer sentence.
- `kind: "build"` is an app being made, or a change that already has its OK. `kind: "change"` is a change to an app that waits for one.
- `app` is the app a change is for, by its id. It's `null` for a new app.
- `what` is what was asked for. `name` is what the app will be called and `says` is what the TV understood, in a line. Both are `null` until it has read the ask.
- `state` and `phase` are a build's, as in [`builds`](#builds). `"confirm"` is the one that waits for the OK.
- `recipe` is the kind of app it knows how to make: `streaming`, `game`, `photos`, `api` or `theme`. `null` means it's something new, with steps to check first.
- `done` and `steps` count the steps done and the steps in all.
- `model` is the AI model it runs on, by its id. `models` is there while it waits for the OK: the ones it could run on, to send one's `id` as `model` to `ask/confirm`.

#### `builds`

```ts
Build = {
  build: string,
  id: string,
  name: string,
  provider: string,
  state: "starting" | "running" | "confirm" | "plan" | "approve" | "sign-in" | "plan-sign-in" | "failed",
  phase: "understand" | "plan" | "build" | "stage-b",
  done: number,
  steps: number,
  signIn?: "starting" | "waiting" | "done" | "failed",
  ranOut?: true,
  reason?: string
}
```

- `build` is this build's own name, for the routes under `/api/phone/builds`. `id` is the app's id, which starts with `local.`.
- `name` is the app's name. Until it has one, it's the sentence that asked for it.
- `provider` is the AI it runs on: `claude`, `chatgpt`, `gemini`, `grok` or `muse`.
- `state` is where it stands. `starting` and `running` are it working. `confirm` waits for the OK that `POST /api/phone/ask/confirm` gives, `plan` for an adult to approve its steps with `POST .../plan`, and `approve` for an adult to approve the app with `POST .../approve`. `sign-in` waits for someone to sign in to the app on the TV, and `plan-sign-in` for the AI plan's own sign-in. `failed` has a `reason`. A build that's installed isn't in the list any more.
- `phase` is which part of the work it's in.
- `signIn` is one word, not an object: how the plan's sign-in is going, while the build is in `plan-sign-in`. Its link and its code aren't in the state. `GET /api/phone/builds` has every build in full, with `signIn` as `{state, url, code, pastes}`.
- `ranOut` is there, and `true`, when the plan's sign-in ran out and is asked for again.

#### `said`

```ts
Said = {
  n: number,
  sentence: string,
  from: string,
  viewer: string,
  state: "routing" | "done",
  outcome?: Outcome,
  at: string
}

Outcome =
  | { kind: "opened", say: string, app: string, item?: Item }
  | { kind: "choose", say: string, candidates: { app: string, name: string, item: Item }[] }
  | { kind: "told", say: string, episode?: object }
  | { kind: "build", say: string, build: string, what: string, app?: string }
  | { kind: "change", say: string, app: string, name: string, what: string, recipe: string | null }
  | { kind: "none", say: string, why: string }

Item = {
  id: string,
  kind: "film" | "series" | "episode" | "track" | "album" | "playlist" | "photo-album" | "game",
  title: string,
  season?: number,
  episode?: number,
  subtitle?: string,
  year?: number,
  poster?: string,
  still?: string
}
```

- `n` counts the sentences since the daemon started. `from` is the phone's name, or `the tv`. `viewer` is the id of the profile that was watching.
- `outcome` is missing while `state` is `"routing"`. `at` is when it was heard, and then when it was done.
- `say` is the line to show, in every kind. It's what the TV shows and says aloud.
- `opened`: an app opened, by its id in `app`, on `item` when it opened a title.
- `choose`: more than one thing fits. `candidates` has up to three, and `POST /api/phone/say/pick` takes the place of one in the list as `choice`, counting from 0. In each, `app` is the app's id and `name` is the app's name.
- `told`: the answer is `say` itself, such as when a new episode comes out. `episode` has the dates behind it, for the TV's own page.
- `build` and `change`: the TV is making an app, or wants an adult's OK to change one. With `askbuilds` on, the state's `ask` has what to show.
- `none`: nothing happened, and `say` is why in a line. `why` is a word for the kind of reason: `unroutable`, `unreadable`, `failed`, `missing`, `not-found`, `soon`, `not-opened`, `no-tmdb`, `child`, `no-ai`, `not-built`, `not-made` or `which`.
- In an `Item`, `poster` and `still` are web addresses of pictures, and `subtitle` is a line such as the artist.

The `said` in the answer to `POST /api/phone/say` and `say/pick` is the same object with one more field, `route`: what the AI made of the sentence. The state leaves it out.

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

## What's playing

This part is behind the `playing2` switch, which is off for now. `GET /api/phone/features` says whether it's on. While it's off, `nowPlaying` and `POST /api/phone/playback` are exactly as the tables above have them: the new actions get a `400` like any action the TV doesn't know, and the picture's address is a sealed `404` like any address that isn't there.

It's made for a card that shows what's playing while the phone is locked: where the thing is, a bar to drag, and buttons that can't do the wrong thing when a press goes out twice.

### `nowPlaying` with the switch on

`nowPlaying` is what's in front on the TV that can be steered, playing or paused. It's `null` when there's nothing.

```json
{
  "title": "Sintel",
  "app": "Jellyfin",
  "left": 11,
  "position": 232.4,
  "duration": 888,
  "at": "2026-11-17T20:15:03.120Z",
  "age": 4310,
  "playing": true,
  "next": false,
  "previous": false,
  "seek": true,
  "picture": true
}
```

| Field | What it is |
| --- | --- |
| `title` | What it's called: the app's own word for it, or the page's. |
| `app` | The app's name. `"Shared"` for something a phone sent to the TV. |
| `left` | Minutes left, counted when the answer was made. Missing for something live. The web remote's card shows it. |
| `position` | Where it is, in seconds from the start, when the TV read it. |
| `duration` | How long it runs, in seconds. `null` for something live. |
| `at` | When `position` was read: an ISO time, on the TV's clock. |
| `age` | How long ago `position` was read, in milliseconds, counted as this answer was made. |
| `playing` | `true` while it plays, `false` while it's paused. |
| `next` | Whether there's one after it to go to. |
| `previous` | Whether there's one before it to go to. |
| `seek` | Whether it can jump to a place. |
| `picture` | Whether `GET /api/phone/playing/picture` has a picture for it. |

Where the thing is right now is `position` while it's paused. While it plays, it's `position` plus the time since the TV read it, and `age` gives you that without the TV's clock:

1. When the answer arrives, take the time on your own clock and subtract `age`. That's when `position` was read, on your clock.
2. From then on, the place is `position` plus what your clock has run since that moment.

Stop at `duration`, and add nothing while it's paused. All this leaves out is the answer's trip over the home network, which is a few milliseconds.

`at` is the same moment on the TV's clock, for a client that trusts that clock. A TV and a phone can be seconds or hours apart, and a bar worked out from `at` is off by as much, so use `age` unless you have a reason not to.

A few things to know:

- `next`, `previous` and `seek` say what this app can do with this thing right now. Don't offer one that's `false`. Asking anyway gets `"ok": false` and a sentence in `why`.
- `tv.playing` is still `true` only while something plays. Something paused is `nowPlaying` with `"playing": false`.
- The TV reads the place again when something starts, pauses or stops, after every playback request, and every 10 seconds while something is playing or paused in front.
- `age` is counted again for every answer. Between two reads of the state with nothing new read on the TV, `position` and `at` are the same and `age` is higher by the time between them. The TV counts it on a clock that only runs forward, so it stays right when the TV sets its own clock.
- The state's `version` doesn't go up just because time passed. It goes up when it's another thing, when it was paused or played, when it jumped by more than 2 seconds, when its length changed, when a picture was found, or when what it can do changed. So the long poll stays quiet through a film, and still tells you about a jump somebody made with the TV's own remote, within 10 seconds.
- A native app, such as a game, has no `nowPlaying`. The TV can't see into it.
- There's no volume, here or anywhere else in this API. The TV keeps its own.

### The requests

All of them are `POST /api/phone/playback` with a sealed body:

| Body | What it does |
| --- | --- |
| `{"action":"play"}` | Plays. Does nothing when it's already playing. |
| `{"action":"pause"}` | Pauses. Does nothing when it's already paused. |
| `{"action":"next"}` | Goes to the one after, where there is one. |
| `{"action":"previous"}` | Goes to the one before, where there is one. |
| `{"action":"seek","position":754}` | Jumps to a place, in seconds from the start. `position` is a number from 0 to 86400. A place past the end stops at the end. |
| `{"action":"toggle"}` | Plays or pauses, whichever it isn't doing. It's as it was, for the web remote, and its answer has no `nowPlaying`. |

Use `play` and `pause` for anything that can send a press twice. A `toggle` sent twice undoes itself.

The answer to every action but `toggle` has `nowPlaying`: the same object as in the state, read after the request was done, so it says where the thing then is. It has its own `age`. That's usually a few milliseconds, since the place was read just before the answer left. Use it all the same: when the wait runs out, `nowPlaying` is what the TV last knew.

```json
{ "ok": true, "by": "app", "nowPlaying": { "title": "Sintel", "position": 754, "age": 6, "playing": true } }
```

(The example leaves out the rest of `nowPlaying`'s fields.) When it didn't work the status is still `200`:

```json
{ "ok": false, "why": "This app can't go back", "nowPlaying": { "title": "Sintel", "position": 232.4, "age": 9, "playing": true } }
```

- `by` says who did it: `"app"` for the app's own player, `"page"` for the video on the page, `"key"` for a media key sent to a native app.
- `why` is a sentence for the person, such as `Nothing is playing`, `This app can't skip`, `This app can't go back`, `This app can't jump to a time`, `Couldn't jump there`, `Couldn't pause` or `Couldn't play`.
- `nowPlaying` is `null` when nothing is left to steer. Right after `next`, `previous` or a jump to the end of a track in Music it can be `null`, or still the old title, while the new one loads. The state follows once it's there.
- A native app has one key for play and pause, which can't say which way it went. So `play`, `pause` and `seek` answer `"ok": false` there, and `toggle`, `next` and `previous` send the key.
- `400` is an action the TV doesn't know, or a `seek` with no `position` in range. `503` with `Your TV isn't ready yet` means the TV's screen session isn't running.

### How long an answer can take

Nearly every answer comes in well under a second. But the TV asks the app in front first, and an app that steers its own player may wait for that player:

| Request | The longest it waits |
| --- | --- |
| `toggle`, and `next` with the `playing2` switch off | 12 seconds |
| `play`, `pause`, `previous`, `seek`, and `next` with `playing2` on | 20 seconds |
| `POST /api/phone/text` | 3 seconds |
| `GET /api/phone/state` with the current `since` | 25 seconds |

The TV gives an app's own call 10 seconds, then tries the video on the page, then reads where the thing is. If the wait runs out, the answer is `200` with `{"ok":false,"why":"Your TV isn't ready yet"}`, and `nowPlaying` as the TV last knew it where the action has one. Give each request a timeout a little longer than its row.

### The picture

```
GET /api/phone/playing/picture
```

It answers `200` with the picture as it is, with its own content type (`image/jpeg`, `image/png`, `image/webp`, `image/gif` or `image/avif`), up to 5 MB, and it isn't sealed. With no picture it's a sealed `404` with `{"ok":false,"error":"There's no picture for what's playing"}`. Like everything under `/api/phone` past the hello, it needs a signed request, so only a paired phone gets it.

The picture is one the TV already has for the title: the one the app itself gives for it, the one on the app's tile, the poster from New this week, or the album's cover when Music plays. Nothing new is looked up for it, so plenty of titles have none. `picture` in `nowPlaying` says whether there's one, and it can turn `true` a moment after the title shows up. Fetch it again when `title` or `app` changes.

### What can do what

- **An app with a video on its page** can play, pause and jump. `next` and `previous` are there only when the app has its own for them, and can say at any moment that there's none right now.
- **Music** can play, pause and jump to a place in the track. `next` and `previous` are `true` only where its queue has a track to go to. The queue is the album or the playlist from the track that was started, so the first track played has no `previous` and the last has no `next`. A jump to the end of a track, or past it, ends the track: the next one starts, or after the last one nothing is playing.
- **Something a phone sent to the TV** can play, pause and jump.
- **A native app** takes the media keys for `toggle`, `next` and `previous`, and nothing else.

## Test vectors

`test/origaitv/fixtures/phone-channel/vectors.json` has one run of everything above with fixed values:

- `pairings`: one by the QR code's secret, one by a typed code, and one by the secret with a TV that has a box id. Each has the TV's code and secret, both X25519 pairs, `k`, the request and the answer as they go on the wire, the shared X25519 value, and `phoneKey`. The TV's part is under `tv`, with the QR code's secret as `tv.secret`. The third has the id as `tv.boxId`, and its answer has the `boxId` and the `confirm` that covers it. The first two are a TV with no id.
- `pairingAnswersToRefuse`: answers to a pairing that a phone has to refuse, and keep no key from. `pairing` says which of `pairings` it answers, counting from 0. The id changed on the way, the id taken out, the id with a `confirm` made the way of a pairing without one, an id put into the answer of a TV that has none, and a TV key of 32 zero bytes, which makes the exchange come to all zeros, with a `confirm` that fits it.
- `session.hello`: the request, both nonces and the answer. `session.derived` has `sign`, `up` and `down`.
- `session.requests`: six requests the TV takes, counters 1 to 6. A sealed `POST`, a `GET` with a query, the PIN, a request with a grant, an upload with an address the wire escapes, and a `403` that comes back sealed. Each has the nonce, the extra data, the digest, the signed text, the headers and the body, and the answer's nonce, extra data and sealed bytes.
- `session.refused`: requests the TV refuses, with the plain `401` each gets. A replayed counter, a body changed on the way, JSON that isn't sealed, a counter of 0. One of them has a good signature over a body with a bad tag, which gets the sealed `400`.
- `session.window`: counters 200, 72 and 73, for the edge of the window.
- `session.answersToRefuse`: answers to the first request that a phone has to refuse. A bad tag, the wrong status, another request's answer, the phone's own request played back, and two that aren't sealed.
- `session.pad`: game mode. `open` is the request that opens the connection, with its headers and the `101`. `up` is two states from the phone and `down` the TV's messages, each with its number, its plain bytes, its nonce, its extra data and the whole message. `dropped` is what the TV drops after those two: a replay, a used number, a state that isn't sealed, one sealed by another session (`otherSession` has its key), one for another connection, one with the wrong key, a changed tag, and one that opens and isn't a state. `after` is the next message it takes. `downToRefuse` is what a phone has to drop.

The file says which fields are plain text. Everything else is base64url.

To check a client against it, feed it the file's "random" values in place of its own: the phone's X25519 private key, the hello's nonce and each request's nonce. It should produce the file's requests byte for byte, and open the file's answers. For each of `pairingAnswersToRefuse`, give it that pairing's private key and the answer: it should refuse, and be no more paired than it was.

The file is made by `make-vectors.mts` next to it, which uses only Node's crypto and none of the daemon's channel code:

```bash
node test/origaitv/fixtures/phone-channel/make-vectors.mts
```

`test/origaitv/unit/phone-channel-vectors.test.mts` replays it, and fails if the file isn't what the script makes. `test/origaitv/unit/phonepad-vectors.test.mts` replays game mode's part, through the TV's side and the phone's.
