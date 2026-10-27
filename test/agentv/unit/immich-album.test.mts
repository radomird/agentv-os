// An Immich album as the background (daemon/immich-album.ts, ADR-012),
// through the link its owner shared it with, against Immich 2.0's own
// recorded replies: the album's photos take the place of a folder's,
// credited to the album, and a link that isn't an album's, has a password,
// or isn't one at all says so and changes nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { shareLink } from "../../../daemon/immich-album.ts";
import { Daemon } from "../../../daemon/server.ts";
import { startImmichShare, type ImmichShare } from "../ui/immich-share.mts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-immich-"));
let immich: ImmichShare;
let daemon: Daemon;
let url = "";

before(async () => {
  immich = await startImmichShare();
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "root"), state: join(scratch, "state"), backgrounds: join(scratch, "backgrounds"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  url = `http://127.0.0.1:${await daemon.listen()}`;
});

after(async () => {
  await daemon.close();
  immich.close();
  rmSync(scratch, { recursive: true, force: true });
});

const use = async (link: unknown) => {
  const response = await fetch(`${url}/api/backgrounds/immich`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link }) });
  return { status: response.status, data: await response.json() };
};
const backgrounds = async () => (await fetch(`${url}/api/backgrounds`)).json();

test("an album's shared link: Immich's own address, under a path too, and its key", () => {
  assert.deepEqual(shareLink("https://photos.example/share/AbC_123-xyz"), { server: "https://photos.example", key: "AbC_123-xyz" });
  assert.deepEqual(shareLink(" http://192.168.1.20:2283/immich/share/AbC_123-xyz/ "), { server: "http://192.168.1.20:2283/immich", key: "AbC_123-xyz" });
  for (const no of ["https://photos.example/albums/123", "ftp://photos.example/share/AbC_123-xyz", "https://me:pw@photos.example/share/AbC_123-xyz", "https://photos.example/share/short", "https://photos.example/share/a b c d e f g h", "photos.example/share/AbC_123-xyz", 42]) {
    assert.equal(shareLink(no), null, String(no));
  }
});

test("the album's photos become the background, credited to it, in place of a folder's", async () => {
  const { status, data } = await use(immich.link);
  assert.equal(status, 200);
  assert.deepEqual([data.album, data.count, data.source], ["Autumn", 2, "folder"]);
  assert.deepEqual(data.items.map((item: { kind: string; credit: object }) => [item.kind, item.credit]), Array(2).fill(["folder", { text: null, from: "Autumn · immich" }]));
  // Only with the link's key, and only Immich's previews.
  assert.ok(immich.seen.every((path) => path.includes("key=fixture-key")));
  assert.equal(immich.seen.filter((path) => path.includes("/thumbnail?size=preview")).length, 2);
  const picture = await fetch(`${url}/api/backgrounds/${data.current}`);
  assert.equal(picture.headers.get("content-type"), "image/jpeg");
});

test("a link that isn't an album's, has a password, or isn't one says so, and the pictures stay", async () => {
  const had = (await backgrounds()).items.length;
  assert.deepEqual(await use("https://photos.example/albums/1"), { status: 400, data: { ok: false, error: "an album's shared link looks like https://photos.example/share/…" } });
  assert.deepEqual(await use(`${immich.url}/share/not-the-key`), { status: 400, data: { ok: false, error: "immich didn't take that link: invalid share key" } });
  immich.editLink((body) => (body.password = "secret"));
  assert.deepEqual(await use(immich.link), { status: 400, data: { ok: false, error: "that link has a password. share the album without one" } });
  immich.editLink((body) => ((body.password = null), (body.type = "INDIVIDUAL"), delete body.album));
  assert.deepEqual(await use(immich.link), { status: 400, data: { ok: false, error: "that link is to some photos, not an album" } });
  immich.editLink((body) => ((body.type = "ALBUM"), (body.album = { id: "00000000-0000-0000-0000-000000000001", albumName: "Autumn" })));
  // Nothing at that address.
  const nowhere = await use("http://127.0.0.1:9/share/fixture-key");
  assert.equal(nowhere.status, 400);
  assert.match(nowhere.data.error, /^immich didn't answer: /);
  assert.equal((await backgrounds()).items.length, had);
});
