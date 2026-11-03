// Share to the TV (ADR-050, S5.10): a link, a photo or a video, for who's
// watching. The TV asks first, with Open and Not now, and never over what's
// playing; until then it waits in Apps → Shared. A photo is drawn again
// first, as Share → TV's is (photo.ts), so nothing of its location or camera
// goes with it. A video goes as it is, with how far it's got.

import { glyph } from "../launcher/glyphs.ts";
import { draw, LONGEST } from "./photo.ts";
import { api, h, prompt, toast, token, Unpaired } from "./lib.ts";

interface Sent {
  ok: boolean;
  waits: boolean;
  error?: string;
}

// What the phone says once the TV has it.
function sent(what: string, waits: boolean): void {
  toast(waits ? `the tv has the ${what}. it'll ask once nothing's playing.` : `the tv is asking about the ${what} now.`, true);
}

// A file as it is, with how far it's got. fetch can't say that of what it
// sends, so this is an XMLHttpRequest.
function upload(path: string, type: string, body: Blob, progress: (fraction: number) => void): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.setRequestHeader("Content-Type", type);
    if (token()) request.setRequestHeader("Authorization", `Bearer ${token()}`);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      let data: Partial<Sent> = {};
      try {
        data = JSON.parse(request.responseText);
      } catch {}
      if (request.status === 401) reject(new Unpaired(data.error ?? "this phone isn't paired"));
      else if (request.status >= 400 || data.ok === false) reject(new Error(data.error ?? "the tv didn't take it"));
      else resolve(data as Sent);
    });
    request.addEventListener("error", () => reject(new Error("it didn't all go: try again")));
    request.send(body);
  });
}

export function sharePage(failed: (error: unknown) => void): HTMLElement {
  const oops = (error: unknown) => {
    if (error instanceof Unpaired) failed(error);
    else toast((error as Error).message);
  };

  // A link.
  const link = h("input", { class: "field", id: "share-link", type: "url", inputmode: "url", placeholder: "a link to a web page", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
  const sendLink = h("button", { type: "button", class: "button primary", "data-action": "share-link", disabled: true }, glyph("tv", 18), h("span", {}, "send the link")) as HTMLButtonElement;
  link.addEventListener("input", () => (sendLink.disabled = !link.value.trim()));
  sendLink.addEventListener("click", async () => {
    sendLink.disabled = true;
    try {
      const reply = await api<Sent>("POST", "/api/phone/share/link", { url: link.value.trim() });
      sent("link", reply.waits);
      link.value = "";
    } catch (error) {
      oops(error);
    } finally {
      sendLink.disabled = !link.value.trim();
    }
  });

  // A photo, with who took it.
  const photo = h("input", { type: "file", accept: "image/*", class: "photo-input", id: "share-photo" }) as HTMLInputElement;
  const preview = h("img", { class: "photo-preview hidden", alt: "the photo to send" }) as HTMLImageElement;
  const credit = h("input", { class: "field", id: "share-credit", type: "text", maxlength: "120", placeholder: "who took it, if you know", autocomplete: "off", autocapitalize: "off" }) as HTMLInputElement;
  const sendPhoto = h("button", { type: "button", class: "button primary", "data-action": "share-photo", disabled: true }, glyph("tv", 18), h("span", {}, "send the photo")) as HTMLButtonElement;
  let picked: File | null = null;
  photo.addEventListener("change", () => {
    picked = photo.files?.[0] ?? null;
    sendPhoto.disabled = !picked;
    if (!picked) return;
    void draw(picked, 640, "image/jpeg", 0.8).then(
      ({ url }) => {
        preview.src = url;
        preview.classList.remove("hidden");
      },
      (error) => toast((error as Error).message),
    );
  });
  sendPhoto.addEventListener("click", async () => {
    if (!picked) return;
    sendPhoto.disabled = true;
    try {
      const { blob } = await draw(picked, LONGEST, "image/jpeg", 0.9);
      const reply = await upload(`/api/phone/share/photo?credit=${encodeURIComponent(credit.value)}`, "image/jpeg", blob, () => {});
      sent("photo", reply.waits);
      picked = null;
      photo.value = "";
      credit.value = "";
      preview.classList.add("hidden");
    } catch (error) {
      oops(error);
    } finally {
      sendPhoto.disabled = !picked;
    }
  });

  // A video, as it is.
  const video = h("input", { type: "file", accept: "video/mp4,video/webm,video/quicktime", class: "photo-input", id: "share-video" }) as HTMLInputElement;
  const chosen = h("p", { class: "note hidden" });
  const sendVideo = h("button", { type: "button", class: "button primary", "data-action": "share-video", disabled: true }, glyph("tv", 18), h("span", {}, "send the video")) as HTMLButtonElement;
  let clip: File | null = null;
  video.addEventListener("change", () => {
    clip = video.files?.[0] ?? null;
    sendVideo.disabled = !clip;
    chosen.textContent = clip ? `${clip.name}, ${Math.max(1, Math.round(clip.size / 1024 / 1024))} mb` : "";
    chosen.classList.toggle("hidden", !clip);
  });
  sendVideo.addEventListener("click", async () => {
    if (!clip) return;
    const file = clip;
    sendVideo.disabled = true;
    try {
      const reply = await upload(`/api/phone/share/video?name=${encodeURIComponent(file.name)}`, file.type || "video/mp4", file, (fraction) => {
        chosen.textContent = `${file.name}: sending, ${Math.floor(fraction * 100)}%`;
      });
      sent("video", reply.waits);
      clip = null;
      video.value = "";
      chosen.classList.add("hidden");
    } catch (error) {
      oops(error);
      if (clip) chosen.textContent = `${clip.name}, ${Math.max(1, Math.round(clip.size / 1024 / 1024))} mb`;
    } finally {
      sendVideo.disabled = !clip;
    }
  });

  return h(
    "div",
    { class: "photo-page share-page" },
    prompt("share"),
    h("h1", {}, "share to the tv."),
    h("p", { class: "note" }, "the tv asks first, and never over what's playing. what you send stays in apps → shared."),
    h("h2", {}, "a link"),
    link,
    sendLink,
    h("h2", {}, "a photo"),
    h("label", { class: "button", for: "share-photo" }, glyph("photo", 18), h("span", {}, "choose a photo")),
    photo,
    preview,
    credit,
    sendPhoto,
    h("h2", {}, "a video"),
    h("label", { class: "button", for: "share-video" }, glyph("film", 18), h("span", {}, "choose a video")),
    video,
    chosen,
    sendVideo,
  );
}
