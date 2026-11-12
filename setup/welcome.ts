// The welcome screen (board 02): "hi.", and a QR code for the phone. With
// the setup hotspot on, it's the hotspot's: the phone joins it, the captive
// page picks the home Wi-Fi, and the box joins that. Once the box is online,
// on that Wi-Fi or a cable, it's the code that pairs the phone. A phone that
// pairs moves setup on. Enter carries on with a keyboard instead: on to
// getting ready when the box is online, or first to the Wi-Fi it can see,
// with its password typed on the TV.
//
// With setup's own switch on (D3), it's "hi.", one line and the code, with
// no "use a keyboard instead": the phone is the way in. Enter still carries
// on the same way, for a household with only a keyboard.

import { asWritten, h } from "../launcher/dom.ts";
import { joinFields, networkRow, type Picked } from "../launcher/wifi-parts.ts";
import { setup, type SetupInfo } from "./api.ts";
import { heading, hi, prompt } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// What's going on, for the status bar.
function info(about: SetupInfo): string {
  const phone = about.phones.length ? `${about.phones[about.phones.length - 1]} paired` : "phone waiting";
  if (about.hotspot.on) return `Wi-Fi hotspot · ${phone}`;
  if (about.network.via === "ethernet") return `Cable · ${phone}`;
  if (about.network.via === "wi-fi") return `Wi-Fi ${about.network.name ?? ""} · ${phone}`.replace("  ", " ");
  return "No network yet";
}

// The welcome screen as D3 draws it, with setup's own switch on.
export const welcome2 = (ctx: Ctx): View => welcome(ctx, true);

