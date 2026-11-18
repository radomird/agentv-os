// What you typed, kept when the page in front is drawn again. A look picked
// on a phone, the display's size, someone else watching, a change to home or
// a switch all build the page anew, with new fields. So each field's text,
// caret and selection go from the old field to the one drawn in its place:
// the same kind of field, with the same name, in the same order. The page
// hears it as typing, so what follows the text, such as a search's results,
// comes back with it.
//
// A password only ever goes to a password field, straight from the old one
// in the same call, and waits for nothing. Nothing here logs the text, stores
// it or sends it anywhere.
//
// A page can hold a pick beside its fields, as a profile's role next to its
// name. That goes over too (keeps, below), so Save never sends the text with
// a pick the person didn't leave on the screen.

type Field = HTMLInputElement | HTMLTextAreaElement;

// The kinds of field that hold typed text (daemon/remote-text.ts has the
// same list for the phone's keyboard).
const TYPES = ["text", "search", "email", "password", "url", "tel", "number", "textarea"];

interface Entry {
  key: string;
  // The text, when it's the person's own and not what the page drew.
  value: string | null;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none";
  focused: boolean;
  secret: boolean;
}

export interface Typed {
  // Puts the text into the page drawn in place of the old one. It answers
  // with the field that had the focus, for the page to start on. A field
  // the page adds later, as one that asks the TV what to show first, gets
  // its text when it comes, and late hears of the one that had the focus.
  into(root: HTMLElement, late?: (field: HTMLElement) => void): HTMLElement | undefined;
  // The caret again, once the field has the focus: a page may move it as
  // the focus arrives.
  caret(): void;
  // The page is going, or is drawn once more: nothing waits here any more.
  // It answers with the text that never found its field.
  stop(): Entry[];
}

// A page's picks beside its fields: what a person chose with left and right
// and hasn't saved yet. The page names them on one of its elements and says
// what they are each time one changes. When the page is drawn again, the new
// page's take gets them, as they were said. They're plain choices, never
// text a person typed, so nothing secret goes this way.
export function keeps<T>(el: HTMLElement, name: string, take: (kept: T) => void): (now: T) => void {
  el.dataset.keeps = name;
  el.addEventListener("kept", (event) => {
    const said = (event as CustomEvent<string>).detail;
    let kept: T;
    try {
      kept = JSON.parse(said) as T;
    } catch {
      return;
    }
    // Still the person's own, if the page is drawn once more.
    el.dataset.kept = said;
    take(kept);
  });
  return (now) => {
    el.dataset.kept = JSON.stringify(now);
  };
}

// The picks a page has said, by the name it gave them.
function picks(root: HTMLElement): [name: string, said: string][] {
  return [...root.querySelectorAll<HTMLElement>("[data-keeps][data-kept]")].map((el) => [el.dataset.keeps!, el.dataset.kept!]);
}

function fields(root: HTMLElement): Field[] {
  return [...root.querySelectorAll<Field>("input, textarea")].filter((el) => TYPES.includes(el.type));
}

// A field's name on its page: what the page calls it, or its label where it
// has no name, and which one it is among those with the same.
function keys(all: Field[]): string[] {
  const seen = new Map<string, number>();
  return all.map((el) => {
    const name = el.dataset.action ?? el.dataset.field ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
    const key = `${el.type} ${name}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key} ${n}`;
  });
}

function place(el: Field, entry: Entry): void {
  if (entry.start === null || entry.end === null) return;
  try {
    el.setSelectionRange(entry.start, entry.end, entry.direction);
  } catch {
    // A number or an email has no caret to place.
  }
}

// The page's fields that hold a person's own text, or the focus.
function read(root: HTMLElement, focused: HTMLElement | undefined): Entry[] {
  const all = fields(root);
  const names = keys(all);
  return all.flatMap((el, i) => {
    const typed = el.value !== el.defaultValue;
    if (!typed && el !== focused) return [];
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      // No caret to read.
    }
    return [{ key: names[i], value: typed ? el.value : null, start, end, direction: el.selectionDirection ?? "none", focused: el === focused, secret: el.type === "password" }];
  });
}

const inSight = (el: HTMLElement) => el.offsetParent !== null;

// Reads the page in front, before it's drawn again. focused is the element
// the launcher's focus is on. waiting is what the last time left waiting for
// its field, when the page was drawn twice before the field came.
export function keepTyped(root: HTMLElement, focused: HTMLElement | undefined, waiting: Entry[] = []): Typed {
  const here = keys(fields(root));
  // What still waited keeps waiting, unless its field is here now.
  let left = [...waiting.filter((entry) => !here.includes(entry.key)), ...read(root, focused)];
  const picked = picks(root);
  // The field that had the focus: the one that has it again, and the one
  // still owed it, while it's out of sight. Neither holds the text.
  let landed: { el: Field; entry: Entry } | undefined;
  let owed: { el: Field; entry: Entry } | undefined;
  let watching: MutationObserver | undefined;
  const moved = () => {
    owed = undefined;
    for (const entry of left) entry.focused = false;
  };

  // Each field that's here takes its text. The ones still to come stay in
  // left. It answers with the field that had the focus, if it's here.
  const fill = (to: HTMLElement): { el: Field; entry: Entry } | undefined => {
    const now = fields(to);
    const at = keys(now);
    let had: { el: Field; entry: Entry } | undefined;
    left = left.filter((entry) => {
      const el = now[at.indexOf(entry.key)];
      if (!el) return true;
      if (entry.value !== null && el.value !== entry.value) {
        el.value = entry.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      place(el, entry);
      if (entry.focused) had = { el, entry: { ...entry, value: null } };
      return false;
    });
    return had;
  };

  const end = () => {
    watching?.disconnect();
    watching = undefined;
    window.removeEventListener("keydown", moved, true);
  };

  return {
    into(to, late) {
      // The picks first, so a field's text finds the page as it was.
      for (const [name, said] of picked) {
        const el = [...to.querySelectorAll<HTMLElement>("[data-keeps]")].find((one) => one.dataset.keeps === name);
        el?.dispatchEvent(new CustomEvent("kept", { detail: said }));
      }
      owed = fill(to);
      // A password never waits.
      left = left.filter((entry) => !entry.secret);
      if (owed && inSight(owed.el)) {
        landed = owed;
        owed = undefined;
      }
      if (left.length || owed) {
        // A field that comes later, or comes into sight, as a form the page
        // shows once the TV has answered.
        watching = new MutationObserver(() => {
          owed = fill(to) ?? owed;
          if (owed && inSight(owed.el)) {
            const { el, entry } = owed;
            owed = undefined;
            late?.(el);
            place(el, entry);
          }
          if (!left.length && !owed) end();
        });
        watching.observe(to, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
        // A key pressed meanwhile moved the focus on: it stays where it's put.
        window.addEventListener("keydown", moved, true);
      }
      return landed?.el;
    },
    caret() {
      if (landed) place(landed.el, landed.entry);
    },
    stop() {
      end();
      const still = left;
      left = [];
      owed = undefined;
      return still;
    },
  };
}
