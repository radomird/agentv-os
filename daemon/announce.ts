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
//   state: whether to, the id and the port. origaitv-announce.path starts
//   bin/origaitv-announce-set as root, which takes only that, adds the
//   version itself and writes the file.
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
export type AnnounceDrop = { on: true; id: string; port: number } | { on: false };

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

  // Hands root what to publish, as the daemon starts and when the switch
  // changes. `port` is the one phones reach the TV on, or null when the
  // daemon isn't listening for them, which is the same as off. Returns what
  // it handed over, or null when there was nothing to do: the switch is off
  // and nothing is published.
  sync(on: boolean, port: number | null): AnnounceDrop | null {
    const wanted: AnnounceDrop = on && port ? { on: true, id: this.id(), port } : { on: false };
    if (!wanted.on && !existsSync(this.file)) return null;
    mkdirSync(join(this.drop, ".."), { recursive: true });
    writeFileSync(`${this.drop}.next`, `${JSON.stringify(wanted)}\n`);
    renameSync(`${this.drop}.next`, this.drop);
    return wanted;
  }
}
