// The apps the household asks the builder for (ADR-011, ADR-043 to ADR-046):
// the daemon's side of a build. It turns a sentence into a build, hands each
// phase to root through build-drop/ (builder/sandbox/hand-over.ts), and reads
// how it goes from the build's own folder: what the agent understood, a plan
// for an adult, the gates, and the app waiting for an adult's approval.
//
// An adult confirms what the agent understood, approves a plan or a finished
// app behind the PIN, and can stop, retry, remove, change, rebuild or roll
// back. A change or a rebuild is a new version through the same gates, and
// the version before stays for one-press rollback (Q117). The spend caps and
// npm's safeguards are an adult's settings, behind the PIN (ADR-044, ADR-045).
//
// On a plan, the first build waits for the plan's sign-in (ADR-040): the TV
// shows the CLI's link as a QR code, the phone hands over any code the
// provider's page gives, and the build starts again once it's in.
//
// The daemon writes nothing into a build: each phase's request, the folders
// and the installs are root's.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildStatus, Understood } from "../builder/build.ts";
import { loadRecipes, type Kind, type Plan, type Recipe } from "../builder/recipe.ts";

export type Provider = "claude" | "chatgpt" | "gemini" | "grok" | "muse";

export interface BuildSettings {
  cap: { build: number; month: number }; // dollars, with a key
  safeguards: boolean;
}

export const DEFAULT_SETTINGS: BuildSettings = { cap: { build: 5, month: 20 }, safeguards: true };

// One build, as the TV and the phone show it.
export interface BuildView {
  build: string;
  id: string;
  version: string;
  sentence: string;
  name?: string;
  // The AI it runs on, and whether on a plan or a key.
  provider: Provider;
  path: "plan" | "key";
  state: BuildStatus["state"] | "starting";
  phase: BuildStatus["phase"];
  step?: string;
  steps: BuildStatus["steps"];
  reason?: string;
  spent?: number;
  understood?: Understood;
  plan?: Plan;
  // Roughly what it costs on Claude with a key, and how long it takes: its
  // recipe's, or its plan's.
  cost?: { low: number; high: number };
  minutes?: number;
  approval?: BuildStatus["approval"];
  // A plan's sign-in, while the build waits for it.
  signIn?: SignInView;
  shot: boolean;
  at: string;
}

// How a plan's sign-in is going, from builder/sign-in.ts: the CLI's link to
// open, a code to enter on its page, or whether the page gives a code to
// paste back on the phone.
export interface SignInView {
  state: "starting" | "waiting" | "done" | "failed";
  url?: string;
  code?: string;
  pastes?: boolean;
  reason?: string;
}

export interface Warning {
  id: string;
  version: string;
  build: string;
  malware: string[];
  serious: string[];
  since: string;
}

export interface BuildsOptions {
  state: string; // the daemon's own: builds.json and the settings
  drop: string; // where root takes asks from: <state>/build-drop
  builds?: string; // /var/lib/agentv/build
  run?: string; // /run/agentv-build: root's answer
  spend?: string; // /var/lib/agentv/spend/spend.json
  warnings?: string; // /var/lib/agentv/npm-check/warnings.json
  recipes?: string; // builder/recipes
  now?: () => Date;
}

// What the daemon keeps of each build: what was asked, and how.
interface Asked {
  build: string;
  id: string;
  version: string;
  sentence: string;
  provider: Provider;
  path: "plan" | "key";
  from?: string;
  change?: string;
  at: string;
}

const SENTENCE_MAX = 300;
const ID = /^local\.[a-z0-9][a-z0-9-]*$/;

// The id an app gets from what was asked: local. and its first words.
export function idFor(sentence: string, taken: (id: string) => boolean): string {
  const words = sentence
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "my", "me", "add", "make", "build", "please", "i", "like", "would", "to", "for", "with", "of"].includes(w));
  const base = `local.${(words.join("-") || "app").slice(0, 32).replace(/-+$/, "")}`;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

// The next version of an app: each change or rebuild moves the minor on.
export function nextVersion(versions: string[]): string {
  const minors = versions.map((v) => /^1\.(\d+)\.0$/.exec(v)?.[1]).filter((m): m is string => m !== undefined).map(Number);
  return minors.length ? `1.${Math.max(...minors) + 1}.0` : "1.0.0";
}

export class Builds {
  private o: Required<Omit<BuildsOptions, "now">> & { now: () => Date };