export function welcome(ctx: Ctx, phase2 = false): View {
  const line = h("p", { class: "welcome-line" }, "Scan the code with your phone");
  const qr = h("img", { class: "qr", alt: "" }) as HTMLImageElement;
  const label = h("span", { class: "qr-label" });
  const frame = h(
    "div",
    { class: "qr-frame" },
    h("span", { class: "qr-corner tl" }),
    h("span", { class: "qr-corner tr" }),
    h("span", { class: "qr-corner bl" }),
    h("span", { class: "qr-corner br" }),
    h("span", { class: "qr-box" }, qr),
  );
  const right = h("div", { class: "welcome-qr away" }, frame, label);
  // The Enter key's cap, and what it does once a phone is paired. With no
  // phone yet, the line above says what Enter is for.
  const enter = h(
    "button",
    { class: "enter", "data-focus": true, "data-action": "enter", onclick: () => void carryOn() },
    h("span", { class: "key" }, "Enter"),
    ctx.info.phones.length ? h("span", {}, "Continue") : null,
  );
  const el = phase2
    ? h("div", { class: "setup-page welcome welcome2" }, h("div", { class: "welcome-left" }, hi(), line), right)
    : h("div", { class: "setup-page welcome" }, h("div", { class: "welcome-left" }, prompt("tv setup"), hi(), line, enter), right);

  let pairing: { code: string; until: number; url: string | null } | null = null;
  let paired: string | null = null;
  let stopped = false;
  let timer = 0;

  // The words under the code. A code, a network's name and its password keep
  // their capitals where the rest is drawn in lower case.
  const showQr = (src: string | null, ...text: (string | Node)[]) => {
    if (src) {
      if (qr.getAttribute("src") !== src) qr.setAttribute("src", src);
      right.classList.remove("away");
    } else {
      right.classList.add("away");
      qr.removeAttribute("src");
    }
    label.replaceChildren(...text);
  };

  // A code that pairs the phone, a new one shortly before it runs out.
  const pairCode = async () => {
    if (pairing && pairing.until > Date.now() + 5000) return pairing;
    const next = await setup.pair().catch(() => null);
    pairing = next ? { code: next.code, until: Date.parse(next.until), url: next.url } : null;
    return pairing;
  };

  async function draw(): Promise<void> {
    const about = await ctx.refresh().catch(() => ctx.info);
    if (stopped) return;
    // The ring follows the button when a longer line moves it.
    requestAnimationFrame(() => ctx.focus.refresh());
    ctx.status(info(about));
    const { hotspot, network } = about;
    if (paired) {
      line.textContent = `${paired} is paired`;
      showQr(null);
    } else if (hotspot.on && hotspot.ssid) {
      line.textContent = hotspot.error ? `${hotspot.error}. Scan the code to try again.` : "Scan the code with your phone";
      showQr(`/api/hotspot/qr?${encodeURIComponent(hotspot.ssid)}`, "Wi-Fi ", asWritten(hotspot.ssid), ...(hotspot.password ? [" · password ", asWritten(hotspot.password)] : []));
    } else if (hotspot.joining) {
      line.replaceChildren("Joining ", asWritten(hotspot.joining), "…");
      showQr(null);
    } else if (network.online) {
      const code = await pairCode();
      if (stopped) return;
      line.textContent = about.phones.length ? "Your phone is paired. Scan the code to pair another." : "Scan the code with your phone to pair it";
      showQr(code?.url ? `/api/phones/qr?${code.code}` : null, ...(code ? ["Code ", asWritten(code.code)] : []));
    } else {
      line.textContent = phase2 ? "Plug in a cable" : "Plug in a cable, or press Enter to pick Wi-Fi";
      showQr(null);
    }
  }

  // Enter: on with the keyboard once the box is online, or to the Wi-Fi it
  // can see first.
  async function carryOn(): Promise<void> {
    const { network, hotspot } = await ctx.refresh().catch(() => ctx.info);
    if (network.online) await ctx.finish("welcome", { keyboard: ctx.info.phones.length === 0 });
    else if (hotspot.on) ctx.open("welcome/wifi");
    else {
      ctx.toast("Plug in a cable first", "fail");
      ctx.sounds.play("failure");
    }
  }

  void draw();
  timer = window.setInterval(() => void draw(), 2000);

  return {
    el,
    first: phase2 ? undefined : enter,
    bright: true,
    info: info(ctx.info),
    // With setup's own switch on there's no button, and Enter carries on
    // all the same.
    act: phase2
      ? (action) => {
          if (action !== "ok") return false;
          void carryOn();
          return true;
        }
      : undefined,
    heard(event, data) {
      // A phone paired: it says so, and setup moves on.
      const name = event === "phones" ? (data as { paired?: string }).paired : undefined;
      if (!name || paired) return;
      paired = name;
      ctx.sounds.play("confirm");
      void draw();
      setTimeout(() => {
        if (!stopped) void ctx.finish("welcome", { keyboard: false });
      }, 1500);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// The Wi-Fi the box saw, picked and joined from the TV with a keyboard,
// for a household with no phone at hand. The list and the fields are the
// ones Settings, network uses (launcher/wifi-parts.ts).
export function wifi(ctx: Ctx): View {
  const list = h("div", { class: "networks" });
  const form = h("div", { class: "network-form hidden" });
  const el = h("div", { class: "setup-page" }, ...heading("tv setup · wifi", "Pick your Wi-Fi", ctx.reduced()), h("div", { class: "wifi" }, list, form));
  let picked: Picked | null = null;

  const join = async (ssid: string, password: string) => {
    try {
      await setup.wifi(ssid, password);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.back();
  };

  const pick = (network: Picked) => {
    picked = network;
    const { name, password, go } = joinFields(network, { name: "Network name", password: `Password for ${network.ssid || "the network"}`, join: "Join" }, (ssid, typed) => void join(ssid, typed));
    const parts: (HTMLElement | null)[] = [
      h("div", { class: "panel-title" }, network.hidden ? "Another network" : asWritten(network.ssid)),
      name ? h("label", { class: "field-label" }, "Name") : null,
      name,
      password ? h("label", { class: "field-label" }, "Password") : null,
      password,
      go,
    ];
    form.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
    form.classList.remove("hidden");
    ctx.focus.set(name ?? password ?? go);
  };

  const row = (network: Parameters<typeof networkRow>[0]) => networkRow(network, { other: "Another network", pick });

  void setup.networks().then(
    (networks) => {
      list.replaceChildren(...networks.map(row), row(null));
      if (!picked) ctx.focus.setRoot(el.closest(".screen") ?? el);
    },
    () => list.replaceChildren(row(null)),
  );

  return { el };
}
