// Your agent's builds on the phone (ADR-043, ADR-046, board 18): the same
// notices the TV shows, and where an adult says yes. A finished app shows
// its screenshot from the test TV, what it reaches in plain words and its
// packages, and goes on the TV's home once it's approved with the PIN. A
// plan, for a request no recipe fits, shows its steps, what it'll reach and
// roughly what it costs, and is built once it's approved the same way. And
// the first build on a plan waits for its sign-in (ADR-040): the phone opens
// the provider's page, and hands back the code it gives, behind the PIN.

import { glyph } from "../launcher/glyphs.ts";
import { api, file, h, prompt, toast } from "./lib.ts";
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
  ranOut?: boolean; // the plan's sign-in ran out, and it's asked for again
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
  ranOut?: boolean;
  understood?: { recipe: string | null };
  shot: boolean;
}

const nameOf = (b: { name?: string; sentence?: string }) => b.name ?? b.sentence ?? "your app";
// Each AI by its name, where the TV sends its id.
const AI: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", muse: "Muse" };
const ai = (provider: string) => AI[provider] ?? provider;
const money = (dollars: number) => `$${dollars.toFixed(2)}`;

// Tells what moved on since the phone last asked, as the TV does.
export function buildNotices(before: PhoneBuild[] | undefined, now: PhoneBuild[] | undefined): void {
  if (!before || !now) return;
  const was = new Map(before.map((b) => [b.build, b]));
  for (const b of now) {
    const then = was.get(b.build);
    if (!then || then.state === b.state) continue;
    if (b.state === "approve") toast(`${b.name} is ready. Approve it here.`, true);
    else if (b.state === "plan") toast(`Check the steps for ${b.name}`, true);
    else if (b.state === "plan-sign-in") toast(b.ranOut ? `Sign in to ${ai(b.provider)} again to finish ${b.name}` : `Sign in to ${ai(b.provider)} to make ${b.name}`, true);
    else if (b.state === "failed") toast(`Couldn't make ${b.name}`);
  }
  // Approved and gone from the list: it's on the TV's home.
  for (const then of before) {
    if (then.state === "approve" && !now.some((b) => b.build === then.build)) toast(`${then.name} is on your TV`, true);
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
      h("span", {}, `Sign in to ${ai(signing.provider)}${signing.ranOut ? " again" : ""}`),
    );
  }
  const waiting = builds?.find((b) => b.state === "approve" || b.state === "plan");
  if (waiting) {
    return h(
      "button",
      { type: "button", class: "banner", "data-action": "approve-build", "data-build": waiting.build, onclick: () => open(waiting.build) },
      glyph("check", 18),
      h("span", {}, waiting.state === "plan" ? `Check the steps for ${waiting.name}` : `${waiting.name} is ready · approve it`),
    );
  }
  const b = builds?.[0];
  if (!b) return null;
  if (b.state === "failed") return h("p", { class: "note bad with-icon", "data-build": b.build }, glyph("tv", 16), h("span", {}, `Couldn't make ${b.name}. Try again on your TV.`));
  if (b.state === "running" || b.state === "starting") {
    const far = b.steps ? ` · ${b.done} of ${b.steps}` : "";
    return h("p", { class: "note with-icon", "data-build": b.build }, glyph("tv", 16), h("span", {}, `Making ${b.name}${far}`));
  }
  return null;
}

