// What the phone companion's views share: building elements, the box's
// requests with the phone's token, and a toast.

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

const TOKEN = "agentv-phone-token";

export function token(): string | null {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

export function keep(value: string | null): void {
  try {
    if (value) localStorage.setItem(TOKEN, value);
    else localStorage.removeItem(TOKEN);
  } catch {
    // A private window keeps it only while the page is open.
  }
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

// The box said this phone isn't paired, or not any more.
export class Unpaired extends Error {}
// The box said this needs the parent PIN.
export class NeedsPin extends Error {}

export async function api<T>(method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(grant ? { "X-AgenTV-Grant": grant } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Unpaired(data.error ?? "this phone isn't paired");
  if (response.status === 403 && data.pin) throw new NeedsPin(data.error ?? "that needs the pin");
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "the tv didn't answer");
  return data as T;
}

export interface Viewer {
  id: string;
  name: string;
  role: "adult" | "kid";
  avatar: string;
}

export function avatar(viewer: Pick<Viewer, "name" | "avatar">, big = false): HTMLElement {
  return h("span", { class: `avatar avatar-${viewer.avatar}${big ? " big" : ""}` }, viewer.name.slice(0, 1).toLowerCase());
}

export function prompt(command: string): HTMLElement {
  return h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${command}`);
}
