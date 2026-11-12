// Settings, network (ADR-084): how the TV is online, the Wi-Fi nearby with
// the one it's on marked, and joining another one. A network with a password
// opens a page with its field, which the paired phone's keyboard types into:
// the typing bar shows dots, and the password goes from this page to the
// daemon and on to root, and nowhere else. An open network joins at once.
// A join that doesn't work leaves the TV on the network it was on, and the
// page says what didn't happen in one line.
//
// Changing the Wi-Fi is an adult's, behind the PIN when one is set, as
// pairing a phone is. A child's profile sees how the TV is online.
//
// The words are written in sentence case with real names, and go through
// named() (looks/looks.ts), so Terminal shows them in lower case and Glass
// and Cinema as written. A network's name is never changed.

import { h } from "../dom.ts";
import { named } from "../looks/looks.ts";
import { asWritten } from "../looks/words.ts";
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

// A sentence with a network's name in it: the words as the look writes
// them, and the name as it is.
function withName(sentence: string, ssid: string): string {
  return named(sentence).replace("%s", ssid);
}

// How the TV is online, in a few words.
function online(now: Status | null): string {
  if (!now) return "";
  if (now.joining) return withName("Joining %s…", now.joining);
  if (now.via === "wi-fi") return now.name ? `${named("Wi-Fi")} · ${now.name}` : named("Wi-Fi");
  if (now.via === "cable") return named("Cable");
  return named("Offline");
}

// Why a join didn't work, and what to do, in one line.
function problemLine(problem: { ssid: string; why: Why }, hidden = false): string {
  if (problem.why === "password") return withName("Couldn't join %s. Check the password.", problem.ssid);
  if (problem.why === "missing") return withName(hidden ? "Couldn't find %s. Check the name." : "Couldn't find %s. Try again.", problem.ssid);
  return withName("Couldn't join %s. Try again.", problem.ssid);
}

// Settings' row for it, which this page keeps up to date itself.
export function networkValue(): string {
  return online(status);
}

function setValue(): void {
  const value = document.querySelector<HTMLElement>('.menu-item[data-key="network"] .menu-value');
  if (!value) return;
  value.setAttribute("data-own-case", "");
  value.textContent = networkValue();
}

// The list of networks is for whoever may pick one, so a child's profile
// isn't given it and doesn't ask.
async function load(): Promise<void> {
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
  if (redraw) void load().then(() => redraw?.()).catch(() => {});
}

// Asked once as the launcher starts, for the notice.
export async function followNetwork(): Promise<void> {
  await load().catch(() => {});
  showOffline(status?.hotspot ?? null);
}

// The join, with the grant from the PIN entered for this visit. A grant
// that ran out is asked for once more.
async function join(ctx: Ctx, ssid: string, password: string): Promise<string | null> {
  for (const again of [false, true]) {
    const grant = again ? await ctx.grant(named("changing the Wi-Fi")) : (ctx.held() ?? "");
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

// What's wrong with a Wi-Fi password, as the TV checks it too
// (daemon/hotspot.ts): 8 to 63 plain characters, or 64 hex digits.
function passwordLine(password: string): string | null {
  if (password.length < 8) return named("Wi-Fi passwords have at least 8 characters");
  if (/^[0-9a-fA-F]{64}$/.test(password)) return null;
  if (!/^[\x20-\x7e]*$/.test(password)) return named("Wi-Fi passwords use plain letters, numbers and symbols");
  if (password.length > 63) return named("Wi-Fi passwords have at most 63 characters");
  return null;
}

// What the page says when the daemon wouldn't start a join.
function refusedLine(why: string, ssid: string, password = ""): string {
  if (why === "password") return passwordLine(password) ?? named("Wi-Fi passwords have at least 8 characters");
  if (why === "name") return named("Check the network name");
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
    const grant = await ctx.grant(named("changing the Wi-Fi"));
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
      ctx.toast(asWritten(refusedLine(why, network.ssid)), "fail");
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
    setValue();
    const now = status;
    const key = JSON.stringify([now, networks]);
    if (key === drawn) return;
    drawn = key;
    const focused = ctx.focus.get();
    const was = box.contains(focused ?? null) ? (focused?.dataset.action ?? `ssid:${focused?.dataset.ssid ?? ""}`) : null;
    const parts: (HTMLElement | null)[] = [h("div", { class: "panel-title", "data-own-case": true, "data-line": "online" }, online(now))];
    if (now?.problem && !now.joining) parts.push(h("p", { class: "panel-note", "data-own-case": true, "data-line": "problem" }, problemLine(now.problem)));
    if (now?.wifi === false) parts.push(h("p", { class: "panel-note" }, named("Your TV has no Wi-Fi")));
    else if (now?.change) {
      const row = (network: Listed | null) => networkRow(network, { other: named("Another network"), class: "button wide network", pick: (one) => void pick(one) });
      if (networks.length === 0 && !now.looking) parts.push(h("p", { class: "panel-note" }, named("No Wi-Fi found nearby")));
      parts.push(...networks.map(row), row(null));
      // With the hotspot open the radio can't look, so the list is from
      // before it opened.
      if (!now.hotspot) {
        parts.push(
          h(
            "button",
            { class: "button wide", "data-focus": true, "data-action": "look", onclick: () => void look() },
            h("span", {}, named("Look again")),
            h("span", { class: "button-value" }, now.looking ? named("Looking…") : ""),
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
  void load()
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
    void load().then(draw).catch(() => {});
  }, 3000);
  return [box];
}

// The page a network with a password, or one that hides its name, opens.
export function wifiPage(ctx: Ctx): View {
  const network = picked ?? { ssid: "", secure: true, hidden: true };
  const title = network.hidden ? named("Another network") : withName("Join %s", network.ssid);
  const [prompt, headline] = heading("tv settings · network", title);
  headline.setAttribute("data-own-case", "");
  const line = h("p", { class: "panel-note", "data-own-case": true, "data-line": "wifi" });
  let sending = false;
  let timer = 0;

  const say = (text: string) => {
    line.textContent = text;
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
    const wrong = fields.password ? passwordLine(password) : null;
    if (wrong) return say(wrong);
    sending = true;
    line.textContent = "";
    const why = await join(ctx, name, password);
    if (why) {
      sending = false;
      if (why !== "pin") say(refusedLine(why, name, password));
      return;
    }
    // Joining takes a while. The page says so, then how it went.
    headline.textContent = withName("Joining %s…", name);
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
          headline.textContent = title;
          if (fields.password) fields.password.value = "";
          say(problemLine(now.problem, network.hidden));
          ctx.focus.set(fields.password ?? fields.name ?? fields.go);
        })
        .catch(() => {});
    }, 500);
  };

  const fields = joinFields(network, { name: named("Network name"), password: named("Password"), join: named("Join"), placeholders: true }, (ssid, password) => void send(ssid, password), "music-search");
  const form = h("div", { class: "profile-form" }, fields.name, fields.password, h("div", { class: "check-actions" }, fields.go));
  const el = h("div", { class: "screen" }, h("div", { class: "page profile wifi-join" }, prompt, headline, line, form), bar(ctx, "settings", ""));
  return { el, first: fields.name ?? fields.password ?? fields.go };
}
