// What's on the TV, for the phone's remote to follow (ADR-037): the PIN pad,
// what it's for and how many digits are in, a text field with the focus and
// its kind, home, a menu or the ambient screen, and whether the focus is on
// an app's tile, where a hold opens its details (ADR-089). It goes to the
// daemon as it changes, a few changes at a time. Never a digit of the PIN.

type Pin = { title: string; for: string; digits: number; error: string | null } | null;
type Field = { kind: string; label?: string };
type Context = { pin: Pin; field: Field | null; screen: "home" | "menu" | "ambient"; details: boolean };

const now: Context = { pin: null, field: null, screen: "home", details: false };
let timer = 0;

export function tell(change: Partial<Context>): void {
  const before = JSON.stringify(now);
  Object.assign(now, change);
  if (JSON.stringify(now) === before) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    void fetch("/api/tv/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(now) }).catch(() => {});
  }, 30);
}

// A text field's kind, as the phone's keyboard opens for it: digits first
// for a number.
export function fieldKind(el: HTMLInputElement): string {
  if (el.inputMode === "numeric" || el.type === "number") return "number";
  return ["search", "email", "password", "url"].includes(el.type) ? el.type : "text";
}

// The field for the phone: its kind, and its name for the phone's keyboard
// to say what it's typing in (ADR-065).
export function fieldOf(el: HTMLInputElement): Field {
  const label = el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.placeholder || "";
  return { kind: fieldKind(el), label: label.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40) };
}
