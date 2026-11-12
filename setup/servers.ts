// What's on your network, in setup's apps step (design page D3, boards "9
// Apps · Jellyfin found on your network" and "9 Music · a NAS's folders"),
// behind the discover switch. Once the apps step hands its apps over, this
// page opens once for each app it handed over that asks for a server
// (Jellyfin, Plex, Immich), and for Music when the TV is for music.
//
// - An app's page lists the servers of its kind the box found. Picking one
//   gives the app its address, now or once it's installed
//   (daemon/server-picks.ts), so its tile is ready on home.
// - Music's lists the NASes, then the picked one's folders. The folder
//   picked is a music source, as it would be from Music → sources.
// - "Type an address on your phone" is the second choice, and "set it up
//   later" goes on. An app left for later says "set up" on its tile.

import { screen } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { discoverOn, foundList, NAS, serverKinds, shareList, type Found, type ShareFound } from "../launcher/pages/network.ts";
import { NEEDS_PIN } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

const MUSIC = "agentv.music";
const NAMES: Record<string, string> = { "agentv.jellyfin": "jellyfin", "agentv.plex": "plex", "agentv.immich": "immich", [MUSIC]: "music" };

// The apps still to go, the one on screen first.
let queue: string[] = [];

// From the apps step, once it's handed its apps over: true when this page
// opened, and the apps step leaves the rest to it.
export async function onNetwork(ctx: Ctx, handed: string[]): Promise<boolean> {
  if (!(await discoverOn())) return false;
  queue = handed.filter((id) => serverKinds(id));
  if (ctx.info.setup.goal === "music") queue.push(MUSIC);
  if (!queue.length) return false;
  ctx.open("apps/network");
  return true;
}

// The next app's page, or the next step after the last.
function next(ctx: Ctx): void {
  queue.shift();
  if (queue.length) ctx.open("apps/network");
  else void ctx.finish("apps");
}

async function pickServer(ctx: Ctx, app: string, url: string, called: string): Promise<boolean> {
  const name = NAMES[app] ?? app;
  type Answer = { ok?: boolean; error?: string; pin?: boolean } | null;
  const picked = await ctx
    .guarded(`setting up ${name}`, async (grant) => {
      const response = await fetch("/api/discover/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
        body: JSON.stringify({ app, url }),
      }).catch(() => null);
      const answer = (await response?.json().catch(() => null)) as Answer;
      if (response?.status === 403 && answer?.pin) throw new Error(NEEDS_PIN);
      return answer;
    })
    .catch((error: Error) => ({ value: { error: error.message } as Answer }));
  if (!picked) return false;
  const answer = picked.value;
  if (!answer?.ok) {
    ctx.sounds.play("failure");
    ctx.toast(answer?.error ?? "the tv couldn't keep that", "fail");
    return false;
  }
  ctx.sounds.play("confirm");
  ctx.toast(`${name} will use ${called.toLowerCase()}`, "ok");
  return true;
}

export function serverPage(ctx: Ctx): View {
  const app = queue[0];
  if (!app) {
    // Nothing left, as after the page was drawn again: on to the next step.
    void ctx.finish("apps");
    return { el: h("div", { class: "setup-page" }) };
  }
  return app === MUSIC ? musicPage(ctx) : appPage(ctx, app);
}

// The two rows under every list: an address typed on the phone, and later.
function choices(ctx: Ctx, typed: () => void): { typed: HTMLElement; later: HTMLElement } {
  return {
    typed: h("button", { class: "button found-typed", "data-focus": true, "data-action": "type-address", onclick: typed }, "type an address on your phone"),
    later: h("button", { class: "button", "data-focus": true, "data-action": "later", onclick: () => next(ctx) }, "set it up later"),
  };
}

