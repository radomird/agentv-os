// The new phone remote (ADR-065, design page D4), behind the remote2 switch.
// One screen:
// - a big surface: swipe to move, tap for OK, and a hold opens the
//   focused app's details on home and Apps (ADR-089) and gives the pointer
//   over an app. A
//   switch in the top bar puts a d-pad on it instead, for people who want
//   buttons. On Omarchy's desktop it's the pointer by itself;
// - Back, Home and play or pause in one row, always in the same place.
//   Holding Back goes home, and the phone sends the hold;
// - Ask, full width under them;
// - one notice line at the bottom, the most important first;
// - a menu with who's watching, edit home, share, Apps, Settings and the
//   click and buzz switch.
// The keyboard comes up by itself whenever a field on the TV has the focus,
// and what's typed shows in the TV's field as it's typed. Play and pause
// ask the box, which says whether it worked. Nothing redraws under a field
// someone is typing in.

import { arrange } from "./arrange.ts";
import { buildBanner, buildPage, exportBanner, type Offer, type PhoneBuild, pushBanner, pushPage } from "./builds.ts";
import { feelOn, setFeel } from "./feel.ts";
import { icon, type Icon } from "./icons.ts";
import { api, avatar, call, h, Unpaired, type Viewer } from "./lib.ts";
import { listKey, networkLine, type TvList } from "./network.ts";
import { askPin, withPin } from "./pad.ts";
import { photoPage } from "./photo.ts";
import { sayAnswer, sayBox, type Said } from "./say.ts";
import { askSheet, refreshAsk, type AskView } from "./ask.ts";
import { sharePage } from "./share.ts";

// The field with the focus on the TV, as the daemon says it.
export interface Field {
  kind: string;
  label?: string;
  app?: string;
  name?: string;
  value?: string;
}

// What of the phone's state the remote draws.
export interface Phone {
  viewer: Viewer;
  viewers: Viewer[];
  pin: { set: boolean; locked: boolean };
  signIn: { name: string } | null;
  update: { version: string; later: boolean } | null;
  // What's on the TV: front is home or an app, and screen is home, a menu
  // or the screen saver.
  tv: { view: string; field: Field | null; playing: boolean; front?: string; screen?: string };
  setup: { step: string; part: string; muted: boolean } | null;
  notices?: { app: string; name: string; text: string; at: string }[];
  builds?: PhoneBuild[];
  export?: Offer | null;
  said?: Said | null;
  nowPlaying?: { title: string; app: string; left?: number } | null;
  look?: string;
  // What's on the network, while the TV shows it (companion-web/network.ts).
  discover?: TvList | null;
  // The Ask box building (ADR-068): its switch, and what it waits on.
  features?: { askbuilds?: boolean };
  ask?: AskView | null;
}

// What the remote needs from the page around it (main.ts).
export interface Kit {
  state(): Phone | null;
  failed(error: unknown): void;
  refresh(force?: boolean): Promise<void>;
  // The update notice's page, as the old remote draws it.
  updatePage(): HTMLElement | null;
}

type Page = "remote" | "edit" | "share" | "photo" | "update" | "build" | "push";
type Sheet = "menu" | "ask" | "notices" | null;

interface Notice {
  text: string;
  open?: () => void;
}

const DPAD = "agentv-phone-dpad";
// How far a swipe goes for one step of the focus, and how long a hold is.
const STEP_PX = 44;
const HOLD_MS = 600;
// How long Back is held before the phone sends the hold that goes home.
const BACK_HOLD_MS = 700;
// How long the TV holds OK for a hold on the phone's OK: longer than the
// TV waits on a tile before it opens the app's details (launcher/input.ts).
const OK_HOLD_MS = 700;

// A request whose answer says how it went, whether or not it worked.
async function post<T extends object>(path: string, body: unknown): Promise<T & { ok: boolean; why?: string; error?: string }> {
  const response = await call("POST", path, { json: body });
  if (response.status === 401) throw new Unpaired("this phone isn't paired");
  return { ok: false, ...response.data } as T & { ok: boolean; why?: string; error?: string };
}

function dpadOn(): boolean {
  try {
    return localStorage.getItem(DPAD) === "on";
  } catch {
    return false;
  }
}

function setDpad(on: boolean): void {
  try {
    localStorage.setItem(DPAD, on ? "on" : "off");
  } catch {
    // A private window keeps it only while the page is open.
  }
}

// Which field the keyboard is for, so a change elsewhere doesn't redraw it.
function fieldKey(state: Phone): string {
  const f = state.tv.field;
  return JSON.stringify([f?.app ?? "", f?.kind ?? "", f?.label ?? "", state.signIn?.name ?? ""]);
}

