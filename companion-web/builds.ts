// Your agent's builds on the phone (ADR-043, ADR-046, board 18): the same
// notices the TV shows, and where an adult says yes. A finished app shows
// its screenshot from the test TV, what it reaches in plain words and its
// packages, and goes on the TV's home once it's approved with the PIN. A
// plan, for a request no recipe fits, shows its steps, what it'll reach and
// roughly what it costs, and is built once it's approved the same way. And
// the first build on a plan waits for its sign-in (ADR-040): the phone opens
// the provider's page, and hands back the code it gives, behind the PIN.

import { glyph } from "../launcher/glyphs.ts";
import { api, h, prompt, toast, token } from "./lib.ts";
import { withPin } from "./pad.ts";

// How each build stands, from the phone's state.
export interface PhoneBuild {
  build: string;
  id: string;
  name: string;
  provider: string;
  state: string;
  phase: string;
  signIn?: string;
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
  phase?: string;
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
  signIn?: { state: string; url?: string; code?: string; pastes?: boolean };
  understood?: { recipe: string | null };
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
    else if (b.state === "plan-sign-in") toast(`sign in to your ${b.provider} plan to build ${name}`, true);
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
  const signing = builds?.find((b) => b.state === "plan-sign-in");
  if (signing) {
    return h(
      "button",
      { type: "button", class: "banner", "data-action": "plan-sign-in", "data-build": signing.build, onclick: () => open(signing.build) },
      glyph("lock", 18),
      h("span", {}, `sign in to your ${signing.provider} plan ›`),
    );
  }
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
    if (b?.state === "plan-sign-in") {
      page.replaceChildren(...signInPage(b, back, failed));
      return;
    }
    if (!b || (b.state !== "approve" && b.state !== "plan")) {
      page.replaceChildren(prompt("tv app approve"), h("p", { class: "note" }, "there's nothing waiting for you here now."), h("button", { class: "button", type: "button", onclick: back }, "back"));
      return;
    }
    const name = lower(b);
    const plan = b.state === "plan";
    // A theme your agent made (S6.4) becomes the TV's and the desktop's.
    const theme = b.understood?.recipe === "theme";
    const yes = async () => {
      try {
        const answered = await withPin(plan ? `the plan for ${name}` : `adding ${name}`, (grant) => api("POST", `/api/phone/builds/${build}/${plan ? "plan" : "approve"}`, {}, grant));
        if (answered === null) return;
        toast(plan ? `your agent builds ${name} now` : theme ? `${name} becomes your theme` : `${name} goes on your tv's home`, true);
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
    const img = h("img", { class: "build-shot", alt: theme ? `the tv in ${name}` : `${name} on the test tv` }) as HTMLImageElement;
    const passed = b.steps.filter((s) => s.state === "done").length;
    page.replaceChildren(
      prompt(`tv app approve ${name}`),
      h("h1", {}, `${name} is ready`),
      h(
        "p",
        { class: "note" },
        b.phase === "stage-b"
          ? `your agent learned how to search ${name}, play from it and see what's on. update it on the tv?`
          : theme
            ? "your agent made a theme: its colours and a background or two. make it your theme, on the tv and omarchy's desktop?"
            : "your agent built it. add it to the tv?",
      ),
      ...(b.shot ? [img] : []),
      checks(theme ? ["its colours, its icons and its pictures, and nothing that runs", "reaches nothing on the internet", "stays on this tv"] : [...a.reaches.always, ...a.reaches.declared, "can't see your other sign-ins or your ai key", "stays on this tv"]),
      ...(theme ? [] : [h("p", { class: "note" }, a.packages.length ? `packages: ${a.packages.map((x) => `${x.name} ${x.version}`).join(", ")}` : "packages: none")]),
      h("p", { class: "note ok-line" }, h("b", {}, "✓"), theme ? ` its checks passed: ${passed} steps, and the theme check` : ` its checks passed: ${passed} steps, and the test tv`),
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

// The plan's sign-in (ADR-040): the provider's own page, opened here, and
// the code it gives, typed into the CLI's prompt on the box. Its tokens stay
// in the CLI's own files there; this page never sees them.
function signInPage(b: FullBuild, back: () => void, failed: (error: unknown) => void): HTMLElement[] {
  const name = lower(b);
  const s = b.signIn;
  const head = [prompt(`tv app sign-in ${b.provider}`), h("h1", {}, `sign in to your ${b.provider} plan`), h("p", { class: "note" }, `${name} is built on your ${b.provider} plan, and your agent isn't signed in to it yet. you sign in once.`)];
  const leave = h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "back");
  if (s?.state !== "waiting" || !s.url) return [...head, h("p", { class: "note" }, s?.state === "done" ? "you're signed in. your agent goes on." : "the sign-in is starting on the tv…"), leave];
  const link = h("a", { class: "button primary", href: s.url, target: "_blank", rel: "noopener noreferrer", "data-action": "open-sign-in" }, `open ${b.provider}'s sign-in ›`);
  if (s.code) {
    return [...head, link, h("p", { class: "note" }, "sign in there, and enter this code when it asks:"), h("p", { class: "plan-code" }, s.code), h("p", { class: "note" }, "the tv goes on once you're in."), leave];
  }
  const field = h("input", { class: "field", type: "text", name: "code", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "paste the code here", "aria-label": "the sign-in code" }) as HTMLInputElement;
  const send = async (event: Event) => {
    event.preventDefault();
    const code = field.value.trim();
    if (!code) return toast("paste the code first");
    try {
      const answered = await withPin(`the ${b.provider} plan's sign-in`, (grant) => api("POST", `/api/phone/builds/${b.build}/code`, { code }, grant));
      if (answered === null) return;
      field.value = "";
      toast("signing in on the tv…", true);
    } catch (error) {
      failed(error);
    }
  };
  return [
    ...head,
    link,
    h("p", { class: "note" }, "sign in there, then copy the code the page gives you and paste it here."),
    h("form", { class: "plan-paste", onsubmit: (event: Event) => void send(event) }, field, h("button", { class: "button primary", type: "submit", "data-action": "send-code" }, glyph("lock", 20), h("span", {}, "send it with pin"))),
    leave,
  ];
}

// An app the TV offered for Export (ADR-045): the package as a .zip, saved
// on this phone, or pushed to a repo of the person's own when the box is
// signed in to GitHub as them.
export interface Offer {
  id: string;
  name: string;
  version: string;
  github?: { via: "gh" | "ssh"; login: string } | null;
}

export function exportBanner(offer: Offer | null | undefined, failed: (error: unknown) => void): HTMLElement | null {
  if (!offer) return null;
  const name = offer.name.toLowerCase();
  const save = async () => {
    try {
      const response = await fetch(`/api/phone/apps/${offer.id}/export`, { headers: { Authorization: `Bearer ${token()}` } });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "it couldn't be exported");
      const link = h("a", { href: URL.createObjectURL(await response.blob()), download: `${offer.id}-${offer.version}.zip` }) as HTMLAnchorElement;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      toast(`${name} is saved on this phone`, true);
    } catch (error) {
      failed(error);
    }
  };
  return h("button", { type: "button", class: "banner", "data-action": "save-export", onclick: () => void save() }, glyph("download", 18), h("span", {}, `save ${name} on this phone ›`));
}

// The push, when the box is signed in to GitHub as the person.
export function pushBanner(offer: Offer | null | undefined, open: () => void): HTMLElement | null {
  if (!offer?.github) return null;
  return h("button", { type: "button", class: "banner", "data-action": "push-export", onclick: open }, glyph("lock", 18), h("span", {}, `push ${offer.name.toLowerCase()} to github ›`));
}

// Where it goes, asked each time, and the PIN. The TV pushes it as the
// person, in a folder named after the app, and never with --force.
export function pushPage(offer: Offer & { github: { via: "gh" | "ssh"; login: string } }, back: () => void, failed: (error: unknown) => void): HTMLElement[] {
  const name = offer.name.toLowerCase();
  const field = h("input", { class: "field", type: "text", name: "repo", value: `${offer.github.login}/${offer.id.replace(/^local\./, "")}`, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "the repo" }) as HTMLInputElement;
  const label = h("span", {}, "push it with pin");
  const button = h("button", { class: "button primary", type: "submit", "data-action": "push" }, glyph("lock", 20), label) as HTMLButtonElement;
  const push = async (event: Event) => {
    event.preventDefault();
    const repo = field.value.trim();
    if (!repo) return toast("type the repo first");
    button.disabled = true;
    label.textContent = "pushing…";
    try {
      const answered = await withPin(`pushing ${name}`, (grant) => api<{ url: string; pushed: boolean }>("POST", `/api/phone/apps/${offer.id}/push`, { repo }, grant));
      if (answered === null) return;
      toast(answered.pushed ? `${name} is on ${answered.url.replace(/^https:\/\//, "")}` : `${answered.url.replace(/^https:\/\//, "")} has this version already`, true);
      back();
    } catch (error) {
      failed(error);
    } finally {
      button.disabled = false;
      label.textContent = "push it with pin";
    }
  };
  return [
    prompt(`git push ${offer.id}`),
    h("h1", {}, `push ${name} to github`),
    h("p", { class: "note" }, `the tv pushes it as ${offer.github.login}, in a folder named ${offer.id}. the rest of the repo stays as it is, and nothing is forced.`),
    h("p", { class: "note" }, offer.github.via === "gh" ? "a repo that isn't there yet is made, private." : "the repo has to be on github already."),
    h("form", { class: "plan-paste", onsubmit: (event: Event) => void push(event) }, field, button),
    h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "back"),
  ];
}
