// Focus on the TV (ADR-008, ADR-015, ADR-024): the arrows move it to the
// nearest element in that direction, a mouse moves it by hovering, and one
// ring glides from the old element to the new one rather than jumping.

import { zoom } from "./dom.ts";

export type Direction = "up" | "down" | "left" | "right";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

// Where an element is, in the page's own pixels (dom.ts zooms the page).
function box(el: Element): Box {
  const r = el.getBoundingClientRect();
  const z = zoom();
  return { left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
}

// Where an element is as the arrows see it from the focused one. In a list
// that scrolls (data-scroll) and doesn't hold the focus, only the part in
// sight counts, and an element scrolled out of it isn't there: the list's
// hidden rows run on under the buttons below it. In the list that holds the
// focus, every row counts, so the arrows go on to the next and it scrolls in.
function seen(el: HTMLElement, from: HTMLElement): Box | null {
  let at = box(el);
  for (let list = el.parentElement?.closest<HTMLElement>("[data-scroll]"); list; list = list.parentElement?.closest<HTMLElement>("[data-scroll]")) {
    if (list.contains(from)) continue;
    const clip = box(list);
    const left = Math.max(at.left, clip.left);
    const top = Math.max(at.top, clip.top);
    const right = Math.min(at.right, clip.right);
    const bottom = Math.min(at.bottom, clip.bottom);
    if (right - left < 1 || bottom - top < 1) return null;
    at = { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  return at;
}

// How far a candidate is in a direction: the gap along it, plus twice how far
// off to the side it is when the two don't line up. Null when it isn't that way.
export function distance(from: Box, to: Box, direction: Direction): number | null {
  const horizontal = direction === "left" || direction === "right";
  const gap =
    direction === "right" ? to.left - from.right : direction === "left" ? from.left - to.right : direction === "down" ? to.top - from.bottom : from.top - to.bottom;
  if (gap < -1) return null;
  const [a1, a2, b1, b2] = horizontal ? [from.top, from.bottom, to.top, to.bottom] : [from.left, from.right, to.left, to.right];
  const overlap = Math.min(a2, b2) - Math.max(a1, b1);
  const side = overlap > 0 ? 0 : Math.abs((a1 + a2) / 2 - (b1 + b2) / 2);
  return Math.max(0, gap) + side * 2;
}

export class Focus {
  private current?: HTMLElement;
  private root?: HTMLElement;
  private ring: HTMLElement;
  private held = false;
  // Called when the focus moves to a new element, by the arrows or a hover.
  onMove: (el: HTMLElement) => void = () => {};
  // Called whenever an element gets the focus, a new page's first included.
  onSet: (el: HTMLElement) => void = () => {};

  constructor(ring: HTMLElement) {
    this.ring = ring;
  }

  get(): HTMLElement | undefined {
    return this.current?.isConnected ? this.current : undefined;
  }

  focusables(): HTMLElement[] {
    if (!this.root) return [];
    return [...this.root.querySelectorAll<HTMLElement>("[data-focus]")].filter((el) => el.offsetParent !== null);
  }

  // A new page: focus starts on first, or on the first focusable element.
  setRoot(root: HTMLElement, first?: HTMLElement): void {
    this.root = root;
    this.current = undefined;
    const target = first ?? this.focusables()[0];
    if (target) this.set(target, false);
    else this.ring.classList.remove("on");
  }

  set(el: HTMLElement, announce = true): void {
    if (el === this.current) return;
    const from = this.current?.isConnected ? this.ringBox() : undefined;
    this.current?.classList.remove("focused");
    // A text field takes the keys while it has the focus, and lets go after.
    if (this.current instanceof HTMLInputElement) this.current.blur();
    this.current = el;
    // A list longer than its box, marked data-scroll, such as every theme
    // in Look (ADR-048), scrolls the element into view first, at once, so
    // the ring lands where it is.
    if (el.parentElement?.closest("[data-scroll]")) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    this.place(el, from !== undefined, from);
    el.classList.add("focused");
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
    this.onSet(el);
    if (announce) this.onMove(el);
  }

  // The nearest focusable element in a direction. False when there's none.
  move(direction: Direction): boolean {
    const current = this.get();
    if (!current) {
      const first = this.focusables()[0];
      if (first) this.set(first);
      return Boolean(first);
    }
    const from = box(current);
    let best: HTMLElement | undefined;
    let bestScore = Infinity;
    for (const el of this.focusables()) {
      if (el === current) continue;
      const to = seen(el, current);
      if (!to) continue;
      const score = distance(from, to, direction);
      if (score !== null && score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) this.set(best);
    return Boolean(best);
  }

  // Follows an element that moved, such as a tile in edit mode.
  refresh(): void {
    if (this.current?.isConnected) this.place(this.current, true, this.ringBox());
  }

  // While a page slides in, the ring waits out of sight, then appears on the
  // focused element once the page is still.
  hold(): void {
    this.held = true;
    this.ring.classList.remove("on");
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.current?.isConnected) this.place(this.current, false);
  }

  private ringBox(): Box {
    return box(this.ring);
  }

  // Puts the ring on el. With glide, it starts where it was and slides there:
  // only its transform moves, so the move stays smooth (ADR-024).
  private place(el: HTMLElement, glide: boolean, from?: Box): void {
    const target = box(el);
    // A tile lifts by 3% when it has focus, so the ring sits on the lifted tile.
    const lift = el.classList.contains("tile") ? 0.03 : 0;
    const left = target.left - (target.width * lift) / 2;
    const top = target.top - (target.height * lift) / 2;
    const width = target.width * (1 + lift);
    const height = target.height * (1 + lift);
    const ring = this.ring;
    ring.style.transition = "none";
    Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    if (glide && from && from.width > 0) {
      ring.style.transform = `translate(${from.left - left}px, ${from.top - top}px) scale(${from.width / width}, ${from.height / height})`;
      void ring.offsetWidth;
      ring.style.transition = "";
      ring.style.transform = "none";
    } else {
      ring.style.transform = "none";
      void ring.offsetWidth;
      ring.style.transition = "";
    }
    if (!this.held) ring.classList.add("on");
  }
}