// What the phone types into the TV's field: each change as it happens, the
// newest one waiting while another is on its way, so the TV keeps up.
class Typing {
  private field: HTMLInputElement;
  private note: HTMLElement;
  private normal: string;
  private failed: (error: unknown) => void;
  private busy = false;
  private next: { value: string; caret: number | null } | null = null;

  constructor(field: HTMLInputElement, note: HTMLElement, normal: string, failed: (error: unknown) => void) {
    this.field = field;
    this.note = note;
    this.normal = normal;
    this.failed = failed;
  }

  change(): void {
    let caret: number | null = null;
    try {
      caret = this.field.selectionStart;
    } catch {
      // Some kinds of field have no caret to ask about.
    }
    this.next = { value: this.field.value, caret };
    void this.pump();
  }

  async done(): Promise<void> {
    while (this.busy || this.next) await new Promise((wait) => setTimeout(wait, 20));
    try {
      const answer = await post("/api/phone/text", { done: true });
      if (!answer.ok) this.say(answer.why ?? answer.error ?? "enter didn't reach the tv", true);
    } catch (error) {
      this.failed(error);
    }
  }

  private say(text: string, bad: boolean): void {
    this.note.textContent = text;
    this.note.classList.toggle("bad", bad);
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.next) {
        const sent = this.next;
        this.next = null;
        const answer = await post<{ value?: string; kept?: number }>("/api/phone/text", sent).catch((error) => {
          this.failed(error);
          return null;
        });
        if (!answer) continue;
        // The TV holds less than the phone: what couldn't go, or a field
        // that's full. The phone shows what the TV has, unless more was
        // typed meanwhile.
        const now = this.field.value === sent.value && !this.next;
        if (now && typeof answer.value === "string" && answer.value !== sent.value) this.field.value = answer.value;
        else if (now && typeof answer.kept === "number" && answer.kept < sent.value.length) this.field.value = sent.value.slice(0, answer.kept);
        if (answer.ok) this.say(this.normal, false);
        else this.say(answer.why ?? answer.error ?? "the tv didn't take that", true);
      }
    } finally {
      this.busy = false;
    }
  }
}

export class Remote2 {
  private root: HTMLElement;
  private kit: Kit;
  private page: Page = "remote";
  private sheet: Sheet = null;
  // The pointer, from a hold on the surface, until done.
  private pointer = false;
  // The field the keyboard was put away for, which it stays away from.
  private dismissed = "";
  // The build being approved, while its page is open.
  private building: string | null = null;
  private shape = "";
  // A page that keeps what's in it while the remote draws around it.
  private kept: HTMLElement | null = null;
  // What the notice line says for a moment, such as why play didn't work.
  private hint = "";
  private hintTimer = 0;
  private notice: HTMLElement | null = null;
  private playKey: HTMLButtonElement | null = null;
  private card: HTMLElement | null = null;
  // The surface's line for what a hold does, which follows what's in front.
  private holdHint: { area: HTMLElement; line: HTMLElement } | null = null;
  private about: string | null = null;
  // The press on the d-pad's OK that's under way, if one is.
  private okPress: { finger: number; held: boolean; filling: boolean; left: boolean; timer: number } | null = null;

  constructor(root: HTMLElement, kit: Kit) {
    this.root = root;
    this.kit = kit;
    // What's left of the screen above the phone's own keyboard: Safari lays
    // the keyboard over the page instead of making the page shorter.
    const viewport = window.visualViewport;
    const fit = () => document.documentElement.style.setProperty("--r2-height", `${Math.round(viewport?.height ?? innerHeight)}px`);
    viewport?.addEventListener("resize", fit);
    fit();
  }

  // Draws the remote for the state, or only what changed when it's still
  // the same screen, so a field being typed in stays as it is.
  draw(force = false): void {
    const state = this.kit.state();
    if (!state) return;
    document.body.dataset.look = state.look ?? "terminal";
    const shape = this.shapeOf(state);
    if (!force && shape === this.shape) {
      this.refreshParts(state);
      return;
    }
    this.shape = shape;
    this.build(state);
  }

  private keyboardFor(state: Phone): boolean {
    return (state.tv.view === "keyboard" || state.signIn !== null) && fieldKey(state) !== this.dismissed;
  }

  private shapeOf(state: Phone): string {
    if (this.page === "update") return `update ${JSON.stringify(state.update)} ${state.pin.set}`;
    if (this.page === "build") return `build ${this.building} ${JSON.stringify(state.builds)}`;
    if (this.page !== "remote") return this.page;
    const screen = this.keyboardFor(state) ? `keyboard ${fieldKey(state)}` : state.tv.view === "trackpad" ? "desktop" : this.pointer ? "pointer" : dpadOn() ? "dpad" : "surface";
    return `${screen} ${this.sheet} ${state.viewer.id} ${state.viewer.name} ${state.viewer.role} ${Boolean(state.nowPlaying && state.tv.playing)} ${listKey(state.discover)}`;
  }

