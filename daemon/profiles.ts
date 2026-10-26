// Profiles (ADR-009, S4.2): who watches on this box, each with a name, an
// avatar and a role, adult or child, kept in the ledger's viewer table. One
// viewer is active for the whole box at a time: home, its layout, Continue
// and the ledger are theirs, and a switch shows on the TV within a second.
// The box's owner, as first boot finds them, is the first adult.
//
// An adult's profile can ask for the PIN to open (ADR-034): after the box
// starts and after the TV has been off, and when someone switches to it.
// Its tile shows a lock. Children's profiles don't; the PIN guards what they can
// reach already.
//
// The daemon decides what needs the PIN: changing profiles once there is
// one, a child's profile and a locked one need one to exist, and switching
// from a child to an adult, or to a locked profile, needs it too (server.ts).

import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Ledger, LedgerViewer } from "./ledger.ts";

export type Profile = LedgerViewer & { avatar: string; locked: boolean };

// An avatar is a colour from the Omarchy theme, behind the name's first
// letter (board 06).
export const AVATARS = ["blue", "green", "magenta", "yellow", "cyan", "orange", "red"];
const NAME_MAX = 20;

export interface ProfilesOptions {
  ledger: () => Ledger;
  state: string; // where the active viewer is kept: <state>/viewer.json
  passwd?: string; // /etc/passwd, for the owner's name
}

export class Profiles {
  private ledger: () => Ledger;
  private state: string;
  private passwd: string;

  constructor(options: ProfilesOptions) {
    this.ledger = options.ledger;
    this.state = options.state;
    this.passwd = options.passwd ?? process.env.AGENTV_PASSWD ?? "/etc/passwd";
  }

  // The person the box belongs to: the first ordinary user.
  private async owner(): Promise<Profile> {
    const passwd = await readFile(this.passwd, "utf8").catch(() => "");
    for (const line of passwd.split("\n")) {
      const [name, , uid, , , , shell] = line.split(":");
      if (Number(uid) >= 1000 && Number(uid) < 60000 && !/nologin|false/.test(shell ?? "")) {
        return { id: name, name, role: "adult", avatar: AVATARS[0], locked: false };
      }
    }
    return { id: "you", name: "you", role: "adult", avatar: AVATARS[0], locked: false };
  }

  // What the ledger keeps of a profile: all but the lock, which is the
  // daemon's own, in viewer.json.
  private keep(profile: Profile): void {
    this.ledger().viewer({ id: profile.id, name: profile.name, role: profile.role, avatar: profile.avatar });
  }

