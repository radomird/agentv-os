// What's on the TV, for the phone's remote to follow (ADR-037): the PIN pad,
// what it's for and how many digits are in, a text field with the focus and
// its kind, and home, a menu or the ambient screen. It goes to the daemon as
// it changes, a few changes at a time. Never a digit of the PIN.

type Pin = { title: string; for: string; digits: number; error: string | null } | null;
type Context = { pin: Pin; field: { kind: string } | null; screen: "home" | "menu" | "ambient" };

const now: Context = { pin: null, field: null, screen: "home" };
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
