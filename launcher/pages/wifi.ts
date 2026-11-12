// Settings, Network (ADR-084): a row that says how the TV is online, and
// its page: the Wi-Fi nearby with the one it's on marked, and joining
// another one. A network with a password opens a page with its field, which
// the paired phone's keyboard types into: the typing bar shows dots, and the
// password goes from this page to the daemon and on to root, and nowhere
// else. An open network joins at once. A join that doesn't work leaves the
// TV on the network it was on, and the page says what didn't happen in one
// line.
//
// Changing the Wi-Fi is an adult's, behind the PIN when one is set, as
// pairing a phone is.
//
// The words are written in sentence case with real names. Terminal shows
// them in lower case with its own CSS rule, and a network's name is marked
// so it's never changed.

import { asWritten, h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { showOffline } from "../offline.ts";
import { joinFields, networkRow, type Listed, type Picked } from "../wifi-parts.ts";
import { bar, heading } from "./parts.ts";

type Why = "password" | "missing" | "failed";

interface Status {
  online: boolean;
  via: "wi-fi" | "cable" | null;
  name: string | null;
  wifi: boolean | null;
  looking: boolean;
  joining: string | null;
  problem: { ssid: string; why: Why } | null;
  hotspot: { ssid: string; problem: boolean } | null;
  // Whether who's watching may change it.
  change?: boolean;
}

// What the daemon said last, kept between visits so the panel draws at once.
let status: Status | null = null;
let networks: Listed[] = [];
// The network the join page is for.
let picked: Picked | null = null;
// The panel on screen, to draw again when there's news.
let redraw: (() => void) | null = null;
// When this page last had root look, so opening Settings twice in a row
// doesn't look twice.
let looked = 0;
const LOOK_EVERY_MS = 30_000;

async function call<T>(method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw Object.assign(new Error(String(data.error ?? "failed")), { pin: data.pin === true });
  return data as T;
}

// A sentence with a network's name in it: the words as written, and the
// name marked as its own.
function withName(sentence: string, ssid = ""): Node[] {
  const [before, after = ""] = sentence.split("%s");
  return [before, ssid ? asWritten(ssid) : "", after].filter((part) => part !== "").map((part) => (typeof part === "string" ? document.createTextNode(part) : part));
}

// How the TV is online, in a few words.
function online(now: Status | null): Node[] {
  if (!now) return [];
  if (now.joining) return withName("Joining %s…", now.joining);
  if (now.via === "wi-fi") return now.name ? withName("Wi-Fi · %s", now.name) : withName("Wi-Fi");
  if (now.via === "cable") return withName("Cable");
  return withName("Offline");
}

// Why a join didn't work, and what to do, in one line.
function problemLine(problem: { ssid: string; why: Why }, hidden = false): Node[] {
  if (problem.why === "password") return withName("Couldn't join %s. Check the password.", problem.ssid);
  if (problem.why === "missing") return withName(hidden ? "Couldn't find %s. Check the name." : "Couldn't find %s. Try again.", problem.ssid);
  return withName("Couldn't join %s. Try again.", problem.ssid);
}

// Settings' rows: how the TV is online. The Wi-Fi row opens its page.
export function networkRows(open: () => void): HTMLElement[] {
  const now = status;
  if (!now) return [];
  const plain = (label: string, value: string) => h("div", { class: "panel-row", "data-row": "cable" }, h("span", {}, label), h("span", { class: "button-value" }, value));
  if (now.wifi === false) return [plain("Cable", now.via === "cable" ? "Connected" : "Not connected")];
  const value = now.joining ? withName("Joining %s…", now.joining) : now.via === "wi-fi" && now.name ? [asWritten(now.name)] : [now.via === "wi-fi" ? "Connected" : "Not connected"];
  return [
    ...(now.via === "cable" ? [plain("Cable", "Connected")] : []),
    h("button", { class: "button wide", "data-focus": true, "data-action": "wifi", onclick: open }, h("span", {}, "Wi-Fi"), h("span", { class: "button-value" }, ...value)),
  ];
}

// Settings, while it's on screen, draws its rows again when there's news.
let rowsHeard: (() => void) | null = null;

export function watchNetwork(heard: () => void): void {
  rowsHeard = heard;
}

// The list of networks is for whoever may pick one, so a child's profile
// isn't given it and doesn't ask.
export async function loadNetwork(): Promise<void> {
  const now = await call<Status>("GET", "/api/network");
  const found = now.change ? await call<{ networks: Listed[] }>("GET", "/api/network/networks") : { networks: [] };
  status = now;
  networks = found.networks;
}

// The daemon's news: root looked, a join moved on, or the hotspot opened or
// closed. The notice follows, and so does Settings when it's on screen.
export function networkHeard(data: unknown): void {
  const now = data as Status | null;
  if (!now || typeof now.online !== "boolean") return;
  status = { ...now, change: status?.change };
  showOffline(now.hotspot);
  if (redraw) void loadNetwork().then(() => redraw?.()).catch(() => {});
}

// Asked once as the launcher starts, for the notice.
export async function followNetwork(): Promise<void> {
  await loadNetwork().catch(() => {});
  showOffline(status?.hotspot ?? null);
}

// The join, with the grant from the PIN entered for this visit. A grant
// that ran out is asked for once more.
async function join(ctx: Ctx, ssid: string, password: string): Promise<string | null> {
  for (const again of [false, true]) {
    const grant = again ? await ctx.grant("changing the Wi-Fi") : (ctx.held() ?? "");
    if (grant === null) return "pin";
    try {
      status = { ...(await call<Status>("POST", "/api/network/join", { ssid, password }, grant || undefined)), change: true };
      return null;
    } catch (error) {
      if (!(error as { pin?: boolean }).pin) return (error as Error).message;
      ctx.forgetGrant();
    }
  }
  return "pin";
}

// What the page says when the daemon wouldn't start a join.
function refusedLine(why: string, ssid: string): Node[] {
  if (why === "password") return withName("Wi-Fi passwords have at least 8 characters");
  if (why === "name") return withName("Check the network name");
  return withName("Couldn't join %s. Try again.", ssid);
}

export function networkPanel(ctx: Ctx): HTMLElement[] {
  const box = h("div", { class: "wifi-panel" });
  let drawn = "";
  let timer = 0;

  // An open network joins from here. One with a password, or a name to
  // type, gets its page. Either way the PIN first, when one is set.
  const pick = async (network: Picked) => {
    if (!network.hidden && networks.find((one) => one.ssid === network.ssid)?.current) return;
    const grant = await ctx.grant("changing the Wi-Fi");
    if (grant === null || !box.isConnected) return;
    if (network.secure || network.hidden) {
      picked = network;
      ctx.go("wifi");
      return;
    }
    const why = await join(ctx, network.ssid, "");
    if (why === "pin") return;
    if (why) {
      ctx.sounds.play("failure");
      ctx.toast(h("span", {}, ...refusedLine(why, network.ssid)), "fail");
      return;
    }
    ctx.sounds.play("confirm");
    draw();
  };

  const look = async () => {
    looked = Date.now();
    try {
      status = { ...(await call<Status>("POST", "/api/network/scan")), change: status?.change };
    } catch {
      // The radio is busy, or the hotspot has it: the list stays as it is.
    }
    draw();
  };

  function draw(): void {
    const now = status;
    const key = JSON.stringify([now, networks]);
    if (key === drawn) return;
    drawn = key;
    const focused = ctx.focus.get();
    const was = box.contains(focused ?? null) ? (focused?.dataset.action ?? `ssid:${focused?.dataset.ssid ?? ""}`) : null;
    const parts: (HTMLElement | null)[] = [h("div", { class: "panel-title", "data-line": "online" }, ...online(now))];
    if (now?.problem && !now.joining) parts.push(h("p", { class: "panel-note", "data-line": "problem" }, ...problemLine(now.problem)));
    if (now?.wifi === false) parts.push(h("p", { class: "panel-note" }, "Your TV has no Wi-Fi"));
    else if (now?.change) {
      const row = (network: Listed | null) => networkRow(network, { other: "Another network", class: "button wide network", pick: (one) => void pick(one) });
      if (networks.length === 0 && !now.looking) parts.push(h("p", { class: "panel-note" }, "No Wi-Fi found nearby"));
      parts.push(...networks.map(row), row(null));
      // With the hotspot open the radio can't look, so the list is from
      // before it opened.
      if (!now.hotspot) {
        parts.push(
          h(
            "button",
            { class: "button wide", "data-focus": true, "data-action": "look", onclick: () => void look() },
            h("span", {}, "Look again"),
            h("span", { class: "button-value" }, now.looking ? "Looking…" : ""),
          ),
        );
      }
    }
    box.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
    if (was === null) return;
    const again = was.startsWith("ssid:") ? [...box.querySelectorAll<HTMLElement>("[data-ssid]")].find((el) => `ssid:${el.dataset.ssid}` === was) : box.querySelector<HTMLElement>(`[data-action="${was}"]`);
    const next = again ?? box.querySelector<HTMLElement>("[data-focus]");
    if (next) ctx.focus.set(next);
  }

  draw();
  redraw = draw;
  void loadNetwork()
    .then(() => {
      draw();
      // A fresh list when Settings opens, for whoever may change it.
      if (status?.change && status.wifi !== false && !status.hotspot && !status.looking && !status.joining && Date.now() - looked > LOOK_EVERY_MS) void look();
    })
    .catch(() => {});
  // A cable going in or out has no news of its own, so the panel asks now
  // and then while it's on screen.
  timer = window.setInterval(() => {
    if (!box.isConnected) {
      clearInterval(timer);
      if (redraw === draw) redraw = null;
      return;
    }
    void loadNetwork().then(draw).catch(() => {});
  }, 3000);
  return [box];
}

// The page a network with a password, or one that hides its name, opens.
export function wifiPage(ctx: Ctx): View {
  const network = picked ?? { ssid: "", secure: true, hidden: true };
  const title = () => (network.hidden ? withName("Another network") : withName("Join %s", network.ssid));
  const [prompt, headline] = heading("tv settings · network", "");
  headline.replaceChildren(...title());
  const line = h("p", { class: "panel-note", "data-line": "wifi" });
  let sending = false;
  let timer = 0;

  const say = (words: Node[]) => {
    line.replaceChildren(...words);
    ctx.sounds.play("failure");
  };

  const send = async (ssid: string, password: string) => {
    if (sending) return;
    const name = ssid.trim();
    if (!name) {
      ctx.sounds.play("failure");
      if (fields.name) ctx.focus.set(fields.name);
      return;
    }
    if (fields.password && password.length < 8) return say(withName("Wi-Fi passwords have at least 8 characters"));
    sending = true;
    line.textContent = "";
    const why = await join(ctx, name, password);
    if (why) {
      sending = false;
      if (why !== "pin") say(refusedLine(why, name));
      return;
    }
    // Joining takes a while. The page says so, then how it went.
    headline.replaceChildren(...withName("Joining %s…", name));
    ctx.sounds.play("confirm");
    timer = window.setInterval(() => {
      if (!el.isConnected) {
        clearInterval(timer);
        return;
      }
      void call<Status>("GET", "/api/network")
        .then((now) => {
          status = now;
          if (now.joining || !el.isConnected || !sending) return;
          clearInterval(timer);
          sending = false;
          if (!now.problem) {
            ctx.back();
            return;
          }
          // The password's field again, empty, for another try.
          headline.replaceChildren(...title());
          if (fields.password) fields.password.value = "";
          say(problemLine(now.problem, network.hidden));
          ctx.focus.set(fields.password ?? fields.name ?? fields.go);
        })
        .catch(() => {});
    }, 500);
  };

  const fields = joinFields(network, { name: "Network name", password: "Password", join: "Join", placeholders: true }, (ssid, password) => void send(ssid, password), "music-search");
  const form = h("div", { class: "profile-form" }, fields.name, fields.password, h("div", { class: "check-actions" }, fields.go));
  const el = h("div", { class: "screen" }, h("div", { class: "page profile wifi-join" }, prompt, headline, line, form), bar(ctx, "settings", ""));
  return { el, first: fields.name ?? fields.password ?? fields.go };
}