  // --- The screen -----------------------------------------------------------

  private build(state: Phone): void {
    this.notice = null;
    this.playKey = null;
    this.card = null;
    this.holdHint = null;
    let children: (HTMLElement | null)[];
    if (this.page !== "remote") children = this.subPage(state);
    else if (this.keyboardFor(state)) children = this.keyboard(state);
    else {
      this.card = this.playing(state);
      this.notice = this.noticeLine(state);
      const network = state.discover ? networkLine(state.discover, this.kit.failed) : null;
      children = [this.top(state), this.card, network, this.surface(state), this.keys(state), this.askButton(), this.notice];
    }
    if (this.page === "remote") this.kept = null;
    this.root.replaceChildren(h("div", { class: "r2", "data-screen": this.shape.split(" ")[0] }, ...children));
    this.drawSheet(state);
  }

  // What changes on the same screen: the notice line, play or pause, and
  // what's playing.
  private refreshParts(state: Phone): void {
    if (this.notice) {
      const fresh = this.noticeLine(state);
      this.notice.replaceWith(fresh);
      this.notice = fresh;
    }
    if (this.playKey) this.setPlay(this.playKey, state.tv.playing);
    this.sayHold();
    if (this.card && state.nowPlaying) {
      const fresh = this.playing(state);
      if (fresh) {
        this.card.replaceWith(fresh);
        this.card = fresh;
      }
    }
    if (this.sheet === "ask") sayAnswer(state.said, this.kit.failed, () => void this.kit.refresh());
    if (this.sheet === "ask" && state.features?.askbuilds) refreshAsk(state.ask, state.viewer.role === "adult", this.kit.failed, () => void this.kit.refresh());
    if (this.sheet === "menu") this.drawSheet(state);
  }

  private send(event: Record<string, unknown>): void {
    void api("POST", "/api/phone/remote", event).catch(this.kit.failed);
  }

  private iconButton(name: Icon, label: string, props: Record<string, unknown>, size = 24): HTMLButtonElement {
    return h("button", { type: "button", ...props }, icon(name, size), label ? h("span", {}, label) : null);
  }

  private top(state: Phone): HTMLElement {
    const dpad = dpadOn();
    return h(
      "div",
      { class: "r2-top" },
      h("button", { type: "button", class: "r2-who", "data-action": "who", "aria-label": `${state.viewer.name}, the menu`, onclick: () => this.openSheet("menu") }, avatar(state.viewer), h("span", {}, state.viewer.name.toLowerCase())),
      h(
        "span",
        { class: "r2-top-buttons" },
        this.iconButton("dpad", "", {
          class: `r2-icon${dpad ? " on" : ""}`,
          "aria-label": "buttons instead of swiping",
          "aria-pressed": String(dpad),
          "data-action": "dpad",
          onclick: () => {
            setDpad(!dpadOn());
            this.pointer = false;
            this.draw(true);
          },
        }),
        this.iconButton("menu", "", { class: "r2-icon", "aria-label": "menu", "data-action": "menu", onclick: () => this.openSheet("menu") }),
      ),
    );
  }

  // What's playing, with next, while something plays and the box knows it.
  private playing(state: Phone): HTMLElement | null {
    const now = state.nowPlaying;
    if (!now || !state.tv.playing) return null;
    const left = now.left !== undefined ? ` · ${now.left} min left` : "";
    return h(
      "div",
      { class: "r2-card", "data-now": now.title },
      h("span", { class: "r2-card-text" }, h("b", {}, now.title), h("span", {}, `${now.app}${left}`)),
      this.iconButton("next", "", { class: "r2-icon flat", "aria-label": "next", "data-action": "next", onclick: () => void this.playback("next") }),
    );
  }

  // What a hold on the surface does, in its hint: details with home or Apps
  // in front, the pointer over an app. Only the words change, so a finger
  // that's on the surface stays on it.
  private sayHold(): void {
    if (!this.holdHint) return;
    const what = this.holds() ? "hold for details" : "hold for the pointer";
    if (this.holdHint.line.textContent !== what) this.holdHint.line.textContent = what;
    this.holdHint.area.setAttribute("aria-label", `swipe to move, tap for ok, ${what}`);
  }

