// Phones on the TV (stage 4): Settings, Phones and controllers has a row for
// each paired phone, which removes it, and pairing shows a QR code that takes
// a phone on the same network to the TV's phone companion, with a code to
// type instead. A code lasts 10 minutes and pairs one phone.

import { asWritten, h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

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

// Pairing and removing are an adult's: with a PIN set, they send its grant.
async function call<T>(method: string, path: string, grant?: string): Promise<T> {
  const response = await fetch(path, { method, headers: grant ? { "X-AgenTV-Grant": grant } : {} });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Something went wrong");
  return data as T;
}

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let phones: PhoneInfo[] | null = null;

export async function loadPhones(): Promise<PhoneInfo[]> {
  phones = (await call<{ phones: PhoneInfo[] }>("GET", "/api/phones")).phones;
  return phones;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// Settings' rows: one for each paired phone, which OK removes, and pairing
// another.
export function phoneRows(ctx: Ctx): HTMLElement[] {
  const parts: (HTMLElement | null)[] = [];
  const remove = async (phone: PhoneInfo) => {
    const grant = await ctx.grant("settings");
    if (grant === null) return;
    try {
      phones = (await call<{ phones: PhoneInfo[] }>("DELETE", `/api/phones/${phone.id}`, grant)).phones;
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`Removed ${phone.name}`, "ok");
    ctx.render("settings/phones", "pair");
  };
  parts.push(
    ...(phones ?? []).map((phone) =>
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": `phone-${phone.id}`, onclick: () => void remove(phone) },
        h("span", { class: "with-icon" }, glyph("phone", 32), h("span", {}, phone.name)),
        h("span", { class: "button-value" }, `Since ${day(phone.pairedAt)} · Remove`),
      ),
    ),
    phones && phones.length === 0 ? h("div", { class: "panel-row", "data-row": "no-phones" }, "No phones yet") : null,
    h(
      "button",
      { class: `button${phones?.length ? "" : " primary"}`, "data-focus": true, "data-action": "pair", onclick: () => void ctx.grant("settings").then((grant) => grant !== null && ctx.go("pair")) },
      h("span", { class: "with-icon" }, glyph("plus", 28), h("span", {}, "Pair a phone")),
    ),
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
    left.textContent = until ? (minutes > 0 ? `The code lasts ${minutes} more ${minutes === 1 ? "minute" : "minutes"}` : "This code expired. Go back and try again.") : "";
  };
  const timer = window.setInterval(tick, 5000);
  void call<{ pairing: Pairing }>("POST", "/api/phones/pair", ctx.held())
    .then(({ pairing }) => {
      code.textContent = pairing.code;
      until = Date.parse(pairing.until);
      tick();
      if (pairing.url) {
        const image = h("img", { src: `/api/phones/qr?at=${Date.now()}`, alt: "A QR code to pair a phone" });
        // No QR code without qrencode: the code to type still pairs.
        image.addEventListener("error", () => qr.classList.add("hidden"));
        qr.replaceChildren(image);
        // The address keeps its capitals in every look.
        where.replaceChildren("Scan it on the same Wi-Fi, or open ", asWritten(pairing.url.replace(/\?.*$/, "")), " and type the code");
      } else {
        where.textContent = "Connect this TV to a network first";
      }
    })
    .catch((error: Error) => (where.textContent = error.message));
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page pair" }, qr, h("div", { class: "pair-text" }, ...heading("tv phones pair", "Pair a phone"), where, code, left)),
    bar(ctx, "settings"),
  );
  return { el };
}
