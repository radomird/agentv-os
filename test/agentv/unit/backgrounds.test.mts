// The backgrounds (daemon/backgrounds.ts, ADR-012, S5.3): a photo from the
// phone becomes the background, kept with its credit, checked to be a
// picture by its own bytes, and the oldest goes once there are too many. And
// what the TV and the phone may do with them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Backgrounds, creditText, imageType, MAX_PHOTOS } from "../../../daemon/backgrounds.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-backgrounds-"));
// The smallest pictures of each kind, by their first bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64, 3)]);

let daemon: Daemon;
let url = "";
let lan = "";
let token = "";

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "root"), state: join(scratch, "state"), backgrounds: join(scratch, "backgrounds"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const send = (body: Buffer, credit = "", auth = token) =>
  fetch(`${lan}/api/phone/background?credit=${encodeURIComponent(credit)}`, { method: "POST", headers: { "Content-Type": "image/jpeg", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: new Uint8Array(body) });

test("a picture is known by its own first bytes, whatever it says it is", () => {
  assert.equal(imageType(JPEG), "image/jpeg");
  assert.equal(imageType(PNG), "image/png");
  assert.equal(imageType(WEBP), "image/webp");
  assert.equal(imageType(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

test("a credit is one line of plain text", () => {
  assert.equal(creditText("  photo by <b>ana</b> on unsplash  "), "photo by b ana /b on unsplash");
  assert.equal(creditText("photo\nby ana"), "photo by ana");
  assert.equal(creditText(""), null);
  assert.equal(creditText(42), null);
  assert.equal(creditText("x".repeat(300))?.length, 120);
});

test("S5.3 a photo becomes the background at once, kept with its credit, and the oldest goes once there are too many", async () => {
  const dir = join(scratch, "store");
  const store = new Backgrounds({ dir });
  assert.deepEqual(await store.read(), { source: "field", current: null, items: [] });
  assert.match((await store.add(Buffer.from("not a picture"), { from: "iphone" })).error ?? "", /jpeg, png or webp/);
  const first = await store.add(JPEG, { text: "photo by ana on unsplash", from: "radomir on iphone" });
  assert.equal(first.state?.source, "photos");
  assert.equal(first.state?.current, first.item?.id);
  assert.deepEqual(first.item?.credit, { text: "photo by ana on unsplash", from: "radomir on iphone" });
  assert.ok(existsSync(join(dir, `${first.item!.id}.jpg`)));
  assert.equal((await store.file(first.item!.id))?.type, "image/jpeg");
  assert.equal(await store.file("../backgrounds"), null);

  for (let i = 0; i < MAX_PHOTOS; i++) await store.add(PNG, { from: "iphone" });
  const now = await store.read();
  assert.equal(now.items.length, MAX_PHOTOS);
  assert.ok(!now.items.some((item) => item.id === first.item!.id), "the oldest went");
  assert.ok(!existsSync(join(dir, `${first.item!.id}.jpg`)), "and its file with it");
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".png")).length, MAX_PHOTOS);
});

test("the pixel field or the photos, and taking the last photo off goes back to the field", async () => {
  const store = new Backgrounds({ dir: join(scratch, "choose") });
  assert.match((await store.choose("photos")).error ?? "", /send a photo from your phone first/);
  assert.match((await store.choose("unsplash")).error ?? "", /a source/);
  const added = await store.add(WEBP, { from: "pixel" });
  assert.equal((await store.choose("field")).state?.source, "field");
  assert.equal((await store.choose("photos", added.item!.id)).state?.current, added.item!.id);
  const removed = await store.remove(added.item!.id);
  assert.deepEqual([removed.state?.source, removed.state?.current, removed.state?.items.length], ["field", null, 0]);
});

test("S5.3 a photo shared from a paired phone becomes the TV's background, with its credit, and the TV hears it", async () => {
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  assert.equal((await send(JPEG, "photo by ana", "")).status, 401, "only a paired phone");
  const reply = await send(JPEG, "photo by ana");
  assert.equal(reply.status, 200);
  const sent = (await reply.json()).background;
  let seen = "";
  while (!seen.includes("event: background")) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const list = await (await fetch(`${url}/api/backgrounds`)).json();
  assert.equal(list.source, "photos");
  assert.equal(list.current, sent.id);
  assert.equal(list.items[0].credit.text, "photo by ana");
  assert.match(list.items[0].credit.from, / on iphone$/, "who sent it, and from which phone");
  const picture = await fetch(`${url}/api/backgrounds/${sent.id}`);
  assert.equal(picture.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), JPEG);
  assert.equal((await fetch(`${lan}/api/backgrounds/${sent.id}`, { headers: { Authorization: `Bearer ${token}` } })).status, 404, "the phone's side has no pictures to give out");
});

test("too big, or not a picture, is refused; a child's profile can't send one; taking one off needs the PIN", async () => {
  assert.equal((await send(Buffer.concat([JPEG, Buffer.alloc(16 * 1024 * 1024)]))).status, 413);
  assert.equal((await send(Buffer.from("GIF89a"))).status, 400);
  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  const grant = (await (await fetch(`${url}/api/pin/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).json()).grant;
  const id = (await (await fetch(`${url}/api/backgrounds`)).json()).current;
  assert.equal((await fetch(`${url}/api/backgrounds/${id}`, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(`${url}/api/backgrounds/${id}`, { method: "DELETE", headers: { "X-AgenTV-Grant": grant } })).status, 200);
  const child = (await (await fetch(`${url}/api/viewers`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ name: "mia", role: "child" }) })).json()).profile;
  await fetch(`${url}/api/viewer`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ id: child.id }) });
  assert.equal((await send(JPEG)).status, 403);
});
