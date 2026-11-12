// The built-in Music app (ADR-017): the albums and playlists in the TV's
// folders, USB drives and network folders, a search, what's playing, and
// where the music comes from. The library and the player live in the TV session (the screen
// daemon), as the person the box logs in, who can read those files; this
// page asks it for each.

import { ONLY_ON_TV, screen } from "../api.ts";
import { asWritten, h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { discoverOn, foundList, NAS, shareList, shown, type ShareFound } from "./network.ts";
import { bar, heading, section } from "./parts.ts";

interface AlbumInfo {
  id: string;
  title: string;
  artist: string;
  year: string;
  cover: boolean | string | null; // a list says whether there is one; an album, its file
  away?: boolean; // on a share or folder that isn't there now
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
  error?: string;
}

interface Progress {
  scanning: boolean;
  source: string | null;
  found: number;
  read: number;
  albums: number;
  finishedAt: string | null;
  error?: string;
}

// What a search result is, and where music comes from, in words.
const KINDS: Record<Result["kind"], string> = { album: "Album", track: "Song", playlist: "Playlist" };
const SOURCES: Record<SourceInfo["kind"], string> = { folder: "Folder", usb: "USB drive", share: "Network folder" };

// How far reading the music has got, in a line.
function progressLine(progress: Progress | undefined): string {
  if (!progress) return "";
  const count = (n: number) => n.toLocaleString("en-GB");
  if (progress.scanning) {
    const where = progress.source ? `Reading ${progress.source}` : "Looking for music";
    return `${where} · ${count(progress.read)} of ${count(progress.found)} files · ${count(progress.albums)} albums so far`;
  }
  if (progress.error) return "Stopped looking";
  return progress.finishedAt ? `${count(progress.read)} files · ${count(progress.albums)} albums` : "";
}

const covers = new Map<string, string | null>();

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// An album's cover, fetched once, or its first letters while it comes or
// when it has none.
function cover(id: string, title: string, has: boolean, big = false): HTMLElement {
  const el = h("span", { class: `album-cover${big ? " album-cover-big" : ""}` }, title.slice(0, 2));
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
    ctx.toast(reply.error ?? "Couldn't play that", "fail");
  }
}

// What's playing, along the top, with pause and next, kept fresh while the
// page is on the screen.
function nowPlaying(): HTMLElement {
  const text = h("span", { class: "now-text" }, "");
  const pause = h("button", { class: "button", "data-focus": true, "data-action": "pause", onclick: () => void screen.music("pause", {}).then(draw) }, "Pause");
  const next = h("button", { class: "button", "data-focus": true, "data-action": "next", onclick: () => void screen.music("next", {}).then(draw) }, "Next");
  const el = h("div", { class: "now-playing hidden" }, h("span", { class: "now-label" }, "Now playing"), text, pause, next);
  async function draw(): Promise<void> {
    const reply = await screen.music("now", {});
    const now = reply.now as Now | null | undefined;
    el.classList.toggle("hidden", !now);
    if (!now) return;
    text.textContent = `${now.title} · ${now.artist} · ${minutes(now.position)} / ${minutes(now.duration)}`;
    pause.textContent = now.playing ? "Pause" : "Play";
  }
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else void draw();
  }, 2000);
  void draw();
  return el;
}

// An album on a folder that isn't connected stays, dimmed, and says so.
function albumTile(ctx: Ctx, album: AlbumInfo): HTMLElement {
  return h(
    "button",
    { class: `tile size-s album-tile${album.away ? " away" : ""}`, "data-focus": true, "data-album": album.id, "aria-label": album.title, onclick: () => ctx.go(`music/${album.id}`) },
    cover(album.id, album.title, Boolean(album.cover)),
    h("span", { class: "album-title" }, album.title),
    h("span", { class: "album-artist" }, album.away ? `Offline · ${album.artist}` : album.artist),
  );
}

