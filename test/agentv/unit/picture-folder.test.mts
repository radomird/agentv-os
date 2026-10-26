// A folder's pictures as the background (daemon/picture-folder.ts, ADR-012):
// only pictures the TV can show, not too big, nothing hidden and no links
// out of the folder, up to 60 at random; and the daemon keeps them as the
// folder's, in place of the folder's from before.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FolderPictures, findPictures } from "../../../daemon/picture-folder.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-folder-"));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
let daemon: Daemon;
let home = "";

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "root"), state: join(scratch, "state"), backgrounds: join(scratch, "backgrounds"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  home = `http://127.0.0.1:${await daemon.listen()}/`;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

function folderOf(name: string, files: Record<string, Buffer | string>): string {
  const dir = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

test("only the pictures in a folder, its own and its folders', nothing hidden, and no link out of it", async () => {
  const outside = folderOf("outside", { "secret.jpg": JPEG });
  const dir = folderOf("pictures", {
    "a.jpg": JPEG,
    "b.PNG": PNG,
    "2025/summer/c.jpeg": JPEG,
    "notes.txt": "not a picture",
    "film.mp4": "not a picture",
    ".hidden/d.jpg": JPEG,
    "@eaDir/a.jpg/SYNOPHOTO_THUMB_XL.jpg": JPEG,
    "1/2/3/4/5/too-deep.jpg": JPEG,
    "empty.jpg": "",
  });
  symlinkSync(join(outside, "secret.jpg"), join(dir, "link.jpg"));
  symlinkSync(outside, join(dir, "linked-folder"));
  const found = (await findPictures(dir)).map((path) => path.slice(dir.length + 1)).sort();
  assert.deepEqual(found, ["2025/summer/c.jpeg", "a.jpg", "b.PNG"]);
  assert.equal((await findPictures(dir, 2)).length, 2, "no more than it's asked for");
  assert.deepEqual(await findPictures(join(scratch, "nowhere")), []);
});

test("a folder's pictures become the background, credited to the folder, in place of the folder's from before", async () => {
  const pictures = new FolderPictures({ home });
  const first = folderOf("first", { "a.jpg": JPEG, "b.jpg": JPEG, "c.png": PNG });
  assert.deepEqual(await pictures.send({ name: "nas/photos", path: first }), { ok: true, count: 3 });
  let now = await (await fetch(`${home}api/backgrounds`)).json();
  assert.equal(now.source, "folder");
  assert.deepEqual(now.items.map((item: { kind: string; credit: object }) => [item.kind, item.credit]), Array(3).fill(["folder", { text: null, from: "nas/photos" }]));

  // Another folder takes its place; the photos from a phone stay.
  const second = folderOf("second", { "d.jpg": JPEG, "not-really.jpg": "plain text" });
  assert.deepEqual(await pictures.send({ name: "usb stick", path: second }), { ok: true, count: 1 });
  now = await (await fetch(`${home}api/backgrounds`)).json();
  assert.deepEqual(now.items.map((item: { credit: { from: string } }) => item.credit.from), ["usb stick"]);

  assert.deepEqual(await pictures.send({ name: "empty", path: folderOf("empty", { "readme.txt": "hi" }) }), { ok: false, error: "there are no pictures in empty" });
  assert.deepEqual(await pictures.send({ name: "bad", path: folderOf("bad", { "x.jpg": "plain text" }) }), { ok: false, error: "none of the pictures in bad can be shown" });
  // The field, then the folder again, which still has its picture.
  assert.equal((await (await fetch(`${home}api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) })).json()).source, "field");
  assert.equal((await (await fetch(`${home}api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "folder" }) })).json()).source, "folder");
});

test("the daemon takes a folder's picture only when it's a picture, and not too big", async () => {
  const post = (body: Buffer, query = "from=nas") => fetch(`${home}api/backgrounds/folder?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) });
  assert.equal((await post(Buffer.from("<svg/>"))).status, 400);
  assert.equal((await post(Buffer.alloc(16 * 1024 * 1024, 0xff))).status, 413);
});
