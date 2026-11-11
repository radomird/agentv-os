// What the phone companion's views share: building elements, the box's
// requests, and a toast.

import { call, Unpaired } from "./channel.ts";

export { call, file, paired, Unpaired } from "./channel.ts";

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer = 0;
export function toast(text: string, ok = false): void {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.classList.toggle("ok", ok);
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("on"), 3000);
}

// The box said this needs the adult PIN.
export class NeedsPin extends Error {}

// A request to the box, signed and sealed (channel.ts), and its JSON answer.
// The answer is the box's own: call takes none that didn't come sealed.
export async function api<T>(method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const { status, ok, data } = await call(method, path, body === undefined ? undefined : { json: body }, grant);
  if (status === 401) throw new Unpaired(data.error ?? "this phone isn't paired");
  if (status === 403 && data.pin) throw new NeedsPin(data.error ?? "that needs the pin");
  if (!ok || data.ok === false) throw new Error(data.error ?? "the tv didn't answer");
  return data as T;
}

export interface Viewer {
  id: string;
  name: string;
  role: "adult" | "child";
  avatar: string;
  // An adult's profile that asks for the PIN to open (ADR-034).
  locked: boolean;
}

export function avatar(viewer: Pick<Viewer, "name" | "avatar">, big = false): HTMLElement {
  return h("span", { class: `avatar avatar-${viewer.avatar}${big ? " big" : ""}` }, viewer.name.slice(0, 1).toLowerCase());
}

export function prompt(command: string): HTMLElement {
  return h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${command}`);
}
