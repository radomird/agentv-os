// A plan's sign-in from setup's AI step (ADR-070), so voice works from the
// first day: the same sign-in a first build runs (ADR-040), started without
// a build. The daemon leaves sign-in.json in the builder's drop, and root's
// hand-over starts the provider's own CLI as agentv-builder in its sandbox
// (builder/sign-in.ts). The TV shows the CLI's link as a QR code, and a code
// the provider's page gives goes back through the drop, as for a build.
// Once it's signed in, the router's CLI reads the same sign-in.
//
// Skipped in setup, it waits in Settings → AI, and a first build still asks.

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Provider } from "./ai.ts";
import type { SignInView } from "./builds.ts";

export interface PlanSignInOptions {
  state: string; // the daemon's own: plan-sign-in.json
  drop: string; // where root takes asks from: <state>/build-drop
  run: string; // /run/agentv-build: root's answer and the sign-in's status
}

// What setup knows of the plan's sign-in: which provider was asked for, and
// when, and when it signed in.
interface Kept {
  provider: Provider;
  asked: string;
  signedIn?: string;
}

export interface PlanSignInState {
  provider: Provider;
  signedIn: boolean;
  // How the sign-in is going, while one runs or after one failed.
  now?: SignInView;
}

const CODE = /^[\x21-\x7e]{1,512}$/;

export class PlanSignIn {
  private o: PlanSignInOptions;
  private path: string;

  constructor(options: PlanSignInOptions) {
    this.o = options;
    this.path = join(options.state, "plan-sign-in.json");
  }

  private async kept(): Promise<Kept | null> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Kept;
      return typeof data.provider === "string" && typeof data.asked === "string" ? data : null;
    } catch {
      return null;
    }
  }

  private async keep(data: Kept): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.next`, `${JSON.stringify(data)}\n`);
    await rename(`${this.path}.next`, this.path);
  }

  private async drop(name: "sign-in" | "sign-in-code", data: unknown): Promise<void> {
    await mkdir(this.o.drop, { recursive: true });
    const path = join(this.o.drop, `${name}.json`);
    await writeFile(`${path}.next`, JSON.stringify(data));
    await rename(`${path}.next`, path);
  }

  // Start the provider's sign-in, or again after one that failed.
  async start(provider: Provider): Promise<void> {
    await this.keep({ provider, asked: new Date().toISOString() });
    await this.drop("sign-in", { build: null, provider });
  }

  // The code the provider's page gave the person, for the CLI's prompt.
  async code(code: unknown): Promise<{ error?: string }> {
    const now = await this.state();
    if (now?.now?.state !== "waiting" || !now.now.pastes) return { error: "Nothing is waiting for a code" };
    const text = typeof code === "string" ? code.trim() : "";
    if (!CODE.test(text)) return { error: "Paste the code the page gave you" };
    await this.drop("sign-in-code", { code: text });
    return {};
  }

  // How it stands: from the sign-in's own status once it's newer than the
  // ask, root's answer if it refused, or starting while the ask waits.
  async state(): Promise<PlanSignInState | null> {
    const kept = await this.kept();
    if (!kept) return null;
    if (kept.signedIn) return { provider: kept.provider, signedIn: true };
    let said: (SignInView & { provider?: string; at?: string }) | null = null;
    try {
      said = JSON.parse(readFileSync(join(this.o.run, "sign-in", "status.json"), "utf8"));
    } catch {}
    if (said && said.provider === kept.provider && typeof said.at === "string" && said.at > kept.asked && ["starting", "waiting", "done", "failed"].includes(said.state)) {
      if (said.state === "done") {
        await this.keep({ ...kept, signedIn: said.at });
        return { provider: kept.provider, signedIn: true };
      }
      return {
        provider: kept.provider,
        signedIn: false,
        now: {
          state: said.state,
          ...(typeof said.url === "string" && said.url.startsWith("https://") ? { url: said.url } : {}),
          ...(typeof said.code === "string" ? { code: said.code } : {}),
          pastes: said.pastes === true,
          ...(typeof said.reason === "string" ? { reason: said.reason } : {}),
        },
      };
    }
    let answer: { action?: string; build?: string | null; started?: boolean; reason?: string; at?: string } | null = null;
    try {
      answer = JSON.parse(readFileSync(join(this.o.run, "answer.json"), "utf8"));
    } catch {}
    if (answer?.action === "sign-in" && answer.build === null && typeof answer.at === "string" && answer.at > kept.asked && !answer.started) {
      return { provider: kept.provider, signedIn: false, now: { state: "failed", reason: answer.reason ?? "Couldn't start the sign-in" } };
    }
    return { provider: kept.provider, signedIn: false, now: { state: "starting" } };
  }

  // A plan changed or set up again: what setup knew of its sign-in goes.
  async forget(): Promise<void> {
    await writeFile(this.path, "{}\n").catch(() => {});
  }
}
