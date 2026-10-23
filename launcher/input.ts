// Every input as one set of actions (ADR-008, ADR-015, ADR-031): a keyboard,
// the virtual input device the phone and the d-pad send through (it types
// the same keys), a gamepad and a mouse.

export type Action = "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "info" | "plus" | "minus" | "edit" | "pin" | "remove";

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
};

// Standard gamepad buttons: A, B, Y, start, the d-pad and the guide button.
const BUTTONS: Record<number, Action> = { 0: "ok", 1: "back", 3: "info", 9: "edit", 12: "up", 13: "down", 14: "left", 15: "right", 16: "home" };
const REPEAT_FIRST = 400;
const REPEAT_NEXT = 120;
const STICK = 0.6;

export function listen(act: (action: Action) => void): void {
  window.addEventListener("keydown", (event) => {
    const action = KEYS[event.key];
    if (!action) return;
    event.preventDefault();
    act(action);
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
