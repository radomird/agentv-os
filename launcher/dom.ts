// Builds elements. Text is always set as text, never as markup, so nothing an
// app sends can add markup to the home screen.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// A monogram for an app with no logo: up to two letters (ADR-015).
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}+ ]/gu, " ").trim().split(/\s+/);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

// A colour for a monogram, the same every time for an app.
export function tint(id: string): number {
  let sum = 0;
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return sum % 6;
}

export function clock(date = new Date()): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
