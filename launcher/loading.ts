// Something that's loading says so, the same way everywhere: three marks
// that light up one after another, drawn by each look in its own style
// (launcher.css and each look.css). A tile gets it in its corner while its
// content is on the way, and a page where its list will be.
//
// It also holds the asking again. Home draws within seconds of a start,
// often before the TV is online, so the first ask for a forecast can fail.
// What's waiting is asked for again, soon at first, then once a minute for
// a few minutes, then every five, for as long as it's on screen. Nothing
// is asked for while the idle screen is up or the TV is off, and it's asked
// for at once when someone's back.

import { h } from "./dom.ts";

// How long to wait before each ask: a minute in all, three more at one a
// minute, and every five minutes after that. Something that never comes (a
// server that's switched off, a key that's refused) costs twelve asks an
// hour, not sixty.
export const WAITS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000];
export const LATER = 300_000;

// How long the mark shows. After that, what's waiting rests as it is, and
// the asking goes on quietly.
export const SHOWN_MS = 20_000;

export function loadingMark(): HTMLElement {
  return h("span", { class: "loading-mark", role: "status", "aria-label": "Loading" }, h("i"), h("i"), h("i"));
}

// What showed its mark for the whole time and still had nothing, by name.
// It rests without the mark the next time it's drawn, so an app whose
// server is switched off doesn't say it's loading on every visit to home.
const rested = new Set<string>();

// Puts the mark on something that waits. What comes back takes it off
// again, and it goes by itself once it has shown long enough. With a name,
// something that rested last time gets no mark until it has come once.
export function showLoading(el: HTMLElement, name?: string): () => void {
  if (name && rested.has(name)) return () => rested.delete(name);
  const mark = loadingMark();
  el.classList.add("is-loading");
  el.setAttribute("aria-busy", "true");
  el.append(mark);
  const off = () => {
    clearTimeout(timer);
    mark.remove();
    el.classList.remove("is-loading");
    el.removeAttribute("aria-busy");
  };
  const timer = setTimeout(() => {
    if (name) rested.add(name);
    off();
  }, SHOWN_MS);
  return () => {
    if (name) rested.delete(name);
    off();
  };
}

// Whether anyone's watching: not while the idle screen is up, and not with
// the TV off. What's waiting then holds its next ask until someone is.
let watching = true;
const held = new Set<() => void>();

export function setWatching(on: boolean): void {
  if (on === watching) return;
  watching = on;
  if (!on) return;
  const asks = [...held];
  held.clear();
  for (const ask of asks) ask();
}

// Asks again until what was asked for is there. ask() says whether it's
// still waiting, and alive() says whether anyone still wants it.
export function keepAsking(ask: () => Promise<boolean>, alive: () => boolean): void {
  let tries = 0;
  const once = async () => {
    if (!alive()) return;
    if (!watching) {
      held.add(once);
      return;
    }
    const waiting = await ask().catch(() => true);
    if (waiting && alive()) again();
  };
  const again = () => setTimeout(() => void once(), WAITS[tries++] ?? LATER);
  again();
}
