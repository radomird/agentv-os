// Share to the TV (ADR-050, S5.10): a link, a photo or a video, for who's
// watching. The TV asks first, with Open and Not now, and never over what's
// playing; until then it waits in Apps → Shared. A photo is drawn again
// first, as Share → TV's is (photo.ts), so nothing of its location or camera
// goes with it. A video goes as it is, with how far it's got.

import { glyph } from "../launcher/glyphs.ts";
import { draw, LONGEST } from "./photo.ts";
import { sign } from "./channel.ts";
import { api, h, prompt, toast, Unpaired } from "./lib.ts";

interface Sent {
  ok: boolean;
  waits: boolean;
  error?: string;
}

// What the phone says once the TV has it.
function sent(waits: boolean): void {
  toast(waits ? "Sent. Your TV asks when nothing's playing." : "Sent. Check your TV.", true);
}

// A file as it is, with how far it's got. fetch can't say that of what it
// sends, so this is an XMLHttpRequest.
//
// It's signed as every request is (channel.ts), with its length in place
// of its hash, and it goes as it is. The answer comes sealed.
async function upload(path: string, type: string, body: Blob, progress: (fraction: number) => void, again = true): Promise<Sent> {
  const signed = await sign("POST", path, { type, length: body.size });
  const answer = await new Promise<Partial<Sent> | null>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.responseType = "arraybuffer";
    for (const [name, value] of Object.entries(signed.headers)) request.setRequestHeader(name, value);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      try {
        const data = signed.answer(request.status, request.getResponseHeader("content-type") ?? "", new Uint8Array(request.response as ArrayBuffer)) as Partial<Sent> | null;
        if (data === null) resolve(null);
        else if (request.status === 401) reject(new Unpaired(data.error ?? "This phone isn't paired"));
        else if (request.status >= 400 || data.ok === false) reject(new Error(data.error ?? "Couldn't send it"));
        else resolve(data);
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener("error", () => reject(new Error("Only part was sent. Try again.")));
    request.send(body);
  });
  if (answer) return answer as Sent;
  // The box wanted a hello first: once more, with a new session.
  if (again) return upload(path, type, body, progress, false);
  throw new Error("Couldn't send it");
}

export function sharePage(failed: (error: unknown) => void): HTMLElement {
  const oops = (error: unknown) => {
    if (error instanceof Unpaired) failed(error);
    else toast((error as Error).message);
  };

  // A link.
  const link = h("input", { class: "field", id: "share-link", type: "url", inputmode: "url", placeholder: "A link to a web page", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
  const sendLink = h("button", { type: "button", class: "button primary", "data-action": "share-link", disabled: true }, glyph("tv", 18), h("span", {}, "Send the link")) as HTMLButtonElement;
  link.addEventListener("input", () => (sendLink.disabled = !link.value.trim()));
  sendLink.addEventListener("click", async () => {
    sendLink.disabled = true;
    try {
      const reply = await api<Sent>("POST", "/api/phone/share/link", { url: link.value.trim() });
      sent(reply.waits);
      link.value = "";
    } catch (error) {
      oops(error);
    } finally {
      sendLink.disabled = !link.value.trim();
    }
  });

  // A photo, with who took it.
  const photo = h("input", { type: "file", accept: "image/*", class: "photo-input", id: "share-photo" }) as HTMLInputElement;
  const preview = h("img", { class: "photo-preview hidden", alt: "The photo to send" }) as HTMLImageElement;
  const credit = h("input", { class: "field", id: "share-credit", type: "text", maxlength: "120", placeholder: "Photo credit (optional)", autocomplete: "off", autocapitalize: "off" }) as HTMLInputElement;
  const sendPhoto = h("button", { type: "button", class: "button primary", "data-action": "share-photo", disabled: true }, glyph("tv", 18), h("span", {}, "Send the photo")) as HTMLButtonElement;
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
      sent(reply.waits);
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
  const sendVideo = h("button", { type: "button", class: "button primary", "data-action": "share-video", disabled: true }, glyph("tv", 18), h("span", {}, "Send the video")) as HTMLButtonElement;
  let clip: File | null = null;
  video.addEventListener("change", () => {
    clip = video.files?.[0] ?? null;
    sendVideo.disabled = !clip;
    chosen.textContent = clip ? `${clip.name}, ${Math.max(1, Math.round(clip.size / 1024 / 1024))} MB` : "";
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
      sent(reply.waits);
      clip = null;
      video.value = "";
      chosen.classList.add("hidden");
    } catch (error) {
      oops(error);
      if (clip) chosen.textContent = `${clip.name}, ${Math.max(1, Math.round(clip.size / 1024 / 1024))} MB`;
    } finally {
      sendVideo.disabled = !clip;
    }
  });

  return h(
    "div",
    { class: "photo-page share-page" },
    prompt("tv send"),
    h("h1", {}, "Send to your TV"),
    h("p", { class: "note" }, "Your TV asks first, and never over what's playing"),
    h("h2", {}, "A link"),
    link,
    sendLink,
    h("h2", {}, "A photo"),
    h("label", { class: "button", for: "share-photo" }, glyph("photo", 18), h("span", {}, "Choose a photo")),
    photo,
    preview,
    credit,
    sendPhoto,
    h("h2", {}, "A video"),
    h("label", { class: "button", for: "share-video" }, glyph("film", 18), h("span", {}, "Choose a video")),
    video,
    chosen,
    sendVideo,
  );
}