// The screenshot, as a data: address: the page's policy takes no other.
async function shot(build: string): Promise<string | null> {
  try {
    const response = await file(`/api/phone/builds/${build}/shot`);
    if (!response.ok) return null;
    const blob = new Blob([response.bytes as BlobPart], { type: response.type });
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
      page.replaceChildren(prompt("tv app approve"), h("p", { class: "note" }, "Nothing to approve right now"), h("button", { class: "button", type: "button", onclick: back }, "Back"));
      return;
    }
    const name = nameOf(b);
    const plan = b.state === "plan";
    // A theme your agent made (S6.4) becomes the TV's and the desktop's.
    const theme = b.understood?.recipe === "theme";
    const yes = async () => {
      try {
        const answered = await withPin(plan ? `the steps for ${name}` : `adding ${name}`, (grant) => api("POST", `/api/phone/builds/${build}/${plan ? "plan" : "approve"}`, {}, grant));
        if (answered === null) return;
        toast(plan ? `Making ${name} now` : theme ? `${name} is your theme now` : `${name} is on your home`, true);
        back();
        await done();
      } catch (error) {
        failed(error);
      }
    };
    const buttons = h(
      "div",
      { class: "build-buttons" },
      h("button", { class: "button primary", type: "button", "data-action": plan ? "approve-plan" : "approve", onclick: () => void yes() }, glyph("lock", 20), h("span", {}, "Approve")),
      h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "Not now"),
    );
    if (plan && b.plan) {
      const p = b.plan;
      const reach = [
        p.permissions.origins.length ? `Connects to ${p.permissions.origins.join(", ")}` : "Doesn't go online",
        ...(p.permissions.media.length ? [`Can show your ${p.permissions.media.join(" and ")}`] : []),
        ...(p.permissions.tile ? ["Adds a tile to home"] : []),
        ...(p.permissions.notices ? ["Can send you notices"] : []),
        "Can't see your other sign-ins or your AI key",
        "Stays on this TV",
      ];
      const cost = b.path === "key" ? (b.cost ? `About ${money(b.cost.low)} to ${money(b.cost.high)}` : `Uses your ${ai(b.provider)} key`) : `Uses your ${ai(b.provider)} plan`;
      page.replaceChildren(
        prompt(`tv app plan ${name.toLowerCase()}`),
        h("h1", {}, `Steps for ${name}`),
        h("p", { class: "note" }, "This one's new, so check the steps. Nothing is made until you approve."),
        h("p", { class: "note" }, p.says),
        h("ol", { class: "plan-steps" }, ...p.steps.map((s) => h("li", {}, s.does))),
        checks(reach),
        ...(p.packages.length ? [h("p", { class: "note" }, `Uses: ${p.packages.map((x) => (x.version ? `${x.name} ${x.version}` : x.name)).join(", ")}`)] : []),
        h("div", { class: "limits" }, h("b", {}, "Cost"), h("span", {}, cost)),
        buttons,
      );
      return;
    }
    const a = b.approval ?? { reaches: { always: [], declared: [] }, packages: [] };
    const img = h("img", { class: "build-shot", alt: theme ? `Your TV in ${name}` : `${name} on a TV` }) as HTMLImageElement;
    const signedInLook = b.understood?.recipe === "streaming" && b.phase !== "stage-b";
    page.replaceChildren(
      prompt(`tv app approve ${name.toLowerCase()}`),
      h("h1", {}, `${name} is ready`),
      h(
        "p",
        { class: "note" },
        b.phase === "stage-b"
          ? `${name} can now search, play and show what's on. Update it on your TV?`
          : theme
            ? "Your theme is ready: colours and a background or two. Use it?"
            : "Add it to your TV?",
      ),
      ...(b.shot ? [img] : []),
      checks(theme ? ["Just colours, icons and pictures", "Doesn't go online", "Stays on this TV"] : [...a.reaches.always, ...a.reaches.declared, "Can't see your other sign-ins or your AI key", "Stays on this TV"]),
      ...(!theme && a.packages.length ? [h("p", { class: "note" }, `Uses: ${a.packages.map((x) => `${x.name} ${x.version}`).join(", ")}`)] : []),
      h("p", { class: "note ok-line" }, h("b", {}, "✓"), " Tested and working"),
      // A streaming app's first yes is also a yes to what comes after it:
      // once someone signs in to it, the TV studies the signed-in pages
      // (stage B), and the AI reads what it finds there.
      ...(signedInLook ? [h("p", { class: "note", "data-note": "signed-in-look" }, `To finish, your TV looks at a few pages of ${name} while you're signed in, and sends what it reads to ${ai(b.provider)}`)] : []),
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
  const name = nameOf(b);
  const provider = ai(b.provider);
  const s = b.signIn;
  const head = [
    prompt(`tv app sign-in ${b.provider}`),
    h("h1", {}, `Sign in to ${provider}${b.ranOut ? " again" : ""}`),
    h("p", { class: "note" }, b.ranOut ? `Your ${provider} sign-in expired. Sign in again to finish ${name}.` : `Sign in to ${provider} to make ${name}. You only do this once.`),
  ];
  const leave = h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "Back");
  if (s?.state !== "waiting" || !s.url) return [...head, h("p", { class: "note" }, s?.state === "done" ? "You're signed in. Carrying on." : "Starting the sign-in…"), leave];
  const link = h("a", { class: "button primary", href: s.url, target: "_blank", rel: "noopener noreferrer", "data-action": "open-sign-in" }, `Open ${provider}'s sign-in`);
  if (s.code) {
    return [...head, link, h("p", { class: "note" }, "Sign in there, and enter this code when it asks:"), h("p", { class: "plan-code" }, s.code), h("p", { class: "note" }, "It continues once you're in"), leave];
  }
  const field = h("input", { class: "field", type: "text", name: "code", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Paste the code", "aria-label": "Sign-in code" }) as HTMLInputElement;
  const send = async (event: Event) => {
    event.preventDefault();
    const code = field.value.trim();
    if (!code) return toast("Paste the code first");
    try {
      const answered = await withPin(`signing in to ${provider}`, (grant) => api("POST", `/api/phone/builds/${b.build}/code`, { code }, grant));
      if (answered === null) return;
      field.value = "";
      toast("Signing in on your TV…", true);
    } catch (error) {
      failed(error);
    }
  };
  return [
    ...head,
    link,
    h("p", { class: "note" }, "Sign in there, then paste the code it gives you here"),
    h("form", { class: "plan-paste", onsubmit: (event: Event) => void send(event) }, field, h("button", { class: "button primary", type: "submit", "data-action": "send-code" }, glyph("lock", 20), h("span", {}, "Send"))),
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
  const save = async () => {
    try {
      const response = await file(`/api/phone/apps/${offer.id}/export`);
      if (!response.ok) throw new Error((response.data as { error?: string }).error ?? "Couldn't save a copy");
      const link = h("a", { href: URL.createObjectURL(new Blob([response.bytes as BlobPart], { type: response.type })), download: `${offer.id}-${offer.version}.zip` }) as HTMLAnchorElement;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      toast(`${offer.name} is saved on this phone`, true);
    } catch (error) {
      failed(error);
    }
  };
  return h("button", { type: "button", class: "banner", "data-action": "save-export", onclick: () => void save() }, glyph("download", 18), h("span", {}, `Save ${offer.name} on this phone`));
}

// The push, when the box is signed in to GitHub as the person.
export function pushBanner(offer: Offer | null | undefined, open: () => void): HTMLElement | null {
  if (!offer?.github) return null;
  return h("button", { type: "button", class: "banner", "data-action": "push-export", onclick: open }, glyph("lock", 18), h("span", {}, `Push ${offer.name} to GitHub`));
}

// Where it goes, asked each time, and the PIN. The TV pushes it as the
// person, in a folder named after the app, and never with --force.
export function pushPage(offer: Offer & { github: { via: "gh" | "ssh"; login: string } }, back: () => void, failed: (error: unknown) => void): HTMLElement[] {
  const name = offer.name;
  const field = h("input", { class: "field", type: "text", name: "repo", value: `${offer.github.login}/${offer.id.replace(/^local\./, "")}`, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Repo" }) as HTMLInputElement;
  const label = h("span", {}, "Push");
  const button = h("button", { class: "button primary", type: "submit", "data-action": "push" }, glyph("lock", 20), label) as HTMLButtonElement;
  const push = async (event: Event) => {
    event.preventDefault();
    const repo = field.value.trim();
    if (!repo) return toast("Type the repo first");
    button.disabled = true;
    label.textContent = "Pushing…";
    try {
      const answered = await withPin(`pushing ${name}`, (grant) => api<{ url: string; pushed: boolean }>("POST", `/api/phone/apps/${offer.id}/push`, { repo }, grant));
      if (answered === null) return;
      toast(answered.pushed ? `${name} is on ${answered.url.replace(/^https:\/\//, "")}` : `${answered.url.replace(/^https:\/\//, "")} has this version already`, true);
      back();
    } catch (error) {
      failed(error);
    } finally {
      button.disabled = false;
      label.textContent = "Push";
    }
  };
  return [
    prompt(`git push ${offer.id}`),
    h("h1", {}, `Push ${name} to GitHub`),
    h("p", { class: "note" }, `Your TV pushes it as ${offer.github.login}, to a folder named ${offer.id}. Nothing else in the repo changes.`),
    h("p", { class: "note" }, offer.github.via === "gh" ? "A new repo is made private" : "The repo has to be on GitHub already"),
    h("form", { class: "plan-paste", onsubmit: (event: Event) => void push(event) }, field, button),
    h("button", { class: "button", type: "button", "data-action": "not-now", onclick: back }, "Back"),
  ];
}
