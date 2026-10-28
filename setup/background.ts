// The background (board 13, ADR-012, ADR-048, S5.3, S5.8): the Omarchy
// theme's own backgrounds, the default, as on Omarchy's desktop, the theme's
// pixel field, the household's photos sent from a phone, a shared folder,
// art from museum archives, or art the TV's agent makes, which is coming
// soon. A photo sent from the phone, a folder picked or a work picked
// becomes the background at once, with its credit, which the ambient screen
// shows.

import { daemon, screen, shownCurrent, shownPictures, type Art, type Backgrounds } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { setup } from "./api.ts";
import { field, heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

interface Card {
  id: "theme" | "field" | "photos" | "folder" | "art" | "made";
  name: string;
  note: string;
  icon?: Glyph;
  soon?: string;
}

const CARDS: Card[] = [
  { id: "theme", name: "the theme's", note: "default", icon: "grid" },
  { id: "field", name: "pixel field", note: "in its colours" },
  { id: "photos", name: "your photos", note: "sent from your phone", icon: "photo" },
  { id: "folder", name: "shared folder", note: "nas or immich", icon: "grid" },
  { id: "art", name: "art", note: "museum archives", icon: "spark" },
  { id: "made", name: "made for you", note: "your agent will draw it", icon: "spark", soon: "your tv's agent will draw backgrounds soon" },
];

const empty = (): Backgrounds => ({ source: "theme", current: null, items: [] });

export async function background(ctx: Ctx): Promise<View> {
  let now = await daemon.backgrounds().catch(empty);
  const cards = CARDS.map((card) => {
    const shot = h("span", { class: "back-shot" });
    return h(
      "button",
      { class: `back${card.soon ? " soon" : ""}`, "data-focus": true, "data-background": card.id, onclick: () => void pick(card) },
      shot,
      h("span", { class: "look-text" }, h("span", { class: "look-name" }, card.name), h("span", { class: "look-note" }, card.soon && card.id !== "made" ? `${card.note} · soon` : card.note)),
    );
  });
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void ctx.finish("background") }, "↵ done");
  const line = h("span", { class: "setup-note" });

  const draw = () => {
    // The theme's own: the one Omarchy shows, or the pixel field for a
    // theme without any.
    const own = shownCurrent({ ...now, source: "theme" });
    for (const card of cards) {
      const id = card.dataset.background;
      card.classList.toggle("picked", id === now.source);
      const shot = card.querySelector<HTMLElement>(".back-shot")!;
      const kind = id === "photos" ? "photo" : id === "art" ? "art" : id === "folder" ? "folder" : null;
      const mine = now.items.filter((item) => item.kind === kind);
      const newest = mine.find((item) => item.id === now.current) ?? mine[0];
      if (id === "theme") {
        if (own && shot.querySelector("img")?.dataset.id !== own.id) shot.replaceChildren(h("img", { src: `/api/backgrounds/${own.id}`, alt: "", "data-id": own.id }));
        else if (!own && !shot.querySelector(".pixel-field")) shot.replaceChildren(field());
      } else if (id === "field" && !shot.firstChild) shot.append(field());
      else if (kind) shot.replaceChildren(newest ? h("img", { src: `/api/backgrounds/${newest.id}`, alt: "" }) : glyph(CARDS.find((c) => c.id === id)!.icon!, 72));
      else if (id !== "field" && !shot.firstChild) shot.append(glyph(CARDS.find((c) => c.id === id)!.icon!, 72));
    }
    const photos = now.items.filter((item) => item.kind === "photo").length;
    const shown = shownPictures(now);
    const theme = now.theme?.name?.replace(/[-_]+/g, " ");
    line.textContent =
      now.source === "theme"
        ? own
          ? `${theme}'s own, as on omarchy's desktop. it changes with the theme.`
          : `${theme ?? "this theme"} has no backgrounds of its own, so it's the pixel field for now.`
        : now.source === "art"
        ? (shown.find((item) => item.id === now.current)?.credit.text ?? "art from the archives.")
        : now.source === "folder"
          ? `${shown.length === 1 ? "1 picture" : `${shown.length} pictures`} from ${shown[0]?.credit.from ?? "a folder"}.`
          : photos
          ? `${photos === 1 ? "1 photo" : `${photos} photos`} from your phone. send more any time.`
          : "on your phone: the tv's page, then send a photo.";
  };

  const pick = async (card: Card) => {
    if (card.soon) {
      ctx.sounds.play("failure");
      ctx.toast(card.soon, "fail");
      return;
    }
    if (card.id === "photos" && !now.items.some((item) => item.kind === "photo")) {
      ctx.open("background/photos");
      return;
    }
    // The archives and the folders each time: there's always another to pick.
    if (card.id === "art" || card.id === "folder") {
      ctx.open(`background/${card.id}`);
      return;
    }
    try {
      now = await daemon.chooseBackground(card.id as Backgrounds["source"]);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    draw();
  };

  draw();
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv background", "pick a background.", ctx.reduced())), go),
    h("div", { class: "backs" }, ...cards),
    line,
  );
  return {
    el,
    first: cards.find((card) => card.dataset.background === now.source) ?? cards[0],
    info: "←→ move · ↵ pick",
    heard(event, data) {
      if (event !== "background") return;
      now = data as Backgrounds;
      draw();
    },
  };
}

