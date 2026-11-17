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
export const REMOTE_WORLD = "origaitv-remote";

// The function each frame calls in that world as its focus moves.
export const FOCUS_BINDING = "origaitvFocus";

// What the screen daemon runs in that world when Back was a tap.
export const BACK_TAP = "window.__origaitvBackTap?.() ?? null";

// Where two fingers on the phone scroll the page from (ADR-103), in the
// page's pixels: the middle of what the arrows focused, while the ring is
// on it and it's in sight, so the row you're on is what slides sideways,
// and otherwise the middle of the page.
export const WHEEL_AT = "window.__origaitvWheelAt?.() ?? [innerWidth / 2, innerHeight / 2]";

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

// The d-pad's own moves (ADR-103): how long a press waits for rows that load
// after it scrolled, or a row that slides after its button, and how often
// it looks for them meanwhile, in milliseconds.
const WAIT_MS = 1500;
const LOOK_MS = 100;

// How much of a scroll area one press scrolls, with nothing further that
// way.
const PAGE_SHARE = 0.7;

// With nothing focused, the first press lands on the biggest thing in view.
// Things within SAME_SIZE of its size count as as big, and of those the one
// nearest the middle of the screen wins, then the higher, then the one on
// the left, each to within NEAR_PX.
const SAME_SIZE = 0.9;
const NEAR_PX = 24;

