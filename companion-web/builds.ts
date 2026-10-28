// Your agent's builds on the phone (ADR-043, ADR-046, board 18): the same
// notices the TV shows, and where an adult says yes. A finished app shows
// its screenshot from the test TV, what it reaches in plain words and its
// packages, and goes on the TV's home once it's approved with the PIN. A
// plan, for a request no recipe fits, shows its steps, what it'll reach and
// roughly what it costs, and is built once it's approved the same way.

import { glyph } from "../launcher/glyphs.ts";
import { api, h, prompt, toast, token } from "./lib.ts";
import { withPin } from "./pad.ts";

// How each build stands, from the phone's state.
export interface PhoneBuild {
  build: string;
  id: string;
  name: string;
  state: string;
  phase: string;
  done: number;
  steps: number;
  reason?: string;
}

// The whole build, as the phone asks for it to approve it.
interface FullBuild {
  build: string;
  name?: string;
  sentence: string;
  provider: string;
  path: "plan" | "key";
  state: string;
  steps: { id: string; state: string }[];
  approval?: { reaches: { always: string[]; declared: string[] }; packages: { name: string; version: string }[] };
  plan?: {
    name: string;
    says: string;
    steps: { id: string; does: string }[];
    permissions: { origins: string[]; media: string[]; tile: boolean; notices: boolean };
    packages: { name: string; version?: string }[];
  };
  cost?: { low: number; high: number };
  shot: boolean;
}

const lower = (b: { name?: string; sentence?: string }) => (b.name ?? b.sentence ?? "the app").toLowerCase();
const money = (dollars: number) => `$${dollars.toFixed(2)}`;

// Tells what moved on since the phone last asked, as the TV does.
export function buildNotices(before: PhoneBuild[] | undefined, now: PhoneBuild[] | undefined): void {
  if (!before || !now) return;
  const was = new Map(before.map((b) => [b.build, b]));
  for (const b of now) {
    const then = was.get(b.build);
    if (!then || then.state === b.state) continue;
    const name = b.name.toLowerCase();
    if (b.state === "approve") toast(`${name} is ready: approve it here`, true);
    else if (b.state === "plan") toast(`a plan for ${name}: approve it here`, true);
    else if (b.state === "failed") toast(`couldn't build ${name}: ${b.reason ?? "it stopped"}`);
  }
  // Approved and gone from the list: it's on the TV's home.
  for (const then of before) {
    if (then.state === "approve" && !now.some((b) => b.build === then.build)) toast(`${then.name.toLowerCase()} is on your tv`, true);
  }
}

// What the remote shows above its pad: the build waiting for a yes, or the
// one going, or the one that failed.
export function buildBanner(builds: PhoneBuild[] | undefined, open: (build: string) => void): HTMLElement | null {
  const waiting = builds?.find((b) => b.state === "approve" || b.state === "plan");
  if (waiting) {
    const name = waiting.name.toLowerCase();
    return h(
      "button",
      { type: "button", class: "banner", "data-action": "approve-build", "data-build": waiting.build, onclick: () => open(waiting.build) },
      glyph("check", 18),
      h("span", {}, waiting.state === "plan" ? `a plan for ${name} · approve it ›` : `${name} is ready · approve it ›`),
    );
  }
  const b = builds?.[0];
  if (!b) return null;
  const name = b.name.toLowerCase();
  if (b.state === "failed") return h("p", { class: "note bad with-icon", "data-build": b.build }, glyph("tv", 16), h("span", {}, `couldn't build ${name} · try again on the tv`));
  if (b.state === "running" || b.state === "starting") {
    const far = b.steps ? ` · ${b.done} of ${b.steps}` : "";
    return h("p", { class: "note with-icon", "data-build": b.build }, glyph("tv", 16), h("span", {}, `building ${name}${far}`));
  }
  return null;
}

