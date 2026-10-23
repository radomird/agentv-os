// Settings (ADR-015, ADR-024, ADR-031): sections on the left, the focused one
// on the right. Look and Sound work now, and so does Omarchy desktop; the
// sections later stages build say so.

import { screen } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// The times the ambient screen can wait, in minutes (ADR-031).
const IDLE = [5, 10, 15, 30, 60];

interface Section {
  key: string;
  label: string;
  value: () => string;
  panel: () => HTMLElement[];
}

function note(text: string): HTMLElement {
  return h("p", { class: "panel-note" }, text);
}

function soon(what: string): HTMLElement[] {
  return [h("div", { class: "panel-big" }, "coming soon"), note(what)];
}

export function settings(ctx: Ctx, open?: string): View {
  const s = ctx.state.settings;
  const save = async (change: Parameters<Ctx["saveSettings"]>[0], key: string, action: string) => {
    await ctx.saveSettings(change);
    ctx.sounds.play("confirm");
    ctx.render(`settings/${key}`, action);
  };
  const toggle = (label: string, on: boolean, action: string, change: () => Promise<void>) =>
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": action, onclick: change },
      h("span", {}, label),
      h("span", { class: "button-value" }, on ? "[x]" : "[ ]"),
    );

  const sections: Section[] = [
    {
      key: "home",
      label: "home",
      value: () => "edit home",
      panel: () => [
        h("div", { class: "panel-title" }, `${ctx.state.viewer.name}'s home`),
        h("div", { class: "panel-big" }, `${ctx.state.layout.length} tiles`),
        note("move, resize and unpin tiles. on home, e does the same."),
        h("button", { class: "button", "data-focus": true, "data-action": "edit", onclick: () => ctx.edit() }, "edit home →"),
      ],
    },
    {
      key: "apps",
      label: "apps",
      value: () => String(ctx.state.apps.length),
      panel: () => [
        h("div", { class: "panel-big" }, `${ctx.state.apps.length} on this tv`),
        h("button", { class: "button", "data-focus": true, "data-action": "apps", onclick: () => ctx.go("apps") }, "all apps →"),
      ],
    },
    {
      key: "look",
      label: "look",
      value: () => "omarchy theme",
      panel: () => [
        h("div", { class: "panel-title" }, "colours"),
        note("they come from your omarchy theme. change it on omarchy's desktop, and the tv follows."),
        toggle("reduce motion", s.reduceMotion, "motion", () => save({ reduceMotion: !s.reduceMotion }, "look", "motion")),
        h(
          "button",
          {
            class: "button",
            "data-focus": true,
            "data-action": "idle",
            "data-adjust": "idle",
            onclick: () => save({ idleMinutes: IDLE[(IDLE.indexOf(s.idleMinutes) + 1) % IDLE.length] }, "look", "idle"),
          },
          h("span", {}, "ambient screen after"),
          h("span", { class: "button-value" }, `${s.idleMinutes} min`),
        ),
        note("with nothing playing and no key pressed for that long. left and right change it."),
      ],
    },
    {
      key: "sound",
      label: "sound",
      value: () => (s.sound.on ? `on · ${Math.round(s.sound.volume * 100)}%` : "off"),
      panel: () => [
        toggle("ui sounds", s.sound.on, "sound", () => save({ sound: { ...s.sound, on: !s.sound.on } }, "sound", "sound")),
        h(
          "button",
          {
            class: "button",
            "data-focus": true,
            "data-action": "volume",
            "data-adjust": "volume",
            onclick: () => save({ sound: { ...s.sound, volume: s.sound.volume >= 1 ? 0.2 : Math.round((s.sound.volume + 0.2) * 10) / 10 } }, "sound", "volume"),
          },
          h("span", {}, "volume"),
          h("span", { class: "button-value" }, `${Math.round(s.sound.volume * 100)}%`),
        ),
        note("left and right change the volume."),
      ],
    },
    { key: "weather", label: "weather", value: () => "soon", panel: () => soon("the weather tile and its city come with the built-in apps.") },
    { key: "profiles", label: "profiles", value: () => ctx.state.viewer.name, panel: () => soon("profiles for everyone who watches, kids too, come with the phone app.") },
    { key: "parental", label: "parental", value: () => "soon", panel: () => soon("the pin comes with profiles.") },
    { key: "ai", label: "ai", value: () => "soon", panel: () => soon("connecting claude, chatgpt or gemini comes with tv setup.") },
    { key: "usage", label: "usage", value: () => "soon", panel: () => soon("ai spending shows here once the agent builds apps.") },
    {
      key: "updates",
      label: "updates",
      value: () => ctx.state.version,
      panel: () => [
        h("div", { class: "panel-title" }, "agentv"),
        h("div", { class: "panel-big" }, `${ctx.state.version} · ${ctx.state.channel}`),
        note("updating from here is coming soon. for now, run agentv update on the box."),
      ],
    },
    { key: "network", label: "network", value: () => "soon", panel: () => soon("wi-fi and the network come with tv setup.") },
    {
      key: "desktop",
      label: "omarchy desktop",
      value: () => "switch",
      panel: () => [
        h("div", { class: "panel-title" }, "omarchy's own desktop"),
        note("for looking after the box. back to tv is super + ctrl + home there."),
        h(
          "button",
          {
            class: "button primary",
            "data-focus": true,
            "data-action": "desktop",
            onclick: async () => {
              const reply = await screen.desktop();
              if (!reply.ok) ctx.toast(reply.error ?? "the desktop didn't start", "fail");
            },
          },
          "switch to omarchy's desktop",
        ),
      ],
    },
    {
      key: "about",
      label: "about",
      value: () => "credits",
      panel: () => [
        h("div", { class: "panel-big" }, `agentv ${ctx.state.version}`),
        note("the open-source tv os that writes its own app integrations. powered by omarchy."),
        note("omarchy is made by david heinemeier hansson and its contributors, under the mit licence."),
      ],
    },
  ];

  const panel = h("div", { class: "panel" });
  const show = (section: Section) => {
    panel.replaceChildren(...section.panel());
    for (const item of menu.children) item.classList.toggle("open", (item as HTMLElement).dataset.key === section.key);
  };
  const menu = h(
    "div",
    { class: "menu" },
    ...sections.map((section) =>
      h(
        "button",
        {
          class: "menu-item",
          "data-focus": true,
          "data-key": section.key,
          onclick: () => {
            show(section);
            const control = panel.querySelector<HTMLElement>("[data-focus]");
            if (control) ctx.focus.set(control);
          },
        },
        h("span", {}, section.label),
        h("span", { class: "menu-value" }, section.value()),
      ),
    ),
  );

  const start = sections.find((section) => section.key === open) ?? sections[0];
  show(start);
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page settings" }, h("div", {}, ...heading("tv settings", "settings."), menu), panel),
    bar(ctx, "settings"),
  );

  return {
    el,
    first: menu.querySelector<HTMLElement>(`[data-key="${start.key}"]`) ?? undefined,
    // The section with focus shows its panel. Left from a panel goes back to
    // its section; left and right on the volume change it.
    focused(target) {
      const key = target.dataset.key;
      const section = sections.find((s) => s.key === key);
      if (section) show(section);
    },
    act(action) {
      const current = ctx.focus.get();
      if (current?.dataset.adjust === "idle" && (action === "left" || action === "right")) {
        const at = Math.max(0, Math.min(IDLE.length - 1, IDLE.indexOf(s.idleMinutes) + (action === "right" ? 1 : -1)));
        void save({ idleMinutes: IDLE[at] }, "look", "idle");
        return true;
      }
      if (current?.dataset.adjust === "volume" && (action === "left" || action === "right")) {
        const volume = Math.max(0, Math.min(1, Math.round((s.sound.volume + (action === "right" ? 0.1 : -0.1)) * 10) / 10));
        void save({ sound: { ...s.sound, volume } }, "sound", "volume");
        return true;
      }
      if (action === "left" && current && panel.contains(current)) {
        const openItem = menu.querySelector<HTMLElement>(".open");
        if (openItem) ctx.focus.set(openItem);
        return true;
      }
      return false;
    },
  };
}