// holdMs: the screen daemon's hold on Back that goes home. back: whether a
// tap on Back goes back a page.
export function remotePage(holdMs = 1000, o: { back?: boolean } = {}): string {
  const back = o.back ?? true;
  return `(() => {
  if (!window.__origaitvFocus) {
    window.__origaitvFocus = true;
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
  if (window.top !== window || window.__origaitvRemote) return;
  window.__origaitvRemote = true;
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
    ring = document.createElement("origaitv-focus");
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
    window.__origaitvBackTap = () => {
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
      // Only a real key's arrows: one the page makes up itself moves nothing.
      if (ARROWS.has(event.key) && event.isTrusted) {
        // The remote's listener goes on the end, after every one the page
        // has, to see whether the page took the arrow (move, above).
        arrow = event;
        arrowFrom = deepest();
        removeEventListener("keydown", last);
        addEventListener("keydown", last);
        // Whether the page took it is known once every listener has run.
        setTimeout(() => {
          if (ours.has(event)) {
            shown = true;
            follow();
            return;
          }
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
  // --- The d-pad: the nearest thing that way (ADR-103) -----------------------
  // An arrow the page leaves alone is the remote's: it moves to the nearest
  // thing that way that can take focus or be pressed, cards that only show
  // a pointer included, past the edge of a row or the screen when they
  // scroll that way. With nothing further, it scrolls what's there, the page
  // or a scroll area of the page's own, so rows that wait to be scrolled to
  // load, and lands on them once they're there. Chromium's spatial
  // navigation is left the arrows only when a page stops them on their way,
  // and OK on what has focus.
  const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  // What can be pressed, by its tag or its role.
  const PRESSABLE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=''], [contenteditable='true'], [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=checkbox], [role=radio], [role=switch], [role=gridcell], [role=treeitem], [onclick]";
  // Of those, what's a control in its own right, kept even with another
  // inside it.
  const CONTROL = "a[href], button, input, select, textarea, summary, [contenteditable=''], [contenteditable='true'], [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=radio], [role=switch]";
  // What takes focus without a tabindex of its own.
  const FOCUSABLE = "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=''], [contenteditable='true']";
  // What's never pressed, and what's pressed only as a whole.
  const PASS = new Set(["script", "style", "link", "meta", "template", "noscript", "head", "title", "origaitv-focus", "option", "optgroup", "datalist"]);
  const LEAF = new Set(["iframe", "svg", "video", "audio", "canvas", "img", "picture", "input", "textarea", "select"]);

  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  // The app's hints for this page (apps/contract/contract.ts, Navigation),
  // which the screen daemon puts next to this script: what to land on and
  // skip, the page's own scroll area, and rows that move by their buttons.
  const valid = (selector) => {
    if (typeof selector !== "string" || !selector) return null;
    try {
      document.createDocumentFragment().querySelector(selector);
      return selector;
    } catch {
      return null;
    }
  };
  const hints = () => {
    const out = { items: [], skip: [], scroller: null, rows: [] };
    const all = Array.isArray(window.__origaitvHints) ? window.__origaitvHints : [];
    for (const hint of all) {
      if (!hint || typeof hint !== "object") continue;
      if (hint.url) {
        try {
          if (!new RegExp(hint.url).test(location.href)) continue;
        } catch {
          continue;
        }
      }
      if (valid(hint.items)) out.items.push(hint.items);
      if (valid(hint.skip)) out.skip.push(hint.skip);
      if (!out.scroller && valid(hint.scroller)) out.scroller = hint.scroller;
      for (const row of Array.isArray(hint.rows) ? hint.rows : []) {
        if (row && valid(row.row) && valid(row.next)) out.rows.push({ row: row.row, next: row.next, previous: valid(row.previous) });
      }
    }
    return { items: out.items.join(", ") || null, skip: out.skip.join(", ") || null, scroller: out.scroller, rows: out.rows };
  };

  // Whether an area scrolls along an axis, and has room left that way.
  const canScroll = (el, dx, dy, own) => {
    const root = document.scrollingElement || document.documentElement;
    if (el === root) {
      const kept = (node, prop) => !!node && /hidden|clip/.test(getComputedStyle(node)[prop]);
      if (dy) {
        if (kept(document.documentElement, "overflowY") || kept(document.body, "overflowY")) return false;
        return dy > 0 ? root.scrollTop + innerHeight < root.scrollHeight - 1 : root.scrollTop > 0;
      }
      if (kept(document.documentElement, "overflowX") || kept(document.body, "overflowX")) return false;
      return dx > 0 ? root.scrollLeft + innerWidth < root.scrollWidth - 1 : root.scrollLeft > 0;
    }
    const style = getComputedStyle(el);
    const overflow = dy ? style.overflowY : style.overflowX;
    // An area you can scroll yourself, or, for a hint, one that hides it.
    if (!/auto|scroll|overlay/.test(overflow) && !(own && overflow === "hidden")) return false;
    if (dy) return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
    return dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
  };

  // Each area that clips what's in it, for one press.
  let clips = new Map();
  const clipOf = (el) => {
    if (clips.has(el)) return clips.get(el);
    const style = getComputedStyle(el);
    const x = style.overflowX !== "visible";
    const y = style.overflowY !== "visible";
    const clip = x || y
      ? { x, y, sx: x && style.overflowX !== "clip" && el.scrollWidth > el.clientWidth + 1, sy: y && style.overflowY !== "clip" && el.scrollHeight > el.clientHeight + 1, box: el.getBoundingClientRect() }
      : null;
    clips.set(el, clip);
    return clip;
  };
  // The row a thing is in: the nearest area that clips it sideways, whether
  // or not it has more to show just now.
  const rowOf = (el) => {
    for (let a = parentOf(el); a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
      const clip = clipOf(a);
      if (clip && clip.x) return a;
    }
    return null;
  };
  // What of an element can be brought into sight on the way: clipped across
  // the way by whatever clips it, but not along it by an area that scrolls
  // that way, the page included. Null when none of it can.
  const sight = (el, axis, page) => {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return null;
    let { left, top, right, bottom } = b;
    for (let a = parentOf(el); a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
      const clip = clipOf(a);
      if (!clip) continue;
      if (clip.x && !(axis === "x" && clip.sx)) {
        left = Math.max(left, clip.box.left);
        right = Math.min(right, clip.box.right);
      }
      if (clip.y && !(axis === "y" && clip.sy)) {
        top = Math.max(top, clip.box.top);
        bottom = Math.min(bottom, clip.box.bottom);
      }
      if (right - left < 2 || bottom - top < 2) return null;
    }
    const fixed = getComputedStyle(el).position === "fixed";
    const pageX = page.x && !fixed;
    const pageY = page.y && !fixed;
    if (!(axis === "x" && pageX)) {
      left = Math.max(left, 0);
      right = Math.min(right, innerWidth);
    }
    if (!(axis === "y" && pageY)) {
      top = Math.max(top, 0);
      bottom = Math.min(bottom, innerHeight);
    }
    if (right - left < 2 || bottom - top < 2) return null;
    return { left, top, right, bottom };
  };

  // Everything the d-pad can land on now, each with what of it can be in
  // sight on the way: what can take focus or be pressed, the app's own
  // items, and the outermost part of each card that shows a pointer.
  // Wrappers around other things to press are passed over for those.
  const gather = (axis, h) => {
    clips = new Map();
    const found = [];
    const walk = (el, pointerAbove) => {
      if (PASS.has(el.localName)) return;
      if (h.skip && el.matches(h.skip)) return;
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      const pointer = style.cursor === "pointer";
      if (el.matches(PRESSABLE) || (h.items && el.matches(h.items)) || (pointer && !pointerAbove)) found.push(el);
      // Media and fields are pressed as a whole, or through what holds them.
      if (LEAF.has(el.localName)) return;
      if (el.shadowRoot) for (const kid of el.shadowRoot.children) walk(kid, pointer);
      for (const kid of el.children) walk(kid, pointer);
    };
    if (document.body) walk(document.body, false);
    // Whether the page itself scrolls each way.
    const root = document.scrollingElement || document.documentElement;
    const page = { x: canScroll(root, 1, 0) || canScroll(root, -1, 0), y: canScroll(root, 0, 1) || canScroll(root, 0, -1) };
    const seen = [];
    for (const el of found) {
      if (el.matches(":disabled") || el.closest("[inert]")) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = sight(el, axis, page);
      if (box) seen.push({ el, box });
    }
    const set = new Set(seen.map((s) => s.el));
    const wraps = new Set();
    for (const s of seen) for (let a = parentOf(s.el); a; a = parentOf(a)) if (set.has(a)) wraps.add(a);
    const kept = seen.filter((s) => !wraps.has(s.el) || s.el.matches(CONTROL) || (h.items && s.el.matches(h.items)));
    // Two things over the same place, such as a card's button and its
    // link: the link, which goes somewhere.
    const links = kept.filter((s) => s.el.matches("a[href]"));
    const over = (a, b) => Math.abs(a.left - b.left) < 3 && Math.abs(a.top - b.top) < 3 && Math.abs(a.right - b.right) < 3 && Math.abs(a.bottom - b.bottom) < 3;
    return kept.filter((s) => s.el.matches("a[href]") || !links.some((l) => over(l.box, s.box)));
  };

  // Where an arrow starts from: what has focus. What has focus but has
  // scrolled out of sight starts from the edge of the screen in its column
  // or its row, so the next press lands on what's in sight.
  const startBox = (key, from) => {
    const [dx, dy] = DIRS[key];
    const b = onScreen(from);
    if (b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth) return b;
    if (dy > 0) return { left: b.left, right: b.right, top: -2, bottom: -1 };
    if (dy < 0) return { left: b.left, right: b.right, top: innerHeight + 1, bottom: innerHeight + 2 };
    if (dx > 0) return { left: -2, right: -1, top: b.top, bottom: b.bottom };
    return { left: innerWidth + 1, right: innerWidth + 2, top: b.top, bottom: b.bottom };
  };
  // With nothing focused, whichever arrow it is: the biggest thing in view,
  // by how much of it is on the screen, such as a banner's Play over a row
  // of small cards. Of things about as big, the one nearest the middle of
  // the screen, then the higher, then the one on the left, so a grid of
  // cards the same size starts at its middle.
  const biggest = (h) => {
    const out = gather("none", h).map(({ el, box }) => ({
      el,
      area: (box.right - box.left) * (box.bottom - box.top),
      off: Math.round(Math.hypot((box.left + box.right) / 2 - innerWidth / 2, (box.top + box.bottom) / 2 - innerHeight / 2) / ${NEAR_PX}),
      top: Math.round(box.top / ${NEAR_PX}),
      left: box.left,
    }));
    if (!out.length) return out;
    const most = Math.max(...out.map((c) => c.area));
    const big = out.filter((c) => c.area >= most * ${SAME_SIZE});
    big.sort((p, q) => p.off - q.off || p.top - q.top || p.left - q.left);
    return big;
  };
  // What's that way from what has focus, the best first: the nearest line
  // of things that way, and of those, the one most in line with it. Along a
  // row, only what shares some of its height, unless it's loose.
  const ahead = (key, from, h, loose) => {
    if (!from) return biggest(h);
    const [dx, dy] = DIRS[key];
    const axis = dx ? "x" : "y";
    const at = startBox(key, from);
    const out = [];
    const things = gather(axis, h);
    // Loose, a press can cross from a row to what's beside it, such as a
    // menu, but never into another row: an area that clips sideways and
    // doesn't hold the row it starts from.
    const row = loose && dx ? rowOf(from) : null;
    for (const { el, box } of things) {
      if (holds(el, from) || holds(from, el)) continue;
      const other = row && rowOf(el);
      if (other && other !== row && !holds(other, from)) continue;
      const gap = dx > 0 ? box.left - at.right : dx < 0 ? at.left - box.right : dy > 0 ? box.top - at.bottom : at.top - box.bottom;
      const mid = (b) => (axis === "x" ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2);
      const length = axis === "x" ? Math.min(box.right - box.left, at.right - at.left) : Math.min(box.bottom - box.top, at.bottom - at.top);
      if ((dx || dy) * (mid(box) - mid(at)) <= 1 || gap < -length / 2) continue;
      const [a0, a1, b0, b1] = axis === "x" ? [box.top, box.bottom, at.top, at.bottom] : [box.left, box.right, at.left, at.right];
      const apart = Math.max(0, a0 - b1, b0 - a1);
      const shared = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
      if (axis === "x" && !loose && shared < Math.min(a1 - a0, b1 - b0) * 0.3) continue;
      out.push({ el, box, gap: Math.max(0, gap), apart, off: Math.abs((a0 + a1) / 2 - (b0 + b1) / 2), size: axis === "x" ? box.right - box.left : box.bottom - box.top });
    }
    if (!out.length) return [];
    const first = out.reduce((best, c) => (c.gap < best.gap ? c : best));
    const line = out.filter((c) => c.gap <= first.gap + first.size * 0.6);
    line.sort((p, q) => p.apart - q.apart || p.off - q.off || p.gap - q.gap);
    return line;
  };

  // Focus on it, giving it a tabindex when it takes none, and the scrolls
  // that bring it into sight, and the next one after it.
  const land = (el) => {
    if (!el.matches(FOCUSABLE)) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    const now = deepest();
    if (now !== el && !holds(el, now)) return false;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    into();
    shown = true;
    follow();
    return true;
  };

  // With nothing further that way: the scroll area it's in that has room
  // that way, else the app's own, else the page, else the area under the
  // middle of the screen (only up and down), a good part of a screen on.
  // For a row, only the area it's in.
  let lastArea = null;
  const scrollOn = (key, from, h, rowOnly) => {
    const [dx, dy] = DIRS[key];
    const root = document.scrollingElement || document.documentElement;
    let area = null;
    for (let a = from && parentOf(from); a && !area; a = parentOf(a)) {
      if (a === document.body || a === document.documentElement) break;
      if (canScroll(a, dx, dy, false)) area = a;
    }
    // Only what it's in, for a row.
    if (rowOnly && !area) return false;
    const own = h.scroller ? document.querySelector(h.scroller) : null;
    if (!area && own && canScroll(own, dx, dy, true)) area = own;
    if (!area && canScroll(root, dx, dy)) area = root;
    if (!area && dy) {
      if (lastArea && lastArea.isConnected && canScroll(lastArea, dx, dy, false)) area = lastArea;
      for (const el of document.elementsFromPoint(innerWidth / 2, innerHeight / 2)) {
        for (let a = el; a && !area; a = parentOf(a)) if (a !== document.body && a !== document.documentElement && canScroll(a, dx, dy, false)) area = a;
        if (area) break;
      }
    }
    if (!area) return false;
    const size = area === root ? (dx ? innerWidth : innerHeight) : dx ? area.clientWidth : area.clientHeight;
    area.scrollBy({ left: dx * size * ${PAGE_SHARE}, top: dy * size * ${PAGE_SHARE}, behavior: "instant" });
    if (area !== root) lastArea = area;
    follow();
    return true;
  };

  // An app's row that moves by its own buttons: its next or previous one,
  // pressed, when what's next along it isn't all in sight.
  const slide = (key, from, h, next) => {
    const [dx] = DIRS[key];
    if (!dx || !from || !h.rows.length) return false;
    for (const hint of h.rows) {
      const row = from.closest(hint.row);
      if (!row) continue;
      const box = row.getBoundingClientRect();
      if (next && holds(row, next.el)) {
        const b = next.el.getBoundingClientRect();
        if (b.left >= box.left - 1 && b.right <= box.right + 1) return false;
      }
      // A row may give only its next button: then the d-pad goes back
      // along it the usual way.
      const selector = dx > 0 ? hint.next : hint.previous;
      if (!selector) return false;
      const button = row.querySelector(selector);
      if (!button || button.matches(":disabled") || button.getAttribute("aria-disabled") === "true") return false;
      button.click();
      return row;
    }
    return false;
  };

  // A press that's waiting for what's further to come: rows loading after
  // a scroll, or a row sliding after its button.
  let waiting = null;
  const look = () => {
    const w = waiting;
    if (!w) return;
    if (performance.now() > w.until) {
      waiting = null;
      return;
    }
    const from = w.from && w.from.isConnected ? w.from : null;
    const h = hints();
    const line = ahead(w.key, from, h);
    const fits = (c) => {
      if (!w.row) return true;
      const box = w.row.getBoundingClientRect();
      const b = c.el.getBoundingClientRect();
      return holds(w.row, c.el) && b.left >= box.left - 1 && b.right <= box.right + 1;
    };
    for (const c of line) {
      if (!fits(c)) continue;
      if (land(c.el)) {
        waiting = null;
        return;
      }
    }
    setTimeout(look, ${LOOK_MS});
  };
  const wait = (key, from, row) => {
    waiting = { key, from, row, until: performance.now() + ${WAIT_MS} };
    setTimeout(look, ${LOOK_MS});
  };

  const move = (key) => {
    waiting = null;
    const now = deepest();
    const from = now && now !== document.body && now !== document.documentElement ? now : null;
    const h = hints();
    // Along a row that's scrolled out of sight, the row comes back first.
    if (from) {
      const b = onScreen(from);
      const [dx, dy] = DIRS[key];
      if ((dx && (b.bottom <= 0 || b.top >= innerHeight)) || (dy && (b.right <= 0 || b.left >= innerWidth))) from.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const line = ahead(key, from, h, false);
    const row = slide(key, from, h, line[0]);
    if (row) return wait(key, from, row);
    for (const c of line.slice(0, 3)) if (land(c.el)) return;
    // Along a row with nothing further in it: the row scrolls on, if it can,
    // and otherwise the nearest thing that way, such as a menu beside it.
    const [dx] = DIRS[key];
    if (dx && from && scrollOn(key, from, h, true)) return wait(key, from, null);
    if (dx) for (const c of ahead(key, from, h, true).slice(0, 3)) if (land(c.el)) return;
    if (scrollOn(key, from, h, false)) wait(key, from, null);
  };

  // Arrows a field or a slider keeps: a caret that isn't at its end yet, a
  // list's choice, a slider's value.
  const keepsArrow = (el, key) => {
    if (el.isContentEditable) return true;
    const across = key === "ArrowLeft" || key === "ArrowRight";
    const name = el.localName;
    if (name === "select") return !across;
    if (name !== "input" && name !== "textarea") return false;
    const type = name === "input" ? el.type : "textarea";
    if (type === "range") return across;
    if (type === "number") return !across;
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {}
    if (start === null || end === null) return false;
    if (start !== end) return across;
    const length = el.value.length;
    if (type === "textarea") {
      const before = el.value.slice(0, start);
      if (key === "ArrowUp") return before.includes("\\n");
      if (key === "ArrowDown") return el.value.slice(start).includes("\\n");
    }
    if (key === "ArrowLeft") return start > 0;
    if (key === "ArrowRight") return start < length;
    return false;
  };

  // The arrow under way, and what had focus as it started. The remote's
  // own listener goes last, once every one of the page's has run.
  let arrow = null;
  let arrowFrom = null;
  const ours = new WeakSet();
  const last = (event) => {
    if (event !== arrow) return;
    arrow = null;
    // The page took it, or moved its own focus with it.
    if (event.defaultPrevented || deepest() !== arrowFrom) return;
    const el = deepest();
    if (el && el !== document.body && keepsArrow(el, event.key)) return;
    event.preventDefault();
    ours.add(event);
    move(event.key);
  };

  window.__origaitvWheelAt = () => {
    const el = deepest();
    const middle = [Math.round(innerWidth / 2), Math.round(innerHeight / 2)];
    if (!shown || !el || el === document.body || el === document.documentElement) return middle;
    const b = onScreen(el);
    const x = (Math.max(b.left, 0) + Math.min(b.right, innerWidth)) / 2;
    const y = (Math.max(b.top, 0) + Math.min(b.bottom, innerHeight)) / 2;
    if (b.right <= 0 || b.left >= innerWidth || b.bottom <= 0 || b.top >= innerHeight) return middle;
    return [Math.round(x), Math.round(y)];
  };
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

// An app's hints for the d-pad on its pages (apps/contract/contract.ts,
// Navigation), for REMOTE_PAGE's world, which reads them at each press. They
// go in as data, never as code.
export function navigationPage(hints: unknown[]): string {
  return "window.__origaitvHints = " + JSON.stringify(hints) + ";";
}

export const REMOTE_PAGE = remotePage();
export const SHARED_PAGE = remotePage(1000, { back: false });