  constructor(options: BuildsOptions) {
    this.o = {
      state: options.state,
      drop: options.drop,
      builds: options.builds ?? "/var/lib/agentv/build",
      run: options.run ?? "/run/agentv-build",
      spend: options.spend ?? "/var/lib/agentv/spend/spend.json",
      warnings: options.warnings ?? "/var/lib/agentv/npm-check/warnings.json",
      recipes: options.recipes ?? fileURLToPath(new URL("../builder/recipes/", import.meta.url)),
      now: options.now ?? (() => new Date()),
    };
  }

  private recipes: Map<Kind, Recipe> | null = null;

  // A kind's recipe, read once, for what a build costs and takes.
  private recipe(kind: string | null | undefined): Recipe | undefined {
    if (!kind) return undefined;
    try {
      this.recipes ??= loadRecipes(this.o.recipes);
    } catch {
      this.recipes = new Map();
    }
    return this.recipes.get(kind as Kind);
  }

  // The screenshot the approval shows, where the test TV left it.
  shot(view: BuildView): string {
    return join(this.o.builds, view.id, view.version, "shot.png");
  }

  private get askedPath(): string {
    return join(this.o.state, "builds.json");
  }

  private get settingsPath(): string {
    return join(this.o.state, "build-settings.json");
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(this.o.state, { recursive: true });
    await writeFile(`${path}.next`, `${JSON.stringify(data, null, 2)}\n`);
    await rename(`${path}.next`, path);
  }

  private asked(): Promise<Asked[]> {
    return this.readJson<Asked[]>(this.askedPath, []);
  }

  async settings(): Promise<BuildSettings> {
    const saved = await this.readJson<Partial<BuildSettings>>(this.settingsPath, {});
    return { cap: { ...DEFAULT_SETTINGS.cap, ...saved.cap }, safeguards: saved.safeguards !== false };
  }

  // An adult's change to the caps or the safeguards; the PIN is the caller's.
  async setSettings(change: unknown): Promise<{ settings?: BuildSettings; error?: string }> {
    const c = (typeof change === "object" && change !== null ? change : {}) as { cap?: { build?: unknown; month?: unknown }; safeguards?: unknown };
    const now = await this.settings();
    const dollars = (value: unknown, fallback: number) => (value === undefined ? fallback : typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1000 ? Math.round(value * 100) / 100 : NaN);
    const cap = { build: dollars(c.cap?.build, now.cap.build), month: dollars(c.cap?.month, now.cap.month) };
    if (Number.isNaN(cap.build) || Number.isNaN(cap.month)) return { error: "a cap is a number of dollars, up to 1000" };
    if (cap.build > cap.month) return { error: "a build's cap is no more than the month's" };
    if (c.safeguards !== undefined && typeof c.safeguards !== "boolean") return { error: "the safeguards are on or off" };
    const settings = { cap, safeguards: typeof c.safeguards === "boolean" ? c.safeguards : now.safeguards };
    await this.writeJson(this.settingsPath, settings);
    return { settings };
  }

  // --- What's going on ----------------------------------------------------

  private status(id: string, version: string): BuildStatus | null {
    try {
      return JSON.parse(readFileSync(join(this.o.builds, id, version, "status.json"), "utf8")) as BuildStatus;
    } catch {
      return null;
    }
  }

  // The build whose start root hasn't taken yet, if one is waiting.
  private waiting(): string | null {
    try {
      return JSON.parse(readFileSync(join(this.o.drop, "start.json"), "utf8")).build ?? null;
    } catch {
      return null;
    }
  }

