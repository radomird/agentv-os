// Phones on the TV (stage 4): Settings → Phones lists the paired phones and
// forgets one, and pairing shows a QR code that takes a phone on the same
// network to the box's phone companion, with a code to type instead. A code
// lasts 10 minutes and pairs one phone.

import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

export interface PhoneInfo {
  id: string;
  name: string;
  pairedAt: string;
  seenAt?: string;
}

interface Pairing {
  code: string;
  until: string;
  url: string | null;
}

async function call<T>(method: string, path: string): Promise<T> {
  const response = await fetch(path, { method });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `${method} ${path} failed`);
  return data as T;
}

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let phones: PhoneInfo[] | null = null;

export async function loadPhones(): Promise<PhoneInfo[]> {
  phones = (await call<{ phones: PhoneInfo[] }>("GET", "/api/phones")).phones;
  return phones;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }).toLowerCase();

export function phonesPanel(ctx: Ctx): HTMLElement[] {
  const parts: (HTMLElement | null)[] = [];
  const forget = async (phone: PhoneInfo) => {
    try {
      phones = (await call<{ phones: PhoneInfo[] }>("DELETE", `/api/phones/${phone.id}`)).phones;
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`${phone.name} is forgotten`, "ok");
    ctx.render("settings/phones", "pair");
  };
  parts.push(
    h("div", { class: "panel-title" }, "paired phones"),
    ...(phones ?? []).map((phone) =>
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": `phone-${phone.id}`, onclick: () => void forget(phone) },
        h("span", {}, phone.name),
        h("span", { class: "button-value" }, `since ${day(phone.pairedAt)} · forget`),
      ),
    ),
    phones && phones.length === 0 ? h("div", { class: "panel-big" }, "none yet") : null,
    h("button", { class: `button${phones?.length ? "" : " primary"}`, "data-focus": true, "data-action": "pair", onclick: () => ctx.go("pair") }, "pair a phone →"),
    h("p", { class: "panel-note" }, "a paired phone is a remote and a keyboard for the tv, on the same network."),
  );
  return parts.filter((el): el is HTMLElement => el !== null);
}

export function pairPage(ctx: Ctx): View {
  const code = h("div", { class: "pair-code" }, "······");
  const where = h("p", { class: "panel-note" }, "…");
  const qr = h("div", { class: "pair-qr" });
  const left = h("p", { class: "panel-note pair-left" }, "");
  let until = 0;
  const tick = () => {
    if (!el.isConnected) return clearInterval(timer);
    const minutes = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
    left.textContent = until ? (minutes > 0 ? `the code lasts ${minutes} more ${minutes === 1 ? "minute" : "minutes"}.` : "the code has run out. back, then pair again.") : "";
  };
  const timer = window.setInterval(tick, 5000);
  void call<{ pairing: Pairing }>("POST", "/api/phones/pair")
    .then(({ pairing }) => {
      code.textContent = pairing.code;
      until = Date.parse(pairing.until);
      tick();
      if (pairing.url) {
        const image = h("img", { src: `/api/phones/qr?at=${Date.now()}`, alt: "a qr code to pair a phone" });
        // No QR code without qrencode: the code to type still pairs.
        image.addEventListener("error", () => qr.classList.add("hidden"));
        qr.replaceChildren(image);
        where.textContent = `scan it with the phone's camera, on the same network as the tv. or open ${pairing.url.replace(/\?.*$/, "")} and type the code.`;
      } else {
        where.textContent = "the box isn't on a network yet, so a phone can't reach it.";
      }
    })
    .catch((error: Error) => (where.textContent = error.message));
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page pair" }, qr, h("div", { class: "pair-text" }, ...heading("tv phones pair", "pair a phone"), where, code, left)),
    bar(ctx, "settings", "esc back"),
  );
  return { el };
}