export function music(ctx: Ctx, album?: string): View {
  if (album === "sources") return sources(ctx);
  if (album?.startsWith("nas:")) return nas(ctx, album.slice(4));
  if (album) return albumPage(ctx, album);
  const results = h("div", { class: "row music-results" });
  const albums = h("div", { class: "row" }, h("div", { class: "empty" }, loadingMark()));
  const playlists = h("div", { class: "row music-lists" });
  let typing: ReturnType<typeof setTimeout> | undefined;
  const search = h("input", {
    class: "music-search",
    "data-focus": true,
    type: "search",
    placeholder: "Search music",
    "aria-label": "Search music",
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
      delete results.dataset.q;
      return;
    }
    const reply = await screen.music("search", { q });
    // A reply for what was typed before comes too late to show.
    if (q !== search.value.trim()) return;
    const found = (reply.results as Result[] | undefined) ?? [];
    results.dataset.q = q;
    results.replaceChildren(
      ...(found.length
        ? found.map((result) =>
            h(
              "button",
              { class: "button music-result", "data-focus": true, onclick: () => void play(ctx, { kind: result.kind, key: result.id }) },
              h("span", {}, `${KINDS[result.kind]} · ${result.title}`),
              h("span", { class: "button-value" }, result.subtitle),
            ),
          )
        : [h("div", { class: "empty" }, "No results for ", asWritten(q))]),
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
        h("div", {}, ...heading("music", "Music")),
        h("button", { class: "button", "data-focus": true, "data-action": "sources", onclick: () => ctx.go("music/sources") }, "Add music"),
      ),
      nowPlaying(),
      search,
      results,
      section("Albums"),
      albums,
      section("Playlists", "playlists-head hidden"),
      playlists,
    ),
    bar(ctx, "music"),
  );

  void screen.music("library", {}).then((reply) => {
    if (!reply.ok) {
      albums.replaceChildren(h("div", { class: "empty" }, reply.error === ONLY_ON_TV ? "Music plays on the TV" : (reply.error ?? "Couldn't open your music")));
      return;
    }
    const list = (reply.albums as AlbumInfo[] | undefined) ?? [];
    albums.replaceChildren(...(list.length ? list.map((item) => albumTile(ctx, item)) : [h("div", { class: "empty" }, "No music yet. Add a folder or a drive.")]));
    const lists = (reply.playlists as { id: string; name: string; tracks: string[] }[] | undefined) ?? [];
    el.querySelector(".playlists-head")?.classList.toggle("hidden", lists.length === 0);
    playlists.replaceChildren(
      ...lists.map((list) =>
        h(
          "button",
          { class: "button", "data-focus": true, onclick: () => void play(ctx, { kind: "playlist", key: list.id }) },
          h("span", {}, list.name),
          h("span", { class: "button-value" }, `${list.tracks.length} tracks`),
        ),
      ),
    );
  });

  return { el, first: search };
}