  // Everyone, in the order they were added, the owner first. A box with no
  // profiles yet gets the owner.
  async list(): Promise<Profile[]> {
    let viewers = this.ledger().viewers();
    if (viewers.length === 0) {
      this.keep(await this.owner());
      viewers = this.ledger().viewers();
    }
    const { order = [], locked = [] } = await this.saved();
    return viewers
      .map((viewer) => ({
        ...viewer,
        avatar: viewer.avatar && AVATARS.includes(viewer.avatar) ? viewer.avatar : AVATARS[0],
        locked: viewer.role === "adult" && locked.includes(viewer.id),
      }))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.id.localeCompare(b.id));
  }

  private async saved(): Promise<{ active?: string; order?: string[]; locked?: string[] }> {
    try {
      const data = JSON.parse(await readFile(join(this.state, "viewer.json"), "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private async save(change: { active?: string; order?: string[]; locked?: string[] }): Promise<void> {
    const next = { ...(await this.saved()), ...change };
    await mkdir(this.state, { recursive: true });
    await writeFile(join(this.state, ".viewer.json.next"), `${JSON.stringify(next, null, 2)}\n`);
    await rename(join(this.state, ".viewer.json.next"), join(this.state, "viewer.json"));
  }

  // Who's watching now: the one switched to last, else the first adult.
  async active(): Promise<Profile> {
    const all = await this.list();
    const id = (await this.saved()).active;
    return all.find((p) => p.id === id) ?? all.find((p) => p.role === "adult") ?? all[0];
  }

  async children(): Promise<boolean> {
    return (await this.list()).some((p) => p.role === "child");
  }

  // Why the adult PIN has to stay, or null: a child's profile, or one that
  // asks for it to open.
  async needPin(): Promise<string | null> {
    const all = await this.list();
    if (all.some((p) => p.role === "child")) return "a child's profile needs the pin, so it stays";
    if (all.some((p) => p.locked)) return "a locked profile needs the pin. unlock it in settings → profiles first";
    return null;
  }

  // Why a name, role and avatar can't be a profile, or null.
  private async problem(input: Record<string, unknown>, id?: string): Promise<string | null> {
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > NAME_MAX) return `a name of up to ${NAME_MAX} characters`;
      const name = input.name.trim().toLowerCase();
      if ((await this.list()).some((p) => p.id !== id && p.name.toLowerCase() === name)) return "someone here has that name already";
    }
    if (input.role !== undefined && input.role !== "adult" && input.role !== "child") return "adult or child";
    if (input.avatar !== undefined && (typeof input.avatar !== "string" || !AVATARS.includes(input.avatar))) return `a colour: ${AVATARS.join(", ")}`;
    if (input.locked !== undefined && typeof input.locked !== "boolean") return "locked is true or false";
    if (input.locked === true && input.role === "child") return "only an adult's profile locks";
    return null;
  }

  private async setLocked(id: string, on: boolean): Promise<void> {
    const locked = ((await this.saved()).locked ?? []).filter((l) => l !== id);
    await this.save({ locked: on ? [...locked, id] : locked });
  }

  async add(input: Record<string, unknown>): Promise<{ profile?: Profile; error?: string }> {
    if (input.name === undefined) return { error: `a name of up to ${NAME_MAX} characters` };
    const why = await this.problem(input);
    if (why) return { error: why };
    const all = await this.list();
    const profile: Profile = {
      id: `v-${randomBytes(4).toString("hex")}`,
      name: String(input.name).trim(),
      role: input.role === "child" ? "child" : "adult",
      avatar: typeof input.avatar === "string" ? input.avatar : (AVATARS.find((a) => !all.some((p) => p.avatar === a)) ?? AVATARS[all.length % AVATARS.length]),
      locked: input.locked === true,
    };
    this.keep(profile);
    await this.save({ order: [...all.map((p) => p.id), profile.id] });
    if (profile.locked) await this.setLocked(profile.id, true);
    return { profile };
  }

  async edit(id: string, input: Record<string, unknown>): Promise<{ profile?: Profile; error?: string }> {
    const all = await this.list();
    const found = all.find((p) => p.id === id);
    if (!found) return { error: "there's no such profile" };
    const why = await this.problem(input, id);
    if (why) return { error: why };
    const role = input.role === undefined ? found.role : (input.role as Profile["role"]);
    if (input.locked === true && role === "child") return { error: "only an adult's profile locks" };
    const profile: Profile = {
      ...found,
      name: input.name === undefined ? found.name : String(input.name).trim(),
      role,
      avatar: input.avatar === undefined ? found.avatar : String(input.avatar),
      // A profile that becomes a child's stops asking for the PIN.
      locked: role === "child" ? false : input.locked === undefined ? found.locked : input.locked === true,
    };
    if (found.role === "adult" && profile.role === "child" && !all.some((p) => p.id !== id && p.role === "adult")) return { error: "the box needs an adult" };
    this.keep(profile);
    if (profile.locked !== found.locked) await this.setLocked(id, profile.locked);
    return { profile };
  }

  // Takes a profile off, with what they watched. The box keeps an adult.
  async remove(id: string): Promise<string | null> {
    const all = await this.list();
    const found = all.find((p) => p.id === id);
    if (!found) return "there's no such profile";
    if (found.role === "adult" && !all.some((p) => p.id !== id && p.role === "adult")) return "the box needs an adult";
    this.ledger().removeViewer(id);
    const saved = await this.saved();
    await this.save({
      order: (saved.order ?? []).filter((o) => o !== id),
      active: saved.active === id ? undefined : saved.active,
      locked: (saved.locked ?? []).filter((l) => l !== id),
    });
    return null;
  }

  async switchTo(id: string): Promise<Profile | null> {
    const found = (await this.list()).find((p) => p.id === id);
    if (!found) return null;
    await this.save({ active: id });
    return found;
  }
}
