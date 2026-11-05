// What you type on the phone, in the TV's field as you type it (ADR-065).
//
// The phone sends its whole field on each change: the text and where the
// caret is. The daemon passes it to the screen daemon, which makes the
// field in front hold exactly that:
// - in a web page (home, an app's page in the services' Chromium, the share
//   browser), through Chromium itself, as if it had been typed there. Only
//   the part that changed is replaced, so the page sees ordinary typing, and
//   accents, other alphabets and emoji all work;
// - in a native app, as keystrokes on the virtual input device (input.py),
//   which types plain ASCII only. Anything else is left out, and the phone
//   is told what couldn't go.
//
// Nothing here logs the text, and no answer or error names it, since it can
// be a password (ADR-032). A password shows as dots on the TV's typing bar.

// The focused element in a page, through open shadow roots and same-origin
// frames, and whether it takes typing. For the expressions below.
const DEEP = `
  const deep = () => {
    let doc = document;
    let el = doc.activeElement;
    for (let i = 0; i < 32 && el; i++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
        continue;
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch {}
        if (inner && inner.activeElement && inner.activeElement !== inner.body) {
          doc = inner;
          el = inner.activeElement;
          continue;
        }
      }
      break;
    }
    return { el, doc };
  };
  const TYPES = ["text", "search", "email", "password", "url", "tel", "number"];
  const typable = (el) =>
    !!el && !el.disabled && !el.readOnly &&
    (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TYPES.includes(el.type)));
`;

// The kinds the phone's keyboard opens for (launcher/context.ts has home's).
export const FIELD_KINDS = ["text", "search", "email", "password", "number", "url"];

// The field in front, as the phone's keyboard needs it, or null: its kind,
// a short name for it from its label, and what's in it now, except for a
// password.
export interface Field {
  kind: string;
  label: string;
  value?: string;
}

// An expression for a page: the focused field there, or null.
export const FIELD = `(() => {${DEEP}
  const { el } = deep();
  if (!typable(el)) return null;
  const type = el.tagName === "INPUT" ? el.type : "";
  const mode = (el.getAttribute("inputmode") || "").toLowerCase();
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  let kind = "text";
  if (type === "password") kind = "password";
  else if (type === "number" || type === "tel" || ["numeric", "decimal", "tel"].includes(mode)) kind = "number";
  else if (type === "email" || mode === "email" || /\\b(username|email)\\b/.test(auto)) kind = "email";
  else if (type === "url" || mode === "url") kind = "url";
  else if (type === "search" || mode === "search" || role === "searchbox" || el.closest("[role=search]")) kind = "search";
  const root = el.getRootNode();
  const by = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
    .map((id) => (root.getElementById ? root.getElementById(id) : null)?.textContent || "").join(" ");
  const label = (el.getAttribute("aria-label") || by || (el.labels && el.labels[0] ? el.labels[0].textContent : "") ||
    el.getAttribute("placeholder") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().toLowerCase().slice(0, 40);
  if (kind === "password") return { kind, label };
  const value = el.isContentEditable ? el.innerText.replace(/\\n$/, "") : el.value;
  return { kind, label, value: String(value).slice(0, 500) };
})()`;

// Only what a field's report can carry, within bounds.
export function cleanField(said: unknown): Field | null {
  if (!said || typeof said !== "object") return null;
  const f = said as Record<string, unknown>;
  const kind = typeof f.kind === "string" && FIELD_KINDS.includes(f.kind) ? f.kind : "text";
  const label = typeof f.label === "string" ? f.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const field: Field = { kind, label };
  if (kind !== "password" && typeof f.value === "string") field.value = f.value.slice(0, 500);
  return field;
}

// An expression for a page: the focused field holds value, with the caret
// at caret. Only the part that differs from what's there is replaced, with
// the page's own editing, so the page hears it as typing; a field that
// won't take that gets its value set and an input event, as a framework's
// own field would. It answers how it went, never with the text.
export function typeIn(value: string, caret: number | null): string {
  return `((value, caret) => {${DEEP}
  const { el, doc } = deep();
  if (!typable(el)) return { ok: false, why: "nothing on the tv takes typing now" };
  const win = doc.defaultView || window;
  const read = () => (el.isContentEditable ? el.innerText.replace(/\\n$/, "") : el.value);
  const before = read();
  if (before !== value) {
    let done = false;
    if (el.isContentEditable) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = win.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try { done = doc.execCommand(value ? "insertText" : "delete", false, value) && read() === value; } catch {}
      if (!done) {
        el.textContent = value;
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
      }
    } else {
      let start = 0;
      while (start < before.length && start < value.length && before[start] === value[start]) start++;
      let end = 0;
      while (end < before.length - start && end < value.length - start && before[before.length - 1 - end] === value[value.length - 1 - end]) end++;
      // Never half of an emoji: a change starts and ends on whole characters.
      const code = (text, i) => text.charCodeAt(i);
      if (start > 0 && code(value, start - 1) >= 0xd800 && code(value, start - 1) <= 0xdbff) start--;
      if (end > 0 && code(value, value.length - end) >= 0xdc00 && code(value, value.length - end) <= 0xdfff) end--;
      const middle = value.slice(start, value.length - end);
      let placed = false;
      try {
        el.setSelectionRange(start, before.length - end);
        placed = true;
      } catch {}
      if (placed) {
        try { done = doc.execCommand(middle ? "insertText" : "delete", false, middle) && el.value === value; } catch {}
      }
      if (!done) {
        const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: middle || null }));
      }
    }
  }
  if (typeof caret === "number" && !el.isContentEditable) {
    try { el.setSelectionRange(caret, caret); } catch {}
  }
  const now = read();
  if (now === value) return { ok: true, by: "page" };
  if (value.startsWith(now)) return { ok: false, by: "page", why: "the tv's field is full", kept: now.length };
  return { ok: false, by: "page", why: "the tv's field didn't take all of it" };
})(${JSON.stringify(value)}, ${caret === null ? "null" : Math.trunc(caret)})`;
}

