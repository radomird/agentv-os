// Settings (ADR-015, ADR-024, ADR-031): sections on the left, the focused one
// on the right. Look, Sound, Weather, Parental, Omarchy desktop and Power work
// now; the sections later stages build say so.

import { daemon, screen, type AudioState, type WeatherPlace } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { powerPanel } from "./power.ts";
import { profilesPanel } from "./profiles.ts";
import { release, updatesPanel } from "./updates.ts";

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

// The weather's city and units, kept between visits so the panel draws at
// once, and asked for again each time Settings opens.
let weather: WeatherPlace | null = null;

// The box's sound output and its volume (S2.19), the same way.
let audio: AudioState | null = null;

// The output playing and its volume, when the screen daemon says.
function playing(state: AudioState | null): { name: string; volume: number } | null {
  const output = state?.ok ? state.outputs?.find((o) => o.name === state.output) : undefined;
  return output && typeof state?.volume === "number" ? { name: output.description.toLowerCase(), volume: state.volume } : null;
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

  // Settings → Weather (ADR-015): another city from the tz database, or the
  // box's own, and the units.
  const saveWeather = async (change: Parameters<typeof daemon.saveWeather>[0], action: string) => {
    try {
      weather = await daemon.saveWeather(change, ctx.held());
      ctx.sounds.play("confirm");
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
    }
    ctx.render("settings/weather", action);
  };
  const stepCity = (by: number) => {
    if (!weather || weather.cities.length === 0) return;
    const at = weather.cities.findIndex((city) => city.zone === weather!.zone);
    const next = weather.cities[(at + by + weather.cities.length) % weather.cities.length];
    void saveWeather({ zone: next.zone }, "city");
  };
  const weatherPanel = (): HTMLElement[] => {
    if (!weather) return [h("div", { class: "panel-big" }, "…")];
    const w = weather;
    return [
      h("div", { class: "panel-title" }, "the forecast is for"),
      h("div", { class: "panel-big" }, w.name || "nowhere yet"),
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "city", "data-adjust": "city", onclick: () => stepCity(1) },
        h("span", {}, "city"),
        h("span", { class: "button-value" }, `‹ ${w.name || "none"} ›`),
      ),
      w.chosen
        ? h(
            "button",
            { class: "button", "data-focus": true, "data-action": "own-city", onclick: () => saveWeather({ zone: null }, "city") },
            "use the time zone's city",
          )
        : null,
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "units", onclick: () => saveWeather({ units: w.units === "c" ? "f" : "c" }, "units") },
        h("span", {}, "degrees"),
        h("span", { class: "button-value" }, w.units === "c" ? "°c" : "°f"),
      ),
      note("left and right pick another city. only its rough location goes to met norway."),
      note("weather data from met norway, under cc by 4.0."),
    ].filter((el): el is HTMLElement => el !== null);
  };

  // Settings → Sound's output and its volume (ADR-017, S2.19). The box plays
  // at full volume, so the TV's remote sets how loud it is; a level set here
  // is kept for that output.
  const saveAudio = async (change: Parameters<typeof screen.audio>[0], action: string) => {
    const reply = await screen.audio(change);
    if (reply.ok && reply.outputs) {
      audio = reply;
      ctx.sounds.play("confirm");
    } else {
      ctx.toast(reply.error ?? "the sound didn't change", "fail");
      ctx.sounds.play("failure");
    }
    ctx.render("settings/sound", action);
  };
  const stepOutput = (by: number) => {
    const outputs = audio?.outputs ?? [];
    if (outputs.length < 2) return;
    const at = outputs.findIndex((o) => o.name === audio?.output);
    void saveAudio({ output: outputs[(at + by + outputs.length) % outputs.length].name }, "output");
  };
  const stepVolume = (by: number) => {
    const now = playing(audio);
    if (!now) return;
    const volume = Math.max(0, Math.min(1, Math.round((now.volume + by) * 20) / 20));
    if (volume !== now.volume) void saveAudio({ volume }, "output-volume");
  };
  const outputRows = (): HTMLElement[] => {
    const now = playing(audio);
    if (!now) return [note(audio === null ? "…" : (audio.error ?? "there's no sound output on this box yet."))];
    return [
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "output", "data-adjust": "output", onclick: () => stepOutput(1) },
        h("span", {}, "output"),
        h("span", { class: "button-value" }, `‹ ${now.name} ›`),
      ),
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "output-volume", "data-adjust": "output-volume", onclick: () => stepVolume(0.05) },
        h("span", {}, "output volume"),
        h("span", { class: "button-value" }, `${Math.round(now.volume * 100)}%`),
      ),
      note("the box plays at full volume, so the tv's remote sets how loud it is. left and right change it here, for this output."),
    ];
  };

  // Settings → Parental (ADR-009, S4.5): the parent PIN, chosen twice on its
  // pad, changed or taken off past the one before, and the TV locked now.
  const pinSet = () => ctx.state.pin?.set === true;
  const choosePin = async () => {
    const grant = pinSet() ? await ctx.grant("changing the pin") : "";
    if (grant === null) return;
    let first = "";
    const chosen = await ctx.pad({
      command: "tv settings · pin",
      title: pinSet() ? "choose a new pin" : "set a parent pin",
      note: "4 digits, for settings, builds and the desktop.",
      submit: async (pin) => {
        first = pin;
        return null;
      },
    });
    if (!chosen) return;
    const again = await ctx.pad({
      command: "tv settings · pin",
      title: "the same pin again",
      note: "so a slip of the finger doesn't lock you out.",
      submit: async (pin) => {
        if (pin !== first) return "that's not the same pin";
        await daemon.setPin(pin, grant || undefined);
        return null;
      },
    });
    if (!again) return;
    ctx.toast(grant ? "the pin is changed" : "the pin is set", "ok");
    ctx.render("settings/parental", "set-pin");
  };
  const removePin = async () => {
    const grant = await ctx.grant("taking the pin off");
    if (grant === null) return;
    try {
      await daemon.removePin(grant);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("the pin is off", "ok");
    ctx.render("settings/parental", "set-pin");
  };
  const parentalPanel = (): HTMLElement[] =>
    pinSet()
      ? [
          h("div", { class: "panel-title" }, "the parent pin"),
          h("div", { class: "panel-big" }, "on"),
          note("it guards omarchy's desktop, power and updates. the tv locks after it starts and after it's been off."),
          h("button", { class: "button", "data-focus": true, "data-action": "set-pin", onclick: () => void choosePin() }, "change the pin →"),
          h(
            "button",
            {
              class: "button",
              "data-focus": true,
              "data-action": "lock",
              onclick: async () => {
                await daemon.lock().catch(() => {});
              },
            },
            "lock the tv now",
          ),
          h("button", { class: "button", "data-focus": true, "data-action": "remove-pin", onclick: () => void removePin() }, "take the pin off"),
        ]
      : [
          h("div", { class: "panel-title" }, "the parent pin"),
          h("div", { class: "panel-big" }, "off"),
          note("a pin guards omarchy's desktop, power and updates, and locks the tv after it starts and after it's been off. a kid's profile needs one."),
          h("button", { class: "button primary", "data-focus": true, "data-action": "set-pin", onclick: () => void choosePin() }, "set a pin →"),
        ];

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
      value: () => {
        const now = playing(audio);
        return `${now ? `${Math.round(now.volume * 100)}% · ` : ""}ui sounds ${s.sound.on ? "on" : "off"}`;
      },
      panel: () => [
        ...outputRows(),
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
          h("span", {}, "ui sounds volume"),
          h("span", { class: "button-value" }, `${Math.round(s.sound.volume * 100)}%`),
        ),
        note("left and right change how loud the ui sounds are."),
      ],
    },
    { key: "weather", label: "weather", value: () => weather?.name ?? "", panel: weatherPanel },
    { key: "profiles", label: "profiles", value: () => String(ctx.state.viewers.length), panel: () => profilesPanel(ctx) },
    { key: "parental", label: "parental", value: () => (pinSet() ? "[pin]" : "off"), panel: parentalPanel },
    { key: "ai", label: "ai", value: () => "soon", panel: () => soon("connecting claude, chatgpt or gemini comes with tv setup.") },
    { key: "usage", label: "usage", value: () => "soon", panel: () => soon("ai spending shows here once the agent builds apps.") },
    {
      key: "updates",
      label: "updates",
      value: () => (release(ctx.updates) ? `● ${release(ctx.updates)}` : ctx.state.version.replace(/\.r\d+\.g[0-9a-f]+$/, "")),
      panel: () => updatesPanel(ctx),
    },
    { key: "network", label: "network", value: () => "soon", panel: () => soon("wi-fi and the network come with tv setup.") },
    {
      key: "desktop",
      label: "omarchy desktop",
      value: () => (pinSet() ? "[pin]" : "switch"),
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
              const grant = await ctx.grant("omarchy's desktop");
              if (grant === null) return;
              const reply = await screen.desktop(grant);
              if (reply.pin) ctx.forgetGrant();
              if (!reply.ok) ctx.toast(reply.error ?? "the desktop didn't start", "fail");
            },
          },
          "switch to omarchy's desktop",
        ),
      ],
    },
    // Restart and Shut down (ADR-033): an adult's, so a kid's profile doesn't
    // see it.
    ...(ctx.state.viewer.role === "adult"
      ? [{ key: "power", label: "power", value: () => (pinSet() ? "[pin]" : "restart · shut down"), panel: () => powerPanel(ctx) }]
      : []),
    {
      key: "about",
      label: "about",
      value: () => "credits",
      panel: () => [
        h("div", { class: "panel-big" }, `agentv ${ctx.state.version}`),
        note("the world's first open-source agentic tv os. powered by omarchy."),
        note("omarchy is made by david heinemeier hansson and its contributors, under the mit licence."),
        note("weather data from met norway, under cc by 4.0."),
      ],
    },
  ];

  const panel = h("div", { class: "panel" });
  const show = (section: Section) => {
    ctx.remember(`settings/${section.key}`);
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
  void daemon
    .weather()
    .then((found) => {
      const changed = JSON.stringify(found) !== JSON.stringify(weather);
      weather = found;
      const item = menu.querySelector<HTMLElement>('[data-key="weather"] .menu-value');
      if (item) item.textContent = found.name;
      if (changed && menu.querySelector(".open")?.getAttribute("data-key") === "weather" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "weather")!);
      }
    })
    .catch(() => {});
  void screen
    .audio()
    .then((found) => {
      // Away from the TV, it says so; a TV with no outputs says that.
      const next = found.ok ? { ...found, outputs: found.outputs ?? [] } : found;
      const changed = JSON.stringify(next) !== JSON.stringify(audio);
      audio = next;
      const item = menu.querySelector<HTMLElement>('[data-key="sound"] .menu-value');
      if (item) item.textContent = sections.find((section) => section.key === "sound")!.value();
      if (changed && menu.querySelector(".open")?.getAttribute("data-key") === "sound" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "sound")!);
      }
    })
    .catch(() => {});
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
      if (current?.dataset.adjust === "city" && (action === "left" || action === "right")) {
        stepCity(action === "right" ? 1 : -1);
        return true;
      }
      if (current?.dataset.adjust === "output" && (action === "left" || action === "right")) {
        stepOutput(action === "right" ? 1 : -1);
        return true;
      }
      if (current?.dataset.adjust === "output-volume" && (action === "left" || action === "right")) {
        stepVolume(action === "right" ? 0.05 : -0.05);
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
