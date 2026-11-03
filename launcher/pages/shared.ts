// Shared to the TV (ADR-050, S5.10): a link, a photo or a video a paired
// phone sent. The TV asks first, with Open and Not now, over home only and
// never over what's playing (main.ts). Open shows a photo full screen, with
// its credit and "make it the background" (ADR-012), plays a video in
// AgenTV's own player, and opens a link in the app that declares its site
// or in a browser page of its own, which the TV session does. Each one waits
// in Apps → Shared until someone takes it off.

import { daemon, screen, type Share, type SharedState } from "../api.ts";
import { h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

let state: SharedState | null = null;

export function shares(): Share[] {
  return state?.shares ?? [];
}

// The children's profiles that take shares.
export function sharesAllowed(): string[] {
  return state?.allowed ?? [];
}

export async function loadShared(): Promise<SharedState | null> {
  try {
    state = await daemon.shared();
  } catch {}
  return state;
}

// What it is, as its notice says it.
export function shareWhat(share: Share): string {
  if (share.kind === "link") return `a link: ${share.title}`;
  if (share.kind === "video") return `a video: ${share.title}`;
  return share.credit ? `a photo: ${share.credit}` : "a photo";
}

// A photo's line: its credit, and who sent it.
function photoLine(share: Share): string {
  return share.credit ? `${share.credit} · ${share.from}` : `photo · ${share.from}`;
}

// A photo or a video on its own page, a link through the TV session.
export async function openShare(ctx: Ctx, share: Share): Promise<void> {
  if (share.kind !== "link") {
    ctx.go(`shared/${share.id}`);
    return;
  }
  const reply = await screen.openShare(share.id);
  if (!reply.ok) ctx.toast(reply.error ?? `${share.title} didn't open`, "fail");
}

// The PIN is asked for only on a child's profile, as the daemon does.
async function childGrant(ctx: Ctx, what: string): Promise<string | undefined | null> {
  if (ctx.state.viewer.role !== "child") return undefined;
  const grant = await ctx.grant(what);
  return grant === null ? null : grant || undefined;
}

// Taken off the box, from its page or Apps → Shared.
export async function removeShare(ctx: Ctx, share: Share): Promise<boolean> {
  const grant = await childGrant(ctx, "taking a share off");
  if (grant === null) return false;
  try {
    await daemon.removeShare(share.id, grant);
  } catch (error) {
    if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return false;
  }
  await loadShared();
  ctx.sounds.play("confirm");
  ctx.toast(`${share.kind === "link" ? share.title : `the ${share.kind}`} is off the tv`, "ok");
  return true;
}

// Its tile in Apps → Shared: the photo itself, or what kind it is.
export function sharedTile(ctx: Ctx, share: Share): HTMLElement {
  const top =
    share.kind === "photo"
      ? h("img", { class: "tile-shared-photo", src: `/api/shared/${share.id}/file`, alt: "" })
      : h("span", { class: "tile-shared-kind" }, glyph(share.kind === "video" ? "film" : "tv", 72));
  return h(
    "button",
    { class: "tile size-s tile-shared", "data-focus": true, "data-share": share.id, "aria-label": `${share.from} sent ${shareWhat(share)}`, onclick: () => void openShare(ctx, share) },
    h("div", { class: "tile-top" }, top),
    h("span", { class: "tile-name" }, share.kind === "photo" ? (share.credit ?? "a photo") : share.title),
  );
}

function gone(ctx: Ctx): View {
  const el = h("div", { class: "screen" }, h("div", { class: "page" }, h("p", { class: "empty" }, "that share isn't here any more")), bar(ctx, "apps"));
  return { el };
}

// A photo full screen, with its credit, as the ambient screen shows one.
function photoView(ctx: Ctx, share: Share): View {
  const background = h(
    "button",
    {
      class: "button primary",
      "data-focus": true,
      "data-action": "shared-background",
      onclick: async () => {
        const grant = await childGrant(ctx, "a shared photo as the background");
        if (grant === null) return;
        try {
          await daemon.shareBackground(share.id, grant);
        } catch (error) {
          ctx.sounds.play("failure");
          ctx.toast((error as Error).message, "fail");
          return;
        }
        ctx.sounds.play("confirm");
        ctx.toast("it's the tv's background now", "ok");
      },
    },
    "make it the background",
  );
  const remove = h("button", { class: "button", "data-focus": true, "data-action": "shared-remove", onclick: async () => (await removeShare(ctx, share)) && ctx.back() }, "take it off");
  const el = h(
    "div",
    { class: "shared-full" },
    h("img", { class: "shared-picture", src: `/api/shared/${share.id}/file`, alt: share.credit ?? "a shared photo" }),
    h("div", { class: "shared-bar" }, h("span", { class: "shared-line" }, photoLine(share)), h("div", { class: "shared-buttons" }, background, remove)),
  );
  return { el, first: background };
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const rest = `${Math.floor((s % 3600) / 60)}`.padStart(hours ? 2 : 1, "0") + `:${`${s % 60}`.padStart(2, "0")}`;
  return hours ? `${hours}:${rest}` : rest;
}

// A video in AgenTV's own player: OK pauses and plays, left and right go
// back and on 10 s, and Back closes it.
function videoView(ctx: Ctx, share: Share): View {
  const video = h("video", { class: "shared-video", src: `/api/shared/${share.id}/file`, autoplay: true, playsinline: true }) as HTMLVideoElement;
  const time = h("span", { class: "shared-time" }, "0:00");
  const state = h("span", { class: "shared-state" }, "playing");
  const line = h("div", { class: "shared-bar shared-player" }, h("span", { class: "shared-line" }, `${share.title} · ${share.from}`), time, state);
  const draw = () => {
    time.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    state.textContent = video.ended ? "ended" : video.paused ? "paused" : "playing";
    line.classList.toggle("shown", video.paused);
  };
  for (const event of ["timeupdate", "play", "pause", "ended", "loadedmetadata"]) video.addEventListener(event, draw);
  video.addEventListener("error", () => {
    ctx.sounds.play("failure");
    state.textContent = "the tv can't play this video";
    line.classList.add("shown");
  });
  const el = h("div", { class: "shared-full" }, video, line);
  return {
    el,
    act(action) {
      if (action === "ok") {
        if (video.paused || video.ended) void video.play().catch(() => {});
        else video.pause();
        return true;
      }
      if (action === "left" || action === "right") {
        video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (action === "right" ? 10 : -10)));
        line.classList.add("shown");
        setTimeout(draw, 1500);
        return true;
      }
      return action === "up" || action === "down";
    },
  };
}

// A link: where it goes, and Open, which the TV session does.
function linkView(ctx: Ctx, share: Share): View {
  const open = h("button", { class: "button primary", "data-focus": true, "data-action": "shared-open", onclick: () => void openShare(ctx, share) }, "open →");
  const remove = h("button", { class: "button", "data-focus": true, "data-action": "shared-remove", onclick: async () => (await removeShare(ctx, share)) && ctx.back() }, "take it off");
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      ...heading(`shared from ${share.from}`, `${share.title}.`),
      h("p", { class: "shared-url" }, share.url ?? ""),
      h("div", { class: "shared-buttons" }, open, remove),
    ),
    bar(ctx, "apps", "↵ select · esc back"),
  );
  return { el, first: open };
}

export function sharedView(ctx: Ctx, id: string): View {
  const share = shares().find((one) => one.id === id);
  if (!share) return gone(ctx);
  if (share.kind === "photo") return photoView(ctx, share);
  if (share.kind === "video") return videoView(ctx, share);
  return linkView(ctx, share);
}