// How it went, for the phone. value comes back only from a native app, where
// what reached the TV is the text without the characters that couldn't go,
// and kept from a field that took only so much.
export interface TextAnswer {
  ok: boolean;
  by?: "page" | "key";
  why?: string;
  value?: string;
  kept?: number;
}

// What the virtual input device can type: printable ASCII, on a US layout.
const TYPABLE = /^[\x20-\x7e]$/;

// Typing into a native app, as keystrokes. It remembers what it typed into
// the window in front, so each change sends only the difference: Backspace
// back to where the old and new text part, then the rest of the new.
export class NativeTyping {
  private typed = "";
  private where = "";

  // where: which window it's typing in; a new one starts afresh.
  async type(value: string, where: string, send: (request: Record<string, unknown>) => Promise<void>): Promise<TextAnswer> {
    if (where !== this.where) {
      this.where = where;
      this.typed = "";
    }
    const chars = [...value];
    const kept = chars.filter((c) => TYPABLE.test(c)).join("");
    const bad = chars.find((c) => !TYPABLE.test(c));
    let same = 0;
    while (same < this.typed.length && same < kept.length && this.typed[same] === kept[same]) same++;
    while (this.typed.length > same) {
      await send({ key: "backspace" });
      this.typed = this.typed.slice(0, -1);
    }
    if (kept.length > same) {
      await send({ text: kept.slice(same) });
      this.typed = kept;
    }
    if (!bad) return { ok: true, by: "key" };
    return { ok: false, by: "key", value: kept, why: `this app takes plain letters, so ${bad} can't go` };
  }

  // Enter, or the window changed: the next text starts afresh.
  reset(): void {
    this.typed = "";
    this.where = "";
  }
}

// What the TV's typing bar shows: who's typing, the newest of the text, or
// a dot for each character of a password.
export interface Bar {
  from: string;
  text: string;
  password: boolean;
}

export function barText(value: string, password: boolean, most = 34): string {
  const chars = [...value];
  if (password) return "•".repeat(Math.min(chars.length, most));
  return chars.length > most ? `…${chars.slice(-(most - 1)).join("")}` : value;
}

// What's in front for typing, from the screen daemon: a page, to type in
// through Chromium, or a native window, for keystrokes. bar draws the
// typing bar over it, or takes it away; home draws its own.
export type TypingFront =
  | { kind: "page"; id: string; evaluate(expression: string): Promise<unknown>; overlay: boolean }
  | { kind: "native"; id: string; overlay: boolean }
  | null;

export interface PhoneTypingOptions {
  front(): TypingFront;
  // A request for the virtual input device: {"key": "enter"}, {"text": ...}.
  keys(request: Record<string, unknown>): Promise<void>;
  // The typing bar over an app, or gone with null.
  bar(bar: Bar | null): Promise<void>;
  // How long a page has to answer.
  ms?: number;
}

// The screen daemon's side of typing: each change into what's in front.
export class PhoneTyping {
  private o: PhoneTypingOptions;
  private native = new NativeTyping();
  private overlay = false;

  constructor(options: PhoneTypingOptions) {
    this.o = options;
  }

  async text(value: string, caret: number | null, bar: Bar | null): Promise<TextAnswer> {
    const front = this.o.front();
    await this.showBar(front, bar);
    if (!front) return { ok: false, why: "nothing on the tv takes typing now" };
    if (front.kind === "native") return this.native.type(value, front.id, this.o.keys);
    this.native.reset();
    const ms = this.o.ms ?? 1000;
    const answer = await Promise.race([
      front.evaluate(typeIn(value, caret)).catch(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), ms)),
    ]);
    return cleanAnswer(answer) ?? { ok: false, why: "the tv's page didn't answer" };
  }

  // Enter: the field's own, as a key, and the bar goes.
  async done(): Promise<TextAnswer> {
    const front = this.o.front();
    this.native.reset();
    await this.showBar(front, null);
    try {
      await this.o.keys({ key: "enter" });
      return { ok: true, by: front?.kind === "page" ? "page" : "key" };
    } catch {
      return { ok: false, why: "enter didn't reach the tv" };
    }
  }

  // The bar over an app follows the typing; over home, home draws its own,
  // so one the overlay still shows goes.
  private async showBar(front: TypingFront, bar: Bar | null): Promise<void> {
    const over = Boolean(front?.overlay) && bar !== null;
    if (!over && !this.overlay) return;
    this.overlay = over;
    await this.o.bar(over ? bar : null).catch(() => {});
  }
}

// Only what an answer can carry: never more text than a native app's.
export function cleanAnswer(said: unknown): TextAnswer | null {
  if (!said || typeof said !== "object") return null;
  const a = said as Record<string, unknown>;
  const answer: TextAnswer = { ok: a.ok === true };
  if (a.by === "page" || a.by === "key") answer.by = a.by;
  if (typeof a.why === "string") answer.why = a.why.slice(0, 120);
  if (typeof a.value === "string") answer.value = a.value.slice(0, 1000);
  if (Number.isInteger(a.kept) && (a.kept as number) >= 0) answer.kept = a.kept as number;
  return answer;
}
