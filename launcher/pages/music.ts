// The built-in Music app (ADR-017): the albums and playlists in the box's
// folders, USB drives and NAS shares, a search, what's playing, and the
// sources. The library and the player live in the TV session (the screen
// daemon), as the person the box logs in, who can read those files; this
// page asks it for each.

import { screen } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

interface AlbumInfo {
  id: string;
  title: string;
  artist: string;
  year: string;
  cover: boolean | string | null; // a list says whether there is one; an album, its file
  tracks: string[];
}

interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  number: number;
  duration: number;
}

interface Result {
  kind: "album" | "track" | "playlist";
  id: string;
  title: string;
  subtitle: string;
}

interface Now {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  position: number;
  duration: number;
}

interface SourceInfo {
  id: string;
  kind: "folder" | "usb" | "share";
  name: string;
  available: boolean;
}

const covers = new Map<string, string | null>();

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// An album's cover, fetched once, or its first letters while it comes or
// when it has none.
function cover(id: string, title: string, has: boolean, big = false): HTMLElement {
  const el = h("span", { class: `album-cover${big ? " album-cover-big" : ""}` }, title.slice(0, 2).toLowerCase());
  const show = (data: string | null) => {
    if (data) el.replaceChildren(h("img", { src: data, alt: "" }));
  };
  if (!has) return el;
  if (covers.has(id)) show(covers.get(id) ?? null);
  else
    void screen.music("cover", { key: id }).then((reply) => {
      const data = typeof reply.cover === "string" ? reply.cover : null;
      covers.set(id, data);
      show(data);
    });
  return el;
}

async function play(ctx: Ctx, request: Record<string, unknown>): Promise<void> {
  const reply = await screen.music("play", request);
  if (reply.ok) ctx.sounds.play("confirm");
  else {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "that didn't play", "fail");
  }
}

// What's playing, along the top, with pause and next, kept fresh while the
// page is on the screen.
function nowPlaying(): HTMLElement {
  const text = h("span", { class: "now-text" }, "");
  const pause = h("button", { class: "button", "data-focus": true, "data-action": "pause", onclick: () => void screen.music("pause", {}).then(draw) }, "pause");
  const next = h("button", { class: "button", "data-focus": true, "data-action": "next", onclick: () => void screen.music("next", {}).then(draw) }, "next");
  const el = h("div", { class: "now-playing hidden" }, h("span", { class: "now-label" }, "now playing"), text, pause, next);
  async function draw(): Promise<void> {
    const reply = await screen.music("now", {});
    const now = reply.now as Now | null | undefined;
    el.classList.toggle("hidden", !now);
    if (!now) return;
    text.textContent = `${now.title.toLowerCase()} · ${now.artist.toLowerCase()} · ${minutes(now.position)} / ${minutes(now.duration)}`;
    pause.textContent = now.playing ? "pause" : "play";
  }
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else void draw();
  }, 2000);
  void draw();
  return el;
}

function albumTile(ctx: Ctx, album: AlbumInfo): HTMLElement {
  return h(
    "button",
    { class: "tile size-s album-tile", "data-focus": true, "data-album": album.id, "aria-label": album.title, onclick: () => ctx.go(`music/${album.id}`) },
    cover(album.id, album.title, album.cover),
    h("span", { class: "album-title" }, album.title.toLowerCase()),
    h("span", { class: "album-artist" }, album.artist.toLowerCase()),
  );
}

export function music(ctx: Ctx, album?: string): View {
  if (album === "sources") return sources(ctx);
  if (album) return albumPage(ctx, album);
  const results = h("div", { class: "row music-results" });
  const albums = h("div", { class: "row" }, h("div", { class: "empty" }, "…"));
  const playlists = h("div", { class: "row music-lists" });
  let typing: ReturnType<typeof setTimeout> | undefined;
  const search = h("input", {
    class: "music-search",
    "data-focus": true,
    type: "search",
    placeholder: "search music",
    "aria-label": "search music",
    autocomplete: "off",
    oninput: () => {
      clearTimeout(typing);
      typing = setTimeout(() => void find(), 250);
    },
  }) as HTMLInputElement;

  async function find(): Promise<void> {
    const q = search.value.trim();
    if (!q) {
      results.replaceChildren();
      return;
    }
    const reply = await screen.music("search", { q });
    const found = (reply.results as Result[] | undefined) ?? [];
    results.replaceChildren(
      ...(found.length
        ? found.map((result) =>
            h(
              "button",
              { class: "button music-result", "data-focus": true, onclick: () => void play(ctx, { kind: result.kind, key: result.id }) },
              h("span", {}, `${result.kind} · ${result.title.toLowerCase()}`),
              h("span", { class: "button-value" }, result.subtitle.toLowerCase()),
            ),
          )
        : [h("div", { class: "empty" }, `nothing matches ${q}`)]),
    );
  }

  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page music" },
      h(
        "div",
        { class: "page-head" },
        h("div", {}, ...heading("music", "music.")),
        h("button", { class: "button", "data-focus": true, "data-action": "sources", onclick: () => ctx.go("music/sources") }, "sources →"),
      ),
      nowPlaying(),
      search,
      results,
      h("div", { class: "section" }, "# albums"),
      albums,
      h("div", { class: "section playlists-head hidden" }, "# playlists"),
      playlists,
    ),
    bar(ctx, "music", "↵ open · type to search"),
  );

  void screen.music("library", {}).then((reply) => {
    if (!reply.ok) {
      albums.replaceChildren(h("div", { class: "empty" }, reply.error === "that works on the TV" ? "music plays on the TV" : (reply.error ?? "the library isn't there")));
      return;
    }
    const list = (reply.albums as AlbumInfo[] | undefined) ?? [];
    albums.replaceChildren(...(list.length ? list.map((item) => albumTile(ctx, item)) : [h("div", { class: "empty" }, "no music yet. add a folder, a usb drive or a share in sources")]));
    const lists = (reply.playlists as { id: string; name: string; tracks: string[] }[] | undefined) ?? [];
    el.querySelector(".playlists-head")?.classList.toggle("hidden", lists.length === 0);
    playlists.replaceChildren(
      ...lists.map((list) =>
        h(
          "button",
          { class: "button", "data-focus": true, onclick: () => void play(ctx, { kind: "playlist", key: list.id }) },
          h("span", {}, list.name.toLowerCase()),
          h("span", { class: "button-value" }, `${list.tracks.length} tracks`),
        ),
      ),
    );
  });

  return { el, first: search };
}

