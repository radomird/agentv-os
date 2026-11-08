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
// - Back in a player leaves it, even when the player takes Escape for
//   itself, as many do and then do nothing with it. A player is a video
//   that covers the screen on a page with nothing else to scroll to, or one
//   full screen. A dialog open over it still closes first, its own settings
//   included. Back never goes back into a player either: past one, it goes
//   on back from the page before it, even when the player's own back arrow
//   put that page on the history again rather than going back.
//
// Hyprland reports each press and release of Back to the screen daemon,
// which tells a tap from a hold (daemon/screen.ts), and on a tap it runs
// BACK_TAP here. The page acts on a tap as it sees it, so this is for the
// taps it doesn't: one whose release it saw a second late on a busy box,
// and one Chromium kept to leave full screen, which never reaches the page.
// The word can come before the key, or before full screen ends, so it waits
// a moment for them.
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

// What the screen daemon runs in that world when Back was a tap.
export const BACK_TAP = "window.__agentvBackTap?.() ?? null";

// The ring's width and the gap it leaves around what has focus, in pixels.
const RING = 4;
const GAP = 3;

// How near an edge of the screen, as a share of it, what has focus scrolls
// to the middle.
const EDGE = 0.15;

// How much of the screen a player's video covers, at least.
const PLAYER_SHARE = 0.8;

// How long after a press the screen daemon's word on it still counts, in
// milliseconds.
const TAP_WAIT_MS = 4000;

