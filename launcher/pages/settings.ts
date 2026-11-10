// Settings (ADR-015, ADR-024, ADR-031): sections on the left, the focused one
// on the right. Look, Sound, Weather, New this week, Adult PIN, Omarchy
// desktop and Power work now; the sections later stages build say so.

import { creditLine, daemon, screen, shownCurrent, type AudioState, type Backgrounds, type ThemePreview, type VoiceState, type WeatherPlace } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import { lookId, looksList, sizeId } from "../looks/looks.ts";
import { lookCards } from "../looks/preview.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { powerPanel } from "./power.ts";
import { aboutBox } from "./box.ts";
import { glyph } from "../glyphs.ts";
import { aiPanel, aiValue, setKeyState } from "./key.ts";
import { loadPhones, phones, phonesPanel } from "./phones.ts";
import { profilesPanel } from "./profiles.ts";
import { release, updatesPanel } from "./updates.ts";
import { BUILD_CAPS, changeBuilder, MONTH_CAPS, stepCap, usagePanel, usageValue } from "./usage.ts";
import { buildsState, loadBuilds } from "./build.ts";
import { countryPanel, countryValue, loadCountry } from "./country.ts";
import { desktopPasswordNote, loadDesktopPassword, needsPassword } from "./desktop-password.ts";
import { loadNews, newsPanel, newsValue } from "./tmdb.ts";
import { TMDB_LOGO, TMDB_NOTICE } from "../tmdb-logo.ts";
import { loadSizes, resolutionName, setOutput, setSize, SIZE_NAMES, sizes, stepped } from "../size.ts";
import { properUnits } from "../box-lines.ts";

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

// Settings → Sound's last line, which voice says the TV's answers, marked
// so it can change in place.
function voiceNote(text: string): HTMLElement {
  return h("p", { class: "panel-note", "data-note": "voice" }, text);
}

function soon(what: string): HTMLElement[] {
  return [h("div", { class: "panel-big" }, "coming soon"), note(what)];
}

// The weather's city and units, kept between visits so the panel draws at
// once, and asked for again each time Settings opens.
let weather: WeatherPlace | null = null;

// The box's sound output and its volume (S2.19), the same way.
let audio: AudioState | null = null;
// Which voice says the TV's answers (stage 8), the same way.
let voice: VoiceState | null = null;

// A TV with nothing to say its answers with: no voice of its own, and no
// key for a provider that has one. Its answers show on the TV, and Sound has
// no rows about a voice.
function noVoice(state: VoiceState | null): boolean {
  return state !== null && state.by === null;
}

// The voice, as Settings → Sound says it.
function voiceLine(state: VoiceState | null): string {
  if (!state) return "";
  if (!state.spoken) return "the tv shows its answers and doesn't say them.";
  if (state.by === "provider") return `the tv says its answers in ${state.provider}'s own voice.`;
  if (state.by === "own") return "the tv says its answers in its own voice.";
  // No voice at all: Sound has no rows for one, so there's nothing to say.
  return "";
}
// The backgrounds, for Settings → Themes and backgrounds, asked for again
// each time Settings opens.
let pictures: Backgrounds | null = null;

// What each background source is called on its row.
const SOURCE_WORDS: Record<Backgrounds["source"], string> = { theme: "the theme's", photos: "your photos", art: "art", folder: "a folder", field: "none" };