// Your photos, before there are any: send one from the phone, which pairs
// from this code if none is paired yet. The first one to come is the
// background, and setup goes back to the choice.
export function photos(ctx: Ctx): View {
  const qr = h("img", { class: "qr", alt: "" }) as HTMLImageElement;
  const label = h("span", { class: "qr-label" });
  const paired = ctx.info.phones.length > 0;
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading("tv background --photos", "send a photo.", ctx.reduced())),
    h(
      "div",
      { class: "terms" },
      h(
        "div",
        { class: "terms-left" },
        h(
          "div",
          { class: "ready-list" },
          h("span", { class: `ready-row ${paired ? "mark-done" : "mark-now"}` }, h("span", {}, h("b", {}, paired ? "[x]" : "[>]"), paired ? ` paired · ${ctx.info.phones[ctx.info.phones.length - 1]}` : " pair your phone with the code")),
          h("span", { class: "ready-row mark-todo" }, h("span", {}, h("b", {}, "[ ]"), " on the phone: send a photo")),
        ),
        h("p", { class: "setup-note" }, "it becomes the background, and the ambient screen says who took it."),
      ),
      paired ? null : h("div", { class: "welcome-qr small" }, h("span", { class: "qr-box" }, qr), label),
    ),
  );
  if (!paired) {
    void setup.pair().then((code) => {
      if (code?.url) qr.setAttribute("src", `/api/phones/qr?${code.code}`);
      label.textContent = code ? `pair a phone · code ${code.code}` : "";
    });
  }
  let moved = false;
  return {
    el,
    info: "waiting for a photo · esc back",
    heard(event, data) {
      if (event !== "background" || moved || !(data as Backgrounds).items?.length) return;
      moved = true;
      ctx.sounds.play("confirm");
      ctx.toast("your photo is the background now", "ok");
      ctx.open("background", "back");
    },
  };
}

// Art from museum archives (ADR-012): The Met, the Art Institute of Chicago
// and Wikimedia Commons, searched through the daemon, which asks each
// archive's own API. A few words to start with, or your own, typed here or
// on the phone; OK on a work fetches it whole and makes it the background,
// with its credit.
const WORDS = ["landscape", "the sea", "flowers", "night", "mountains"];
const ARCHIVES: { id: Art["archive"]; name: string }[] = [
  { id: "met", name: "the met" },
  { id: "aic", name: "art institute of chicago" },
  { id: "commons", name: "wikimedia commons" },
];