function appPage(ctx: Ctx, app: string): View {
  const name = NAMES[app] ?? app;
  const address = h("input", {
    class: "text-field",
    "data-focus": true,
    "data-field": "address",
    type: "url",
    placeholder: "http://192.168.1.20:8096",
    "aria-label": `your ${name} server's address`,
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const form = h("div", { class: "profile-form hidden" }, address);
  let busy = false;
  const use = async (url: string, called: string) => {
    if (busy) return;
    busy = true;
    const ok = await pickServer(ctx, app, url, called).finally(() => (busy = false));
    if (ok) next(ctx);
  };
  address.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    const typed = address.value.trim();
    if (!typed) return;
    const url = /^https?:\/\//i.test(typed) ? typed : `http://${typed}`;
    void use(url, typed);
  });
  const { typed, later } = choices(ctx, () => {
    form.classList.remove("hidden");
    ctx.focus.set(address, false);
  });
  const list = foundList({ kinds: serverKinds(app) ?? [], focus: ctx.focus, typed, pick: (server: Found) => void use(server.url, server.name) });
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(`agentv app setup ${name}`, `pick your ${name}.`, ctx.reduced())),
    h("div", { class: "found" }, h("span", { class: "field-label" }, "found on your network"), list.el, typed, form, later),
  );
  return { el, first: typed, info: "↑↓ move · ↵ pick" };
}

function musicPage(ctx: Ctx): View {
  const el = h("div", { class: "setup-page" });
  let nasHost: string | null = null;
  let adding = false;

  // A folder picked, from a NAS's list or typed: a music source now.
  const add = async (uri: string, called: string, password?: string, folders?: ReturnType<typeof shareList>): Promise<void> => {
    if (adding) return;
    adding = true;
    ctx.toast("mounting the share");
    const reply = await screen.music("add-share", { uri, ...(password ? { password } : {}) }).finally(() => (adding = false));
    if (reply.ok) {
      ctx.sounds.play("confirm");
      ctx.toast(`${called.toLowerCase()} is a music source now`, "ok");
      next(ctx);
      return;
    }
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "that share didn't mount", "fail");
    // A folder shown to a guest that wants a user name to open.
    if (/user name and password/.test(reply.error ?? "") && !password) folders?.signIn();
  };

  // The NASes on the network, and a share's address typed on the phone.
  const machines = () => {
    nasHost = null;
    const address = h("input", { class: "text-field", "data-focus": true, "data-field": "share", type: "url", placeholder: "smb://nas.local/music", "aria-label": "the share's address", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const password = h("input", { class: "text-field", "data-focus": true, "data-field": "password", type: "password", placeholder: "its password, if it has one", "aria-label": "the share's password", autocomplete: "current-password" }) as HTMLInputElement;
    const form = h("div", { class: "profile-form hidden" }, address, password);
    for (const field of [address, password]) {
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        // The password leaves the page as it's sent.
        const secret = password.value;
        password.value = "";
        const typed = address.value.trim();
        if (typed) void add(typed, typed.replace(/^[a-z]+:\/\//i, ""), secret || undefined);
      });
    }
    const { typed, later } = choices(ctx, () => {
      form.classList.remove("hidden");
      ctx.focus.set(address, false);
    });
    const list = foundList({ kinds: NAS, machines: true, focus: ctx.focus, typed, pick: (one) => folders(one.host) });
    el.replaceChildren(
      h("div", {}, ...heading("agentv music sources", "pick your nas.", ctx.reduced())),
      h("div", { class: "found" }, h("span", { class: "field-label" }, "found on your network"), list.el, typed, form, later),
    );
    return typed;
  };

  // A NAS's folders, after a sign-in typed on the phone if it wants one.
  const folders = (host: string) => {
    nasHost = host;
    const list: ReturnType<typeof shareList> = shareList({ host, focus: ctx.focus, pick: (share: ShareFound, password?: string) => void add(share.uri, share.name, password, list) });
    el.replaceChildren(
      h("div", {}, ...heading(`agentv music sources ${host}`, `${host}.`, ctx.reduced())),
      h("div", { class: "found" }, h("span", { class: "field-label" }, "pick the folder with your music"), list.el),
    );
    ctx.sounds.play("forward");
  };

  const first = machines();
  return {
    el,
    first,
    info: "↑↓ move · ↵ pick",
    // Back from a NAS's folders goes back to the NASes.
    back() {
      if (!nasHost) return false;
      ctx.focus.set(machines(), false);
      ctx.sounds.play("back");
      return true;
    },
  };
}