function albumPage(ctx: Ctx, id: string): View {
  const body = h("div", { class: "album-page" }, h("div", { class: "empty" }, loadingMark()));
  const el = h("div", { class: "screen" }, h("div", { class: "page music" }, nowPlaying(), body), bar(ctx, "music"));
  let first: HTMLElement | undefined;
  void screen.music("album", { key: id }).then((reply) => {
    if (!reply.ok) {
      body.replaceChildren(h("div", { class: "empty" }, reply.error ?? "Couldn't find that album"));
      return;
    }
    const album = reply.album as AlbumInfo;
    const tracks = (reply.tracks as TrackInfo[]) ?? [];
    const playAll = h("button", { class: "button primary", "data-focus": true, "data-action": "play", onclick: () => void play(ctx, { kind: "album", key: id }) }, "Play album");
    body.replaceChildren(
      h(
        "div",
        { class: "details-head" },
        cover(album.id, album.title, Boolean(album.cover), true),
        h(
          "div",
          {},
          h("div", { class: "prompt" }, h("b", {}, "~"), " $ music album"),
          h("h1", { class: "headline" }, album.title),
          h("div", { class: "maker" }, [album.artist, album.year, `${tracks.length} tracks`].filter(Boolean).join(" · ")),
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
            h("span", {}, `${String(track.number || at + 1).padStart(2, "0")}  ${track.title}`),
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

// A network drive the TV found (pages/network.ts): its folders, after a
// sign-in typed on the phone if it wants one. The one picked is added to the
// music, with the password kept where only root reads it, as for a folder
// typed in.
function nas(ctx: Ctx, host: string): View {
  let adding = false;
  const add = async (share: ShareFound, password?: string) => {
    if (adding) return;
    adding = true;
    ctx.toast("Connecting…");
    const reply = await screen.music("add-share", { uri: share.uri, ...(password ? { password } : {}) });
    adding = false;
    if (reply.ok) {
      ctx.sounds.play("confirm");
      ctx.toast(h("span", {}, "Added ", asWritten(share.name)), "ok");
      ctx.back();
      return;
    }
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "Couldn't open that folder", "fail");
    // A folder shown to a guest that wants a user name to open.
    if (/user name/i.test(reply.error ?? "") && !password) folders.signIn();
  };
  const folders = shareList({ host, focus: ctx.focus, pick: (share, password) => void add(share, password) });
  // The drive's own name keeps its letters in every look.
  const [prompt, headline] = heading("music add", host);
  headline.setAttribute("data-own-case", "");
  const el = h("div", { class: "screen" }, h("div", { class: "page music" }, prompt, headline, h("div", { class: "panel-note" }, "Pick the folder with your music"), folders.el), bar(ctx, "music"));
  return { el, first: folders.first() };
}

// Where the music comes from: folders, USB drives and network folders, a new
// network folder, and reading them all again.
function sources(ctx: Ctx): View {
  const list = h("div", { class: "sources" }, h("div", { class: "empty" }, loadingMark()));
  const progress = h("div", { class: "scan-progress" }, "");
  const address = h("input", { class: "music-search", "data-focus": true, type: "text", placeholder: "smb://nas/music or smb://you@nas/music", "aria-label": "Folder address", autocomplete: "off" }) as HTMLInputElement;
  // Only for a folder with a user name in its address. The TV keeps it where
  // only root can read it, mounts the share with it after every restart, and
  // never shows it again (ADR-038).
  const password = h("input", { class: "music-search", "data-focus": true, type: "password", placeholder: "Password, if it needs one", "aria-label": "Password", autocomplete: "off" }) as HTMLInputElement;
  const hint = h("div", { class: "hint" }, "Your TV saves this password. A read-only account is safest.");
  const add = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "add-share",
      onclick: async () => {
        // The password leaves the page as it's sent, not once the share
        // has mounted.
        const secret = password.value;
        password.value = "";
        ctx.toast("Connecting…");
        const reply = await screen.music("add-share", { uri: address.value.trim(), ...(secret ? { password: secret } : {}) });
        if (reply.ok) {
          ctx.sounds.play("confirm");
          ctx.render("music/sources", "add-share");
        } else {
          ctx.sounds.play("failure");
          ctx.toast(reply.error ?? "Couldn't open that folder", "fail");
        }
      },
    },
    "Add folder",
  );
  const scan = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "scan",
      onclick: async () => {
        const reply = await screen.music("scan", {});
        if (!reply.ok) ctx.toast(reply.error ?? "Something went wrong", "fail");
        progress.textContent = progressLine(reply.progress as Progress | undefined);
      },
    },
    "Rescan",
  );
  // With the discover switch on, the drives on the network come first, and
  // the folder's address typed on the phone second.
  const onNetwork = h("div", { class: "found" });
  shown(onNetwork, false);
  void discoverOn().then((on) => {
    if (!on) return;
    const found = foundList({ kinds: NAS, machines: true, focus: ctx.focus, typed: address, pick: (one) => ctx.go(`music/nas:${one.host}`) });
    onNetwork.replaceChildren(section("On your network"), found.el);
    shown(onNetwork, true);
  });
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page music" },
      ...heading("music add", "Your music"),
      list,
      progress,
      onNetwork,
      section("A network folder"),
      h("div", { class: "share-form" }, address, password),
      hint,
      h("div", { class: "share-actions" }, add, scan),
    ),
    bar(ctx, "music", "USB drives show up when they're plugged in"),
  );
  // The sources, and how far reading them has got, every 2 s while it reads.
  let wasScanning = false;
  const draw = async () => {
    const reply = await screen.music("sources", {});
    const found = (reply.sources as SourceInfo[] | undefined) ?? [];
    const now = reply.progress as Progress | undefined;
    progress.textContent = progressLine(now);
    list.replaceChildren(
      ...(found.length
        ? found.map((source) =>
            h(
              "div",
              { class: "source" },
              // A folder's or a drive's own name keeps its letters in every look.
              h("span", {}, `${SOURCES[source.kind]} · `, asWritten(source.name)),
              source.available || source.kind === "usb"
                ? h("span", { class: "button-value" }, source.available ? "Ready" : "Plugged in")
                : h("span", { class: `button-value ${source.error ? "problem" : "away"}` }, source.error ?? "Offline"),
            ),
          )
        : [h("div", { class: "empty" }, reply.ok ? "No folders or drives yet" : "Music plays on the TV")]),
    );
    wasScanning = Boolean(now?.scanning);
  };
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else if (wasScanning) void draw();
  }, 2000);
  // A scan started from here starts the polling too.
  scan.addEventListener("click", () => {
    wasScanning = true;
  });
  void draw();
  return { el, first: address };
}
