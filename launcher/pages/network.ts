// What's on your network (daemon/discover.ts), wherever the TV used to ask
// for an address: the servers and network drives the TV found come first,
// as they answer, and typing an address on the phone second. A row is a
// find's name and its address, "Jellyfin · 192.168.1.20:8096", so one that
// answers from two addresses reads as two rows you can tell apart. A drive
// lists its folders when it's picked, after a sign-in typed on the phone if
// it wants one. The TV's pages show this only with the discover switch on.
//
// The phone shows the same list as a line "On your network" while it's on
// the TV, and a pick there picks the TV's row, as OK would.

import { asWritten, h } from "../dom.ts";
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

// AgenTV's own apps that ask for a server, and the kind each one uses.
const OWN: Record<string, Kind[]> = { "agentv.jellyfin": ["jellyfin"], "agentv.plex": ["plex"], "agentv.immich": ["immich"] };

// The servers an app can use: its own kind for AgenTV's own apps, and any
// media server for one your agent made.
export function kindsFor(app: string): Kind[] {
  return OWN[app] ?? SERVERS;
}

// The kind of server one of AgenTV's own apps asks for, before it's
// installed: setup's server page opens for these.
export function serverKinds(app: string): Kind[] | null {
  return OWN[app] ?? null;
}

// One stream of the box's events for every list on the page. A browser
// keeps only six connections to the box open at once, and a list holding a
// stream of its own used them up, so the page's own requests had to wait.
type Heard = "discover" | "discover-pick";
const hearers: Record<Heard, Set<(data: unknown) => void>> = { discover: new Set(), "discover-pick": new Set() };
let stream: EventSource | null = null;

function hear(event: Heard, heard: (data: unknown) => void): () => void {
  if (!stream) {
    stream = new EventSource("/api/events");
    for (const name of Object.keys(hearers) as Heard[]) {
      stream.addEventListener(name, (message) => {
        const data = JSON.parse((message as MessageEvent).data) as unknown;
        for (const one of [...hearers[name]]) one(data);
      });
    }
  }
  hearers[event].add(heard);
  return () => {
    hearers[event].delete(heard);
    if (stream && !hearers.discover.size && !hearers["discover-pick"].size) {
      stream.close();
      stream = null;
    }
  };
}

// The list the TV shows, for the phone's line (daemon/discover.ts). It's
// said when the list is on the page, again every 20 s while it stays, and
// taken back once it's gone. Only the newest list on the page speaks, and
// only it hears the phone's picks.
let speaking: object | null = null;

function say(list: object): void {
  void fetch("/api/discover/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) }).catch(() => {});
}

function onTv(el: HTMLElement, list: object, picked: (key: string) => void): void {
  const me = {};
  const unhear = hear("discover-pick", (data) => {
    if (speaking === me && el.isConnected) picked((data as { key: string }).key);
  });
  let on = false;
  let off = 0;
  let beat = 0;
  const check = () => {
    if (el.isConnected) {
      off = 0;
      // On the page, or back on it, or the list that spoke is gone: this is
      // the one the TV shows. Two on one page don't take turns.
      if (!on || speaking === null || (speaking === me && ++beat % 20 === 0)) {
        on = true;
        speaking = me;
        say(list);
      }
      return;
    }
    if (on && speaking === me) {
      speaking = null;
      say({});
    }
    on = false;
    // Gone from the page for a minute, or never on it: it stops listening.
    if (++off > 60) {
      clearInterval(timer);
      unhear();
    }
  };
  const timer = setInterval(check, 1000);
  requestAnimationFrame(check);
}

// A row picked from the phone: the TV picks it, focus on it first, as OK
// on it would.
function pickRow(rows: HTMLElement, attribute: string, key: string, focus: Pick<Focus, "set">): void {
  const row = rows.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(key)}"]`);
  if (!row) return;
  focus.set(row, false);
  row.click();
}

async function ask<T>(path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as Answer<T>;
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Couldn't search your network");
  return data;
}

// Where a find answers, as its row says it: the address's host, with its
// port when it isn't the usual one, or the machine's name for a drive.
export function addressOf(found: Pick<Found, "url" | "host">): string {
  try {
    return new URL(found.url).host || found.host;
  } catch {
    return found.host;
  }
}

// A row of the list: a server's letter in its colour, as setup's apps step
// draws the apps, then "{name} · {address}". The address keeps its own
// letters in every look, and so does a folder's name. A folder has no letter
// and no address, and says what kind it is on the right when that matters.
function row(face: Kind | null, name: string, address: string, value: string, data: Record<string, string>, pick: () => void): HTMLElement {
  const letter = face ? h("span", { class: `avatar avatar-${FACES[face][1]}`, "aria-hidden": "true" }, FACES[face][0]) : null;
  const words = face ? h("b", {}, name) : h("b", { "data-own-case": true }, name);
  const where = address ? h("span", { class: "found-address" }, " · ", asWritten(address)) : null;
  return h("button", { class: "button", "data-focus": true, ...data, onclick: pick }, h("span", { class: "profile-who" }, letter, h("span", { class: "found-name" }, words, where)), value ? h("span", { class: "button-value" }, value) : null);
}

