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

// How far a list has to scroll along one axis to show an element, the way
// scrollIntoView's "nearest" does: not at all when it's in sight or covers
// the list, and otherwise by the shorter way.
function nearest(from: number, to: number, clipFrom: number, clipTo: number): number {
  const before = from < clipFrom;
  const after = to > clipTo;
  if (before === after) return 0;
  const fits = to - from <= clipTo - clipFrom;
  return before === fits ? from - clipFrom : to - clipTo;
}

// scrollIntoView for a page inside a frame, such as a look's preview in
// Settings: it scrolls the lists that hold the element (data-scroll), with
// its scroll-margin, and stops at the page's own edge. scrollIntoView itself
// goes on up through the frames, so a preview that loads would scroll
// Settings to where the preview is.
function reveal(el: HTMLElement): void {
  const z = zoom();
  const style = getComputedStyle(el);
  const margin = (side: string) => (parseFloat(style.getPropertyValue(`scroll-margin-${side}`)) || 0) * z;
  for (let list = el.parentElement?.closest<HTMLElement>("[data-scroll]"); list; list = list.parentElement?.closest<HTMLElement>("[data-scroll]")) {
    const at = el.getBoundingClientRect();
    const clip = list.getBoundingClientRect();
    const left = clip.left + list.clientLeft * z;
    const top = clip.top + list.clientTop * z;
    list.scrollLeft += nearest(at.left - margin("left"), at.right + margin("right"), left, left + list.clientWidth * z) / z;
    list.scrollTop += nearest(at.top - margin("top"), at.bottom + margin("bottom"), top, top + list.clientHeight * z) / z;
  }
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

// Tells when an element moves or changes size with no key pressed: a look's
// stylesheet or a font that arrives after the page was drawn, a picture
// above it that loads. An IntersectionObserver whose root is cut down to the
// element's own box says when it leaves that box, and a ResizeObserver when
// it changes size inside it. Nothing runs while the page is still. again()
// starts from where the element is now, and stop() ends it.
function watch(el: HTMLElement, changed: () => void): { again(): void; stop(): void } {
  let edges: IntersectionObserver | undefined;
  let stopped = false;
  const arm = (threshold = 1) => {
    edges?.disconnect();
    edges = undefined;
    if (stopped) return;
    const armed = el.getBoundingClientRect();
    if (!armed.width || !armed.height) return;
    const inset = [armed.top, innerWidth - armed.right, innerHeight - armed.bottom, armed.left].map((px) => `${-Math.floor(px)}px`).join(" ");
    let first = true;
    edges = new IntersectionObserver(
      (entries) => {
        const ratio = entries[entries.length - 1].intersectionRatio;
        const told = first;
        first = false;
        if (ratio === threshold) return;
        if (told) {
          // The first word comes a frame after the asking. Where the
          // element hasn't moved since, part of it is under a list's edge,
          // and from here on it's a change in how much shows. With none of
          // it in sight there's no edge to watch: a scroll brings it back,
          // and the scroll places the ring.
          const now = el.getBoundingClientRect();
          const still = Math.abs(now.left - armed.left) < 0.5 && Math.abs(now.top - armed.top) < 0.5 && Math.abs(now.width - armed.width) < 0.5 && Math.abs(now.height - armed.height) < 0.5;
          if (still) {
            if (ratio) arm(ratio);
            return;
          }
        }
        changed();
        arm();
      },
      { root: document, rootMargin: inset, threshold },
    );
    edges.observe(el);
  };
  let sized = false;
  const size = new ResizeObserver(() => {
    // Its first call is only the size it has now.
    if (sized) {
      changed();
      arm();
    }
    sized = true;
  });
  size.observe(el);
  arm();
  return {
    again: () => arm(),
    stop() {
      stopped = true;
      edges?.disconnect();
      size.disconnect();
    },
  };
}

export class Focus {
  private current?: HTMLElement;
  private root?: HTMLElement;
  private ring: HTMLElement;
  private held = false;
  // Where the ring was last put, and what stops watching the element there.
  private aimed?: Box;
  private watching?: { again(): void; stop(): void };
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
    if (target) {
      this.set(target, false);
    } else {
      this.watching?.stop();
      this.watching = undefined;
      this.ring.classList.remove("on");
    }
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
    if (el.parentElement?.closest("[data-scroll]")) {
      if (window.parent === window) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      else reveal(el);
    }
    this.place(el, from !== undefined, from);
    // The page can still move under it: the ring goes along, at once.
    this.watching?.stop();
    this.watching = watch(el, () => this.follow(el));
    el.classList.add("focused");
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
    this.onSet(el);
    if (announce) this.onMove(el);
  }

  // The nearest focusable element in a direction, or only among those inside
  // within. False when there's none.
  move(direction: Direction, within?: HTMLElement): boolean {
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
      if (el === current || (within && !within.contains(el))) continue;
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
    if (!this.current?.isConnected) return;
    this.place(this.current, true, this.ringBox());
    this.watching?.again();
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
    if (!this.current?.isConnected) return;
    this.place(this.current, false);
    this.watching?.again();
  }

  private ringBox(): Box {
    return box(this.ring);
  }

  // The ring's place after a change nobody asked for. The element's own lift
  // and a move the arrows made end where the ring already is, so this does
  // nothing then.
  private follow(el: HTMLElement): void {
    if (el !== this.current || !el.isConnected || this.held) return;
    const next = this.aim(el).at;
    const was = this.aimed;
    if (was && Math.abs(next.left - was.left) < 0.5 && Math.abs(next.top - was.top) < 0.5 && Math.abs(next.width - was.width) < 0.5 && Math.abs(next.height - was.height) < 0.5) return;
    this.place(el, false);
  }

  // Where the ring goes for el, and its corners.
  private aim(el: HTMLElement): { at: Box; radius: string } {
    const target = box(el);
    // A tile lifts by 3% when it has focus, so the ring sits on the lifted
    // tile. A look can say how far its own lift (--lift), and the ring takes
    // the element's rounded corners, as Glass's and Cinema's are.
    const style = getComputedStyle(el);
    const own = parseFloat(style.getPropertyValue("--lift"));
    const lift = Number.isFinite(own) ? own : el.classList.contains("tile") ? 0.03 : 0;
    // However far it has lifted by now doesn't count, so the ring lands in
    // the same place before the lift, during it and after.
    const lifted = style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
    const [sx, sy] = lifted && lifted.is2D && lifted.b === 0 && lifted.c === 0 && lifted.a > 0 && lifted.d > 0 ? [lifted.a, lifted.d] : [1, 1];
    const width = (target.width / sx) * (1 + lift);
    const height = (target.height / sy) * (1 + lift);
    const left = (target.left + target.right) / 2 - width / 2;
    const top = (target.top + target.bottom) / 2 - height / 2;
    return {
      at: { left, top, right: left + width, bottom: top + height, width, height },
      radius: style.borderRadius === "0px" ? "" : `calc(${style.borderRadius} * ${1 + lift})`,
    };
  }

  // Puts the ring on el. With glide, it starts where it was and slides there:
  // only its transform moves, so the move stays smooth (ADR-024).
  private place(el: HTMLElement, glide: boolean, from?: Box): void {
    const { at, radius } = this.aim(el);
    this.aimed = at;
    const { left, top, width, height } = at;
    this.ring.style.borderRadius = radius;
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
