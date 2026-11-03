// Shared to the TV (daemon/shared.ts, ADR-050, S5.10): a link, a photo or a
// video from a paired phone, each kept with who sent it and checked to be
// what it says, a video written to disk as it comes. The TV asks about one
// only with home in front and nothing playing, a child's profile takes them
// only once an adult allowed it, and each stays until someone takes it off.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { cleanLink, Shared, videoType } from "../../../daemon/shared.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-shared-"));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
// An MP4's first box, then what plays, made up.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("isomiso2"), Buffer.alloc(4000, 7)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 9)]);
const who = { from: "radomir on iphone", to: "radomir" };

let daemon: Daemon;
let url = "";
let lan = "";
let token = "";

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  process.env.AGENTV_PASSWD = join(scratch, "passwd");
  writeFileSync(process.env.AGENTV_PASSWD, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  daemon = new Daemon({ root: join(scratch, "root"), state: join(scratch, "state"), backgrounds: join(scratch, "backgrounds"), shared: join(scratch, "shared"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
});

after(async () => {
  await daemon.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(scratch, { recursive: true, force: true });
});

async function tv(method: string, path: string, body?: unknown, grant?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

async function share(kind: "link" | "photo" | "video", body: unknown, query = "") {
  const json = kind === "link";
  const response = await fetch(`${lan}/api/phone/share/${kind}${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": json ? "application/json" : kind === "photo" ? "image/jpeg" : "video/mp4" },
    body: json ? JSON.stringify(body) : new Uint8Array(body as Buffer),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

const context = (change: Record<string, unknown>) => tv("POST", "/api/tv/context", change);
const grant = async () => (await tv("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;

test("a video is known by its own first bytes, and a link is a web page with no password in it", () => {
  assert.equal(videoType(MP4), "video/mp4");
  assert.equal(videoType(WEBM), "video/webm");
  assert.equal(videoType(JPEG), null);
  assert.equal(videoType(Buffer.from("<html>")), null);
  assert.deepEqual(cleanLink(" https://www.example.org/a?b=1 "), { url: "https://www.example.org/a?b=1", site: "example.org" });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://ana:secret@example.org/", "not a link", "", 42, `https://example.org/${"x".repeat(2100)}`]) {
    assert.ok("error" in cleanLink(bad), String(bad).slice(0, 40));
  }
});

test("a video comes to disk as it's sent, kept only once it's all here and plays, and one too big is refused", async () => {
  const store = new Shared({ dir: join(scratch, "store") });
  const kept = await store.addVideo(Readable.from([MP4.subarray(0, 10), MP4.subarray(10)]), "beach.mp4", who);
  assert.equal(kept.share?.type, "video/mp4");
  assert.equal(kept.share?.size, MP4.length);
  assert.equal(kept.share?.title, "beach.mp4");
  assert.equal((await store.file(kept.share!.id))?.size, MP4.length);
  assert.match((await store.addVideo(Readable.from([MP4]), "big.mp4", who, 1000)).error!, /too big/);
  assert.match((await store.addVideo(Readable.from([JPEG]), "photo.mp4", who)).error!, /mp4 or webm/);
  // Nothing half-sent is left behind.
  assert.deepEqual(readdirSync(join(scratch, "store")).filter((name) => name.startsWith(".")), []);
  // Two at once are both kept.
  await Promise.all([store.addLink("https://one.example/", who), store.addLink("https://two.example/", who)]);
  assert.deepEqual((await store.list()).map((one) => one.title).slice(0, 2).sort(), ["one.example", "two.example"]);
  assert.equal(await store.remove(kept.share!.id), true);
  assert.equal(await store.file(kept.share!.id), null);
});

test("S5.10 a link from a paired phone waits for Open on the TV, and only once nothing's playing", async () => {
  await context({ front: "app", playing: true });
  const sent = await share("link", { url: "https://www.example.org/watch" });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.waits, true, "the phone hears it waits while something plays");
  assert.equal(sent.data.share.from, "radomir on iphone");
  assert.equal(sent.data.share.title, "example.org");
  let shared = (await tv("GET", "/api/shared")).data;
  assert.deepEqual(shared.shares.map((one: any) => one.kind), ["link"]);
  assert.equal(shared.ask, null, "never over what's playing");
  // Home again with nothing playing: the TV asks about it now.
  await context({ front: "home", playing: false });
  shared = (await tv("GET", "/api/shared")).data;
  assert.equal(shared.ask, sent.data.share.id);
  // Not now: it doesn't ask again, and it stays in Apps → Shared.
  assert.equal((await tv("POST", `/api/shared/${sent.data.share.id}/answer`)).status, 200);
  shared = (await tv("GET", "/api/shared")).data;
  assert.equal(shared.ask, null);
  assert.equal(shared.shares[0].answered, true);
  // Not a web page, or no phone, isn't taken.
  assert.equal((await share("link", { url: "javascript:alert(1)" })).status, 400);
  assert.equal((await fetch(`${lan}/api/phone/share/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.org/" }) })).status, 401);
});

test("S5.10 a photo is kept with its credit, asked about at once on an idle home, served to the TV and can be the background", async () => {
  const sent = await share("photo", JPEG, "?credit=photo%20by%20ana");
  assert.equal(sent.status, 200);
  assert.equal(sent.data.waits, false);
  assert.equal(sent.data.share.credit, "photo by ana");
  assert.equal((await tv("GET", "/api/shared")).data.ask, sent.data.share.id);
  const file = await fetch(`${url}/api/shared/${sent.data.share.id}/file`);
  assert.equal(file.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), JPEG);
  const background = await tv("POST", `/api/shared/${sent.data.share.id}/background`);
  assert.equal(background.status, 200);
  assert.deepEqual(background.data.background.credit, { text: "photo by ana", from: "radomir on iphone" });
  assert.equal((await tv("GET", "/api/backgrounds")).data.current, background.data.background.id);
  // Not a picture, or too big, isn't taken.
  assert.equal((await share("photo", Buffer.from("<svg onload=alert(1)>"))).status, 400);
  assert.equal((await share("photo", Buffer.alloc(16 * 1024 * 1024))).status, 413);
});

test("S5.10 a video plays from the box in parts, as a player seeks, and only a photo becomes the background", async () => {
  const sent = await share("video", MP4, "?name=beach.mp4");
  assert.equal(sent.status, 200);
  assert.equal(sent.data.share.type, "video/mp4");
  const id = sent.data.share.id;
  const part = await fetch(`${url}/api/shared/${id}/file`, { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${MP4.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), MP4.subarray(100, 200));
  const end = await fetch(`${url}/api/shared/${id}/file`, { headers: { Range: "bytes=-16" } });
  assert.deepEqual(Buffer.from(await end.arrayBuffer()), MP4.subarray(MP4.length - 16));
  assert.equal((await fetch(`${url}/api/shared/${id}/file`, { headers: { Range: `bytes=${MP4.length}-` } })).status, 416);
  assert.equal((await tv("POST", `/api/shared/${id}/background`)).status, 400);
  assert.equal((await share("video", JPEG)).status, 400);
  // Taken off, it's gone with its file.
  assert.equal((await tv("DELETE", `/api/shared/${id}`)).status, 200);
  assert.equal((await fetch(`${url}/api/shared/${id}/file`)).status, 404);
  assert.ok(!readdirSync(join(scratch, "shared")).some((name) => name.startsWith(id)));
});

test("S5.10 a child's profile takes shares only once an adult allowed it, and sees only its own", async () => {
  assert.equal((await tv("PUT", "/api/pin", { pin: "4826" })).status, 200);
  const mila = (await tv("POST", "/api/viewers", { name: "mila", role: "child" }, await grant())).data.profile;
  assert.equal((await tv("POST", "/api/viewer", { id: mila.id })).status, 200);
  const refused = await share("link", { url: "https://example.org/cartoons" });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, "mila's profile doesn't take shares. an adult can allow it in settings → profiles");
  assert.deepEqual((await tv("GET", "/api/shared")).data.shares, [], "a child doesn't see what was sent to an adult");
  // Allowing it is changing a profile, past the PIN.
  assert.equal((await tv("PUT", `/api/viewers/${mila.id}`, { shares: true })).status, 403);
  assert.equal((await tv("PUT", `/api/viewers/${mila.id}`, { shares: true }, await grant())).status, 200);
  assert.deepEqual((await tv("GET", "/api/shared")).data.allowed, [mila.id]);
  const sent = await share("link", { url: "https://example.org/cartoons" });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.share.from, "mila on iphone");
  assert.deepEqual((await tv("GET", "/api/shared")).data.shares.map((one: any) => one.id), [sent.data.share.id]);
  // Taking a share off on a child's profile needs the PIN.
  assert.equal((await tv("DELETE", `/api/shared/${sent.data.share.id}`)).status, 403);
  // Back to the adult: they see every share. A profile taken off takes its
  // shares and its allowance with it.
  assert.equal((await tv("POST", "/api/viewer", { id: "radomir" }, await grant())).status, 200);
  assert.ok((await tv("GET", "/api/shared")).data.shares.some((one: any) => one.id === sent.data.share.id));
  assert.equal((await tv("DELETE", `/api/viewers/${mila.id}`, undefined, await grant())).status, 200);
  const after = (await tv("GET", "/api/shared")).data;
  assert.ok(!after.shares.some((one: any) => one.id === sent.data.share.id));
  assert.deepEqual(after.allowed, []);
  assert.ok(existsSync(join(scratch, "shared", "shared.json")));
});
