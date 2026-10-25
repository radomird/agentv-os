// Profiles (ADR-009, S4.2): who watches on this box, each with a name, an
// avatar and a role, adult or kid, kept in the ledger's viewer table. One
// viewer is active for the whole box at a time: home, its layout, Continue
// and the ledger are theirs, and a switch shows on the TV within a second.
// The box's owner, as first boot finds them, is the first adult.
//
// The daemon decides what needs the PIN: changing profiles once there is
// one, a kid's profile needs one to exist, and switching from a kid to an
// adult needs it too (server.ts).

import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Ledger, LedgerViewer } from "./ledger.ts";

export type Profile = LedgerViewer & { avatar: string };

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
        return { id: name, name, role: "adult", avatar: AVATARS[0] };
      }
    }
    return { id: "you", name: "you", role: "adult", avatar: AVATARS[0] };
  }

  // Everyone, in the order they were added, the owner first. A box with no
  // profiles yet gets the owner.
  async list(): Promise<Profile[]> {
    let viewers = this.ledger().viewers();
    if (viewers.length === 0) {
      this.ledger().viewer(await this.owner());
      viewers = this.ledger().viewers();
    }
    const order = await this.order();
    return viewers
      .map((viewer) => ({ ...viewer, avatar: viewer.avatar && AVATARS.includes(viewer.avatar) ? viewer.avatar : AVATARS[0] }))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.id.localeCompare(b.id));
  }

  private async saved(): Promise<{ active?: string; order?: string[] }> {
    try {
      const data = JSON.parse(await readFile(join(this.state, "viewer.json"), "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private async save(change: { active?: string; order?: string[] }): Promise<void> {
    const next = { ...(await this.saved()), ...change };
    await mkdir(this.state, { recursive: true });
    await writeFile(join(this.state, ".viewer.json.next"), `${JSON.stringify(next, null, 2)}\n`);
    await rename(join(this.state, ".viewer.json.next"), join(this.state, "viewer.json"));
  }

  private async order(): Promise<string[]> {
    return (await this.saved()).order ?? [];
  }

  // Who's watching now: the one switched to last, else the first adult.
  async active(): Promise<Profile> {
    const all = await this.list();
    const id = (await this.saved()).active;
    return all.find((p) => p.id === id) ?? all.find((p) => p.role === "adult") ?? all[0];
  }

  async kids(): Promise<boolean> {
    return (await this.list()).some((p) => p.role === "kid");
  }

  // Why a name, role and avatar can't be a profile, or null.
  private async problem(input: Record<string, unknown>, id?: string): Promise<string | null> {
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > NAME_MAX) return `a name of up to ${NAME_MAX} characters`;
      const name = input.name.trim().toLowerCase();
      if ((await this.list()).some((p) => p.id !== id && p.name.toLowerCase() === name)) return "someone here has that name already";
    }
    if (input.role !== undefined && input.role !== "adult" && input.role !== "kid") return "adult or kid";
    if (input.avatar !== undefined && (typeof input.avatar !== "string" || !AVATARS.includes(input.avatar))) return `a colour: ${AVATARS.join(", ")}`;
    return null;
  }

  async add(input: Record<string, unknown>): Promise<{ profile?: Profile; error?: string }> {
    if (input.name === undefined) return { error: `a name of up to ${NAME_MAX} characters` };
    const why = await this.problem(input);
    if (why) return { error: why };
    const all = await this.list();
    const profile: Profile = {
      id: `v-${randomBytes(4).toString("hex")}`,
      name: String(input.name).trim(),
      role: input.role === "kid" ? "kid" : "adult",
      avatar: typeof input.avatar === "string" ? input.avatar : (AVATARS.find((a) => !all.some((p) => p.avatar === a)) ?? AVATARS[all.length % AVATARS.length]),
    };
    this.ledger().viewer(profile);
    await this.save({ order: [...all.map((p) => p.id), profile.id] });
    return { profile };
  }

  async edit(id: string, input: Record<string, unknown>): Promise<{ profile?: Profile; error?: string }> {
    const all = await this.list();
    const found = all.find((p) => p.id === id);
    if (!found) return { error: "there's no such profile" };
    const why = await this.problem(input, id);
    if (why) return { error: why };
    const profile: Profile = {
      ...found,
      name: input.name === undefined ? found.name : String(input.name).trim(),
      role: input.role === undefined ? found.role : (input.role as Profile["role"]),
      avatar: input.avatar === undefined ? found.avatar : String(input.avatar),
    };
    if (found.role === "adult" && profile.role === "kid" && !all.some((p) => p.id !== id && p.role === "adult")) return { error: "the box needs an adult" };
    this.ledger().viewer(profile);
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
    await this.save({ order: (saved.order ?? []).filter((o) => o !== id), active: saved.active === id ? undefined : saved.active });
    return null;
  }

  async switchTo(id: string): Promise<Profile | null> {
    const found = (await this.list()).find((p) => p.id === id);
    if (!found) return null;
    await this.save({ active: id });
    return found;
  }
}