export function art(ctx: Ctx): View {
  let archive: Art["archive"] = "met";
  let asked = 0;
  let picking = false;
  const tabs = ARCHIVES.map((one) =>
    h("button", { class: "chip archive", "data-focus": true, "data-archive": one.id, onclick: () => ((archive = one.id), void look()) }, one.name),
  );
  const words = h("input", {
    class: "text-field art-field",
    "data-focus": true,
    "data-action": "words",
    type: "search",
    value: WORDS[0],
    maxlength: "80",
    placeholder: "what to look for",
    "aria-label": "what to look for",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const chips = WORDS.map((word) => h("button", { class: "chip", "data-focus": true, "data-words": word, onclick: () => ((words.value = word), void look()) }, word));
  const works = h("div", { class: "works" });
  const line = h("span", { class: "setup-note" });

  const card = (work: Art) =>
    h(
      "button",
      { class: "work", "data-focus": true, "data-work": `${work.archive}/${work.id}`, onclick: () => void pick(work) },
      h("span", { class: "work-shot" }, h("img", { src: `/api/art/${work.archive}/${work.id}/thumb`, alt: "", loading: "lazy" })),
      h("span", { class: "look-text" }, h("span", { class: "look-name" }, work.title.toLowerCase()), h("span", { class: "look-note" }, [work.artist, work.date].filter(Boolean).join(", ").toLowerCase())),
    );

  const look = async () => {
    const at = ++asked;
    for (const tab of tabs) tab.classList.toggle("picked", tab.dataset.archive === archive);
    const name = ARCHIVES.find((one) => one.id === archive)!.name;
    line.textContent = `asking ${name}…`;
    let found: Art[];
    try {
      found = await daemon.searchArt(archive, words.value.trim() || WORDS[0]);
    } catch (error) {
      if (at !== asked) return;
      works.replaceChildren();
      line.textContent = (error as Error).message;
      return;
    }
    if (at !== asked) return;
    works.replaceChildren(...found.map(card));
    line.textContent = found.length ? `${found.length === 1 ? "1 work" : `${found.length} works`} from ${name}, free to show.` : `nothing from ${name} for that. try other words.`;
  };

  const pick = async (work: Art) => {
    if (picking) return;
    picking = true;
    line.textContent = `fetching ${work.title.toLowerCase()}…`;
    try {
      await daemon.pickArt(work.archive, work.id);
    } catch (error) {
      picking = false;
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      line.textContent = "";
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("it's the background now", "ok");
    ctx.open("background", "back");
  };

  void look();
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading("tv background --art", "pick a work.", ctx.reduced())),
    h("div", { class: "art-page" }, h("div", { class: "art-side" }, h("div", { class: "chips archives" }, ...tabs), words, h("div", { class: "chips" }, ...chips), line), works),
  );
  return {
    el,
    first: tabs[0],
    info: "↵ pick · esc back",
    act(action) {
      // Enter in the field looks.
      if (action !== "ok" || ctx.focus.get() !== words) return false;
      void look();
      return true;
    },
  };
}

// A folder, a USB drive or a NAS share (ADR-012, ADR-038): Music's sources,
// which the TV session reads. OK on one copies up to 60 of its pictures to
// the box as the background. A share can be added here too, as in Music →
// sources: its password is typed once and kept where only root can read it.
// Or an Immich album, through the link its owner shares it with, which the
// box doesn't keep.
interface FolderInfo {
  id: string;
  kind: "folder" | "usb" | "share";
  name: string;
  available: boolean;
  error?: string;
}

export function folder(ctx: Ctx): View {
  const list = h("div", { class: "chips archives" });
  const line = h("span", { class: "setup-note" }, "…");
  let copying = false;
  const address = h("input", {
    class: "text-field art-field",
    "data-focus": true,
    "data-action": "share",
    type: "text",
    placeholder: "smb://nas/photos or smb://you@nas/photos",
    "aria-label": "a share's address",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const password = h("input", {
    class: "text-field art-field",
    "data-focus": true,
    "data-action": "share-password",
    type: "password",
    placeholder: "its password, if it has a user name",
    "aria-label": "the share's password",
    autocomplete: "off",
  }) as HTMLInputElement;

  const link = h("input", {
    class: "text-field art-field",
    "data-focus": true,
    "data-action": "immich",
    type: "url",
    placeholder: "https://photos.example/share/…",
    "aria-label": "an immich album's shared link",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const album = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "use-album",
      onclick: async () => {
        if (copying) return;
        copying = true;
        line.textContent = "getting the album's photos…";
        try {
          const got = await daemon.immichAlbum(link.value.trim());
          ctx.sounds.play("confirm");
          ctx.toast(`photos from ${got.album.toLowerCase()} are the background now`, "ok");
          ctx.open("background", "back");
        } catch (error) {
          ctx.sounds.play("failure");
          ctx.toast((error as Error).message, "fail");
          line.textContent = "";
        } finally {
          copying = false;
        }
      },
    },
    "use the album",
  );

  const draw = async () => {
    const reply = await screen.music("sources", {});
    const found = ((reply.sources as FolderInfo[] | undefined) ?? []).filter((one) => one.available);
    list.replaceChildren(
      ...found.map((one) =>
        h("button", { class: "chip", "data-focus": true, "data-folder": one.id, onclick: () => void copy(one) }, `${one.kind === "folder" ? "folder" : one.kind} · ${one.name}`),
      ),
    );
    line.textContent = found.length ? "ok on one copies up to 60 of its pictures." : "no folders, drives or shares yet. add a share, or plug in a usb drive.";
    // The first source, rather than the share's field, once there's one.
    const first = list.querySelector<HTMLElement>("[data-folder]");
    if (first && ctx.focus.get() === address && !address.value) ctx.focus.set(first, false);
  };

  const copy = async (one: FolderInfo) => {
    if (copying) return;
    copying = true;
    line.textContent = `copying pictures from ${one.name}…`;
    const reply = await screen.backgroundFolder(one.id);
    copying = false;
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? `${one.name}'s pictures didn't come`, "fail");
      line.textContent = "";
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`pictures from ${one.name} are the background now`, "ok");
    ctx.open("background", "back");
  };

  const add = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "add-share",
      onclick: async () => {
        // The password leaves the page as it's sent.
        const secret = password.value;
        password.value = "";
        line.textContent = "mounting the share…";
        const reply = await screen.music("add-share", { uri: address.value.trim(), ...(secret ? { password: secret } : {}) });
        if (!reply.ok) {
          ctx.sounds.play("failure");
          ctx.toast(reply.error ?? "that share didn't mount", "fail");
          line.textContent = "";
          return;
        }
        ctx.sounds.play("confirm");
        address.value = "";
        await draw();
      },
    },
    "add the share",
  );

  void draw();
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading("tv background --folder", "pick a folder.", ctx.reduced())),
    h(
      "div",
      { class: "art-page" },
      h("div", { class: "art-side" }, list, line),
      h(
        "div",
        { class: "art-side" },
        h("span", { class: "field-label" }, "a nas share"),
        address,
        password,
        h("span", { class: "setup-note" }, "a read-only nas account is best."),
        add,
        h("span", { class: "field-label" }, "an immich album's shared link"),
        link,
        album,
      ),
    ),
  );
  return { el, first: address, info: "↵ pick · esc back" };
}