// The screenshot, as a data: address: the page's policy takes no other.
async function shot(build: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/phone/builds/${build}/shot`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise((done) => {
      const reader = new FileReader();
      reader.onload = () => done(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => done(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function checks(lines: string[]): HTMLElement {
  return h("ul", { class: "checks" }, ...lines.map((line) => h("li", {}, h("b", {}, "[x]"), ` ${line}`)));
}

// A finished app (board 18), or a plan, for an adult's yes. back leaves it.
export function buildPage(build: string, back: () => void, failed: (error: unknown) => void, done: () => Promise<void>): HTMLElement {
  const page = h("div", { class: "page build-approve", "data-build": build }, prompt("tv app approve"), h("p", { class: "note" }, "…"));
  void (async () => {
    let b: FullBuild | undefined;
    try {
      b = (await api<{ builds: FullBuild[] }>("GET", "/api/phone/builds")).builds.find((x) => x.build === build);
    } catch (error) {
      failed(error);
      return;
    }
    if (!b || (b.state !== "approve" && b.state !== "plan")) {
      page.replaceChildren(prompt("tv app approve"), h("p", { class: "note" }, "there's nothing waiting for you here now."), h("button", { class: "button", type: "button", onclick: back }, "back"));
      return;
    }
    const name = lower(b);
    const plan = b.state === "plan";
    const yes = async () => {
      try {
        const answered = await withPin(plan ? `the plan for ${name}` : `adding ${name}`, (grant) => api("POST", `/api/phone/builds/${build}/${plan ? "plan" : "approve"}`, {}, grant));
        if (answered === null) return;
        toast(plan ? `your agent builds ${name} now` : `${name} goes on your tv's home`, true);
        back();
        await done();
      } catch (error) {
        failed(error);
      }
    };
    const buttons = h(
      "div",
      { class: "build-buttons" },
      h("button", { class: "button primary", type: "button", "data-action": plan ? "approve-plan" : "approve", onclick: () => void yes() }, glyph("lock", 20), h("span", {}, "approve with pin")),
      h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "not now"),
    );
    if (plan && b.plan) {
      const p = b.plan;
      const reach = [
        p.permissions.origins.length ? `reaches ${p.permissions.origins.join(", ")}` : "reaches nothing on the internet",
        ...(p.permissions.media.length ? [`shows your ${p.permissions.media.join(" and ")} through the tv`] : []),
        ...(p.permissions.tile ? ["puts a tile on home"] : []),
        ...(p.permissions.notices ? ["can show notices on the tv and here"] : []),
        "can't see your other sign-ins or your ai key",
        "stays on this tv",
      ];
      const cost = b.path === "key" ? (b.cost ? `about ${money(b.cost.low)} to ${money(b.cost.high)} on your ${b.provider} key.` : `on your ${b.provider} key.`) : `on your ${b.provider} plan, within its own limits.`;
      page.replaceChildren(
        prompt(`tv app plan ${name}`),
        h("h1", {}, `a plan for ${name}`),
        h("p", { class: "note" }, `no recipe fits "${b.sentence}", so your agent wrote this plan. it builds nothing until you approve it.`),
        h("p", { class: "note" }, p.says.toLowerCase()),
        h("ol", { class: "plan-steps" }, ...p.steps.map((s) => h("li", {}, s.does))),
        checks(reach),
        h("p", { class: "note" }, p.packages.length ? `packages: ${p.packages.map((x) => (x.version ? `${x.name} ${x.version}` : x.name)).join(", ")}` : "packages: none"),
        h("div", { class: "limits" }, h("b", {}, "cost"), h("span", {}, cost)),
        buttons,
      );
      return;
    }
    const a = b.approval ?? { reaches: { always: [], declared: [] }, packages: [] };
    const img = h("img", { class: "build-shot", alt: `${name} on the test tv` }) as HTMLImageElement;
    page.replaceChildren(
      prompt(`tv app approve ${name}`),
      h("h1", {}, `${name} is ready`),
      h("p", { class: "note" }, "your agent built it. add it to the tv?"),
      ...(b.shot ? [img] : []),
      checks([...a.reaches.always, ...a.reaches.declared, "can't see your other sign-ins or your ai key", "stays on this tv"]),
      h("p", { class: "note" }, a.packages.length ? `packages: ${a.packages.map((x) => `${x.name} ${x.version}`).join(", ")}` : "packages: none"),
      h("p", { class: "note ok-line" }, h("b", {}, "✓"), ` its checks passed: ${b.steps.filter((s) => s.state === "done").length} steps, and the test tv`),
      buttons,
    );
    if (b.shot) {
      const src = await shot(build);
      if (src) img.src = src;
      else img.remove();
    }
  })();
  return page;
}