  // The surface: swipes move the focus and a tap is OK. A hold with home or
  // Apps in front is a hold on OK, which opens the focused app's details
  // (ADR-089), and over an app it gives the pointer. With the switch on, a
  // d-pad; on the desktop, the pointer.
  private surface(state: Phone): HTMLElement {
    if (state.tv.view === "trackpad" || this.pointer) return this.pointerPad(state.tv.view !== "trackpad");
    if (dpadOn()) return this.dpad();
    const line = h("span", {});
    const area = h("div", { class: "r2-surface", role: "application", "data-action": "surface" }, h("span", { class: "r2-hint" }, h("span", {}, "swipe to move"), h("span", {}, "tap for OK"), line));
    this.holdHint = { area, line };
    this.sayHold();
    let from: { x: number; y: number; at: number } | null = null;
    let moved = false;
    let hold = 0;
    const flash = () => {
      area.classList.add("pressed");
      window.setTimeout(() => area.classList.remove("pressed"), 120);
      if (feelOn()) navigator.vibrate?.(8);
    };
    area.addEventListener("pointerdown", (event) => {
      area.setPointerCapture(event.pointerId);
      from = { x: event.clientX, y: event.clientY, at: Date.now() };
      moved = false;
      hold = window.setTimeout(() => {
        from = null;
        if (feelOn()) navigator.vibrate?.(20);
        // What the TV says is in front as the hold lands, the same way the
        // d-pad's OK asks.
        if (this.holds()) {
          this.send({ hold: "enter", ms: OK_HOLD_MS });
          flash();
          return;
        }
        this.pointer = true;
        this.draw(true);
      }, HOLD_MS);
    });
    area.addEventListener("pointermove", (event) => {
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (Math.abs(dx) < STEP_PX && Math.abs(dy) < STEP_PX) {
        if (Math.abs(dx) + Math.abs(dy) > 12) clearTimeout(hold);
        return;
      }
      clearTimeout(hold);
      moved = true;
      const across = Math.abs(dx) >= Math.abs(dy);
      this.send({ key: across ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up" });
      flash();
      // The next step counts from here, so a long swipe moves on.
      from = across ? { ...from, x: from.x + Math.sign(dx) * STEP_PX } : { ...from, y: from.y + Math.sign(dy) * STEP_PX };
    });
    const end = (event: PointerEvent) => {
      clearTimeout(hold);
      if (from && !moved && event.type === "pointerup" && Date.now() - from.at < HOLD_MS) {
        this.send({ key: "enter" });
        flash();
      }
      from = null;
    };
    area.addEventListener("pointerup", end);
    area.addEventListener("pointercancel", end);
    return area;
  }

  // Whether a hold on OK, or on the surface, has anything to open: only on
  // home's own screens, where a tile's details are. With an app or the screen saver in front,
  // the TV would only get Enter held down. (For the PIN pad the phone shows
  // its own digits, and no OK.)
  private holds(): boolean {
    const tv = this.kit.state()?.tv;
    return tv?.front === "home" && tv.screen !== "ambient";
  }

  // The d-pad's OK. A tap is OK. Held with home in front, the phone sends
  // the hold, and on a tile the TV opens that app's details (ADR-084), as
  // Back's hold goes home. Anywhere else a long press is OK as it lifts.
  // The press is the remote's and not the button's, since the remote can
  // draw itself again under a finger: one press at a time, which ends when
  // its own finger lifts, whichever button is there by then.
  private ok(): HTMLElement {
    const ok = h("button", { type: "button", class: "r2-ok", "aria-label": "ok", "data-key": "enter" }, "OK");
    if (this.okPress?.filling) ok.classList.add("holding");
    ok.addEventListener("pointerdown", (event) => {
      if (this.okPress) return;
      const press: NonNullable<Remote2["okPress"]> = { finger: event.pointerId, held: false, filling: this.holds(), left: false, timer: 0 };
      this.okPress = press;
      // It fills while it's held, when a hold does something.
      if (press.filling) ok.classList.add("holding");
      press.timer = window.setTimeout(() => {
        if (!this.holds()) return;
        press.held = true;
        if (feelOn()) navigator.vibrate?.(20);
        this.send({ hold: "enter", ms: OK_HOLD_MS });
      }, HOLD_MS);
      const release = (lifted: PointerEvent) => {
        if (lifted.pointerId !== press.finger) return;
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        clearTimeout(press.timer);
        this.okPress = null;
        this.root.querySelector(".r2-ok")?.classList.remove("holding");
        if (!press.held && !press.left && lifted.type === "pointerup") this.send({ key: "enter" });
      };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
    });
    // A finger that slides off the button takes the press back.
    ok.addEventListener("pointerleave", (event) => {
      const press = this.okPress;
      if (!press || press.finger !== event.pointerId) return;
      press.left = true;
      clearTimeout(press.timer);
      ok.classList.remove("holding");
    });
    // A keyboard's Enter on the button, which has no pointer.
    ok.addEventListener("click", (event) => event.detail === 0 && this.send({ key: "enter" }));
    // A long press is the hold, not the phone's own menu.
    ok.addEventListener("contextmenu", (event) => event.preventDefault());
    return ok;
  }

  private dpad(): HTMLElement {
    const arrow = (name: "up" | "down" | "left" | "right") => this.iconButton(name, "", { class: `r2-arrow r2-${name}`, "aria-label": name, "data-key": name, onclick: () => this.send({ key: name }) }, 36);
    return h(
      "div",
      { class: "r2-surface r2-dpad", "data-action": "dpad-pad" },
      arrow("up"),
      arrow("left"),
      this.ok(),
      arrow("right"),
      arrow("down"),
    );
  }

  // The pointer: move to point, tap to click. From a hold, done puts the
  // surface back; on the desktop it stays.
  private pointerPad(byHold: boolean): HTMLElement {
    const dot = h("span", { class: "r2-dot", "aria-hidden": "true" });
    const area = h(
      "div",
      { class: "r2-surface r2-pointer", role: "application", "aria-label": "move to point, tap to click", "data-action": "trackpad" },
      h(
        "span",
        { class: "r2-pointer-top" },
        h("span", { class: "r2-chip" }, icon("pointer", 16), h("span", {}, "pointer")),
        byHold
          ? h(
              "button",
              {
                type: "button",
                class: "r2-done",
                "data-action": "pointer-done",
                onclick: () => {
                  this.pointer = false;
                  this.draw(true);
                },
              },
              "done",
            )
          : null,
      ),
      dot,
      h("span", { class: "r2-hint low" }, "move to point · tap to click"),
    );
    let last: { x: number; y: number } | null = null;
    let travelled = 0;
    let downAt = 0;
    let owed = [0, 0];
    let flushing = 0;
    const flush = () => {
      flushing = 0;
      const [dx, dy] = owed.map(Math.round);
      owed = [0, 0];
      if (dx || dy) this.send({ move: [dx, dy] });
    };
    const place = (event: PointerEvent) => {
      const box = area.getBoundingClientRect();
      dot.style.transform = `translate(${event.clientX - box.left}px, ${event.clientY - box.top}px)`;
    };
    area.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button")) return;
      area.setPointerCapture(event.pointerId);
      last = { x: event.clientX, y: event.clientY };
      travelled = 0;
      downAt = Date.now();
      area.classList.add("touching");
      place(event);
    });
    area.addEventListener("pointermove", (event) => {
      if (!last) return;
      // Twice the finger's way, so a phone's width crosses the TV.
      const dx = (event.clientX - last.x) * 2;
      const dy = (event.clientY - last.y) * 2;
      last = { x: event.clientX, y: event.clientY };
      travelled += Math.abs(dx) + Math.abs(dy);
      owed = [owed[0] + dx, owed[1] + dy];
      flushing ||= window.setTimeout(flush, 30);
      place(event);
    });
    const end = () => {
      if (last && travelled < 12 && Date.now() - downAt < 250) this.send({ click: "left" });
      last = null;
      area.classList.remove("touching");
      flush();
    };
    area.addEventListener("pointerup", end);
    area.addEventListener("pointercancel", end);
    return area;
  }

