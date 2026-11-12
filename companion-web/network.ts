// The phone's line "on your network", behind the discover switch. While the
// TV shows what the box found on the network (an app's setup, Music's
// sources, setup's server page or the background's shared folder), the
// phone lists it too: one row a find, as "living room · nas.local", and
// "type an address" under them. A NAS's folders list the same way.
//
// Tapping a row picks it on the TV, exactly as OK on the TV's own row would,
// so it goes where the TV's pick would. "Type an address" opens the TV's
// address field, and the phone's keyboard comes up for it by itself.

import { api, h, Unpaired } from "./lib.ts";

// The list on the TV, as the daemon says it (daemon/discover.ts).
export type TvList = { kinds: string[]; machines: boolean } | { host: string };

interface Found {
  kind: string;
  name: string;
  url: string;
  host: string;
}

interface Share {
  kind: string;
  name: string;
  uri: string;
}

interface Row {
  key: string;
  text: string;
}

// How often the phone asks again: often while the box is still looking,
// then as often as the TV does, which keeps the box looking.
const LOOKING_MS = 2_000;
const AGAIN_MS = 20_000;

// Which list the TV shows, as one string, so the remote redraws only when
// it changes.
export function listKey(list: TvList | null | undefined): string {
  return list ? JSON.stringify(list) : "";
}

// The NASes, one row a machine, as the TV draws them: its SMB name over its
// NFS export's.
function machines(found: Found[]): Row[] {
  const byHost = new Map<string, Found>();
  for (const one of found) {
    const known = byHost.get(one.host);
    if (!known || (known.kind === "nfs" && one.kind === "smb")) byHost.set(one.host, one);
  }
  return [...byHost.values()].map((one) => ({ key: `nas ${one.host}`, text: `${one.name} · ${one.host}` }));
}

// Where a server answers, as its row says it: the address in its link, so
// a server that answers from two addresses is two rows that read apart.
function address(one: Found): string {
  try {
    return new URL(one.url).host || one.host;
  } catch {
    return one.host;
  }
}

// The line for the list on the TV. It asks the box for what's in it for as
// long as it's on the phone's screen.
export function networkLine(list: TvList, failed: (error: unknown) => void): HTMLElement {
  const folders = "host" in list;
  const rows = h("div", { class: "r2-network-rows" });
  const status = h("span", { class: "r2-network-status" }, "Looking…");
  const el = h(
    "section",
    { class: "r2-network", "aria-label": folders ? `${list.host}'s folders` : "On your network" },
    h("div", { class: "r2-network-head" }, h("span", {}, folders ? list.host : "On your network"), status),
    rows,
    folders ? null : row("typed", "Type its address", "r2-network-typed"),
  );
  let shown = "";
  let placed = false;
  let timer = 0;

  function row(key: string, text: string, kind = ""): HTMLButtonElement {
    return h("button", { type: "button", class: `r2-network-row ${kind}`.trim(), "data-found": key, onclick: () => void pick(key) }, text);
  }

  async function pick(key: string): Promise<void> {
    try {
      const answer = await api<{ ok: boolean }>("POST", "/api/phone/discover/pick", { key });
      if (answer.ok && navigator.vibrate) navigator.vibrate(8);
    } catch (error) {
      failed(error);
    }
  }

  const draw = (items: Row[], line: string) => {
    status.textContent = line;
    const key = items.map((item) => `${item.key}|${item.text}`).join("\n");
    if (key === shown) return;
    shown = key;
    rows.replaceChildren(...items.map((item) => row(item.key, item.text)));
  };

  const ask = async (): Promise<number> => {
    if ("host" in list) {
      const answer = await api<{ shares?: Share[]; login?: boolean }>("GET", `/api/phone/discover/shares?host=${encodeURIComponent(list.host)}`);
      const shares = answer.shares ?? [];
      draw(
        shares.map((share) => ({ key: share.uri, text: share.name })),
        answer.login && !shares.length ? "Sign in to it on your TV" : shares.length ? "" : "No shared folders",
      );
      return AGAIN_MS;
    }
    const answer = await api<{ found?: Found[]; looking?: boolean }>("GET", `/api/phone/discover?kinds=${list.kinds.join(",")}`);
    const found = (answer.found ?? []).filter((one) => list.kinds.includes(one.kind));
    const items = list.machines ? machines(found) : found.map((one) => ({ key: `${one.kind} ${one.url}`, text: `${one.name} · ${address(one)}` }));
    draw(items, answer.looking ? "Looking…" : items.length ? "" : "Nothing found");
    return answer.looking ? LOOKING_MS : AGAIN_MS;
  };

  // Asks again while it's on the phone's screen, and stops once it's gone.
  const again = async () => {
    placed ||= el.isConnected;
    if (placed && !el.isConnected) return;
    let wait = AGAIN_MS;
    try {
      wait = await ask();
    } catch (error) {
      // Only a phone that isn't paired any more hears about it here.
      if (error instanceof Unpaired) return failed(error);
      status.textContent = (error as Error).message;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void again(), wait);
  };
  void again();
  return el;
}