  private answer(): { action?: string; build: string | null; started: boolean; reason?: string; at: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.o.run, "answer.json"), "utf8"));
    } catch {
      return null;
    }
  }

  // The plan's sign-in for a build waiting on it: how it's going, once it's
  // newer than the build's own word, or asked for and not yet begun.
  private signInFor(asked: Asked, mine: BuildStatus): SignInView | undefined {
    let said: (SignInView & { provider?: string; at?: string }) | null = null;
    try {
      said = JSON.parse(readFileSync(join(this.o.run, "sign-in", "status.json"), "utf8"));
    } catch {}
    const answer = this.answer();
    // A stop from the TV ends it, whatever the sign-in got to say.
    if (answer?.action === "stop" && answer.at > mine.at && (!said?.at || answer.at > said.at)) return { state: "failed", reason: "you stopped it" };
    if (said && said.provider === asked.provider && typeof said.at === "string" && said.at > mine.at && ["starting", "waiting", "done", "failed"].includes(said.state)) {
      return {
        state: said.state,
        ...(typeof said.url === "string" && said.url.startsWith("https://") ? { url: said.url } : {}),
        ...(typeof said.code === "string" ? { code: said.code } : {}),
        pastes: said.pastes === true,
        ...(typeof said.reason === "string" ? { reason: said.reason } : {}),
      };
    }
    if (existsSync(join(this.o.drop, "sign-in.json"))) return { state: "starting" };
    if (answer?.action === "sign-in" && answer.build === asked.build && answer.at > mine.at) return answer.started ? { state: "starting" } : { state: "failed", reason: answer.reason };
    return undefined;
  }

  // Every build the household asked for, newest first, as it stands.
  async list(): Promise<BuildView[]> {
    const answer = this.answer();
    const waiting = this.waiting();
    const views: BuildView[] = [];
    for (const asked of [...(await this.asked())].reverse()) {
      const status = this.status(asked.id, asked.version);
      const mine = status && status.build === asked.build ? status : null;
      // Root's word on this build, when it's newer than what the build says:
      // a start it refused, or took before the builder wrote anything, or an
      // install that didn't go in.
      const fresh = answer && answer.build === asked.build && (!mine || answer.at > mine.at) ? answer : null;
      const signIn = mine?.state === "plan-sign-in" ? this.signInFor(asked, mine) : undefined;
      // A sign-in that didn't finish fails the build, which tries again from
      // its sign-in.
      const refused = signIn?.state === "failed" ? `couldn't sign in to the plan: ${signIn.reason ?? "it stopped"}` : fresh && fresh.action !== "install" && !fresh.started ? fresh.reason : undefined;
      const starting = waiting === asked.build || (fresh?.action === "start" && fresh.started);
      const notInstalled = fresh?.action === "install" && !fresh.started ? fresh.reason : undefined;
      const recipe = this.recipe(mine?.understood?.recipe);
      views.push({
        build: asked.build,
        id: asked.id,
        version: asked.version,
        sentence: asked.sentence,
        name: mine?.understood?.name ?? mine?.plan?.name,
        provider: asked.provider,
        path: asked.path,
        state: refused ? "failed" : starting ? "starting" : (mine?.state ?? "starting"),
        phase: mine?.phase ?? "understand",
        step: mine?.step,
        steps: mine?.steps ?? [],
        reason: refused ?? notInstalled ?? mine?.reason,
        spent: this.spentBy(asked.build) ?? mine?.spent,
        understood: mine?.understood,
        plan: mine?.plan,
        cost: mine?.plan?.cost ?? recipe?.cost,
        minutes: recipe?.minutes,
        approval: mine?.approval,
        ...(signIn && signIn.state !== "failed" ? { signIn } : {}),
        shot: existsSync(join(this.o.builds, asked.id, asked.version, "shot.png")),
        at: mine?.at ?? asked.at,
      });
    }
    return views;
  }

  async find(build: unknown): Promise<BuildView | null> {
    return typeof build === "string" ? ((await this.list()).find((b) => b.build === build) ?? null) : null;
  }

  // What a build spent with a key, as the relay counted it.
  private spentBy(build: string): number | undefined {
    try {
      const spend = JSON.parse(readFileSync(this.o.spend, "utf8"));
      return typeof spend.builds?.[build] === "number" ? Math.round(spend.builds[build] * 100) / 100 : undefined;
    } catch {
      return undefined;
    }
  }

  // This month's spend with a key, against the caps.
  async spend(): Promise<{ month: string; spent: number; cap: BuildSettings["cap"] }> {
    const month = this.o.now().toISOString().slice(0, 7);
    const cap = (await this.settings()).cap;
    try {
      const spend = JSON.parse(readFileSync(this.o.spend, "utf8"));
      return { month, spent: spend.month === month ? Math.round(spend.spent * 100) / 100 : 0, cap };
    } catch {
      return { month, spent: 0, cap };
    }
  }

  // Apps whose packages turned bad since they were approved (ADR-044).
  warnings(): Warning[] {
    try {
      return (JSON.parse(readFileSync(this.o.warnings, "utf8")).apps ?? []) as Warning[];
    } catch {
      return [];
    }
  }

  // Whether a build is under way, for how often to look again. One waiting
  // for its plan's sign-in is, since it goes on by itself once it's in.
  async running(): Promise<boolean> {
    return (await this.list()).some((b) => b.state === "running" || b.state === "starting" || b.state === "plan-sign-in");
  }

  // What the daemon does by itself, each time it looks: a build waiting for
  // its plan's sign-in gets one, and starts again once it's signed in. True
  // when it asked root for something.
  async tend(): Promise<boolean> {
    this.tending ??= this.tendNow().finally(() => (this.tending = null));
    return this.tending;
  }

  private tending: Promise<boolean> | null = null;

  private async tendNow(): Promise<boolean> {
    const views = await this.list();
    const all = await this.asked();
    for (const view of views) {
      if (view.state !== "plan-sign-in") continue;
      const asked = all.find((a) => a.build === view.build);
      if (!asked) continue;
      if (!view.signIn) {
        await this.drop("sign-in", { build: view.build, provider: view.provider });
        return true;
      }
      if (view.signIn.state === "done") {
        await this.start(asked, view.phase, { ...this.again(view), signedIn: true });
        return true;
      }
    }
    return false;
  }

  // The code the provider's page gave the person, for the CLI's prompt.
  async signInCode(build: unknown, code: unknown): Promise<{ error?: string }> {
    const view = await this.find(build);
    if (!view) return { error: "there's no such build" };
    if (view.state !== "plan-sign-in" || view.signIn?.state !== "waiting" || !view.signIn.pastes) return { error: "nothing is waiting for a code" };
    const text = typeof code === "string" ? code.trim() : "";
    if (!/^[\x21-\x7e]{1,512}$/.test(text)) return { error: "paste the code the page gave you" };
    await this.drop("sign-in-code", { code: text });
    return {};
  }

  // --- What an adult asks for -----------------------------------------------

  private async drop(name: "start" | "stop" | "install" | "remove" | "sign-in" | "sign-in-code", data: unknown): Promise<void> {
    await mkdir(this.o.drop, { recursive: true });
    const path = join(this.o.drop, `${name}.json`);
    await writeFile(`${path}.next`, JSON.stringify(data));
    await rename(`${path}.next`, path);
  }

  private async start(asked: Asked, phase: BuildStatus["phase"], extra: Record<string, unknown> = {}): Promise<void> {
    const settings = await this.settings();
    await this.drop("start", {
      build: asked.build,
      id: asked.id,
      version: asked.version,
      sentence: asked.sentence,
      phase,
      recipe: null,
      provider: asked.provider,
      path: asked.path,
      safeguards: settings.safeguards,
      ...(asked.path === "key" ? { cap: settings.cap } : {}),
      ...(asked.from ? { from: asked.from } : {}),
      ...(asked.change ? { change: asked.change } : {}),
      ...extra,
    });
  }

  private taken(id: string, asked: Asked[], installed: string[]): boolean {
    return asked.some((a) => a.id === id) || installed.includes(id) || existsSync(join(this.o.builds, id));
  }

  // A sentence, for a new app: the agent says what it understood first.
  async ask(sentence: unknown, ai: { provider: Provider; path: "plan" | "key" }, installed: string[] = []): Promise<{ build?: BuildView; error?: string }> {
    const words = typeof sentence === "string" ? sentence.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (!words || words.length > SENTENCE_MAX) return { error: `say what you'd like in up to ${SENTENCE_MAX} characters` };
    if (await this.running()) return { error: "another build is going; one runs at a time" };
    const all = await this.asked();
    const at = this.o.now().toISOString();
    const asked: Asked = { build: `b${this.o.now().getTime()}`, id: idFor(words, (id) => this.taken(id, all, installed)), version: "1.0.0", sentence: words, provider: ai.provider, path: ai.path, at };
    await this.writeJson(this.askedPath, [...all, asked]);
    await this.start(asked, "understand");
    return { build: (await this.find(asked.build))! };
  }

  // An adult's yes to what the agent understood: the recipe's build, or with
  // no recipe a plan for an adult first (ADR-046).
  async confirm(build: unknown): Promise<{ build?: BuildView; error?: string }> {
    const view = await this.find(build);
    const asked = (await this.asked()).find((a) => a.build === view?.build);
    if (!view || !asked) return { error: "there's no such build" };
    if (view.state !== "confirm" || !view.understood) return { error: "this build isn't waiting to be confirmed" };
    const u = view.understood;
    if (u.recipe === null) await this.start(asked, "plan", { name: u.name });
    else await this.start(asked, "build", { recipe: u.recipe, name: u.name });
    return { build: (await this.find(asked.build))! };
  }

  // An adult's yes to a plan, on the phone behind the PIN: then it's built.
  async approvePlan(build: unknown): Promise<{ build?: BuildView; error?: string }> {
    const view = await this.find(build);
    const asked = (await this.asked()).find((a) => a.build === view?.build);
    if (!view || !asked) return { error: "there's no such build" };
    if (view.state !== "plan" || !view.plan) return { error: "this build has no plan waiting" };
    await this.start(asked, "build", { recipe: null, name: view.plan.name, plan: view.plan });
    return { build: (await this.find(asked.build))! };
  }

  // An adult's yes to the app, on the phone behind the PIN: root installs it.
  async approve(build: unknown): Promise<{ build?: BuildView; error?: string }> {
    const view = await this.find(build);
    if (!view) return { error: "there's no such build" };
    if (view.state !== "approve") return { error: "this app isn't waiting for approval" };
    await this.drop("install", { build: view.build, id: view.id, version: view.version });
    return { build: view };
  }

  // The same phase again, after it failed.
  async retry(build: unknown): Promise<{ build?: BuildView; error?: string }> {
    const view = await this.find(build);
    const asked = (await this.asked()).find((a) => a.build === view?.build);
    if (!view || !asked) return { error: "there's no such build" };
    if (view.state !== "failed") return { error: "only a build that failed is tried again" };
    if (await this.running()) return { error: "another build is going; one runs at a time" };
    await this.start(asked, view.phase, this.again(view));
    return { build: (await this.find(asked.build))! };
  }

  // What a phase needs again: what the agent understood, and an approved plan.
  private again(view: BuildView): Record<string, unknown> {
    return view.phase === "understand" ? {} : { recipe: view.understood?.recipe ?? null, name: view.name, ...(view.plan && view.understood?.recipe == null ? { plan: view.plan } : {}) };
  }

  async stop(): Promise<void> {
    await this.drop("stop", {});
  }

  // A build that never reached home, put away: "not this" when it's
  // confirmed, or one that failed. Its folder goes too, once no other
  // version of the app is left.
  async forget(build: unknown): Promise<{ error?: string }> {
    const view = await this.find(build);
    if (!view) return { error: "there's no such build" };
    if (view.state === "running") return { error: "stop it first" };
    if (view.state === "installed" || view.state === "kept") return { error: "that version is on the tv: remove the app instead" };
    if (view.state === "starting" || view.state === "plan-sign-in") await this.stop();
    const left = (await this.asked()).filter((a) => a.build !== view.build);
    await this.writeJson(this.askedPath, left);
    if (!left.some((a) => a.id === view.id)) await this.drop("remove", { id: view.id });
    return {};
  }

  // An app's next version: a change to it, or the same again from its recipe.
  async next(id: unknown, change: unknown, ai: { provider: Provider; path: "plan" | "key" }): Promise<{ build?: BuildView; error?: string }> {
    if (typeof id !== "string" || !ID.test(id)) return { error: "which app" };
    if (await this.running()) return { error: "another build is going; one runs at a time" };
    const all = await this.asked();
    const mine = all.filter((a) => a.id === id);
    const views = (await this.list()).filter((b) => b.id === id);
    const current = views.find((b) => b.state === "installed");
    const first = mine[0];
    if (!first || !current) return { error: "that app isn't one the builder made, or it isn't installed" };
    const words = typeof change === "string" ? change.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (change !== undefined && (!words || words.length > SENTENCE_MAX)) return { error: `say the change in up to ${SENTENCE_MAX} characters` };
    const asked: Asked = {
      build: `b${this.o.now().getTime()}`,
      id,
      version: nextVersion(mine.map((a) => a.version)),
      sentence: first.sentence,
      provider: ai.provider,
      path: ai.path,
      ...(words ? { from: current.version, change: words } : {}),
      at: this.o.now().toISOString(),
    };
    await this.writeJson(this.askedPath, [...all, asked]);
    await this.start(asked, "build", { recipe: current.understood?.recipe ?? null, name: current.name, ...(current.plan && current.understood?.recipe == null ? { plan: current.plan } : {}) });
    return { build: (await this.find(asked.build))! };
  }

  // The version before, back in place, behind the PIN: one press.
  async rollback(id: unknown): Promise<{ build?: BuildView; error?: string }> {
    const views = (await this.list()).filter((b) => b.id === id);
    const kept = views.find((b) => b.state === "kept");
    if (!kept) return { error: "there's no version before this one to go back to" };
    await this.drop("install", { build: kept.build, id: kept.id, version: kept.version });
    return { build: kept };
  }

  // An app and all its builds gone, behind the PIN.
  async remove(id: unknown): Promise<{ error?: string }> {
    if (typeof id !== "string" || !ID.test(id)) return { error: "which app" };
    const all = await this.asked();
    if (!all.some((a) => a.id === id)) return { error: "that app isn't one the builder made" };
    await this.drop("remove", { id });
    await this.writeJson(this.askedPath, all.filter((a) => a.id !== id));
    return {};
  }
}
