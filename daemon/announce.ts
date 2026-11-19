// The TV found on the home network (PHASE-2-PLAN.md track 25), behind the
// `announce` switch.
//
// The QR code holds the TV's address as it was when the phone paired. When
// the router gives the TV a new one, a paired phone has lost it. So the TV
// says it's there: Avahi, which already runs to look for servers, publishes
// `_origaitv._tcp` on the port phones use, with the TV's name, its version
// and a box id. A phone learns the id when it pairs, and looks for it
// afterwards.
//
// - The box id is 16 random bytes, made the first time it's needed and kept
//   in the daemon's state. It's made from nothing: not from a key, the
//   hardware or the network. It names this install and says nothing else.
// - Avahi publishes from a file that only root writes. The daemon faces the
//   network and isn't root, so it leaves what to publish in a drop in its
//   state: whether to, the id, the port and the name. origaitv-announce.path
//   starts bin/origaitv-announce-set as root, which takes only that, adds
//   the version itself and writes the file.
// - The TV has a name of its own, "OrigaiTV" until somebody changes it. It's
//   what the record is called, and what a phone shows. It's kept here, apart
//   from the machine's name, which never changes. A name is what a person
//   typed, so it's cleaned here before it's kept, and root checks it again.
// - Anyone on the network can read what Avahi publishes, paired or not. So
//   the record has the name, the version and the id, and nothing more. What
//   a phone needs to wake the TV goes to paired phones only (box.ts).
// - With the switch off the daemon makes no id and hands nothing over. If
//   the file is there from when it was on, it has root take it away.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What a phone browses for.
export const SERVICE_TYPE = "_origaitv._tcp";
// Where root keeps what Avahi publishes.
export const SERVICE_FILE = "/etc/avahi/services/origaitv.service";

const ID = /^[0-9a-f]{32}$/;

// What a TV is called until somebody names it.
export const DEFAULT_NAME = "OrigaiTV";
// A name is at most this many characters,
export const NAME_MAX = 30;
// and this many bytes as UTF-8, which is as long as a name on the network
// can be.
export const NAME_BYTES = 63;

// What a name never has in it. Control characters, as a phone's name drops
// them, and the ones past U+007F too. Half of a pair, which isn't a
// character. The code points Avahi refuses a name for: U+FDD0 to U+FDEF and
// the last two of every plane. And U+FFFD, which root's check reads as bytes
// that weren't UTF-8.
function dropped(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) || (code >= 0xfdd0 && code <= 0xfdef) || code === 0xfffd || (code & 0xfffe) === 0xfffe;
}

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A name for the TV out of what somebody typed, or null when nothing's left
// of it: 1 to 30 characters after trimming, and 63 bytes at most. A longer
// one is cut, between two characters as a person sees them, so an emoji or
// a letter with its accent is kept whole or not at all. Spaces, accents and
// emoji are fine. Whatever this returns, bin/origaitv-announce-set takes.
export function cleanName(typed: unknown): string | null {
  if (typeof typed !== "string") return null;
  const kept = Array.from(typed)
    .filter((one) => !dropped(one.codePointAt(0)!))
    .join("")
    .trim();
  let name = "";
  let count = 0;
  for (const { segment } of characters.segment(kept)) {
    if (count === NAME_MAX || Buffer.byteLength(name + segment) > NAME_BYTES) break;
    name += segment;
    count++;
  }
  return name.trim() || null;
}

// The TV's name, as it's kept in the daemon's state: the one somebody gave
// it, or OrigaiTV. A file someone broke isn't a name.
export function tvName(state: string): string {
  try {
    const kept = readFileSync(join(state, "box-name"), "utf8").replace(/\n$/, "");
    if (cleanName(kept) === kept) return kept;
  } catch {
    // Nobody has named it.
  }
  return DEFAULT_NAME;
}

// The box id, made the first time it's asked for and the same from then on.
export function boxId(state: string, random: (length: number) => Buffer = randomBytes): string {
  const path = join(state, "box-id");
  try {
    const kept = readFileSync(path, "utf8").trim();
    if (ID.test(kept)) return kept;
  } catch {
    // There isn't one yet.
  }
  const id = random(16).toString("hex");
  mkdirSync(state, { recursive: true });
  writeFileSync(`${path}.next`, `${id}\n`, { mode: 0o600 });
  renameSync(`${path}.next`, path);
  return id;
}

export interface AnnounceOptions {
  state: string; // the daemon's own state: the id and the drop go in it
  // The file root writes for Avahi, for the tests. The daemon only looks
  // whether it's there.
  file?: string;
}

// What the daemon hands root: publish this, or publish nothing.
export type AnnounceDrop = { on: true; id: string; port: number; name: string } | { on: false };

export class Announce {
  private state: string;
  private file: string;

  constructor(options: AnnounceOptions) {
    this.state = options.state;
    this.file = options.file ?? SERVICE_FILE;
  }

  // Where the drop goes, which origaitv-announce.path watches.
  get drop(): string {
    return join(this.state, "announce-drop", "announce.json");
  }

  // The id, for a phone that's pairing or reading the state.
  id(): string {
    return boxId(this.state);
  }

  // The TV's name, for the record, a phone's state and the TV's own pages.
  name(): string {
    return tvName(this.state);
  }

  // Names the TV. Returns the name as it's kept, which may be shorter than
  // what was typed, or null when what was typed isn't a name.
  rename(typed: unknown): string | null {
    const name = cleanName(typed);
    if (name === null) return null;
    const path = join(this.state, "box-name");
    mkdirSync(this.state, { recursive: true });
    writeFileSync(`${path}.next`, `${name}\n`, { mode: 0o600 });
    renameSync(`${path}.next`, path);
    return name;
  }

  // Hands root what to publish, as the daemon starts, when the switch
  // changes and when the TV is named. `port` is the one phones reach the TV
  // on, or null when the daemon isn't listening for them, which is the same
  // as off. Returns what it handed over, or null when there was nothing to
  // do: the switch is off and nothing is published.
  sync(on: boolean, port: number | null): AnnounceDrop | null {
    const wanted: AnnounceDrop = on && port ? { on: true, id: this.id(), port, name: this.name() } : { on: false };
    if (!wanted.on && !existsSync(this.file)) return null;
    mkdirSync(join(this.drop, ".."), { recursive: true });
    writeFileSync(`${this.drop}.next`, `${JSON.stringify(wanted)}\n`);
    renameSync(`${this.drop}.next`, this.drop);
    return wanted;
  }
}
