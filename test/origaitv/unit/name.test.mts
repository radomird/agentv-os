// A name of its own for the TV (PHASE-2-PLAN.md track 28, T28.5's unit
// half), behind the announce switch: the TV is OrigaiTV until somebody names
// it, a name is cleaned and cut before it's kept, the phone's state and the
// hand-over to root carry it, an adult changes it from the TV's pages or
// from a paired phone, with the PIN once there is one, and a child's profile
// can't from a phone. With the switch off there's no name anywhere and the
// routes aren't there. What root does with a name is
// bin/origaitv-announce-set's, which the last tests here run for real on
// what the daemon kept, and announce-test.sh checks on its own.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Announce, cleanName, DEFAULT_NAME, NAME_BYTES, NAME_MAX, tvName } from "../../../daemon/announce.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "origaitv-name-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
const fresh = (name: string): string => {
  const dir = join(scratch, `${name}-${count++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const bytes = (text: string) => Buffer.byteLength(text);
const characters = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

// What bin/origaitv-announce-set takes for a name, written out again here so
// the two can't drift apart unseen: 1 to 63 bytes, no space at either end,
// and none of the code points it refuses.
function rootTakes(name: string): boolean {
  if (bytes(name) < 1 || bytes(name) > 63 || name.startsWith(" ") || name.endsWith(" ")) return false;
  return Array.from(name).every((one) => {
    const code = one.codePointAt(0)!;
    // Half of a pair comes out of jq as U+FFFD, or stops it reading at all.
    if (code >= 0xd800 && code <= 0xdfff) return false;
    return code >= 32 && (code < 127 || code > 159) && (code < 0xfdd0 || code > 0xfdef) && code !== 0xfffd && code % 65536 < 65534;
  });
}

test("T28.5 a name is trimmed, loses its control characters, and is cut at 30 characters and 63 bytes, between two characters", () => {
  assert.equal(DEFAULT_NAME, "OrigaiTV");
  assert.deepEqual([NAME_MAX, NAME_BYTES], [30, 63]);

  // As typed.
  for (const name of ["Living room", "Dnevna soba", "Küche", "📺 Den", "Küche 📺", "寝室", "Tom & Jerry's <TV> \"%h\"", "a  b", "OrigaiTV"]) assert.equal(cleanName(name), name);

  // Trimmed, and nothing left isn't a name.
  assert.equal(cleanName("  Living room \n"), "Living room");
  assert.equal(cleanName(" Bedroom　"), "Bedroom", "whatever kind of space it is");
  for (const nothing of ["", " ", "   ", "\n", "\t \r", "\u0000", "\u001b", "\ud83d", "�", "￿"]) assert.equal(cleanName(nothing), null, JSON.stringify(nothing));
  for (const nothing of [undefined, null, 7, true, ["Living room"], { name: "Living room" }]) assert.equal(cleanName(nothing), null, "only text is a name");

  // Control characters are dropped, the way a phone's name drops them, and
  // the ones past U+007F with them.
  assert.equal(cleanName("Living\nroom"), "Livingroom");
  assert.equal(cleanName("Li\u0000vi\tng\r \u001b[31mroom\u007f\u0085\u009f"), "Living [31mroom");
  // So is half of a pair, the code points Avahi refuses a name for, and the
  // one root reads as bytes that weren't UTF-8.
  assert.equal(cleanName("a\ud83db\udcfac"), "abc");
  assert.equal(cleanName("a﷐b﷯c￾d￿e\u{1fffe}f\u{10ffff}g�h"), "abcdefgh");
  assert.equal(cleanName("\u{1f4fa}"), "📺", "a whole pair is a character");

  // 30 characters at most, counted as a person sees them.
  assert.equal(cleanName("a".repeat(31)), "a".repeat(30));
  assert.equal(cleanName("a".repeat(200)), "a".repeat(30));
  assert.equal(cleanName("ü".repeat(40)), "ü".repeat(30), "30 characters of 2 bytes each fit in 63 bytes");
  assert.equal(cleanName(`${"a".repeat(29)} b`), "a".repeat(29), "a space the cut left at the end goes too");
  const decomposed = "é".repeat(40);
  assert.equal(cleanName(decomposed), "é".repeat(21), "a letter and its accent are one character, kept whole or not at all");

  // 63 bytes at most, cut between two characters and never inside one.
  assert.equal(cleanName("€".repeat(30)), "€".repeat(21), "21 characters of 3 bytes are 63 bytes");
  assert.equal(cleanName("📺".repeat(30)), "📺".repeat(15), "15 emoji of 4 bytes are 60, and a 16th would be 64");
  assert.equal(cleanName(`${"a".repeat(62)}ü`), "a".repeat(30));
  assert.equal(cleanName(`${"€".repeat(20)}ab📺`), `${"€".repeat(20)}ab`, "an emoji that doesn't fit is left off whole");
  const family = "👨‍👩‍👧‍👦";
  assert.equal(bytes(family), 25);
  assert.equal(cleanName(family.repeat(3)), family.repeat(2), "a family of four is one character of 25 bytes: two fit, and the third isn't cut in half");
  assert.equal(cleanName("🇭🇷".repeat(10)), "🇭🇷".repeat(7), "a flag is one character of 8 bytes");
  assert.equal(cleanName(`a${"́".repeat(40)}`), null, "one character that's over 63 bytes by itself isn't a name");

  // Whatever it keeps is a name root takes, and cleaning it again changes
  // nothing.
  const pieces = ["a", "B", " ", "  ", "ü", "é", "€", "📺", family, "🇭🇷", "寝", "ס", "&", "<", ">", '"', "'", "%h", "\\", "$(id)", "\n", "\t", "\u0000", "\u001b", "\u007f", "\u0085", " ", "‍", " ", "\ud83d", "\udcfa", "﷐", "�", "￾", "￿", "\u{1ffff}", "\u{10fffe}"];
  let seed = 28;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 3000; i++) {
    const typed = Array.from({ length: next() % 45 }, () => pieces[next() % pieces.length]).join("");
    const name = cleanName(typed);
    if (name === null) continue;
    assert.ok(rootTakes(name), `root takes ${JSON.stringify(name)}, from ${JSON.stringify(typed)}`);
    assert.ok(characters(name) <= 30 && bytes(name) <= 63 && name === name.trim(), JSON.stringify(name));
    assert.equal(cleanName(name), name, "cleaned once is clean");
  }
});

test("T28.5 the TV is OrigaiTV until it's named, the name is kept through a restart, and it goes to root with the id and the port", () => {
  const state = fresh("kept");
  const file = join(fresh("avahi"), "origaitv.service");
  const announce = new Announce({ state, file });
  assert.equal(announce.name(), "OrigaiTV");
  assert.equal(existsSync(join(state, "box-name")), false, "asking for the name keeps nothing");

  assert.equal(announce.rename("  Dnevna soba "), "Dnevna soba", "the name as it's kept");
  assert.equal(announce.name(), "Dnevna soba");
  assert.equal(new Announce({ state, file }).name(), "Dnevna soba", "and after a restart");
  assert.equal(tvName(state), "Dnevna soba");
  assert.equal(readFileSync(join(state, "box-name"), "utf8"), "Dnevna soba\n", "kept in the daemon's state");

  const handed = announce.sync(true, 3001);
  assert.deepEqual(handed, { on: true, id: announce.id(), port: 3001, name: "Dnevna soba" });
  assert.deepEqual(JSON.parse(readFileSync(announce.drop, "utf8")), handed, "the drop says the same, and nothing more");

  // Something that isn't a name changes nothing.
  for (const nothing of ["", "   ", "\n", 7, null, undefined]) assert.equal(announce.rename(nothing), null);
  assert.equal(announce.name(), "Dnevna soba");
  // A longer one is cut, and what's kept is what's said.
  assert.equal(announce.rename("x".repeat(80)), "x".repeat(30));
  assert.equal(announce.name(), "x".repeat(30));
  // Back to what every TV starts as.
  assert.equal(announce.rename("OrigaiTV"), "OrigaiTV");

  // A file someone broke isn't a name: the TV is OrigaiTV again.
  for (const broken of ["", "\n", " padded \n", "two\nlines\n", `${"a".repeat(64)}\n`, "a\u0000b\n", "a�b\n"]) {
    writeFileSync(join(state, "box-name"), broken);
    assert.equal(announce.name(), "OrigaiTV", JSON.stringify(broken));
  }
  writeFileSync(join(state, "box-name"), Buffer.from([0x4c, 0xff, 0x4c, 0x0a]));
  assert.equal(announce.name(), "OrigaiTV", "nor are bytes that aren't UTF-8");
});

// A daemon on a box that's on edge, where a switch can be turned on.
function tv(state: string, file: string): { daemon: Daemon; start: () => Promise<{ url: string; lan: string }> } {
  const channelFile = join(state, "..", `channel-${count++}`);
  writeFileSync(channelFile, "edge\n");
  const root = fresh("root");
  writeFileSync(join(root, "settings"), "ORIGAITV_VERSION=1.0.0.r7.gabc1234\nORIGAITV_CHANNEL=edge\n");
  const daemon = new Daemon({ root, state, port: 0, log: () => {}, channelFile, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", announceFile: file, box: { root: fresh("machine"), exec: async () => null, interfaces: () => ({}), disk: scratch } });
  return { daemon, start: async () => ({ url: `http://127.0.0.1:${await daemon.listen()}`, lan: `http://127.0.0.1:${daemon.lanPort}` }) };
}

// A request from the TV's own pages.
function pages(url: string) {
  return async (method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; data: Record<string, any> }> => {
    const response = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
}

// What the daemon last handed root, once it's there.
async function dropped(path: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("T28.5 with announce off, the TV has no name anywhere: not in the state, not on its own pages, and neither route is there", async () => {
  const state = fresh("off");
  const { daemon, start } = tv(state, join(fresh("avahi"), "origaitv.service"));
  const { url, lan } = await start();
  const send = pages(url);
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const seen = await phone.json("GET", "/api/phone/state");
    assert.equal("boxName" in seen, false);
    assert.equal("boxId" in seen, false);
    assert.deepEqual(await send("GET", "/api/name"), { status: 404, data: { ok: false, error: "not found" } });
    assert.deepEqual(await send("PUT", "/api/name", { name: "Living room" }), { status: 404, data: { ok: false, error: "not found" } });
    const asked = await phone.call("POST", "/api/phone/name", { name: "Living room" });
    assert.deepEqual([asked.status, asked.sealed, asked.data], [404, true, { ok: false, error: "not found" }]);
    assert.equal(existsSync(join(state, "box-name")), false, "nothing is kept");
    assert.equal(existsSync(join(state, "announce-drop")), false, "and nothing is handed to root");
  } finally {
    await daemon.close();
  }
});

test("T28.5 with announce on, a name set from the TV's page and from an adult's phone shows in the state and in what root is handed, cut and cleaned", async () => {
  const state = fresh("on");
  const drop = join(state, "announce-drop", "announce.json");
  const { daemon, start } = tv(state, join(fresh("avahi"), "origaitv.service"));
  const { url, lan } = await start();
  const send = pages(url);
  // Every event the TV's pages hear.
  const heard: string[] = [];
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      heard.push(Buffer.from(value!).toString("utf8"));
    }
  })();
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const other = await pairPhone(lan, daemon.phones.code().code, "ipad");
    assert.equal((await send("PUT", "/api/features", { announce: true })).status, 200);
    const id = daemon.announce.id();

    // Before anybody names it.
    assert.deepEqual(await dropped(drop), { on: true, id, port: daemon.lanPort, name: "OrigaiTV" });
    assert.deepEqual(await send("GET", "/api/name"), { status: 200, data: { ok: true, name: "OrigaiTV" } });
    const first = await phone.call("GET", "/api/phone/state");
    assert.equal(first.sealed, true, "the state is sealed");
    assert.equal(first.data.boxName, "OrigaiTV");
    assert.equal(first.data.boxId, id);
    assert.deepEqual(Object.keys(first.data).slice(0, 5), ["ok", "version", "phone", "boxId", "boxName"], "the name is beside the id");

    // From the TV's own page.
    rmSync(drop);
    assert.deepEqual(await send("PUT", "/api/name", { name: "  Dnevna soba " }), { status: 200, data: { ok: true, name: "Dnevna soba" } });
    assert.deepEqual(await dropped(drop), { on: true, id, port: daemon.lanPort, name: "Dnevna soba" }, "root is handed the new name");
    assert.equal((await send("GET", "/api/name")).data.name, "Dnevna soba");
    const second = await phone.json("GET", `/api/phone/state?since=${first.data.version}`);
    assert.equal(second.boxName, "Dnevna soba", "a phone that was waiting hears at once");
    assert.notEqual(second.version, first.data.version);
    assert.equal((await other.json("GET", "/api/phone/state")).boxName, "Dnevna soba", "and so does every other phone");
    assert.ok(heard.join("").includes('event: name\ndata: {"name":"Dnevna soba"}'), "the TV's pages hear it too");

    // From an adult's phone, with an accent and an emoji.
    rmSync(drop);
    const named = await phone.call("POST", "/api/phone/name", { name: "Küche 📺" });
    assert.deepEqual([named.status, named.sealed, named.data], [200, true, { ok: true, name: "Küche 📺" }]);
    assert.deepEqual(await dropped(drop), { on: true, id, port: daemon.lanPort, name: "Küche 📺" });
    assert.equal((await other.json("GET", "/api/phone/state")).boxName, "Küche 📺");
    assert.equal((await send("GET", "/api/name")).data.name, "Küche 📺", "Settings on the TV reads the phone's name");

    // The same name again: nothing new for root, and no news for anyone.
    rmSync(drop);
    const version = (await phone.json("GET", "/api/phone/state")).version;
    assert.equal((await send("PUT", "/api/name", { name: "Küche 📺" })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(drop), false);
    assert.equal((await phone.json("GET", "/api/phone/state")).version, version);

    // Over the limit it's cut, control characters are dropped, and the
    // answer says what was kept.
    assert.equal((await send("PUT", "/api/name", { name: "x".repeat(200) })).data.name, "x".repeat(30));
    assert.equal((await dropped(drop)).name, "x".repeat(30));
    assert.equal((await phone.json("POST", "/api/phone/name", { name: `${"€".repeat(30)}` })).name, "€".repeat(21), "63 bytes, cut between two characters");
    assert.equal((await phone.json("GET", "/api/phone/state")).boxName, "€".repeat(21));
    assert.equal((await send("PUT", "/api/name", { name: "Living\n room\u0000\u001b\t" })).data.name, "Living room");
    assert.equal((await phone.json("GET", "/api/phone/state")).boxName, "Living room");

    // Not a name: refused, and the one it has stays.
    for (const nothing of [{ name: "" }, { name: "   " }, { name: "\n\u0000" }, { name: 7 }, { name: ["Den"] }, {}]) {
      assert.deepEqual(await send("PUT", "/api/name", nothing), { status: 400, data: { ok: false, error: "Names can be up to 30 characters" } }, JSON.stringify(nothing));
      const refused = await phone.call("POST", "/api/phone/name", nothing);
      assert.deepEqual([refused.status, refused.data], [400, { ok: false, error: "Names can be up to 30 characters" }], JSON.stringify(nothing));
    }
    assert.equal((await phone.json("GET", "/api/phone/state")).boxName, "Living room");

    // Only a paired phone: with no session there's a plain 401 and no name.
    const unpaired = await fetch(`${lan}/api/phone/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Mine now" }) });
    assert.equal(unpaired.status, 401);
    assert.ok(!(await unpaired.text()).includes("Living room"));
    assert.equal((await send("GET", "/api/name")).data.name, "Living room");
    // The machine's own name is never asked for or changed: the daemon has
    // no way to, and the name lives in its state.
    assert.equal(readFileSync(join(state, "box-name"), "utf8"), "Living room\n");
  } finally {
    await reader.cancel().catch(() => {});
    await daemon.close();
  }

  // The daemon again, on the same state: the same name, handed over as it
  // starts with no one asking.
  rmSync(join(state, "announce-drop"), { recursive: true });
  const again = tv(state, join(fresh("avahi"), "origaitv.service"));
  const { url: url2, lan: lan2 } = await again.start();
  try {
    assert.equal((await dropped(drop)).name, "Living room", "the name is the same after a restart");
    const phone = await pairPhone(lan2, again.daemon.phones.code().code, "iphone");
    assert.equal((await phone.json("GET", "/api/phone/state")).boxName, "Living room");
    assert.equal((await pages(url2)("GET", "/api/name")).data.name, "Living room");
  } finally {
    await again.daemon.close();
  }
});

test("T28.5 naming the TV is an adult's, past the PIN once there is one: a child's phone and a wrong PIN are refused, on the phone and on the TV", async () => {
  const state = fresh("guard");
  const { daemon, start } = tv(state, join(fresh("avahi"), "origaitv.service"));
  const { url, lan } = await start();
  const send = pages(url);
  const NEEDS_PIN = { ok: false, error: "That needs the PIN", pin: true };
  try {
    assert.equal((await send("PUT", "/api/features", { announce: true })).status, 200);
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const name = async () => (await phone.json("GET", "/api/phone/state")).boxName;

    // With no PIN yet, an adult just names it, from either.
    assert.equal((await phone.json("POST", "/api/phone/name", { name: "Den" })).name, "Den");
    assert.equal((await send("PUT", "/api/name", { name: "Living room" })).data.name, "Living room");

    // With a PIN, both ask for it, and a grant is the asker's own.
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    const onTv = (await send("POST", "/api/pin/check", { pin: "2468" })).data.grant as string;
    let refused = await phone.call("POST", "/api/phone/name", { name: "Bedroom" });
    assert.deepEqual([refused.status, refused.sealed, refused.data], [403, true, NEEDS_PIN], "a phone with no grant");
    assert.deepEqual(await send("PUT", "/api/name", { name: "Bedroom" }), { status: 403, data: NEEDS_PIN }, "the TV's page with no grant");
    assert.deepEqual((await phone.call("POST", "/api/phone/name", { name: "Bedroom" }, { grant: "not-a-grant" })).data, NEEDS_PIN, "a grant that isn't one");
    assert.deepEqual((await phone.call("POST", "/api/phone/name", { name: "Bedroom" }, { grant: onTv })).data, NEEDS_PIN, "the TV's grant, sent by a phone");
    // A wrong PIN gives no grant, so there's nothing to name the TV with.
    const wrong = await phone.call("POST", "/api/phone/pin", { pin: "1111" });
    assert.equal(wrong.status, 403);
    assert.equal("grant" in wrong.data, false);
    assert.deepEqual((await send("POST", "/api/pin/check", { pin: "1111" })).status, 403);
    assert.equal(await name(), "Living room", "and the name stays");
    // The right one does.
    const onPhone = (await phone.json("POST", "/api/phone/pin", { pin: "2468" })).grant as string;
    assert.deepEqual(await send("PUT", "/api/name", { name: "Bedroom" }, onPhone), { status: 403, data: NEEDS_PIN }, "the phone's grant, sent by the TV's page");
    assert.equal((await phone.call("POST", "/api/phone/name", { name: "Bedroom" }, { grant: onPhone })).data.name, "Bedroom");
    assert.equal((await send("PUT", "/api/name", { name: "Kitchen" }, onTv)).data.name, "Kitchen");

    // On a child's profile a phone can't, grant or not. The TV's page asks
    // for the PIN, as it does for every adult's change there.
    const child = (await send("POST", "/api/viewers", { name: "mia", role: "child" }, onTv)).data.profile;
    assert.equal((await send("POST", "/api/viewer", { id: child.id }, onTv)).status, 200);
    for (const grant of [undefined, onPhone]) {
      refused = await phone.call("POST", "/api/phone/name", { name: "Mia's TV" }, { grant });
      assert.deepEqual([refused.status, refused.sealed, refused.data], [403, true, { ok: false, error: "Only adults can change the name" }]);
    }
    assert.deepEqual(await send("PUT", "/api/name", { name: "Mia's TV" }), { status: 403, data: NEEDS_PIN });
    assert.equal(await name(), "Kitchen", "the name stays");
    assert.equal((await send("PUT", "/api/name", { name: "Office" }, onTv)).data.name, "Office", "an adult with the PIN, on the TV");
    assert.equal(await name(), "Office", "a child's phone still reads the name");
  } finally {
    await daemon.close();
  }
});

// What origaitv-announce.path does when the drop appears: what root said, on
// each of its outputs, and how it ended.
function root(drop: string, file: string): { status: number | null; out: string; log: string } {
  mkdirSync(join(scratch, "package"), { recursive: true });
  writeFileSync(join(scratch, "package", "settings"), "ORIGAITV_VERSION=1.0.0.r7.gabc1234\nORIGAITV_CHANNEL=edge\n");
  const ran = spawnSync("bash", [join(ROOT, "bin/origaitv-announce-set")], { env: { ...process.env, ORIGAITV_ANNOUNCE_DROP: drop, ORIGAITV_ANNOUNCE_FILE: file, ORIGAITV_PATH: join(scratch, "package") }, encoding: "utf8" });
  return { status: ran.status, out: ran.stdout, log: ran.stderr };
}
// The name in Avahi's file, as an XML parser would hand it over.
function announcedAs(file: string): string {
  const written = readFileSync(file, "utf8");
  const found = /^ {2}<name replace-wildcards="no">([^<>\n]*)<\/name>$/m.exec(written);
  assert.ok(found, written);
  assert.equal(written.match(/<name/g)?.length, 1);
  assert.equal(written.match(/</g)?.length, 17, "the file has its own tags and no others");
  assert.ok(!/["']/.test(found[1]), "no quote is left as itself");
  assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(found[1]), "every & starts one of the five");
  return found[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

test("T28.5 from the name to Avahi's file: what the daemon keeps, root takes and writes as typed, with nothing filled in", async () => {
  const state = fresh("file");
  const file = join(fresh("avahi"), "origaitv.service");
  const drop = join(state, "announce-drop", "announce.json");
  const { daemon, start } = tv(state, file);
  const { url, lan } = await start();
  const send = pages(url);
  try {
    assert.equal((await send("PUT", "/api/features", { announce: true })).status, 200);
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    await dropped(drop);
    assert.match(root(drop, file).out, /the TV is announced on the home network/);
    assert.equal(announcedAs(file), "OrigaiTV", "before a name is set");
    assert.ok(!readFileSync(file, "utf8").includes("%h"), "the machine's name is in it nowhere");

    const typed = [
      "Dnevna soba",
      "Küche 📺",
      "Tom & Jerry",
      "<Den>",
      'a "b" c',
      "Ana's room",
      "& < > \" '",
      "%h",
      "100% %h %s",
      "</name><host-name>x.local</host-name>",
      "$(id) `id` $HOME",
      "back\\slash \\n",
      "a]]>b",
      "&amp;&lt;&#39;",
      "寝室",
      "👨‍👩‍👧‍👦 home",
      "€".repeat(30),
      "📺".repeat(30),
      "x".repeat(200),
      "Living\nroom\u0000\u001b",
      "a\ud83db�c￿d",
      "  spaces  inside  ",
    ];
    for (const [index, name] of typed.entries()) {
      const set = index % 2 ? (await phone.json("POST", "/api/phone/name", { name })).name : (await send("PUT", "/api/name", { name })).data.name;
      assert.equal(set, cleanName(name));
      assert.equal((await dropped(drop)).name, set);
      const said = root(drop, file);
      assert.deepEqual([said.status, said.log], [0, ""], `root takes ${JSON.stringify(set)} as it is`);
      assert.match(said.out, /^origaitv-announce-set: the TV is announced on the home network, on port \d+\n$/);
      assert.equal(announcedAs(file), set, `T28.5 ${JSON.stringify(name)} is announced as the state has it`);
      assert.equal((await phone.json("GET", "/api/phone/state")).boxName, set);
    }
  } finally {
    await daemon.close();
  }
});

test("T28.5 a name the daemon never kept, left in the drop by something else, is announced as OrigaiTV", () => {
  const state = fresh("forged");
  const file = join(fresh("avahi"), "origaitv.service");
  const announce = new Announce({ state, file });
  const drop = announce.drop;
  mkdirSync(join(drop, ".."), { recursive: true });
  const id = announce.id();
  for (const name of ["a\nb", " padded ", "x".repeat(64), "a\u0000b", "a\uffffb", "", 7, null]) {
    writeFileSync(file, "<service-group/>\n");
    writeFileSync(drop, JSON.stringify({ on: true, id, port: 3001, name }));
    const said = root(drop, file);
    assert.equal(said.status, 0, "the TV is still announced");
    assert.equal(said.log, "origaitv-announce-set: the drop's name isn't one to announce, so the TV is announced as OrigaiTV\n", "and root says the name was left out");
    assert.equal(announcedAs(file), "OrigaiTV", JSON.stringify(name));
    assert.equal(existsSync(drop), false);
  }
});
