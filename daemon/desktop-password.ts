// The password of Omarchy's desktop account, set from Settings → Omarchy
// desktop and typed on the phone. A box set up from the USB stick's first
// screen has an account with a random password nobody knows, and a note
// saying so (/var/lib/agentv/account.json). Until a password is set there,
// SSH takes keys only, and the desktop can't run anything that asks for it.
//
// The daemon checks the password, then hands it to root on
// agentv-password.socket, which starts bin/agentv-password-set with the
// connection as its stdin. It never goes in a file or a log here.

import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

export const MIN = 8;
export const MAX = 128;

export interface DesktopPasswordOptions {
  marker?: string; // the first screen's account note
  socket?: string; // root's side of the hand-over
  waitMs?: number;
}

// What Settings shows: whether this box's account has a note at all (a box
// installed through Omarchy's own installer has its typed password, and no
// note), its name, and whether a password is known yet.
export interface PasswordState {
  managed: boolean;
  name: string | null;
  known: boolean;
}

// Why a password won't do, or null. Root checks it again.
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "Type a password first";
  if ([...password].length < MIN) return `Passwords need ${MIN} characters or more`;
  if ([...password].length > MAX) return `Passwords can be up to ${MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(password)) return "Passwords can't have a line break";
  return null;
}

export class DesktopPassword {
  private marker: string;
  private socket: string;
  private waitMs: number;

  constructor(options: DesktopPasswordOptions = {}) {
    this.marker = options.marker ?? "/var/lib/agentv/account.json";
    this.socket = options.socket ?? "/run/agentv-password.sock";
    this.waitMs = options.waitMs ?? 20_000;
  }

  async state(): Promise<PasswordState> {
    try {
      const note = JSON.parse(await readFile(this.marker, "utf8")) as { name?: unknown; passwordKnown?: unknown };
      return { managed: true, name: typeof note.name === "string" ? note.name : null, known: note.passwordKnown === true };
    } catch {
      return { managed: false, name: null, known: true };
    }
  }

  // Hands the password to root: null once it's set, or why not.
  set(password: string, grant: string | undefined): Promise<string | null> {
    return new Promise((done) => {
      let answer = "";
      let finished = false;
      const finish = (why: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        connection.destroy();
        done(why);
      };
      const connection = createConnection(this.socket);
      const timer = setTimeout(() => finish("Couldn't set the password. Try again."), this.waitMs);
      connection.setEncoding("utf8");
      connection.on("connect", () => connection.write(`${JSON.stringify({ password, grant: grant ?? "" })}\n`));
      connection.on("data", (chunk: string) => {
        answer += chunk;
        if (answer.length > 4096) finish("Couldn't set the password. Try again.");
        if (!answer.includes("\n")) return;
        try {
          const reply = JSON.parse(answer.slice(0, answer.indexOf("\n"))) as { ok?: unknown; error?: unknown };
          finish(reply.ok === true ? null : typeof reply.error === "string" ? reply.error : "Couldn't set the password");
        } catch {
          finish("Couldn't set the password. Try again.");
        }
      });
      connection.on("error", () => finish("Couldn't set the password. Restart your TV and try again."));
      connection.on("close", () => finish("Couldn't set the password. Try again."));
    });
  }
}