export interface ListOptions {
  kinds: Kind[];
  focus: Pick<Focus, "get" | "set">;
  pick(found: Found): void;
  // One row a machine, for the network drives, rather than one a server.
  machines?: boolean;
  // The row after the list, which has the focus until something's found.
  typed: HTMLElement;
}

// The list, filling as the box hears from the network, for as long as it's
// on the page.
export function foundList(options: ListOptions): { el: HTMLElement; rows: HTMLElement } {
  const rows = h("div", { class: "found-rows profile-form" });
  const looking = h("div", { class: "panel-note found-looking" }, "Looking…");
  const el = h("div", { class: "found-list" }, rows, looking);
  let unhear: (() => void) | null = null;
  // How many times the stream spoke: an answer asked for before the last
  // time is older than what it said, and is left out.
  let spoke = 0;
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
    const items = options.machines ? machines(found) : found.map((one) => ({ key: `${one.kind} ${one.url}`, face: one.kind, name: one.name, value: addressOf(one), found: one }));
    looking.textContent = answer.looking ? "Looking…" : items.length ? "" : "Nothing found on your network";
    const key = items.map((item) => `${item.key} ${item.name} ${item.value}`).join("|");
    if (key === shown) return;
    shown = key;
    const had = options.focus.get();
    const index = had ? [...rows.children].indexOf(had) : -1;
    rows.replaceChildren(...items.map((item) => row(item.face, item.name, item.value, "", { "data-found": item.key }, () => options.pick(item.found))));
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
    const at = spoke;
    void ask<never>(`/api/discover?kinds=${kinds}`).then(
      (answer) => spoke === at && draw(answer),
      (error: Error) => (looking.textContent = error.message),
    );
  };
  const stop = () => {
    unhear?.();
    unhear = null;
    clearInterval(timer);
  };
  unhear = hear("discover", (data) => {
    if (gone()) return stop();
    spoke++;
    draw(data as { found: Found[]; looking: boolean });
  });
  const timer = setInterval(again, AGAIN_MS);
  for (const at of [400, 900, SETTLE_MS]) setTimeout(settle, at);
  again();
  onTv(el, { kinds, machines: Boolean(options.machines) }, (key) => {
    if (key !== "typed") return pickRow(rows, "data-found", key, options.focus);
    options.focus.set(options.typed, false);
    options.typed.click();
  });
  return { el, rows };
}

// The network drives, one row a machine: its SMB name, or its NFS export's.
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
  // The folder picked, with the sign-in its address was listed with, which
  // the folder then keeps as Music's own do.
  pick(share: ShareFound, password?: string): void;
}

// A network drive's folders, and its sign-in, typed on the phone, when it
// lists them only for a user.
export function shareList(options: SharesOptions): { el: HTMLElement; signIn(): void; first(): HTMLElement | undefined } {
  const rows = h("div", { class: "found-rows profile-form" });
  const line = h("div", { class: "panel-note" }, "…");
  const user = h("input", { class: "music-search", "data-focus": true, "data-field": "user", type: "text", placeholder: "User name", "aria-label": "User name", autocomplete: "username", spellcheck: "false" }) as HTMLInputElement;
  const password = h("input", { class: "music-search", "data-focus": true, "data-field": "password", type: "password", placeholder: "Password", "aria-label": "Password", autocomplete: "current-password" }) as HTMLInputElement;
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "list", onclick: () => void list(true) }, "Show folders");
  const form = h("div", { class: "share-form" }, user, password, go);
  shown(form, false);
  const el = h("div", { class: "found-list" }, rows, form, line);
  let signedIn: string | undefined;

  const signIn = () => {
    shown(form, true);
    line.replaceChildren("Sign in to see ", asWritten(options.host), "'s folders");
    options.focus.set(user.value ? password : user, false);
  };

  const list = async (withLogin = false) => {
    line.textContent = "…";
    let answer: Answer<ShareFound>;
    try {
      // The password leaves the page with the ask, and the folder keeps it.
      answer = withLogin ? await ask<ShareFound>("/api/discover/shares", { host: options.host, user: user.value.trim(), password: password.value }) : await ask<ShareFound>(`/api/discover/shares?host=${encodeURIComponent(options.host)}`);
    } catch (error) {
      line.textContent = (error as Error).message;
      return;
    }
    signedIn = withLogin ? password.value : undefined;
    password.value = "";
    const shares = answer.shares ?? [];
    rows.replaceChildren(...shares.map((share) => row(null, share.name, "", "", { "data-share": share.uri }, () => options.pick(share, signedIn))));
    if (answer.login && !withLogin) return signIn();
    shown(form, false);
    line.replaceChildren(...(shares.length ? [] : ["No network folders on ", asWritten(options.host)]));
    const first = rows.firstElementChild as HTMLElement | null;
    if (first) options.focus.set(first, false);
  };

  void list();
  onTv(el, { host: options.host }, (key) => pickRow(rows, "data-share", key, options.focus));
  return { el, signIn, first: () => (rows.firstElementChild as HTMLElement | null) ?? undefined };
}