// The looks Settings → Look offers (board 12), and which one the TV has.
let looks: { themes: ThemePreview[]; current: string | null } | null = null;
let settingLook: string | null = null;
// The volume the last press asked for, until the screen daemon has set it,
// so presses quicker than its replies each go one step further.
let volumeTarget: number | null = null;

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
    if (!weather) return [h("div", { class: "panel-big" }, loadingMark())];
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
    volumeTarget = null;
    void saveAudio({ output: outputs[(at + by + outputs.length) % outputs.length].name }, "output");
  };
  const stepVolume = (by: number) => {
    const now = playing(audio);
    if (!now) return;
    const from = volumeTarget ?? now.volume;
    const volume = Math.max(0, Math.min(1, Math.round((from + by) * 20) / 20));
    if (volume === from) return;
    volumeTarget = volume;
    void saveAudio({ volume }, "output-volume").then(() => {
      if (volumeTarget === volume) volumeTarget = null;
    });
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

  // Settings → Adult PIN (ADR-009, S4.5): the adult PIN, chosen twice on its
  // pad, changed or taken off past the one before, and the TV locked now.
  const pinSet = () => ctx.state.pin?.set === true;
  const choosePin = async () => {
    const grant = pinSet() ? await ctx.grant("changing the pin") : "";
    if (grant === null) return;
    let first = "";
    const chosen = await ctx.pad({
      command: "tv settings · pin",
      title: pinSet() ? "choose a new pin" : "set an adult pin",
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
    ctx.render("settings/pin", "set-pin");
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
    ctx.render("settings/pin", "set-pin");
  };
  const pinPanel = (): HTMLElement[] =>
    pinSet()
      ? [
          h("div", { class: "panel-title" }, "the adult pin"),
          h("div", { class: "panel-big with-icon" }, glyph("lock", 72), h("span", {}, "on")),
          note("it guards omarchy's desktop, power and updates. a profile can ask for it to open, in settings → profiles."),
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
          h("div", { class: "panel-title" }, "the adult pin"),
          h("div", { class: "panel-big with-icon" }, glyph("lock", 72), h("span", {}, "off")),
          note("a pin guards omarchy's desktop, power and updates, and can lock a profile. a child's profile needs one."),
          h("button", { class: "button primary", "data-focus": true, "data-action": "set-pin", onclick: () => void choosePin() }, "set a pin →"),
        ];

  // Settings → Themes and backgrounds (ADR-063, D2), with the looks on:
  // the look, with a preview of each, the theme, the size, the background
  // and the ambient screen. It keeps Look's key, so a page that opens
  // settings/look lands here.
  const themesAndBackgrounds = (): Section => ({
    key: "look",
    label: "themes and backgrounds",
    value: () => looksList().find((look) => look.id === lookId())?.name ?? "",
    panel: () => {
      return [
        h("div", { class: "panel-title" }, "look"),
        h("div", { class: "look-cards" }, ...lookCards(looksList(), lookId(), sizeId(), 300, (look) => void pickLook(look.id), looks?.current)),
        h("div", { class: "panel-title" }, "theme"),
        lookList(),
        ...(looks?.themes ?? []).flatMap((look) => {
          const made = look.app ? buildsState()?.builds.find((b) => b.id === look.app && b.state === "installed") : undefined;
          return made ? [h("button", { class: "button wide", "data-focus": true, "data-action": `theme-made-${look.id}`, onclick: () => ctx.go(`build/${made.build}`) }, h("span", {}, `${look.name}, made by your agent`), h("span", { class: "button-value" }, "→"))] : [];
        }),
        ...(ctx.state.viewer.role === "adult" ? [h("button", { class: "button wide", "data-focus": true, "data-action": "theme-own", onclick: () => ctx.go("describe") }, h("span", {}, "describe your own"), h("span", { class: "button-value" }, "your agent makes it →"))] : []),
        // The TV's size (ADR-062), stepped with left and right, or OK for
        // the next one. With the sizes off, or a TV that offers one, it just
        // says which.
        sizeRow(),
        ...resolutionRow(),
        ...backgroundRows(),
        h(
          "button",
          { class: "button", "data-focus": true, "data-action": "idle", "data-adjust": "idle", onclick: () => save({ idleMinutes: IDLE[(IDLE.indexOf(s.idleMinutes) + 1) % IDLE.length] }, "look", "idle") },
          h("span", {}, "ambient screen after"),
          h("span", { class: "button-value" }, `${s.idleMinutes} min`),
        ),
        toggle("reduce motion", s.reduceMotion, "motion", () => save({ reduceMotion: !s.reduceMotion }, "look", "motion")),
      ];
    },
  });

  // The size row: a button that steps through the sizes this TV offers.
  let sizing = false;
  const sizeRow = (): HTMLElement => {
    const display = sizes();
    if (!display || display.sizes.length < 2) return h("div", { class: "panel-row", "data-row": "size" }, h("span", {}, "size"), h("span", { class: "button-value" }, SIZE_NAMES[display?.size ?? sizeId()]));
    return h(
      "button",
      { class: "button", "data-focus": true, "data-action": "size", "data-adjust": "size", onclick: () => void stepSize(1, true) },
      h("span", {}, "size"),
      h("span", { class: "button-value" }, sizing ? "…" : SIZE_NAMES[display.size]),
    );
  };
  // One size over. OK goes round from the last to the first; left and
  // right stop at the ends. Home follows on the display event.
  const stepSize = async (by: number, round = false) => {
    const display = sizes();
    if (!display || sizing) return;
    const next = round && !stepped(display, by) ? display.sizes[0] : stepped(display, by);
    if (!next) return;
    sizing = true;
    ctx.render("settings/look", "size");
    const set = await setSize(next, ctx.held());
    sizing = false;
    if (set.error) {
      ctx.sounds.play("failure");
      ctx.toast(set.error, "fail");
    } else ctx.sounds.play("confirm");
    if (menu.isConnected) ctx.render("settings/look", "size");
  };

  // The resolution row, on a TV with more than 1080p: its full resolution,
  // or 1080p output, which the TV scales up. OK and left and right switch.
  const resolutionRow = (): HTMLElement[] => {
    const display = sizes();
    if (!display?.full) return [];
    const units = lookId() === "glass" || lookId() === "cinema" ? properUnits : (text: string) => text;
    return [
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "resolution", "data-adjust": "resolution", onclick: () => void switchOutput() },
        h("span", {}, "resolution"),
        h("span", { class: "button-value" }, sizing ? "…" : units(resolutionName(display))),
      ),
    ];
  };
  const switchOutput = async () => {
    const display = sizes();
    if (!display?.full || sizing) return;
    sizing = true;
    ctx.render("settings/look", "resolution");
    const set = await setOutput(display.output === "1080p" ? "auto" : "1080p", ctx.held());
    sizing = false;
    if (set.error) {
      ctx.sounds.play("failure");
      ctx.toast(set.error, "fail");
    } else ctx.sounds.play("confirm");
    if (menu.isConnected) ctx.render("settings/look", "resolution");
  };

  // Picks a look: the TV hears it and draws itself again in it.
  const pickLook = async (id: string) => {
    if (id === lookId()) {
      ctx.sounds.play("confirm");
      return;
    }
    const grant = ctx.held();
    const response = await fetch("/api/look", { method: "PUT", headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify({ look: id }) }).catch(() => null);
    if (!response?.ok) {
      ctx.sounds.play("failure");
      ctx.toast("that look didn't set", "fail");
      return;
    }
    ctx.sounds.play("confirm");
  };

  // The background: a row that steps through the sources that have
  // pictures, the theme's own included, then each of the theme's own
  // pictures, so a photo from the phone is never the only way it can be.
  const backgroundRows = (): HTMLElement[] => {
    const shown = shownCurrent(pictures);
    const source = pictures?.source ?? "theme";
    return [
      h(
        "button",
        { class: "button", "data-focus": true, "data-action": "background", onclick: () => void nextBackground() },
        h("span", {}, "background"),
        h("span", { class: "button-value" }, source === "theme" ? (shown ? creditLine(shown) : "the theme's") : SOURCE_WORDS[source]),
      ),
      ...themePictures(),
    ];
  };

  // The theme's own pictures, each its own card, when it has more than one.
  // OK on one asks Omarchy to show it, as its desktop does, and makes the
  // theme's own the background.
  const themePictures = (): HTMLElement[] => {
    const items = pictures?.theme?.items ?? [];
    if (items.length < 2) return [];
    const current = pictures?.source === "theme" ? pictures.theme?.current : null;
    return [
      h(
        "div",
        { class: "theme-pictures", "data-scroll": true },
        ...items.map((item, i) =>
          h(
            "button",
            { class: `theme-picture${item.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `theme-picture-${item.id}`, "aria-label": `the theme's background ${i + 1}`, onclick: () => void pickThemePicture(item.id) },
            h("img", { src: `/api/backgrounds/${item.id}`, alt: "" }),
          ),
        ),
      ),
    ];
  };

  const pickThemePicture = async (id: string) => {
    const reply = await screen.setBackground(id);
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? "that background didn't change", "fail");
      return;
    }
    try {
      if (pictures?.source !== "theme") pictures = await daemon.chooseBackground("theme");
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    // Omarchy's own link has it now. The daemon hears it a moment later.
    if (pictures?.theme) pictures = { ...pictures, theme: { ...pictures.theme, current: id } };
    ctx.sounds.play("confirm");
    ctx.render("settings/look", `theme-picture-${id}`);
  };

  // The background, from the sources that have pictures, then none.
  const nextBackground = async () => {
    const order: Backgrounds["source"][] = ["theme", "photos", "art", "folder", "field"];
    const has = (source: Backgrounds["source"]) => source === "field" || (source === "theme" ? (pictures?.theme?.items.length ?? 0) > 0 : (pictures?.items ?? []).some((item) => item.kind === (source === "photos" ? "photo" : source)));
    const at = order.indexOf(pictures?.source ?? "theme");
    const next = [...order.slice(at + 1), ...order.slice(0, at + 1)].find(has) ?? "field";
    try {
      pictures = await daemon.chooseBackground(next);
      ctx.sounds.play("confirm");
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    }
    ctx.render("settings/look", "background");
  };

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
    lookId() ? themesAndBackgrounds() : {
      key: "look",
      label: "look",
      value: () => looks?.themes.find((look) => look.id === looks?.current)?.name ?? "omarchy theme",
      panel: () => [
        h("div", { class: "panel-title" }, "colours"),
        lookList(),
        // A theme your agent made: its page, where it can be removed.
        ...(looks?.themes ?? []).flatMap((look) => {
          const made = look.app ? buildsState()?.builds.find((b) => b.id === look.app && b.state === "installed") : undefined;
          return made ? [h("button", { class: "button wide", "data-focus": true, "data-action": `theme-made-${look.id}`, onclick: () => ctx.go(`build/${made.build}`) }, h("span", {}, `${look.name}, made by your agent`), h("span", { class: "button-value" }, "→"))] : [];
        }),
        // Look's last: a theme your agent makes from a few words (S6.4).
        ...(ctx.state.viewer.role === "adult" ? [h("button", { class: "button wide", "data-focus": true, "data-action": "theme-own", onclick: () => ctx.go("describe") }, h("span", {}, "describe your own"), h("span", { class: "button-value" }, "your agent makes it →"))] : []),
        ...backgroundRows(),
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
        note("the tv follows omarchy's theme, and the ambient screen comes on after that long with nothing playing."),
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
        // What the TV answers, said aloud (stage 8), and which voice says it.
        // A TV with no voice has neither row (ADR-087).
        ...(noVoice(voice) ? [] : [toggle("spoken answers", s.spoken, "spoken", () => save({ spoken: !s.spoken }, "sound", "spoken"))]),
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
        ...(voice && !noVoice(voice) ? [voiceNote(voiceLine({ ...voice, spoken: s.spoken }))] : []),
      ],
    },
    // The box's country (ADR-055): the time zone and new this week follow it.
    { key: "country", label: "country", value: countryValue, panel: () => countryPanel(ctx) },
    { key: "weather", label: "weather", value: () => weather?.name ?? "", panel: weatherPanel },
    // What came out this week on the household's services, from TMDB (S8.1).
    { key: "tmdb", label: "new this week", value: newsValue, panel: () => newsPanel(ctx) },
    { key: "profiles", label: "profiles", value: () => String(ctx.state.viewers.length), panel: () => profilesPanel(ctx) },
    { key: "phones", label: "phones", value: () => (phones ? String(phones.length) : ""), panel: () => phonesPanel(ctx) },
    { key: "pin", label: "adult pin", value: () => (pinSet() ? "on" : "off"), panel: pinPanel },
    { key: "ai", label: "ai", value: () => aiValue(ctx), panel: () => aiPanel(ctx) },
    { key: "usage", label: "usage", value: usageValue, panel: () => usagePanel(ctx) },
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
              // The first time, a password before it goes (with setup's
              // own switch on).
              if (needsPassword()) {
                ctx.go("desktop-password");
                return;
              }
              const grant = await ctx.grant("omarchy's desktop");
              if (grant === null) return;
              const reply = await screen.desktop(grant);
              if (reply.pin) ctx.forgetGrant();
              if (!reply.ok) ctx.toast(reply.error ?? "the desktop didn't start", "fail");
            },
          },
          "switch to omarchy's desktop",
        ),
        ...desktopPasswordNote(),
      ],
    },
    // Restart and Shut down (ADR-033): an adult's, so a child's profile doesn't
    // see it.
    ...(ctx.state.viewer.role === "adult"
      ? [{ key: "power", label: "power", value: () => (pinSet() ? "[pin]" : "restart · shut down"), panel: () => powerPanel(ctx) }]
      : []),
    {
      key: "about",
      label: "about",
      value: () => "credits",
      panel: () => [
        aboutBox(ctx),
        h("div", { class: "panel-big" }, `agentv ${ctx.state.version}`),
        note("the world's first open-source agentic tv os. powered by omarchy."),
        note("omarchy is made by david heinemeier hansson and its contributors, under the mit licence."),
        note("weather data from met norway, under cc by 4.0."),
        // TMDB's terms: its logo, less prominent than AgenTV's, and its
        // notice; JustWatch's: credit for where to watch.
        h("img", { class: "about-tmdb", src: TMDB_LOGO, alt: "tmdb" }),
        note(TMDB_NOTICE),
        note("where to watch is from justwatch, through tmdb."),
      ],
    },
  ];

  // A section longer than the screen, such as Look, scrolls with the focus.
  const panel = h("div", { class: "panel settings-panel", "data-scroll": true });
  panel.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });
  const show = (section: Section) => {
    ctx.remember(`settings/${section.key}`);
    panel.replaceChildren(...section.panel());
    for (const item of menu.children) item.classList.toggle("open", (item as HTMLElement).dataset.key === section.key);
  };
  const menu = h(
    "div",
    // With the looks, the list scrolls with the focus (ADR-063).
    { class: "menu", "data-scroll": lookId() ? true : undefined },
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
  // Which voice says the answers, against what this page drew: a Settings
  // drawn again while another one's ask waited has no voice line on it yet,
  // though the other ask already knew the voice.
  const voiceDrawn = JSON.stringify(voice);
  void daemon
    .voice()
    .then((found) => {
      const changed = JSON.stringify(found) !== voiceDrawn;
      voice = found;
      if (!changed || !menu.isConnected || menu.querySelector(".open")?.getAttribute("data-key") !== "sound") return;
      if (!panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "sound")!);
        return;
      }
      // With the focus on a control in the panel, drawing it again would
      // move the focus, so only the voice line changes, or comes last.
      const line = voiceLine({ ...found, spoken: s.spoken });
      const kept = panel.querySelector<HTMLElement>('[data-note="voice"]');
      if (noVoice(found)) kept?.remove();
      else if (kept) kept.textContent = line;
      else panel.append(voiceNote(line));
    })
    .catch(() => {});
  // The backgrounds, for the look section's background rows.
  {
    const drew = JSON.stringify(pictures);
    void daemon
      .backgrounds()
      .then((found) => {
        pictures = found;
        if (JSON.stringify(found) !== drew && menu.querySelector(".open")?.getAttribute("data-key") === "look" && !panel.contains(ctx.focus.get() ?? null)) {
          show(sections.find((section) => section.key === "look")!);
        }
      })
      .catch(() => {});
  }
  void loadCountry()
    .then(() => {
      const item = menu.querySelector<HTMLElement>('[data-key="country"] .menu-value');
      if (item) item.textContent = countryValue();
      if (menu.querySelector(".open")?.getAttribute("data-key") === "country" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "country")!);
      }
    })
    .catch(() => {});
  void loadNews()
    .then(() => {
      const item = menu.querySelector<HTMLElement>('[data-key="tmdb"] .menu-value');
      if (item) item.textContent = newsValue();
      if (menu.querySelector(".open")?.getAttribute("data-key") === "tmdb" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "tmdb")!);
      }
    })
    .catch(() => {});
  void loadDesktopPassword()
    .then(() => {
      if (menu.querySelector(".open")?.getAttribute("data-key") === "desktop" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "desktop")!);
      }
    })
    .catch(() => {});
  void loadPhones()
    .then(() => {
      const item = menu.querySelector<HTMLElement>('[data-key="phones"] .menu-value');
      if (item) item.textContent = String(phones?.length ?? "");
      if (menu.querySelector(".open")?.getAttribute("data-key") === "phones" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "phones")!);
      }
    })
    .catch(() => {});
  void daemon
    .key()
    .then((found) => {
      setKeyState({ set: found.set, provider: found.provider, plans: found.plans, ai: found.ai });
      const item = menu.querySelector<HTMLElement>('[data-key="ai"] .menu-value');
      if (item) item.textContent = aiValue(ctx);
      if (menu.querySelector(".open")?.getAttribute("data-key") === "ai" && !panel.contains(ctx.focus.get() ?? null)) {
        show(sections.find((section) => section.key === "ai")!);
      }
    })
    .catch(() => {});
  // Every theme Omarchy has (ADR-048), two to a row, each with its own
  // colours beside its name, in a list that scrolls with the focus. Declared
  // so it's there for a page drawn straight at Look, before this line runs.
  function lookList(): HTMLElement {
    const list = h(
      "div",
      { class: "look-list", "data-scroll": true },
      ...(looks?.themes ?? []).map((look) => {
        const swatch = h("span", { class: "look-swatch" });
        for (const colour of [look.colors.background, look.colors.accent, look.colors.selection, look.colors.foreground]) {
          const block = h("span", {});
          block.style.background = colour;
          swatch.append(block);
        }
        return h(
          "button",
          { class: "button look-item", "data-focus": true, "data-action": `theme-${look.id}`, onclick: () => void setLook(look) },
          swatch,
          h("span", { class: "look-item-name" }, look.name),
          h("span", { class: "button-value" }, settingLook === look.id ? "setting…" : look.id === looks?.current ? "■ on" : "□"),
        );
      }),
    );
    list.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });
    return list;
  }
  void loadBuilds(ctx).then(() => {
    const item = menu.querySelector<HTMLElement>('[data-key="usage"] .menu-value');
    if (item) item.textContent = usageValue();
    if (menu.querySelector(".open")?.getAttribute("data-key") === "usage" && !panel.contains(ctx.focus.get() ?? null)) {
      show(sections.find((section) => section.key === "usage")!);
    }
  });
  const setLook = async (look: ThemePreview) => {
    if (settingLook || look.id === looks?.current) return;
    settingLook = look.id;
    ctx.render("settings/look", `theme-${look.id}`);
    const reply = await screen.setTheme(look.id);
    settingLook = null;
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? `${look.name} didn't set`, "fail");
    } else {
      ctx.sounds.play("confirm");
      if (looks) looks = { ...looks, current: look.id };
    }
    // Still on Settings, after the few seconds Omarchy takes.
    if (menu.isConnected) ctx.render("settings/look", `theme-${look.id}`);
  };
  // The sizes this TV offers, against what this page drew.
  const sized = JSON.stringify(sizes());
  void loadSizes().then((found) => {
    if (JSON.stringify(found) === sized || !menu.isConnected || menu.querySelector(".open")?.getAttribute("data-key") !== "look") return;
    const at = ctx.focus.get() ?? null;
    if (!panel.contains(at)) show(sections.find((section) => section.key === "look")!);
    else ctx.render("settings/look", at?.getAttribute("data-action") ?? undefined);
  });
  // Against what this page drew, not what another Settings drawn since has
  // seen: a redraw while this one waited, such as for a build's news, mustn't
  // keep the list it started with.
  const drew = JSON.stringify(looks);
  void daemon
    .themes()
    .then((found) => {
      const changed = JSON.stringify(found) !== drew;
      looks = found;
      if (!menu.isConnected) return;
      const item = menu.querySelector<HTMLElement>('[data-key="look"] .menu-value');
      if (item) item.textContent = sections.find((section) => section.key === "look")!.value();
      if (changed && menu.querySelector(".open")?.getAttribute("data-key") === "look") {
        // A theme your agent made since, say: drawn again, with the focus
        // where it was.
        const at = ctx.focus.get() ?? null;
        if (!panel.contains(at)) show(sections.find((section) => section.key === "look")!);
        else if (menu.isConnected) ctx.render("settings/look", at?.getAttribute("data-action") ?? undefined);
      }
    })
    .catch(() => {});
  // The sound, too, against what this page drew: a Settings drawn again
  // while another one's ask waited has no output on it yet.
  const heard = JSON.stringify(audio);
  void screen
    .audio()
    .then((found) => {
      // Away from the TV, it says so; a TV with no outputs says that.
      const next = found.ok ? { ...found, outputs: found.outputs ?? [] } : found;
      const changed = JSON.stringify(next) !== heard;
      audio = next;
      if (!menu.isConnected) return;
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
      if (current?.dataset.adjust === "size" && (action === "left" || action === "right")) {
        void stepSize(action === "right" ? 1 : -1);
        return true;
      }
      if (current?.dataset.adjust === "resolution" && (action === "left" || action === "right")) {
        void switchOutput();
        return true;
      }
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
      // Your agent's caps, a step at a time, past the PIN (ADR-045).
      const caps = buildsState()?.settings.cap;
      if (caps && (current?.dataset.adjust === "cap-build" || current?.dataset.adjust === "cap-month") && (action === "left" || action === "right")) {
        const by = action === "right" ? 1 : -1;
        const cap = current.dataset.adjust === "cap-build" ? { ...caps, build: stepCap(BUILD_CAPS, caps.build, by) } : { ...caps, month: stepCap(MONTH_CAPS, caps.month, by) };
        void changeBuilder(ctx, { cap }, current.dataset.adjust);
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
