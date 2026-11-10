// Every input as one set of actions (ADR-008, ADR-015, ADR-031): a keyboard,
// the virtual input device the phone and the d-pad send through (it types
// the same keys), a gamepad and a mouse.

export type Action = "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "info" | "plus" | "minus" | "edit" | "pin" | "remove" | "quit";

const KEYS: Record<string, Action> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "ok",
  NumpadEnter: "ok",
  Escape: "back",
  Backspace: "back",
  BrowserBack: "back",
  GoBack: "back",
  Home: "home",
  BrowserHome: "home",
  i: "info",
  I: "info",
  "+": "plus",
  "=": "plus",
  "-": "minus",
  e: "edit",
  E: "edit",
  p: "pin",
  P: "pin",
  Delete: "remove",
  q: "quit",
  Q: "quit",
};

// Standard gamepad buttons: A, B, X, Y, start, the d-pad and the guide button.
const BUTTONS: Record<number, Action> = { 0: "ok", 1: "back", 2: "quit", 3: "info", 9: "edit", 12: "up", 13: "down", 14: "left", 15: "right", 16: "home" };
const REPEAT_FIRST = 400;
const REPEAT_NEXT = 120;
const STICK = 0.6;
// How long OK is held on a tile before it opens the app's details and not
// the app (ADR-084), the way a long press does on a phone.
export const HOLD_MS = 600;

// In a text field, the keys type; only these still move, choose and go back.
const FIELD_KEYS = ["ArrowUp", "ArrowDown", "Enter", "NumpadEnter", "Escape", "Home", "BrowserBack", "GoBack", "BrowserHome"];

// details says which app's details a hold on OK would open: the focused
// tile's, or nothing when the focus isn't on one. Only there does OK wait
// for the key to come up, so a short press opens the app and a held one
// opens its details. Everywhere else OK acts as the key goes down, as ever.
export function listen(act: (action: Action) => void, details: () => string | undefined = () => undefined): void {
  // The press of OK under way on a tile, and whether the hold has already
  // opened details, so the key's repeats and its release do nothing more.
  let press: { on: string; at: number; timer: number } | null = null;
  let spent = false;
  // The hold opens details only while the focus is still on that tile.
  const settle = (action: Action) => {
    const on = press?.on;
    clearTimeout(press?.timer);
    press = null;
    if (on !== undefined && details() === on) act(action);
  };

  window.addEventListener("keydown", (event) => {
    const action = KEYS[event.key];
    if (!action) return;
    // A key held with Super, Ctrl or Alt is a shortcut, such as Omarchy's
    // Super+Return, not the remote's.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement && !FIELD_KEYS.includes(event.key)) return;
    event.preventDefault();
    if (action === "ok") {
      // A held key repeats: the press is already counted.
      if (press || spent) return;
      const on = event.repeat ? undefined : details();
      if (on !== undefined) {
        const timer = window.setTimeout(() => {
          spent = true;
          settle("info");
        }, HOLD_MS);
        press = { on, at: event.timeStamp, timer };
        return;
      }
    }
    act(action);
  });
  window.addEventListener("keyup", (event) => {
    if (KEYS[event.key] !== "ok") return;
    spent = false;
    // Let go before the hold: OK. A busy page can hear the release before
    // its own timer, so the time between the two decides.
    if (press) settle(event.timeStamp - press.at >= HOLD_MS ? "info" : "ok");
  });
  // The window lost the keys with OK still down: its release never comes.
  window.addEventListener("blur", () => {
    clearTimeout(press?.timer);
    press = null;
    spent = false;
  });

  // Right-click and a mouse's back button are Back (ADR-015).
  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    act("back");
  });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3) act("back");
  });

  // Gamepads have no events for their buttons, so they're read each frame
  // while one is connected. A held direction repeats like a held key.
  const held = new Map<string, number>();
  const poll = (now: number) => {
    const pads = navigator.getGamepads().filter((pad): pad is Gamepad => pad !== null);
    if (pads.length === 0) {
      held.clear();
      return;
    }
    const pressed = new Set<Action>();
    for (const pad of pads) {
      for (const [index, action] of Object.entries(BUTTONS)) {
        if (pad.buttons[Number(index)]?.pressed) pressed.add(action);
      }
      const [x = 0, y = 0] = pad.axes;
      if (x < -STICK) pressed.add("left");
      if (x > STICK) pressed.add("right");
      if (y < -STICK) pressed.add("up");
      if (y > STICK) pressed.add("down");
    }
    for (const action of pressed) {
      const at = held.get(action);
      if (at === undefined) {
        held.set(action, now + REPEAT_FIRST);
        act(action);
      } else if (now >= at && ["up", "down", "left", "right"].includes(action)) {
        held.set(action, now + REPEAT_NEXT);
        act(action);
      }
    }
    for (const action of held.keys()) if (!pressed.has(action as Action)) held.delete(action);
    requestAnimationFrame(poll);
  };
  window.addEventListener("gamepadconnected", () => requestAnimationFrame(poll));
}
