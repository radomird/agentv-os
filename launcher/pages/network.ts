// What's on your network (daemon/discover.ts), wherever the TV used to ask
// for an address: the servers and NASes the box found come first, as they
// answer, and typing an address on the phone second. A NAS lists its
// folders when it's picked, after a sign-in typed on the phone if it wants
// one. The TV's pages show this only with the discover switch on.

import { h } from "../dom.ts";
import { featureOn } from "../features.ts";
import type { Focus } from "../focus.ts";

export type Kind = "jellyfin" | "emby" | "plex" | "immich" | "smb" | "nfs";

export interface Found {
  kind: Kind;
  name: string;
  url: string;
  host: string;
  via: string;
}

export interface ShareFound {
  kind: "smb" | "nfs";
  name: string;
  uri: string;
  note?: string;
}

interface Answer<T> {
  ok: boolean;
  error?: string;
  found?: Found[];
  looking?: boolean;
  shares?: T[];
  host?: string;
  login?: boolean;
}

export const NAS: Kind[] = ["smb", "nfs"];
const SERVERS: Kind[] = ["jellyfin", "emby", "plex", "immich"];
// Each kind's letter and colour, as setup's apps step draws the apps.
const FACES: Record<Kind, [string, string]> = {
  jellyfin: ["J", "magenta"],
  emby: ["E", "green"],
  plex: ["P", "orange"],
  immich: ["I", "yellow"],
  smb: ["N", "blue"],
  nfs: ["N", "blue"],
};
// How often an open list asks again, which keeps the box looking.
const AGAIN_MS = 20_000;
// How long a new list may move the focus to its first find by itself.
const SETTLE_MS = 1_500;

// Shows or hides a part of a page. The hidden attribute alone loses to a
// class that sets display, as the forms' do.
export function shown(el: HTMLElement, yes: boolean): void {
  el.style.display = yes ? "" : "none";
}

export function discoverOn(): Promise<boolean> {
  return featureOn("discover");
}

// The servers an app can use: its own kind for AgenTV's own apps, and any
// media server for one your agent made.
export function kindsFor(app: string): Kind[] {
  const own: Record<string, Kind[]> = { "agentv.jellyfin": ["jellyfin"], "agentv.plex": ["plex"], "agentv.immich": ["immich"] };
  return own[app] ?? SERVERS;
}

async function ask<T>(path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as Answer<T>;
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "the tv couldn't ask its network");
  return data;
}

// A row of the list: a server's letter in its colour, as setup's apps step
// draws the apps, its name, and where it is on the right. A folder has no
// letter.
function row(face: Kind | null, name: string, value: string, data: Record<string, string>, pick: () => void): HTMLElement {
  const letter = face ? h("span", { class: `avatar avatar-${FACES[face][1]}`, "aria-hidden": "true" }, FACES[face][0]) : null;
  return h("button", { class: "button", "data-focus": true, ...data, onclick: pick }, h("span", { class: "profile-who" }, letter, h("b", {}, name.toLowerCase())), h("span", { class: "button-value" }, value));
}

export interface ListOptions {
  kinds: Kind[];
  focus: Pick<Focus, "get" | "set">;
  pick(found: Found): void;
  // One row a machine, for the NASes, rather than one a server.
  machines?: boolean;
  // The row after the list, which has the focus until something's found.
  typed: HTMLElement;
}

