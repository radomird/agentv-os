// The phone's d-pad in a web app (ADR-008). Its arrows, OK and Back reach the
// app's page as keys, through the virtual input device. A web app made for a
// TV moves its own focus with the arrows. One made for a desktop doesn't: the
// arrows only scroll, OK has nothing to press, and only the trackpad gets
// anywhere.
//
// So the services' Chromium runs with Chromium's own spatial navigation. An
// arrow the page doesn't take moves the focus to the nearest thing that can
// be pressed in that direction, and OK presses it. A page that takes the
// arrows itself (it calls preventDefault) keeps them, so an app with focus of
// its own works as before.
//
// REMOTE_PAGE adds the rest to each of the app's pages. It runs in an
// isolated world, so the page's own scripts can't reach it or change it:
// - a ring around what has focus, drawn over the page while the arrows move
//   it, since many desktop pages hide their own focus outline. It goes when
//   the pointer moves, and when the page takes an arrow itself.
// - Back, when the page doesn't use it: a tap goes back a page, the way a
//   browser's back button would. Not while the page shows a dialog or
//   something full screen, and not when there's no page to go back to.
//   Holding Back for a second still goes home (ADR-031), so a hold never
//   goes back a page first.
//
// A link shared from a phone opens in the share browser (ADR-050), which
// gets the same spatial navigation and SHARED_PAGE: the ring without Back,
// since Back there closes the page.
//
// Every frame of the page also says when its focus moves, through
// FOCUS_BINDING, which the screen daemon gives this world alone. The screen
// daemon then reads the focused field itself, so the phone's keyboard comes
// up for a service's search or sign-in (ADR-065). The nudge carries nothing,
// so a page can't tell the phone anything with it.

// For the services' Chromium's command line.
export const SPATIAL_NAVIGATION = "--enable-spatial-navigation";

// The isolated world REMOTE_PAGE runs in.
export const REMOTE_WORLD = "agentv-remote";

// The function each frame calls in that world as its focus moves.
export const FOCUS_BINDING = "agentvFocus";

// The ring's width and the gap it leaves around what has focus, in pixels.
const RING = 4;
const GAP = 3;

// How near an edge of the screen, as a share of it, what has focus scrolls
// to the middle.
const EDGE = 0.15;

// holdMs: the screen daemon's hold on Back that goes home. back: whether a
// tap on Back goes back a page.
export function remotePage(holdMs = 1000, o: { back?: boolean } = {}): string {
  const back = o.back ?? true;
  return `(() => {
  if (!window.__agentvFocus) {
    window.__agentvFocus = true;
    // Focus moving inside one shadow root never reaches the window, so each
    // root the focus has gone into gets the same ear.
    const roots = new WeakSet();
    const nudge = (event) => {
      for (const node of event.composedPath()) {
        if (node instanceof ShadowRoot && !roots.has(node)) {
          roots.add(node);
          node.addEventListener("focusin", nudge, true);
          node.addEventListener("focusout", nudge, true);
        }
      }
      try { window.${FOCUS_BINDING}?.(""); } catch {}
    };
    addEventListener("focusin", nudge, true);
    addEventListener("focusout", nudge, true);
  }
  if (window.top !== window || window.__agentvRemote) return;
  window.__agentvRemote = true;
  const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  let shown = false;
  let ring = null;
  let followUntil = 0;
  let frame = 0;

  const deepest = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const make = () => {
    ring = document.createElement("agentv-focus");
    ring.style.cssText = "all: initial; position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; display: none; border: ${RING}px solid #fff; border-radius: 8px; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.7), inset 0 0 0 2px rgba(0, 0, 0, 0.7);";
  };
  const draw = () => {
    const el = deepest();
    const box = shown && el && el !== document.body && el !== document.documentElement ? el.getBoundingClientRect() : null;
    if (!box || (box.width === 0 && box.height === 0)) {
      if (ring) ring.style.display = "none";
      return;
    }
    if (!ring) make();
    // A page that redraws its whole document takes the ring with it.
    if (!ring.isConnected) document.documentElement.append(ring);
    const out = ${RING + GAP};
    Object.assign(ring.style, {
      display: "block",
      left: box.left - out + "px",
      top: box.top - out + "px",
      width: box.width + out * 2 + "px",
      height: box.height + out * 2 + "px",
    });
  };
  // Chromium focuses only what it can see, and an arrow with nothing in
  // sight that way scrolls a little instead. So what the arrows focus near an
  // edge of the screen scrolls to the middle, and the next one along a row
  // or down the page is in sight for the next press.
  const into = () => {
    const el = deepest();
    if (!el || el === document.body) return;
    const box = el.getBoundingClientRect();
    const x = innerWidth * ${EDGE};
    const y = innerHeight * ${EDGE};
    const inline = box.left < x || box.right > innerWidth - x ? "center" : "nearest";
    const block = box.top < y || box.bottom > innerHeight - y ? "center" : "nearest";
    if (inline === "center" || block === "center") el.scrollIntoView({ block, inline });
  };
  // A page often scrolls or slides a row as its focus moves, so the ring
  // follows for a moment after each key.
  const follow = () => {
    followUntil = performance.now() + 700;
    if (frame) return;
    const step = () => {
      draw();
      frame = performance.now() < followUntil ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
  };

  let backDown = null;
  const busy = () =>
    !!document.fullscreenElement ||
    [...document.querySelectorAll("dialog[open], [aria-modal='true']")].some((el) => el.getClientRects().length > 0);
  const canGoBack = () => (window.navigation ? window.navigation.canGoBack : history.length > 1);

  addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        if (!${back}) return;
        // Whether a dialog or full screen is up is read now, since the
        // press itself can close it.
        if (!event.repeat) backDown = { event, busy: busy(), at: performance.now() };
        return;
      }
      if (ARROWS.has(event.key)) {
        // Whether the page took it is known once every listener has run.
        setTimeout(() => {
          shown = !event.defaultPrevented;
          if (shown) into();
          follow();
        }, 0);
      } else if (event.key === "Tab") {
        shown = true;
        follow();
      } else if (event.key === "Enter") follow();
    },
    true,
  );
  addEventListener(
    "keyup",
    (event) => {
      if (!${back} || event.key !== "Escape" || !backDown) return;
      const down = backDown;
      backDown = null;
      if (down.busy || performance.now() - down.at >= ${holdMs}) return;
      setTimeout(() => {
        if (down.event.defaultPrevented || event.defaultPrevented || busy() || !canGoBack()) return;
        history.back();
      }, 0);
    },
    true,
  );
  const hide = () => {
    if (!shown) return;
    shown = false;
    draw();
  };
  // Only a pointer that really moved: a page that scrolls under a still
  // pointer can report a move of nothing.
  addEventListener("pointermove", (event) => (event.movementX || event.movementY) && hide(), true);
  addEventListener("pointerdown", hide, true);
  addEventListener("focusin", () => shown && follow(), true);
  addEventListener("focusout", () => shown && follow(), true);
  addEventListener("scroll", () => shown && follow(), { capture: true, passive: true });
  addEventListener("resize", () => shown && follow());
})()`;
}

export const REMOTE_PAGE = remotePage();
export const SHARED_PAGE = remotePage(1000, { back: false });
