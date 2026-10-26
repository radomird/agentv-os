// Share → TV (ADR-012, S5.3): a photo from the phone becomes the TV's
// background, with a credit line the ambient screen shows. The phone draws
// it again first, no bigger than a 4K screen, so only the picture goes to
// the box: nothing of the file's location or camera data. A photo seen in
// another app, such as one on Unsplash, is saved to the phone and sent from
// here; the TV never browses those sites itself.

import { glyph } from "../launcher/glyphs.ts";
import { h, prompt, toast, token, Unpaired } from "./lib.ts";

const LONGEST = 3840;

async function draw(file: File, longest: number, type: string, quality: number): Promise<{ blob: Blob; url: string }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("that photo couldn't be read");
  });
  const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((made) => (made ? resolve(made) : reject(new Error("that photo couldn't be read"))), type, quality));
  return { blob, url: canvas.toDataURL(type, quality) };
}

export function photoPage(failed: (error: unknown) => void): HTMLElement {
  const input = h("input", { type: "file", accept: "image/*", class: "photo-input", id: "photo-file" }) as HTMLInputElement;
  const preview = h("img", { class: "photo-preview hidden", alt: "the photo to send" }) as HTMLImageElement;
  const credit = h("input", {
    class: "field",
    id: "photo-credit",
    type: "text",
    maxlength: "120",
    placeholder: "who took it, if you know",
    autocomplete: "off",
    autocapitalize: "off",
  }) as HTMLInputElement;
  const send = h("button", { type: "button", class: "button primary", "data-action": "send-photo", disabled: true }, glyph("tv", 18), h("span", {}, "send to the tv")) as HTMLButtonElement;
  let picked: File | null = null;

  input.addEventListener("change", () => {
    picked = input.files?.[0] ?? null;
    send.disabled = !picked;
    if (!picked) return;
    void draw(picked, 640, "image/jpeg", 0.8).then(
      ({ url }) => {
        preview.src = url;
        preview.classList.remove("hidden");
      },
      (error) => toast((error as Error).message),
    );
  });

  send.addEventListener("click", async () => {
    if (!picked) return;
    send.disabled = true;
    try {
      const { blob } = await draw(picked, LONGEST, "image/jpeg", 0.9);
      const response = await fetch(`/api/phone/background?credit=${encodeURIComponent(credit.value)}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Unpaired(data.error ?? "this phone isn't paired");
      if (!response.ok || data.ok === false) throw new Error(data.error ?? "the tv didn't take it");
      toast("it's the tv's background now.", true);
      picked = null;
      input.value = "";
      credit.value = "";
      preview.classList.add("hidden");
    } catch (error) {
      if (error instanceof Unpaired) failed(error);
      else toast((error as Error).message);
    } finally {
      send.disabled = !picked;
    }
  });

  return h(
    "div",
    { class: "photo-page" },
    prompt("tv background"),
    h("h1", {}, "send a photo."),
    h("p", { class: "note" }, "it becomes the tv's background, and the ambient screen says who took it."),
    h("label", { class: "button", for: "photo-file" }, glyph("photo", 18), h("span", {}, "choose a photo")),
    input,
    preview,
    credit,
    send,
  );
}
