// A page app's photos and music (daemon/page-media.ts, ADR-043, S6.7's
// parts here): Music's sources, read-only, only for an app the daemon says
// declared them, and nothing outside a source.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PageMedia } from "../../../daemon/page-media.ts";
import type { Source } from "../../../daemon/storage.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-page-media-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const nas = join(scratch, "nas");
const outside = join(scratch, "outside");
for (const dir of [join(nas, "2024", "summer"), join(nas, ".hidden"), join(nas, "@eaDir"), outside]) mkdirSync(dir, { recursive: true });
writeFileSync(join(nas, "a.jpg"), "photo a");
writeFileSync(join(nas, "b.png"), "photo b");
writeFileSync(join(nas, "notes.txt"), "not a photo");
writeFileSync(join(nas, "2024", "summer", "beach.jpg"), "beach");
writeFileSync(join(nas, ".hidden", "secret.jpg"), "hidden");
writeFileSync(join(outside, "private.jpg"), "private");
writeFileSync(join(outside, "song.mp3"), "outside song");
symlinkSync(join(outside, "private.jpg"), join(nas, "linked.jpg"));
symlinkSync(outside, join(nas, "away"));
mkdirSync(join(nas, "music"));
writeFileSync(join(nas, "music", "one.mp3"), "a song");

// ffmpeg's stand-in: it copies the photo to where it's asked to write, with
// the width it was given in front.
const ffmpeg = join(scratch, "ffmpeg");
writeFileSync(ffmpeg, '#!/bin/bash\nin=""; for ((i=1;i<=$#;i++)); do [[ ${!i} == -i ]] && { j=$((i+1)); in=${!j}; }; [[ ${!i} == -vf ]] && { j=$((i+1)); vf=${!j}; }; done\nout=${@: -1}\n{ printf "%s|" "$vf"; cat "$in"; } >"$out"\n');
chmodSync(ffmpeg, 0o755);

const source: Source = { id: "share:smb://nas/photos", kind: "share", name: "nas/photos", path: nas, available: true };
const asked: string[] = [];
let allowed = true;
const media = new PageMedia({
  storage: { paths: async () => [{ source, path: nas }] },
  library: {
    load: async () => ({ scannedAt: "", tracks: { t1: { id: "t1", path: join(nas, "music", "one.mp3"), title: "One", artist: "Band", album: "First", albumArtist: "Band", albumId: "a1", year: "", number: 1, disc: 1, duration: 61, source: source.id, size: 6, mtime: 0 } }, albums: {}, playlists: {} }) as never,
    albums: async () => [{ id: "a1", title: "First", artist: "Band", year: "", cover: false, tracks: ["t1"], source: source.id }],
    album: async () => null,
  },
  allowed: async (app, call) => {
    asked.push(`${app} ${call}`);
    return allowed ? null : "agentv.blocks didn't declare what photos.list needs";
  },
  cache: join(scratch, "cache"),
  ffmpeg,
});

async function value<T>(call: string, ...args: unknown[]): Promise<T> {
  const reply = await media.handle("agentv.album", call, args);
  assert.ok(reply.ok, reply.error);
  return reply.value as T;
}

test("S6.7 the sources are Music's, named, with no path on the box", async () => {
  const sources = await value<{ id: string; name: string; kind: string }[]>("photos.sources");
  assert.deepEqual(sources.map(({ name, kind }) => ({ name, kind })), [{ name: "nas/photos", kind: "share" }]);
  assert.match(sources[0].id, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(sources).includes(scratch));
});

test("S6.7 a folder's photos and folders, a page at a time, with nothing hidden", async () => {
  const [{ id }] = await value<{ id: string }[]>("photos.sources");
  const top = await value<{ folders: string[]; photos: { id: string; name: string; folder: string }[]; total: number }>("photos.list", id, {});
  assert.deepEqual(top.folders, ["2024", "music"]);
  assert.deepEqual(top.photos.map((p) => p.name), ["a.jpg", "b.png"]);
  assert.equal(top.total, 2);
  const page = await value<{ photos: { name: string }[]; total: number }>("photos.list", id, { offset: 1, limit: 1 });
  assert.deepEqual(page.photos.map((p) => p.name), ["b.png"]);
  const summer = await value<{ photos: { name: string; folder: string }[] }>("photos.list", id, { folder: "2024/summer" });
  assert.deepEqual(summer.photos.map((p) => `${p.folder}/${p.name}`), ["2024/summer/beach.jpg"]);
  for (const folder of ["../outside", "2024/../..", ".hidden", "@eaDir", "/etc"]) {
    const reply = await media.handle("agentv.album", "photos.list", [id, { folder }]);
    assert.equal(reply.ok, false, folder);
  }
  assert.equal((await media.handle("agentv.album", "photos.list", ["nope", {}])).ok, false);
});

test("S6.7 a photo whole, or scaled down by ffmpeg and kept", async () => {
  const [{ id }] = await value<{ id: string }[]>("photos.sources");
  const { photos } = await value<{ photos: { id: string; name: string }[] }>("photos.list", id, {});
  const whole = await value<{ type: string; bytes: string }>("photos.image", photos[0].id);
  assert.equal(whole.type, "image/jpeg");
  assert.equal(Buffer.from(whole.bytes, "base64").toString(), "photo a");
  const small = await value<{ type: string; bytes: string }>("photos.image", photos[1].id, 320);
  assert.equal(small.type, "image/jpeg");
  assert.equal(Buffer.from(small.bytes, "base64").toString(), "scale='min(320,iw)':-2|photo b");
  // The second time comes from the cache.
  writeFileSync(ffmpeg, "#!/bin/bash\nexit 1\n");
  const again = await value<{ bytes: string }>("photos.image", photos[1].id, 320);
  assert.equal(Buffer.from(again.bytes, "base64").toString(), "scale='min(320,iw)':-2|photo b");
});

test("ADR-043 S6.8 nothing outside a source, through a link or a made-up id", async () => {
  const [{ id }] = await value<{ id: string }[]>("photos.sources");
  const made = (rel: string) => Buffer.from(JSON.stringify([id, rel])).toString("base64url");
  for (const rel of ["linked.jpg", "away/private.jpg", "../outside/private.jpg", ".hidden/secret.jpg", "notes.txt"]) {
    const reply = await media.handle("agentv.album", "photos.image", [made(rel)]);
    assert.equal(reply.ok, false, rel);
  }
  assert.equal((await media.handle("agentv.album", "photos.image", ["not-an-id"])).ok, false);
  assert.equal((await media.handle("agentv.album", "music.track", [made("away/song.mp3")])).ok, false);
});

test("the music library's albums, and a track's file", async () => {
  const albums = await value<{ title: string; tracks: { id: string; title: string; seconds?: number }[] }[]>("music.albums");
  assert.equal(albums[0].title, "First");
  assert.equal(albums[0].tracks[0].title, "One");
  const track = await value<{ type: string; bytes: string }>("music.track", albums[0].tracks[0].id);
  assert.equal(track.type, "audio/mpeg");
  assert.equal(Buffer.from(track.bytes, "base64").toString(), readFileSync(join(nas, "music", "one.mp3"), "utf8"));
});

test("ADR-043 the daemon says yes first, for every call", async () => {
  asked.length = 0;
  allowed = false;
  const reply = await media.handle("agentv.blocks", "photos.list", ["x", {}]);
  assert.deepEqual(reply, { ok: false, error: "agentv.blocks didn't declare what photos.list needs" });
  assert.deepEqual(asked, ["agentv.blocks photos.list"]);
  allowed = true;
});
