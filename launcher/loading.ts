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
// the TV off. What's waiting then stops asking, and asks at once when
// someone's back, however long its next ask was still away.
let watching = true;
const loops = new Set<{ wake(): void; sleep(): void }>();

export function setWatching(on: boolean): void {
  if (on === watching) return;
  watching = on;
  for (const loop of [...loops]) {
    if (on) loop.wake();
    else loop.sleep();
  }
}

// Asks again until what was asked for is there. ask() says whether it's
// still waiting, and alive() says whether anyone still wants it.
export function keepAsking(ask: () => Promise<boolean>, alive: () => boolean): void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking = false;
  const stop = () => {
    clearTimeout(timer);
    loops.delete(loop);
  };
  const once = async () => {
    if (!alive()) return stop();
    if (!watching || asking) return;
    asking = true;
    const waiting = await ask().catch(() => true);
    asking = false;
    if (!waiting || !alive()) return stop();
    if (watching) again();
  };
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void once(), WAITS[tries++] ?? LATER);
  };
  const loop = {
    wake: () => {
      clearTimeout(timer);
      void once();
    },
    sleep: () => clearTimeout(timer),
  };
  loops.add(loop);
  again();
}
