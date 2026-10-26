// Art from museum archives (daemon/art.ts, ADR-012): a search of The Met,
// the Art Institute of Chicago or Wikimedia Commons gives only works free to
// show, each with its credit; thumbnails come through the daemon from the
// archive's own image host and nowhere else; and a work picked is fetched
// whole and becomes the background, kept beside the household's photos.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { ArtArchives, commonsThumb, commonsUrl, commonsYear, licenceOf, person, plain } from "../../../daemon/art.ts";
import { Daemon } from "../../../daemon/server.ts";
import { startArchives, type Archives } from "../ui/archives.mts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-art-"));
let archives: Archives;
let daemon: Daemon;
let url = "";

before(async () => {
  archives = await startArchives();
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({
    root: join(scratch, "root"),
    state: join(scratch, "state"),
    backgrounds: join(scratch, "backgrounds"),
    art: archives.options,
    port: 0,
    log: () => {},
    builtins: null,
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
});

after(async () => {
  await daemon.close();
  archives.close();
  rmSync(scratch, { recursive: true, force: true });
});

const get = async (path: string) => {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
};

test("an archive's text is plain, and only free licences are shown", () => {
  assert.equal(plain('<a href="https://en.wikipedia.org/wiki/Claude_Monet" class="extiw">Claude Monet</a>&nbsp;'), "Claude Monet");
  assert.equal(plain("<script>alert(1)</script>Sea"), "alert(1) Sea");
  assert.equal(plain(""), null);
  assert.equal(person('<a href="//commons.wikimedia.org/wiki/User:JJ_Harrison">JJ Harrison</a> ( https://www.jjharrison.com.au/ )'), "JJ Harrison");
  assert.equal(licenceOf("Public domain"), "public domain");
  assert.equal(licenceOf("CC0"), "cc0");
  assert.equal(licenceOf("CC BY-SA 4.0"), "cc by-sa 4.0");
  assert.equal(licenceOf("CC BY 2.0"), "cc by 2.0");
  for (const no of ["Fair use", "CC BY-NC 4.0", "All rights reserved", null]) assert.equal(licenceOf(no), null, String(no));
  const original = "https://upload.wikimedia.org/wikipedia/commons/4/4f/Harbour_at_dusk.jpg";
  assert.equal(commonsThumb(original), "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Harbour_at_dusk.jpg/640px-Harbour_at_dusk.jpg");
  assert.equal(commonsThumb("https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/W.jpg/3840px-W.jpg"), "https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/W.jpg/640px-W.jpg");
  // As Commons gives them: with its tracking, and the day as words.
  assert.equal(commonsUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d1/S.jpg/3840px-S.jpg?utm_source=commons.wikimedia.org&utm_content=thumbnail"), "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d1/S.jpg/3840px-S.jpg");
  assert.equal(commonsYear("Taken on 30 January 2010"), "2010");
  assert.equal(commonsYear("2019-06-11 20:48"), "2019");
  assert.equal(commonsYear("unknown date"), null);
});

test("The Met: its public-domain works, each looked up and credited, and one that isn't left out", async () => {
  const { status, data } = await get("/api/art/search?archive=met&q=sea");
  assert.equal(status, 200);
  assert.deepEqual(
    data.items.map((work: { id: string; credit: string }) => [work.id, work.credit]),
    [
      ["502724", "Ensuranai · Sea Dayaks (Iban), 19th century · the met"],
      ["436021", "The Sea · Gustave Courbet, 1865 or later · the met"],
      ["361765", "Sea Storms · Wenceslaus Hollar, 1665 · the met"],
      ["195362", "Sea monster · Severo Calzetta da Ravenna, early 16th century · the met"],
      ["437914", "Calm Sea · Simon de Vlieger, after 1640 · the met"],
      ["207000", "Sea monster · Severo Calzetta da Ravenna, ca. 1500–1510 · the met"],
    ],
  );
  // The search can list one that isn't public domain (267004 for "sea" one
  // day): looked up, it isn't there to show.
  assert.equal((await get("/api/art/met/267004/thumb")).status, 404);
  assert.equal(data.items[1].page, "https://www.metmuseum.org/art/collection/search/436021");
  // The page gets no address of the archive's to fetch itself.
  assert.ok(data.items.every((work: object) => !("thumb" in work) && !("image" in work)));
  // AgenTV says who it is, as Wikimedia and the Art Institute ask.
  assert.match(String(archives.seen.find((one) => one.url.startsWith("/met/"))?.headers["user-agent"]), /^AgenTV\//);
});

test("the Art Institute and Commons: their works, with the licence when one asks for a credit", async () => {
  const aic = (await get("/api/art/search?archive=aic&q=water lilies")).data;
  assert.equal(aic.items.length, 6);
  assert.deepEqual([aic.items[0].id, aic.items[0].credit], ["16568", "Water Lilies · Claude Monet, 1906 · art institute of chicago"]);
  assert.equal(aic.items[0].page, "https://www.artic.edu/artworks/16568");
  assert.match(String(archives.seen.find((one) => one.url.startsWith("/aic/artworks/search"))?.url), /query\[term\]\[is_public_domain\]=true/);
  const commons = (await get("/api/art/search?archive=commons&q=harbour")).data;
  assert.equal(commons.items.length, 8);
  assert.deepEqual(
    commons.items.slice(0, 3).map((work: { id: string; credit: string }) => [work.id, work.credit]),
    [
      ["9428075", "Sydney Harbour Bridge from Circular Quay · JJ Harrison, 2010 · cc by-sa 3.0 · wikimedia commons"],
      ["37347823", "Puerto de Vestmannaeyjar, Heimaey, Islas Vestman, Suðurland, Islandia, 2014-08-17, DD 017-019 PAN · Diego Delso, 2014 · cc by-sa 4.0 · wikimedia commons"],
      ["37658477", "Sète Harbour Sunset 04 · Christian Ferrer, 2014 · cc by 4.0 · wikimedia commons"],
    ],
  );
  // Its thumbnail comes from Commons' thumbnail host, at the picker's width,
  // without the tracking.
  await get("/api/art/commons/37658477/thumb");
  assert.ok(archives.seen.some((one) => one.url.startsWith("/thumb/wikipedia/commons/thumb/b/b2/S%C3%A8te_Harbour_Sunset_04.jpg/640px-") && !one.url.includes("utm_")));
});

test("Commons: a file under a licence that doesn't let the TV show it, or that isn't a photo, is left out", async () => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/art/commons-search.json"), "utf8"));
  recorded.query.pages[0].imageinfo[0].extmetadata.LicenseShortName.value = "Fair use";
  recorded.query.pages[1].imageinfo[0].mime = "image/svg+xml";
  recorded.query.pages[2].imageinfo[0].extmetadata.LicenseShortName.value = "CC BY-NC 4.0";
  // Commons' own hosts, as a box has them; only the search is asked.
  const archive = new ArtArchives({
    cache: join(scratch, "commons"),
    userAgent: "AgenTV/test",
    endpoints: { commons: "https://commons.example/w/api.php" },
    fetch: async () => new Response(JSON.stringify(recorded), { headers: { "Content-Type": "application/json" } }),
  });
  const found = await archive.search("commons", "harbour");
  assert.deepEqual(found.items?.map((work) => work.id), ["44007484", "57807690", "82284212", "85066612", "94814881"]);
});

test("a search says what's wrong: an archive it doesn't know, no words, or the archive not answering", async () => {
  assert.deepEqual(await get("/api/art/search?archive=louvre&q=sea"), { status: 400, data: { ok: false, error: "an archive: met, aic, commons" } });
  assert.deepEqual(await get("/api/art/search?archive=met&q=%20"), { status: 400, data: { ok: false, error: "say what to look for" } });
  archives.down(429);
  try {
    assert.deepEqual(await get("/api/art/search?archive=commons&q=sea"), { status: 502, data: { ok: false, error: "wikimedia commons didn't answer: it answered 429" } });
  } finally {
    archives.down(null);
  }
  assert.deepEqual((await get("/api/art/search?archive=met&q=nothing like it")).data, { ok: true, items: [] });
});

test("a thumbnail comes through the daemon, once, and only for a work the archive has", async () => {
  await get("/api/art/search?archive=met&q=sea");
  const before = archives.seen.filter((one) => one.url.startsWith("/met-images/")).length;
  const first = await get("/api/art/met/436021/thumb");
  assert.equal(first.status, 200);
  assert.ok(Buffer.isBuffer(first.data) && first.data[0] === 0xff && first.data[1] === 0xd8);
  assert.equal((await get("/api/art/met/436021/thumb")).status, 200);
  assert.equal(archives.seen.filter((one) => one.url.startsWith("/met-images/")).length, before + 1, "kept after the first time");
  // Not public domain, not in the archive, not an archive.
  assert.equal((await get("/api/art/met/267004/thumb")).status, 404);
  assert.equal((await get("/api/art/met/999/thumb")).status, 404);
  assert.equal((await get("/api/art/louvre/1/thumb")).status, 404);
});

test("pictures come only from the archives' own image hosts", async () => {
  const strict = new ArtArchives({ cache: join(scratch, "strict"), userAgent: "AgenTV/test", endpoints: archives.options.endpoints });
  // The test server's pictures aren't on images.metmuseum.org.
  assert.deepEqual(await strict.search("met", "sea"), { items: [] });
  assert.equal(await strict.thumb("met", "436021"), null);
});

test("a work picked becomes the background, fetched whole and kept with its credit, beside the photos", async () => {
  const picked = await fetch(`${url}/api/backgrounds/art`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archive: "aic", id: "16568" }) });
  const data = await picked.json();
  assert.equal(picked.status, 200);
  assert.equal(data.source, "art");
  assert.deepEqual([data.background.kind, data.background.credit], ["art", { text: "Water Lilies · Claude Monet, 1906 · art institute of chicago", from: "art institute of chicago" }]);
  assert.equal(data.current, data.background.id);
  // The whole picture, at the largest size the Art Institute gives.
  assert.ok(archives.seen.some((one) => one.url === "/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/1686,/0/default.jpg"));
  const file = await get(`/api/backgrounds/${data.background.id}`);
  assert.equal(file.status, 200);

  // The photos stay the photos.
  assert.deepEqual((await (await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "photos" }) })).json()).error, "send a photo from your phone first");
  assert.equal((await (await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) })).json()).source, "field");
  assert.equal((await (await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "art" }) })).json()).source, "art");

  // One that can't be shown, or isn't there, isn't kept.
  const no = await fetch(`${url}/api/backgrounds/art`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archive: "met", id: "267004" }) });
  assert.deepEqual([no.status, (await no.json()).error], [502, "that work isn't in the archive, or can't be shown"]);
  assert.equal((await (await fetch(`${url}/api/backgrounds`)).json()).items.length, 1);
});