// The list, filling as the box hears from the network, for as long as it's
// on the page.
export function foundList(options: ListOptions): { el: HTMLElement; rows: HTMLElement } {
  const rows = h("div", { class: "found-rows profile-form" });
  const looking = h("div", { class: "panel-note found-looking" }, "● still looking");
  const el = h("div", { class: "found-list" }, rows, looking);
  let source: EventSource | null = null;
  let shown = "";
  let count = 0;
  let placed = false;
  const born = Date.now();

  // The first find has the focus, over the row for typing, when it's the
  // first, or in the list's first moments: a page sliding in sets its own
  // first focus a moment after it's drawn.
  const settle = () => {
    const had = options.focus.get();
    const first = rows.firstElementChild as HTMLElement | null;
    if (first && (!had || had === options.typed) && (count === 0 || Date.now() - born < SETTLE_MS)) options.focus.set(first, false);
  };

  const draw = (answer: { found?: Found[]; looking?: boolean }) => {
    const found = (answer.found ?? []).filter((one) => options.kinds.includes(one.kind));
    const items = options.machines ? machines(found) : found.map((one) => ({ key: `${one.kind} ${one.url}`, face: one.kind, name: one.name, value: one.host, found: one }));
    looking.textContent = answer.looking ? "● still looking" : items.length ? "" : "nothing on your network answered";
    const key = items.map((item) => `${item.key} ${item.name} ${item.value}`).join("|");
    if (key === shown) return;
    shown = key;
    const had = options.focus.get();
    const index = had ? [...rows.children].indexOf(had) : -1;
    rows.replaceChildren(...items.map((item) => row(item.face, item.name, item.value, { "data-found": item.key }, () => options.pick(item.found))));
    // Focus stays on the same place in the list.
    if (index >= 0) options.focus.set((rows.children[Math.min(index, rows.children.length - 1)] as HTMLElement | undefined) ?? options.typed, false);
    else settle();
    count = items.length;
  };

  const kinds = options.kinds.join(",");
  // Gone from the page: the list stops asking.
  const gone = () => {
    placed ||= el.isConnected;
    return placed && !el.isConnected;
  };
  const again = () => {
    if (gone()) return stop();
    void ask<never>(`/api/discover?kinds=${kinds}`).then(draw, (error: Error) => (looking.textContent = error.message));
  };
  const stop = () => {
    source?.close();
    source = null;
    clearInterval(timer);
  };
  source = new EventSource("/api/events");
  source.addEventListener("discover", (message) => {
    if (gone()) return stop();
    draw(JSON.parse((message as MessageEvent).data) as { found: Found[]; looking: boolean });
  });
  const timer = setInterval(again, AGAIN_MS);
  for (const at of [400, 900, SETTLE_MS]) setTimeout(settle, at);
  again();
  return { el, rows };
}

// The NASes, one row a machine: its SMB name, or its NFS export's.
function machines(found: Found[]): { key: string; face: Kind; name: string; value: string; found: Found }[] {
  const byHost = new Map<string, Found>();
  for (const one of found) {
    const known = byHost.get(one.host);
    if (!known || (known.kind === "nfs" && one.kind === "smb")) byHost.set(one.host, one);
  }
  return [...byHost.values()].map((one) => ({ key: `nas ${one.host}`, face: one.kind, name: one.name, value: one.host, found: one }));
}

export interface SharesOptions {
  host: string;
  focus: Pick<Focus, "get" | "set">;
  // The share picked, with the sign-in its address was listed with, which
  // the share then keeps as Music's sources do.
  pick(share: ShareFound, password?: string): void;
}

// A NAS's folders, and its sign-in, typed on the phone, when it lists them
// only for a user.
export function shareList(options: SharesOptions): { el: HTMLElement; signIn(): void; first(): HTMLElement | undefined } {
  const rows = h("div", { class: "found-rows profile-form" });
  const line = h("div", { class: "panel-note" }, "…");
  const user = h("input", { class: "music-search", "data-focus": true, "data-field": "user", type: "text", placeholder: "your user name on it", "aria-label": "your user name on the nas", autocomplete: "username", spellcheck: "false" }) as HTMLInputElement;
  const password = h("input", { class: "music-search", "data-focus": true, "data-field": "password", type: "password", placeholder: "its password", "aria-label": "the nas's password", autocomplete: "current-password" }) as HTMLInputElement;
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "list", onclick: () => void list(true) }, "↵ show its folders");
  const form = h("div", { class: "share-form" }, user, password, go);
  shown(form, false);
  const el = h("div", { class: "found-list" }, rows, form, line);
  let signedIn: string | undefined;

  const signIn = () => {
    shown(form, true);
    line.textContent = `${options.host} shows its folders after you sign in. type it on your phone.`;
    options.focus.set(user.value ? password : user, false);
  };

  const list = async (withLogin = false) => {
    line.textContent = "…";
    let answer: Answer<ShareFound>;
    try {
      // The password leaves the page with the ask, and the share keeps it.
      answer = withLogin ? await ask<ShareFound>("/api/discover/shares", { host: options.host, user: user.value.trim(), password: password.value }) : await ask<ShareFound>(`/api/discover/shares?host=${encodeURIComponent(options.host)}`);
    } catch (error) {
      line.textContent = (error as Error).message;
      return;
    }
    signedIn = withLogin ? password.value : undefined;
    password.value = "";
    const shares = answer.shares ?? [];
    rows.replaceChildren(...shares.map((share) => row(null, `▶ ${share.name}`, share.kind === "nfs" ? "nfs" : "", { "data-share": share.uri }, () => options.pick(share, signedIn))));
    if (answer.login && !withLogin) return signIn();
    shown(form, false);
    line.textContent = shares.length ? "" : `${options.host} has no folders to share`;
    const first = rows.firstElementChild as HTMLElement | null;
    if (first) options.focus.set(first, false);
  };

  void list();
  return { el, signIn, first: () => (rows.firstElementChild as HTMLElement | null) ?? undefined };
}