// How long the screen daemon's word waits for the key or full screen ending
// that it came before, in milliseconds.
const TAP_LATE_MS = 1500;

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

  // What matches under a root, through open shadow roots and same-origin
  // frames.
  const deep = (root, selector, found = []) => {
    found.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) deep(el.shadowRoot, selector, found);
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) deep(el.contentDocument, selector, found);
        } catch {}
      }
    }
    return found;
  };
  // Where an element is on the screen, from inside a frame too.
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let view = el.ownerDocument.defaultView; view && view !== window && view.frameElement; view = view.parent) {
      const f = view.frameElement.getBoundingClientRect();
      left += f.left;
      right += f.left;
      top += f.top;
      bottom += f.top;
    }
    return { left, top, right, bottom };
  };
  const covers = (el) => {
    const b = onScreen(el);
    const w = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0));
    const h = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
    return w * h >= innerWidth * innerHeight * ${PLAYER_SHARE};
  };
  // A video that has started, paused or not, and covers the screen.
  const playerVideo = () => {
    const ok = (v) => (!v.paused || v.currentTime > 0 || v.readyState > 0) && covers(v);
    return [...document.querySelectorAll("video")].find(ok) ?? deep(document, "video").find(ok) ?? null;
  };
  const scrolls = () => {
    const root = document.scrollingElement || document.documentElement;
    const kept = (el) => !!el && /hidden|clip/.test(getComputedStyle(el).overflowY);
    return root.scrollHeight > innerHeight + 2 && !kept(document.documentElement) && !kept(document.body);
  };
  // A player: a video over the whole screen, on a page with nothing else to
  // scroll to, or full screen. A title's page with a trailer playing behind
  // it scrolls to its episodes and extras.
  const inPlayer = () => !!playerVideo() && (!!document.fullscreenElement || !scrolls());

  // A dialog open, which Escape closes: one on the page, or one of a
  // player's own in its shadow roots. Not one the player itself is in.
  const holds = (outer, inner) => {
    for (let node = inner; node; node = node.parentNode || node.host) if (node === outer) return true;
    return false;
  };
  const busy = () => {
    const video = playerVideo();
    return [...document.querySelectorAll("dialog[open], [aria-modal='true']"), ...deep(document, "dialog[open]")].some(
      (el) => el.getClientRects().length > 0 && !(video && holds(el, video)),
    );
  };
  const canGoBack = () => (window.navigation ? window.navigation.canGoBack : history.length > 1);

  // The history entries a player had, by their keys, so Back never goes
  // back into one. Each is noted as the page leaves it.
  const players = new Set();
  const notePlayer = () => {
    const key = window.navigation?.currentEntry?.key;
    if (key) players.add(key);
  };
  try {
    window.navigation?.addEventListener("navigate", () => inPlayer() && notePlayer());
  } catch {}

  // Back a page. Past a player, it goes on past the page before it when
  // that's the page Back started on, which a player's own back arrow can
  // put on the history again.
  const goBack = (fromPlayer) => {
    const nav = window.navigation;
    if (!nav?.currentEntry) {
      if (history.length > 1) history.back();
      return;
    }
    const here = nav.currentEntry;
    const page = (url) => {
      try {
        const u = new URL(url);
        return u.origin + u.pathname;
      } catch {
        return url;
      }
    };
    const entries = nav.entries();
    let past = false;
    for (let i = here.index - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;
      if (players.has(entry.key)) {
        past = true;
        continue;
      }
      if (past && !fromPlayer && page(entry.url) === page(here.url)) continue;
      const going = nav.traverseTo(entry.key);
      going.committed?.catch(() => {});
      going.finished?.catch(() => {});
      return;
    }
  };
  const leavePlayer = () => {
    notePlayer();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    goBack(true);
  };

  // A tap on Back, once every listener of the page has had it.
  let settledAt = -Infinity;
  const act = (down, up) => {
    settledAt = performance.now();
    if (down.busy || busy()) return;
    if (down.player) return leavePlayer();
    if (down.event.defaultPrevented || up?.defaultPrevented || document.fullscreenElement || !canGoBack()) return;
    goBack(false);
  };

  // The screen daemon's word on a tap that nothing here has explained yet:
  // its key, or full screen ending, can come a moment after it.
  let tapAt = -Infinity;

  // Full screen that ends without a key reaching the page: Chromium keeps
  // the Escape that leaves it.
  let fullPlayer = false;
  let leftFull = null;
  document.addEventListener(
    "fullscreenchange",
    () => {
      if (document.fullscreenElement) {
        fullPlayer = inPlayer();
        if (fullPlayer) notePlayer();
        return;
      }
      const now = performance.now();
      const player = fullPlayer;
      fullPlayer = false;
      if (player && now - tapAt < ${TAP_LATE_MS}) {
        tapAt = -Infinity;
        settledAt = now;
        leavePlayer();
        return;
      }
      leftFull = { at: now, player };
    },
    true,
  );

  // The press on Back under way, and one the page timed as a hold, which may
  // still be a tap by the screen daemon's clock.
  let backDown = null;
  let held = null;
  if (${back}) {
    // The screen daemon's word that Back was a tap (BACK_TAP).
    window.__agentvBackTap = () => {
      const now = performance.now();
      if (backDown) {
        backDown.tap = true;
        return "early";
      }
      if (held && now - held.upAt < ${TAP_WAIT_MS}) {
        const down = held;
        held = null;
        act(down, null);
        return "held";
      }
      if (leftFull?.player && leftFull.at > settledAt && now - leftFull.at < ${TAP_WAIT_MS}) {
        leftFull = null;
        settledAt = now;
        leavePlayer();
        return "full screen";
      }
      // A press the page has just settled was this tap.
      if (now - settledAt >= ${TAP_LATE_MS}) tapAt = now;
      return null;
    };
  }

  addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        if (!${back} || event.repeat) return;
        // What's up is read now, since the press itself can close it.
        const player = inPlayer();
        if (player) notePlayer();
        // The screen daemon may have had its word on this tap already.
        const tap = performance.now() - tapAt < ${TAP_LATE_MS};
        tapAt = -Infinity;
        backDown = { event, busy: busy(), player, at: performance.now(), tap };
        held = null;
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
      if (!down.tap && performance.now() - down.at >= ${holdMs}) {
        held = { ...down, upAt: performance.now() };
        return;
      }
      setTimeout(() => act(down, event), 0);
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