  // Back, Home, and play or pause. A tap on Back goes back; held, it goes
  // home, and the phone sends the hold.
  private keys(state: Phone, small = false): HTMLElement {
    const size = small ? 22 : 28;
    const label = h("span", {}, small ? "" : "back");
    const back = h("button", { type: "button", class: "r2-key", "aria-label": "back, hold for home", "data-key": "back" }, icon("back", size), small ? null : label);
    let timer = 0;
    let held = false;
    back.addEventListener("pointerdown", () => {
      held = false;
      back.classList.add("holding");
      timer = window.setTimeout(() => {
        held = true;
        label.textContent = "home…";
        if (feelOn()) navigator.vibrate?.(20);
        this.send({ hold: "back", ms: 1100 });
      }, BACK_HOLD_MS);
    });
    const release = (event: Event) => {
      clearTimeout(timer);
      back.classList.remove("holding");
      if (!held && event.type === "pointerup") this.send({ key: "back" });
      if (held) window.setTimeout(() => (label.textContent = small ? "" : "back"), 600);
      held = false;
    };
    back.addEventListener("pointerup", release);
    back.addEventListener("pointercancel", release);
    back.addEventListener("pointerleave", (event) => back.classList.contains("holding") && release(event));
    // A keyboard's Enter on the button, which has no pointer.
    back.addEventListener("click", (event) => event.detail === 0 && this.send({ key: "back" }));
    const home = this.iconButton("home", small ? "" : "home", { class: "r2-key", "aria-label": "home", "data-key": "home", onclick: () => this.send({ key: "home" }) }, size);
    const play = this.iconButton("play", small ? "" : "play", { class: "r2-key", "data-action": "playpause", onclick: () => void this.playback("toggle") }, size);
    this.setPlay(play, state.tv.playing, small);
    this.playKey = play;
    const row = h("div", { class: `r2-keys${small ? " small" : ""}` }, back, home, play);
    if (small) row.append(this.iconButton("ask", "", { class: "r2-key r2-ask-small", "aria-label": "ask", "data-action": "ask", onclick: () => this.openSheet("ask") }, size));
    return row;
  }