function albumPage(ctx: Ctx, id: string): View {
  const body = h("div", { class: "album-page" }, h("div", { class: "empty" }, "…"));
  const el = h("div", { class: "screen" }, h("div", { class: "page music" }, nowPlaying(), body), bar(ctx, "music", "↵ play · back to music"));
  let first: HTMLElement | undefined;
  void screen.music("album", { key: id }).then((reply) => {
    if (!reply.ok) {
      body.replaceChildren(h("div", { class: "empty" }, reply.error ?? "that album isn't there"));
      return;
    }
    const album = reply.album as AlbumInfo;
    const tracks = (reply.tracks as TrackInfo[]) ?? [];
    const playAll = h("button", { class: "button primary", "data-focus": true, "data-action": "play", onclick: () => void play(ctx, { kind: "album", key: id }) }, "↵ play the album");
    body.replaceChildren(
      h(
        "div",
        { class: "details-head" },
        cover(album.id, album.title, Boolean(album.cover), true),
        h(
          "div",
          {},
          h("div", { class: "prompt" }, h("b", {}, "~"), " $ music album"),
          h("h1", { class: "headline" }, album.title.toLowerCase()),
          h("div", { class: "maker" }, [album.artist.toLowerCase(), album.year, `${tracks.length} tracks`].filter(Boolean).join(" · ")),
        ),
      ),
      playAll,
      h(
        "div",
        { class: "tracks" },
        ...tracks.map((track, at) =>
          h(
            "button",
            { class: "button track", "data-focus": true, onclick: () => void play(ctx, { kind: "album", key: id, from: at }) },
            h("span", {}, `${String(track.number || at + 1).padStart(2, "0")}  ${track.title.toLowerCase()}`),
            h("span", { class: "button-value" }, minutes(track.duration)),
          ),
        ),
      ),
    );
    first = playAll;
    ctx.focus.setRoot(el, playAll);
  });
  return { el, first };
}

// Where the music comes from: folders, USB drives and shares, a new share,
// and reading them all again.
function sources(ctx: Ctx): View {
  const list = h("div", { class: "sources" }, h("div", { class: "empty" }, "…"));
  const address = h("input", { class: "music-search", "data-focus": true, type: "text", placeholder: "smb://nas/music or smb://you@nas/music", "aria-label": "a share's address", autocomplete: "off" }) as HTMLInputElement;
  // Only for a share with a user name in its address. It goes to the mount
  // once and isn't kept (ADR-032).
  const password = h("input", { class: "music-search", "data-focus": true, type: "password", placeholder: "its password, if it has a user name", "aria-label": "the share's password", autocomplete: "off" }) as HTMLInputElement;
  const add = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "add-share",
      onclick: async () => {
        const reply = await screen.music("add-share", { uri: address.value.trim(), ...(password.value ? { password: password.value } : {}) });
        password.value = "";
        if (reply.ok) {
          ctx.sounds.play("confirm");
          ctx.render("music/sources", "add-share");
        } else {
          ctx.sounds.play("failure");
          ctx.toast(reply.error ?? "that share didn't mount", "fail");
        }
      },
    },
    "add the share",
  );
  const scan = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "scan",
      onclick: async () => {
        ctx.toast("reading the music again");
        const reply = await screen.music("scan", {});
        ctx.toast(reply.ok ? `${reply.albums} albums, ${reply.tracks} tracks` : (reply.error ?? "that didn't work"), reply.ok ? "ok" : "fail");
      },
    },
    "read them all again",
  );
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page music" }, ...heading("music sources", "sources."), list, h("div", { class: "section" }, "# a nas share"), address, password, add, scan),
    bar(ctx, "music", "usb drives show up when they're plugged in"),
  );
  void screen.music("sources", {}).then((reply) => {
    const found = (reply.sources as SourceInfo[] | undefined) ?? [];
    list.replaceChildren(
      ...(found.length
        ? found.map((source) =>
            h(
              "div",
              { class: "source" },
              h("span", {}, `${source.kind === "usb" ? "usb" : source.kind} · ${source.name}`),
              h("span", { class: "button-value" }, source.available ? "ready" : source.kind === "usb" ? "plugged in" : "not there"),
            ),
          )
        : [h("div", { class: "empty" }, reply.ok ? "no folders, drives or shares yet" : "music plays on the TV")]),
    );
  });
  return { el, first: address };
}