  private setPlay(button: HTMLButtonElement, playing: boolean, small = button.closest(".small") !== null): void {
    const word = playing ? "pause" : "play";
    if (button.dataset.state === word) return;
    button.dataset.state = word;
    button.setAttribute("aria-label", playing ? "pause" : "play or pause");
    button.replaceChildren(icon(playing ? "pause" : "play", small ? 22 : 28), small ? "" : h("span", {}, word));
  }

  // Play and pause ask the box, which says whether it worked.
  private async playback(action: "toggle" | "next"): Promise<void> {
    try {
      const answer = await post("/api/phone/playback", { action });
      if (!answer.ok) this.say(answer.why ?? answer.error ?? "that didn't work");
    } catch (error) {
      this.kit.failed(error);
    }
  }

  private askButton(): HTMLElement {
    return this.iconButton("ask", "ask", { class: "r2-ask", "data-action": "ask", onclick: () => this.openSheet("ask") });
  }

  // --- The notice line --------------------------------------------------------

  // A moment's word on the notice line, such as why play didn't work.
  private say(text: string): void {
    this.hint = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hint = "";
      const state = this.kit.state();
      if (state && this.notice) this.refreshParts(state);
    }, 4000);
    const state = this.kit.state();
    if (state && this.notice) this.refreshParts(state);
    else if (state && this.page === "remote") this.draw(true);
  }

  // Everything that would have been a banner, the most important first.
  private notices(state: Phone): Notice[] {
    const list: Notice[] = [];
    const from = (el: HTMLElement | null, open?: () => void) => {
      const text = el?.textContent?.replace(/\s*›\s*$/, "").trim();
      if (text) list.push({ text, open: open ?? (el instanceof HTMLButtonElement ? () => el.click() : undefined) });
    };
    if (this.hint) list.push({ text: this.hint });
    if (state.pin.locked) {
      const unlock = async () => {
        if ((await askPin("unlocking the tv")) !== null) await this.kit.refresh(true);
      };
      list.push({ text: "the tv is locked · unlock", open: () => void unlock() });
    }
    if (state.setup) {
      list.push({ text: `tv setup · ${state.setup.part}` });
      const muted = state.setup.muted;
      list.push({ text: muted ? "play the setup music" : "mute the setup music", open: () => void api("POST", "/api/phone/setup-music", { muted: !muted }).then(() => this.kit.refresh(true), this.kit.failed) });
      if (state.setup.step === "background") list.push({ text: "send a photo for the tv's background", open: () => this.go("photo") });
    }
    from(buildBanner(state.builds, (build) => {
      this.building = build;
      this.go("build");
    }));
    from(exportBanner(state.export, this.kit.failed));
    from(pushBanner(state.export, () => this.go("push")));
    if (state.update && !state.update.later) list.push({ text: state.update.version === "packages" ? "updates are ready" : `agentv ${state.update.version.replace(/\.r\d+\.g[0-9a-f]+/, "").replace(/-\d+$/, "")} is ready`, open: () => this.go("update") });
    if (state.signIn) list.push({ text: `${state.signIn.name.toLowerCase()} wants you to sign in` });
    const latest = state.notices?.[0];
    if (latest) list.push({ text: `${latest.name.toLowerCase()}: ${latest.text}` });
    return list;
  }

  private noticeLine(state: Phone): HTMLElement {
    const list = this.notices(state);
    const first = list[0];
    if (!first) return h("div", { class: "r2-notice empty", "aria-hidden": "true" });
    const more = list.length - 1;
    const open = more > 0 ? () => this.openSheet("notices") : first.open;
    return h(
      "button",
      { type: "button", class: "r2-notice", "data-action": "notice", disabled: !open, onclick: () => open?.() },
      h("span", { class: "r2-notice-dot", "aria-hidden": "true" }),
      h("span", { class: "r2-notice-text" }, first.text),
      more > 0 ? h("span", { class: "r2-notice-more" }, `+${more}`) : null,
      open ? icon("more", 18) : null,
    );
  }

  // --- The keyboard -------------------------------------------------------------

  private keyboard(state: Phone): HTMLElement[] {
    const field = state.tv.field ?? { kind: state.signIn ? "email" : "text" };
    const kind = field.kind;
    const where = field.name ?? (state.signIn ? state.signIn.name.toLowerCase() : field.app ? field.app : "home");
    const what = kind === "search" ? "search" : kind === "password" || kind === "email" || state.signIn ? "sign in" : field.label || "typing";
    const words: Record<string, string> = { search: "search", password: "password", email: "email or name", number: "a number", url: "an address" };
    const headline = field.label || words[kind] || "type";
    const normal = kind === "password" ? "your password manager can fill it" : "shows on the tv as you type";
    const input = h("input", {
      class: "r2-field",
      id: "tv-text",
      type: kind === "password" ? "password" : kind === "email" ? "email" : kind === "url" ? "url" : kind === "search" ? "search" : "text",
      inputmode: kind === "number" ? "numeric" : kind === "email" ? "email" : kind === "url" ? "url" : kind === "search" ? "search" : "text",
      autocomplete: kind === "password" ? "current-password" : kind === "email" ? "username" : "off",
      name: kind === "password" ? "password" : kind === "email" ? "username" : "text",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: kind === "search" ? "search" : "go",
      maxlength: "500",
      "aria-label": headline,
    }) as HTMLInputElement;
    if (kind !== "password" && field.value) input.value = field.value;
    const note = h("p", { class: "r2-note" }, normal);
    const typing = new Typing(input, note, normal, this.kit.failed);
    input.addEventListener("input", () => typing.change());
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void typing.done();
    });
    const done = () => {
      this.dismissed = fieldKey(state);
      input.blur();
      this.draw(true);
    };
    // The keyboard comes up by itself where the phone's browser lets a page
    // open it; elsewhere the field is ready for one tap.
    requestAnimationFrame(() => input.focus());
    return [
      h(
        "div",
        { class: "r2-keyboard-top" },
        h("span", { class: "r2-where" }, icon("tv", 20), h("span", {}, `${where} · ${what}`)),
        h("button", { type: "button", class: "r2-done", "data-action": "keyboard-done", onclick: done }, "done"),
      ),
      h("h1", { class: "r2-headline" }, headline),
      h("label", { class: `r2-field-box${kind === "password" ? " secret" : ""}` }, kind === "password" ? icon("lock", 18) : null, input),
      note,
      h("div", { class: "r2-gap" }),
      this.keys(state, true),
    ];
  }

  // --- The menu and the sheets --------------------------------------------------

  private openSheet(sheet: Sheet): void {
    this.sheet = sheet;
    if (sheet === "menu" && this.about === null) {
      this.about = "";
      void call("GET", "/api/phone/box")
        .then((response) => (response.ok ? response.data : null))
        .then((data: { line?: unknown } | null) => {
          if (typeof data?.line === "string" && data.line) {
            this.about = data.line;
            if (this.sheet === "menu") this.draw(true);
          }
        })
        .catch(() => {});
    }
    this.draw(true);
  }

  private closeSheet(): void {
    this.sheet = null;
    this.draw(true);
  }

  private drawSheet(state: Phone): void {
    document.getElementById("r2-sheet")?.remove();
    if (!this.sheet || this.page !== "remote") return;
    const body = this.sheet === "menu" ? this.menu(state) : this.sheet === "ask" ? this.ask(state) : this.noticesSheet(state);
    const sheet = h(
      "div",
      { id: "r2-sheet", class: "r2-sheet-wrap", role: "dialog", "aria-label": this.sheet === "menu" ? "menu" : this.sheet === "ask" ? "ask your tv" : "notices" },
      h("div", { class: "r2-scrim", "data-action": "close-sheet", onclick: () => this.closeSheet() }),
      h("div", { class: "r2-sheet" }, h("span", { class: "r2-handle", "aria-hidden": "true" }), ...body),
    );
    document.body.append(sheet);
  }

  private menu(state: Phone): HTMLElement[] {
    const watch = async (viewer: Viewer) => {
      if (viewer.id === state.viewer.id) return;
      try {
        const done = await withPin(`watching as ${viewer.name}`, (grant) => api("POST", "/api/phone/viewer", { id: viewer.id }, grant));
        if (done === null) return;
        await this.kit.refresh(true);
      } catch (error) {
        this.kit.failed(error);
      }
    };
    const row = (name: Icon, label: string, action: string, onclick: () => void) =>
      h("button", { type: "button", class: "r2-row", "data-action": action, onclick }, icon(name, 22), h("span", {}, label), icon("more", 18));
    const tv = (path: string) => () => {
      void api("POST", path).catch(this.kit.failed);
      this.closeSheet();
    };
    const feel = h(
      "button",
      {
        type: "button",
        class: "r2-row",
        role: "switch",
        "aria-checked": String(feelOn()),
        "data-action": "feel",
        onclick: () => {
          setFeel(!feelOn());
          feel.setAttribute("aria-checked", String(feelOn()));
        },
      },
      icon("sound", 22),
      h("span", {}, "click and buzz"),
      h("span", { class: "r2-switch", "aria-hidden": "true" }),
    );
    const items: (HTMLElement | null)[] = [
      h("p", { class: "r2-label" }, "who's watching"),
      h(
        "div",
        { class: "r2-viewers" },
        ...state.viewers.map((viewer) =>
          h(
            "button",
            { type: "button", class: `r2-viewer${viewer.id === state.viewer.id ? " on" : ""}`, "data-viewer": viewer.id, onclick: () => void watch(viewer) },
            avatar(viewer, true),
            h("span", {}, viewer.name.toLowerCase()),
            viewer.role === "child" ? h("span", { class: "r2-role" }, "child") : null,
          ),
        ),
      ),
      h("hr", { class: "r2-rule" }),
      row("edit", "edit home", "edit-home", () => this.go("edit")),
      row("share", "share", "share", () => this.go("share")),
      row("apps", "apps", "apps", tv("/api/phone/apps")),
      state.viewer.role === "adult" ? row("settings", "settings", "settings", tv("/api/phone/settings")) : null,
      feel,
      this.about ? h("p", { class: "r2-about" }, this.about) : null,
    ];
    return items.filter((el): el is HTMLElement => el !== null);
  }

  private ask(state: Phone): HTMLElement[] {
    // With the Ask box building, D5's sheet (companion-web/ask.ts).
    if (state.features?.askbuilds) return askSheet(state.said, state.ask, state.viewer.role === "adult", this.kit.failed, () => void this.kit.refresh());
    const box = sayBox(state.said, this.kit.failed, () => void this.kit.refresh());
    requestAnimationFrame(() => box.querySelector("input")?.focus());
    return [box];
  }

  private noticesSheet(state: Phone): HTMLElement[] {
    return this.notices(state).map((notice) =>
      h(
        "button",
        {
          type: "button",
          class: "r2-row",
          "data-action": "notice-row",
          disabled: !notice.open,
          onclick: () => {
            this.sheet = null;
            notice.open?.();
            this.draw(true);
          },
        },
        h("span", { class: "r2-notice-dot", "aria-hidden": "true" }),
        h("span", {}, notice.text),
        notice.open ? icon("more", 18) : null,
      ),
    );
  }

  // --- Pages from the menu and the notices --------------------------------------

  private go(page: Page): void {
    this.page = page;
    this.sheet = null;
    this.kept = null;
    this.draw(true);
  }

  private subPage(state: Phone): HTMLElement[] {
    const back = h(
      "div",
      { class: "r2-top" },
      this.iconButton("back", "remote", {
        class: "r2-back",
        "data-action": "to-remote",
        onclick: () => {
          this.building = null;
          this.go("remote");
        },
      }, 22),
    );
    const body = h("div", { class: "r2-page" });
    if (this.page === "edit") void arrange(body);
    else if (this.page === "share") {
      this.kept ??= h("div", {}, sharePage(this.kit.failed), h("button", { type: "button", class: "button", "data-action": "photo", onclick: () => this.go("photo") }, "send a photo for the background ›"));
      body.append(this.kept);
    } else if (this.page === "photo") body.append((this.kept ??= photoPage(this.kit.failed)));
    else if (this.page === "update") {
      const page = this.kit.updatePage();
      if (page) body.append(page);
      else return this.leave();
    } else if (this.page === "build" && this.building) {
      body.append(buildPage(this.building, () => this.leave(), this.kit.failed, () => this.kit.refresh(true)));
    } else if (this.page === "push" && state.export?.github) {
      this.kept ??= h("div", {}, ...pushPage({ ...state.export, github: state.export.github }, () => this.leave(), this.kit.failed));
      body.append(this.kept);
    } else return this.leave();
    return [back, body];
  }

  // Back to the remote, from a page that's done or has nothing to show.
  private leave(): HTMLElement[] {
    this.page = "remote";
    this.building = null;
    window.setTimeout(() => this.draw(true), 0);
    return [];
  }
}
