// Settings (ADR-015, ADR-024, ADR-031), as design page D10 draws it: eight
// sections on the left, and the focused one's rows on the right. A row is
// one line, its name and then its value. Nothing is explained under a row.
// OK on a row changes it in place, or opens its page: in the same panel for
// the pages that were sections of their own before (updates, the adult PIN,
// Wi-Fi and so on), or as a screen of its own (a profile, a key, restart).
// Back from a page goes to its section, with the focus on its row.
//
// A route names what the panel shows: "settings/tv" is a section,
// "settings/updates" a page in one, and "settings/tv.restart" a section with
// the focus on one of its rows, which is where Back lands from a screen a
// row opened. The names sections had before D10 still open where they went
// ("settings/power" is This TV, and OK then starts on Restart).

import { creditLine, daemon, screen, shownCurrent, type AudioState, type Backgrounds, type ThemePreview, type VoiceState, type WeatherPlace } from "../api.ts";
import { asWritten, h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import { lookId, looksList, sizeId } from "../looks/looks.ts";
import { lookCards } from "../looks/preview.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { powerRows } from "./power.ts";
import { aboutBox } from "./box.ts";
import { aiPanel, aiValue, keyState, providerName, setKeyState } from "./key.ts";
import { controllerRows, controllersPanel, loadControllers } from "./controllers.ts";
import { loadPhones, phoneRows, phones } from "./phones.ts";
import { loadNetwork, networkPanel, networkRows, watchNetwork } from "./wifi.ts";
import { profileRows } from "./profiles.ts";
import { notesPanel, updatesPanel, updatesStart, updatesValue } from "./updates.ts";
import { BUILD_CAPS, changeBuilder, MONTH_CAPS, stepCap, usagePanel, usageRows } from "./usage.ts";
import { buildsState, loadBuilds } from "./build.ts";
import { countryValue, loadCountry } from "./country.ts";
import { desktopPasswordNote, loadDesktopPassword, needsPassword } from "./desktop-password.ts";
import { loadNews, newsPanel, newsState, newsValue } from "./tmdb.ts";
import { TMDB_LOGO, TMDB_NOTICE } from "../tmdb-logo.ts";
import { loadSizes, resolutionName, setOutput, setSize, SIZE_NAMES, sizes, stepped } from "../size.ts";
import { properUnits } from "../box-lines.ts";

// The times the screen saver can wait, in minutes (ADR-031).
const IDLE = [5, 10, 15, 30, 60];

// One of the eight: its name on the left, its rows on the right.
interface Section {
  key: string;
  label: string;
  rows: () => (HTMLElement | null)[];
}

// A page a row opens in the panel. Its key is its row's action too.
interface Page {
  key: string;
  in: string;
  panel: () => HTMLElement[];
  // The page it's a level under, which Back goes to, if not the section.
  under?: string;
  // The row it opens on, when not its first.
  start?: () => string | undefined;
}

// Where the sections from before D10 went: the section, and the row OK
// starts on.
const MOVED: Record<string, [string, string]> = {
  power: ["tv", "restart"],
  country: ["tv", "country"],
  apps: ["home", "apps"],
};

function note(text: string): HTMLElement {
  return h("p", { class: "panel-note" }, text);
}

// A row that isn't a choice: its name, and its value if it has one.
function plain(label: string, value = "", mark?: string): HTMLElement {
  return h("div", { class: "panel-row", "data-row": mark }, h("span", {}, label), h("span", { class: "button-value" }, value));
}

const onOff = (on: boolean) => (on ? "On" : "Off");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The weather's city and units, kept between visits so the panel draws at
// once, and asked for again each time Settings opens.
let weather: WeatherPlace | null = null;

// The box's sound output and its volume (S2.19), the same way.
let audio: AudioState | null = null;
// Which voice says the TV's answers (stage 8), the same way.
let voice: VoiceState | null = null;

// A TV with nothing to say its answers with: no voice of its own, and no
// key for a provider that has one. Its answers show on the TV, and Sound has
// no row about a voice.
function noVoice(state: VoiceState | null): boolean {
  return state !== null && state.by === null;
}

// The voice, as the value of Sound's "Speak answers" row.
function voiceValue(state: VoiceState | null, spoken: boolean): string {
  if (!spoken) return "Off";
  if (state?.by === "provider" && state.provider) return `${providerName(state.provider)}'s voice`;
  if (state?.by === "own") return "Built-in voice";
  return "On";
}
// The backgrounds, for Appearance, asked for again each time Settings opens.
let pictures: Backgrounds | null = null;
// The theme's picture just picked here. Omarchy shows it at once, and the
// daemon hears a moment later, so until then its answer still names the one
// before.
let pickedPicture: { id: string; until: number } | null = null;

function withPicked(found: Backgrounds): Backgrounds {
  if (!pickedPicture || Date.now() > pickedPicture.until || found.source !== "theme" || !found.theme) return found;
  return { ...found, theme: { ...found.theme, current: pickedPicture.id } };
}

// What each background source is called on its row.
const SOURCE_WORDS: Record<Backgrounds["source"], string> = { theme: "From the theme", photos: "Your photos", art: "Art", folder: "A folder", field: "None" };

// The themes Appearance offers (board 12), and which one the TV has.
let looks: { themes: ThemePreview[]; current: string | null } | null = null;
let settingLook: string | null = null;
// The volume the last press asked for, until the screen daemon has set it,
// so presses quicker than its replies each go one step further.
let volumeTarget: number | null = null;

// The output playing and its volume, when the screen daemon says.
function playing(state: AudioState | null): { name: string; volume: number } | null {
  const output = state?.ok ? state.outputs?.find((o) => o.name === state.output) : undefined;
  return output && typeof state?.volume === "number" ? { name: output.description, volume: state.volume } : null;
}

export function settings(ctx: Ctx, open?: string): View {
  const s = ctx.state.settings;
  const adult = ctx.state.viewer.role === "adult";
  const save = async (change: Parameters<Ctx["saveSettings"]>[0], key: string, action: string) => {
    await ctx.saveSettings(change);
    ctx.sounds.play("confirm");
    ctx.render(`settings/${key}`, action);
  };
  // A row: its name, then its value. Its page's key is its action.
  const row = (action: string, label: string, value: string | Node, onclick: () => void, adjust = false): HTMLElement =>
    h("button", { class: "button", "data-focus": true, "data-action": action, "data-adjust": adjust ? action : undefined, onclick }, h("span", {}, label), h("span", { class: "button-value" }, value));
  const toggle = (label: string, on: boolean, action: string, change: () => Promise<void>) => row(action, label, onOff(on), () => void change());

  // Home and apps, weather (ADR-015): another city from the tz database, or
  // the box's own, and the units.
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
      row("city", "City", w.name || "No city yet", () => stepCity(1), true),
      w.chosen ? h("button", { class: "button", "data-focus": true, "data-action": "own-city", onclick: () => saveWeather({ zone: null }, "city") }, "Use my time zone's city") : null,
      row("units", "Degrees", w.units === "c" ? "°C" : "°F", () => void saveWeather({ units: w.units === "c" ? "f" : "c" }, "units")),
      note("Only the city's rough location goes to MET Norway"),
    ].filter((el): el is HTMLElement => el !== null);
  };

  // Sound's output and its volume (ADR-017, S2.19). The box plays at full
  // volume, so the TV's remote sets how loud it is. A level set here is
  // kept for that output.
  const saveAudio = async (change: Parameters<typeof screen.audio>[0], action: string) => {
    const reply = await screen.audio(change);
    if (reply.ok && reply.outputs) {
      audio = reply;
      ctx.sounds.play("confirm");
    } else {
      ctx.toast(reply.error ?? "Couldn't change the sound", "fail");
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
  // The output shows as a row only when there's another to pick.
  const outputRows = (): HTMLElement[] => {
    const now = playing(audio);
    if (!now) return [plain(audio === null ? "…" : (audio.error ?? "No sound output found"), "", "output")];
    return [
      (audio?.outputs?.length ?? 0) > 1 ? row("output", "Output", now.name, () => stepOutput(1), true) : null,
      row("output-volume", "Volume", `${Math.round(now.volume * 100)}%`, () => stepVolume(0.05), true),
    ].filter((el): el is HTMLElement => el !== null);
  };

  // Profiles, adult PIN (ADR-009, S4.5): the adult PIN, chosen twice on its
  // pad, changed or removed past the one before, and the TV locked now.
  const pinSet = () => ctx.state.pin?.set === true;
  const choosePin = async () => {
    const grant = pinSet() ? await ctx.grant("changing the PIN") : "";
    if (grant === null) return;
    let first = "";
    const chosen = await ctx.pad({
      command: "tv settings · pin",
      title: pinSet() ? "Choose a new PIN" : "Set an adult PIN",
      note: "4 digits, for settings, new apps and the desktop",
      submit: async (pin) => {
        first = pin;
        return null;
      },
    });
    if (!chosen) return;
    const again = await ctx.pad({
      command: "tv settings · pin",
      title: "Enter it again",
      note: "So a typo doesn't lock you out",
      submit: async (pin) => {
        if (pin !== first) return "Those don't match";
        await daemon.setPin(pin, grant || undefined);
        return null;
      },
    });
    if (!again) return;
    ctx.toast(grant ? "PIN changed" : "PIN set", "ok");
    ctx.render("settings/pin", "set-pin");
  };
  const removePin = async () => {
    const grant = await ctx.grant("removing the PIN");
    if (grant === null) return;
    try {
      await daemon.removePin(grant);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("PIN removed", "ok");
    ctx.render("settings/pin", "set-pin");
  };
  const pinPanel = (): HTMLElement[] =>
    pinSet()
      ? [
          h("button", { class: "button", "data-focus": true, "data-action": "set-pin", onclick: () => void choosePin() }, "Change PIN"),
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
            "Lock the TV now",
          ),
          h("button", { class: "button", "data-focus": true, "data-action": "remove-pin", onclick: () => void removePin() }, "Remove PIN"),
        ]
      : [
          h("button", { class: "button primary", "data-focus": true, "data-action": "set-pin", onclick: () => void choosePin() }, "Set a PIN"),
          note("4 digits, for settings, new apps and the desktop"),
        ];

  // The size row: a button that steps through the sizes this TV offers. With
  // the sizes off, or a TV that offers one, it just says which.
  let sizing = false;
  const sizeRow = (): HTMLElement => {
    const display = sizes();
    if (!display || display.sizes.length < 2) return plain("Size", capital(SIZE_NAMES[display?.size ?? sizeId()]), "size");
    return row("size", "Size", sizing ? "…" : capital(SIZE_NAMES[display.size]), () => void stepSize(1, true), true);
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
    return [row("resolution", "Resolution", sizing ? "…" : properUnits(resolutionName(display)), () => void switchOutput(), true)];
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
      ctx.toast("Couldn't set that look", "fail");
      return;
    }
    ctx.sounds.play("confirm");
  };

  // The background: a row that steps through the sources that have
  // pictures, the theme's own included. A theme with more than one picture
  // of its own has a row for which, so a photo from the phone is never the
  // only way it can be.
  const backgroundRows = (): HTMLElement[] => {
    const shown = shownCurrent(pictures);
    const source = pictures?.source ?? "theme";
    const own = pictures?.theme?.items ?? [];
    const at = source === "theme" ? own.findIndex((item) => item.id === pictures?.theme?.current) : -1;
    return [
      row("background", "Background", source === "theme" ? (shown ? asWritten(creditLine(shown)) : SOURCE_WORDS.theme) : SOURCE_WORDS[source], () => void nextBackground()),
      own.length > 1 ? row("pictures", "Picture", at >= 0 ? `${at + 1} of ${own.length}` : "", () => openPage("pictures")) : null,
    ].filter((el): el is HTMLElement => el !== null);
  };

  // The theme's own pictures, each its own card. OK on one asks Omarchy to
  // show it, as its desktop does, and makes the theme's own the background.
  const themePictures = (): HTMLElement[] => {
    const items = pictures?.theme?.items ?? [];
    const current = pictures?.source === "theme" ? pictures.theme?.current : null;
    return [
      h(
        "div",
        { class: "theme-pictures", "data-scroll": true },
        ...items.map((item, i) =>
          h(
            "button",
            { class: `theme-picture${item.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `theme-picture-${item.id}`, "aria-label": `Picture ${i + 1}`, onclick: () => void pickThemePicture(item.id) },
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
      ctx.toast(reply.error ?? "Couldn't change the background", "fail");
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
    pickedPicture = { id, until: Date.now() + 10_000 };
    if (pictures?.theme) pictures = { ...pictures, theme: { ...pictures.theme, current: id } };
    ctx.sounds.play("confirm");
    ctx.render("settings/pictures", `theme-picture-${id}`);
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

  // The theme's page: every theme Omarchy has, the ones made here, each
  // with its own page where it can be removed, and making one from a few
  // words (S6.4).
  const themePanel = (): HTMLElement[] => [
    h("div", { class: "panel-title" }, "Theme"),
    lookList(),
    ...(looks?.themes ?? []).flatMap((look) => {
      const made = look.app ? buildsState()?.builds.find((b) => b.id === look.app && b.state === "installed") : undefined;
      return made ? [h("button", { class: "button wide", "data-focus": true, "data-action": `theme-made-${look.id}`, onclick: () => ctx.go(`build/${made.build}`) }, `${look.name}, made by you`)] : [];
    }),
    ...(adult ? [h("button", { class: "button wide", "data-focus": true, "data-action": "theme-own", onclick: () => ctx.go("describe") }, "Make your own theme")] : []),
  ];

  const desktopPanel = (): HTMLElement[] => {
    // One line: what the first switch asks for, or how to come back.
    const first = desktopPasswordNote();
    return [
      ...(first.length ? first : [note("Super + Ctrl + Home brings you back")]),
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
            const grant = await ctx.grant("Omarchy's desktop");
            if (grant === null) return;
            const reply = await screen.desktop(grant);
            if (reply.pin) ctx.forgetGrant();
            if (!reply.ok) ctx.toast(reply.error ?? "Couldn't open the desktop", "fail");
          },
        },
        "Switch",
      ),
    ];
  };

  const version = () => ctx.state.version.replace(/\.r\d+\.g[0-9a-f]+$/, "");
  const aboutPanel = (): HTMLElement[] => [
    aboutBox(ctx),
    h("div", { class: "panel-big" }, `AgenTV ${ctx.state.version}`),
    note("The world's first open-source agentic TV OS. Powered by Omarchy."),
    note("Omarchy is made by David Heinemeier Hansson and its contributors, under the MIT licence."),
    note("Weather data from MET Norway, under CC BY 4.0."),
    // TMDB's terms: its logo, less prominent than AgenTV's, and its
    // notice; JustWatch's: credit for where to watch.
    h("img", { class: "about-tmdb", src: TMDB_LOGO, alt: "TMDB" }),
    // TMDB's own notice, as they word it, in every look.
    h("p", { class: "panel-note", "data-own-case": true }, TMDB_NOTICE),
    note("Where to watch is from JustWatch, through TMDB."),
  ];

  // The eight sections (D10). A child's profile has no AI and no Network,
  // and This TV has no Restart or Shut down for it (ADR-033).
  const sections: Section[] = [
    {
      // It keeps Look's key, so a page that opens settings/look lands here.
      key: "look",
      label: "Appearance",
      rows: () => [
        lookId() ? row("looks", "Look", looksList().find((look) => look.id === lookId())?.name ?? "", () => openPage("looks")) : null,
        row("theme", "Theme", looks?.themes.find((look) => look.id === looks?.current)?.name ?? "Omarchy theme", () => openPage("theme")),
        // The TV's size (ADR-062), stepped with left and right, or OK for
        // the next one.
        ...(lookId() ? [sizeRow(), ...resolutionRow()] : []),
        ...backgroundRows(),
        row("idle", "Screen saver", `After ${s.idleMinutes} min`, () => void save({ idleMinutes: IDLE[(IDLE.indexOf(s.idleMinutes) + 1) % IDLE.length] }, "look", "idle"), true),
        toggle("Reduce motion", s.reduceMotion, "motion", () => save({ reduceMotion: !s.reduceMotion }, "look", "motion")),
      ],
    },
    {
      key: "sound",
      label: "Sound",
      rows: () => [
        ...outputRows(),
        toggle("Menu sounds", s.sound.on, "sound", () => save({ sound: { ...s.sound, on: !s.sound.on } }, "sound", "sound")),
        row(
          "volume",
          "Menu sounds volume",
          `${Math.round(s.sound.volume * 100)}%`,
          () => void save({ sound: { ...s.sound, volume: s.sound.volume >= 1 ? 0.2 : Math.round((s.sound.volume + 0.2) * 10) / 10 } }, "sound", "volume"),
          true,
        ),
        // What the TV answers, said aloud (stage 8), and which voice says
        // it. A TV with no voice has no row for it (ADR-087).
        noVoice(voice) ? null : row("spoken", "Speak answers", voiceValue(voice, s.spoken), () => void save({ spoken: !s.spoken }, "sound", "spoken")),
      ],
    },
    {
      key: "home",
      label: "Home and apps",
      rows: () => [
        h("button", { class: "button", "data-focus": true, "data-action": "edit", onclick: () => ctx.edit() }, "Edit home"),
        row("apps", "All apps", String(ctx.state.apps.length), () => ctx.go("apps")),
        row("weather", "Weather", weather ? weather.name || "No city yet" : "", () => openPage("weather")),
        // What came out this week on the household's apps, from TMDB (S8.1).
        row("tmdb", "New this week", newsValue(), () => openPage("tmdb")),
      ],
    },
    {
      key: "profiles",
      label: "Profiles",
      rows: () => [...profileRows(ctx), row("pin", "Adult PIN", onOff(pinSet()), () => openPage("pin"))],
    },
    {
      key: "phones",
      label: "Phones and controllers",
      rows: () => [...phoneRows(ctx), ...controllerRows((action) => openPage("controllers", action)), h("button", { class: "button", "data-focus": true, "data-action": "controllers", onclick: () => openPage("controllers") }, "Pair a controller")],
    },
    ...(adult ? [{ key: "network", label: "Network", rows: () => networkRows(() => openPage("wifi")) }] : []),
    ...(adult
      ? [
          {
            key: "ai",
            label: "AI",
            rows: () => [row("your-ai", "Your AI", aiValue(), () => openPage("your-ai")), ...usageRows(ctx, () => openPage("usage"))],
          },
        ]
      : []),
    {
      key: "tv",
      label: "This TV",
      rows: () => [
        // The TV's location (ADR-055): the time zone and new this week follow it.
        row("country", "Location", countryValue(), () => ctx.go("country")),
        row("updates", "Updates", updatesValue(ctx), () => openPage("updates")),
        h("button", { class: "button", "data-focus": true, "data-action": "desktop", onclick: () => openPage("desktop") }, "Omarchy's desktop"),
        // Restart and Shut down (ADR-033) are an adult's.
        ...(adult ? powerRows(ctx) : []),
        row("about", "About", `AgenTV ${version()}`, () => openPage("about")),
      ],
    },
  ];

  const pages: Page[] = [
    // The three looks, with a preview of each (ADR-063, D2).
    { key: "looks", in: "look", panel: () => [h("div", { class: "panel-title" }, "Look"), h("div", { class: "look-cards" }, ...lookCards(looksList(), lookId(), sizeId(), 300, (look) => void pickLook(look.id), looks?.current))] },
    { key: "theme", in: "look", panel: themePanel },
    { key: "pictures", in: "look", panel: themePictures },
    { key: "weather", in: "home", panel: weatherPanel },
    { key: "tmdb", in: "home", panel: () => newsPanel(ctx) },
    { key: "pin", in: "profiles", panel: pinPanel },
    // Game controllers (ADR-084): the ones nearby, to pair.
    { key: "controllers", in: "phones", panel: () => controllersPanel(ctx) },
    { key: "wifi", in: "network", panel: () => networkPanel(ctx) },
    { key: "your-ai", in: "ai", panel: () => aiPanel(ctx) },
    { key: "usage", in: "ai", panel: () => usagePanel(ctx) },
    { key: "updates", in: "tv", panel: () => updatesPanel(ctx, (key) => openPage(key)), start: () => updatesStart(ctx) },
    // What's new, a level under Updates (ADR-094).
    { key: "whats-new", in: "tv", under: "updates", panel: () => notesPanel(ctx), start: () => updatesStart(ctx) },
    { key: "desktop", in: "tv", panel: desktopPanel },
    { key: "about", in: "tv", panel: aboutPanel },
  ];

  // What the panel shows: a section's rows, or a page in it.
  let shown: { section: Section; page: Page | null } = { section: sections[0], page: null };
  // The row OK on the section starts on, when the route named one.
  let prefer: string | null = null;
  // True until the focus first leaves the section it arrived on, so a page
  // stays in the panel while its section has the focus.
  let landing = true;
  // Whether the route opened the page, not a row. Back then leaves Settings
  // while the focus is still on the list.
  let routed = false;

  // A section longer than the screen scrolls with the focus.
  const panel = h("div", { class: "panel settings-panel", "data-scroll": true });
  panel.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });
  // Where Back lands from a screen a row opens: its section, on that row.
  panel.addEventListener(
    "click",
    (event) => {
      const at = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (at && panel.contains(at)) ctx.remember(`settings/${shown.page?.key ?? shown.section.key}.${at.dataset.action}`);
    },
    true,
  );
  const show = (section: Section, page: Page | null = null) => {
    shown = { section, page };
    ctx.remember(`settings/${page?.key ?? section.key}`);
    panel.dataset.page = page?.key ?? section.key;
    panel.replaceChildren(...(page ? page.panel() : section.rows().filter((el): el is HTMLElement => el !== null)));
    for (const item of menu.children) item.classList.toggle("open", (item as HTMLElement).dataset.key === section.key);
  };
  const openItem = () => menu.querySelector<HTMLElement>(`[data-key="${shown.section.key}"]`)!;
  const into = (action?: string | null) => {
    const control = (action ? panel.querySelector<HTMLElement>(`[data-action="${action}"]`) : null) ?? panel.querySelector<HTMLElement>("[data-focus]");
    if (control) ctx.focus.set(control);
    return Boolean(control);
  };
  // A row's page, in the panel. One with nothing to choose, such as About,
  // leaves the focus on its section.
  function openPage(key: string, action?: string): void {
    const page = pages.find((one) => one.key === key);
    if (!page) return;
    routed = false;
    show(shown.section, page);
    ctx.sounds.play("forward");
    if (into(action ?? page.start?.())) return;
    landing = true;
    ctx.focus.set(openItem());
  }
  // Back from a page: the page it's under, or its section, with the focus
  // on the page's row.
  const closePage = () => {
    const from = shown.page;
    if (!from) return;
    show(shown.section, pages.find((one) => one.key === from.under) ?? null);
    ctx.sounds.play("back");
    if (!into(from.key)) ctx.focus.set(openItem());
  };
  // Draws what the panel shows again, if it's one of these, with the focus
  // where it was.
  const refresh = (...keys: string[]) => {
    if (!menu.isConnected || !keys.includes(shown.page?.key ?? shown.section.key)) return;
    const at = ctx.focus.get() ?? null;
    const inside = panel.contains(at);
    const action = at?.dataset.action;
    show(shown.section, shown.page);
    if (inside && !into(action)) ctx.focus.set(openItem());
  };
  // Asks for something again, and draws what shows it once it's different
  // from what this page drew. Not from what another Settings drawn since has
  // seen: a redraw while this one waited mustn't keep what it started with.
  const follow = (have: () => unknown, ask: Promise<unknown>, ...keys: string[]) => {
    const drew = JSON.stringify(have());
    void ask.then(() => JSON.stringify(have()) !== drew && refresh(...keys)).catch(() => {});
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
            if (section !== shown.section) show(section);
            into(prefer);
          },
        },
        h("span", {}, section.label),
      ),
    ),
  );

  // The route: a section, a page, or either with a row after a dot.
  const [named, at = null] = (open ?? "").split(".");
  const moved = MOVED[named];
  const page = pages.find((one) => one.key === named && sections.some((section) => section.key === one.in)) ?? null;
  const start = sections.find((section) => section.key === (page?.in ?? moved?.[0] ?? named)) ?? sections[0];
  prefer = moved?.[1] ?? null;
  routed = page !== null;
  show(start, page);
  // A name from before keeps its row through a redraw, until the focus moves.
  if (moved) ctx.remember(`settings/${named}`);

  follow(() => weather, daemon.weather().then((found) => (weather = found)), "home", "weather");
  // Which voice says the answers.
  follow(() => voice, daemon.voice().then((found) => (voice = found)), "sound");
  // The backgrounds, for Appearance's background rows.
  follow(() => pictures, daemon.backgrounds().then((found) => (pictures = withPicked(found))), "look", "pictures");
  follow(() => [countryValue(), newsState], Promise.all([loadCountry(), loadNews()]), "tv", "home", "tmdb");
  follow(() => desktopPasswordNote().map((line) => line.textContent), loadDesktopPassword(), "desktop");
  follow(() => phones, loadPhones(), "phones");
  follow(() => controllerRows().map((one) => one.textContent), loadControllers(), "phones");
  follow(() => keyState, daemon.key().then((found) => setKeyState({ set: found.set, provider: found.provider, plans: found.plans, ai: found.ai })), "ai", "your-ai");
  follow(() => buildsState(), loadBuilds(ctx), "ai", "usage", "theme");
  // How the TV is online, now and when the daemon has news of it.
  follow(() => networkRows(() => {}).map((one) => one.textContent), loadNetwork(), "network");
  watchNetwork(() => refresh("network"));
  // Every theme Omarchy has (ADR-048), two to a row, each with its own
  // colours beside its name, in a list that scrolls with the focus. Declared
  // so it's there for a page drawn straight at it, before this line runs.
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
          h("span", { class: "button-value" }, settingLook === look.id ? "Setting…" : look.id === looks?.current ? "■ On" : "□"),
        );
      }),
    );
    // The list shows whole rows, and a thumb beside it says it goes on and
    // how far down it is (launcher.css). The thumb is only to look at.
    const thumb = h("span", {});
    const wrap = h("div", { class: "look-scroll" }, list, h("span", { class: "look-thumb", "aria-hidden": "true" }, thumb));
    const mark = () => {
      const all = list.scrollHeight;
      wrap.classList.toggle("scrolls", all > list.clientHeight + 2);
      thumb.style.height = `${(list.clientHeight / all) * 100}%`;
      thumb.style.top = `${(list.scrollTop / all) * 100}%`;
    };
    list.addEventListener(
      "scroll",
      () => {
        mark();
        ctx.focus.refresh();
      },
      { passive: true },
    );
    new ResizeObserver(mark).observe(list);
    // On the theme's own page the list takes as many whole rows as the panel
    // has room for, in every look and at every size, rather than two. It's
    // measured once the page is laid out, and again whenever the list or the
    // panel changes size, since a frame after drawing can come before that.
    let watched: HTMLElement | null = null;
    const fit = () => {
      const page = wrap.closest<HTMLElement>('.settings-panel[data-page="theme"]');
      if (!page || !page.isConnected) return;
      if (watched !== page) {
        watched = page;
        sizes.observe(page);
      }
      const box = page.getBoundingClientRect();
      if (!box.height) return;
      const style = getComputedStyle(list);
      const row = parseFloat(style.getPropertyValue("--look-row"));
      const gap = parseFloat(style.rowGap) || 0;
      const inside = parseFloat(getComputedStyle(page).paddingBottom) || 0;
      // The room from the list's top to the panel's bottom, less what comes
      // after the list.
      const after = [...page.children].filter((el) => el !== wrap && el.getBoundingClientRect().top >= wrap.getBoundingClientRect().bottom - 1).reduce((sum, el) => sum + el.getBoundingClientRect().height + (parseFloat(getComputedStyle(page).rowGap) || 0), 0);
      const room = box.bottom - inside - list.getBoundingClientRect().top - after;
      const rows = Math.max(2, Math.floor((room + gap) / (row + gap)));
      const height = `${rows * row + (rows - 1) * gap}px`;
      if (Number.isFinite(rows) && list.style.maxHeight !== height) list.style.maxHeight = height;
      mark();
    };
    const sizes = new ResizeObserver(fit);
    sizes.observe(wrap);
    return wrap;
  }
  const setLook = async (look: ThemePreview) => {
    if (settingLook || look.id === looks?.current) return;
    settingLook = look.id;
    ctx.render("settings/theme", `theme-${look.id}`);
    const reply = await screen.setTheme(look.id);
    settingLook = null;
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? `Couldn't use ${look.name}`, "fail");
    } else {
      ctx.sounds.play("confirm");
      if (looks) looks = { ...looks, current: look.id };
    }
    // Still on Settings, after the few seconds Omarchy takes.
    if (menu.isConnected) ctx.render("settings/theme", `theme-${look.id}`);
  };
  // The sizes this TV offers.
  follow(() => sizes(), loadSizes(), "look");
  // A theme made since, say: drawn again, with the focus where it was.
  follow(() => looks, daemon.themes().then((found) => (looks = found)), "look", "theme", "looks");
  // The sound: away from the TV, it says so; a TV with no outputs says that.
  follow(() => audio, screen.audio().then((found) => (audio = found.ok ? { ...found, outputs: found.outputs ?? [] } : found)), "sound");
  const links = bar(ctx, "settings");
  const el = h("div", { class: "screen" }, h("div", { class: "page settings" }, h("div", {}, ...heading("tv settings", "Settings"), menu), panel), links);

  return {
    el,
    first: (at ? panel.querySelector<HTMLElement>(`[data-action="${at}"]`) : null) ?? (page?.start?.() ? panel.querySelector<HTMLElement>(`[data-action="${page.start()}"]`) : null) ?? openItem(),
    // The section with focus shows its rows. A page the route opened stays
    // while the focus is still where it arrived.
    focused(target) {
      if (!menu.contains(target)) {
        landing = false;
        return;
      }
      const section = sections.find((one) => one.key === target.dataset.key);
      if (!section || (landing && section === shown.section)) return;
      landing = false;
      prefer = null;
      show(section);
    },
    act(action) {
      const current = ctx.focus.get();
      const inside = Boolean(current && panel.contains(current));
      // Back from a page is its section. From the list it leaves Settings.
      if (action === "back" && shown.page && !(routed && landing && !inside)) {
        closePage();
        return true;
      }
      if (current?.dataset.adjust === "size" && (action === "left" || action === "right")) {
        void stepSize(action === "right" ? 1 : -1);
        return true;
      }
      if (current?.dataset.adjust === "resolution" && (action === "left" || action === "right")) {
        void switchOutput();
        return true;
      }
      if (current?.dataset.adjust === "idle" && (action === "left" || action === "right")) {
        const next = Math.max(0, Math.min(IDLE.length - 1, IDLE.indexOf(s.idleMinutes) + (action === "right" ? 1 : -1)));
        void save({ idleMinutes: IDLE[next] }, "look", "idle");
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
      // The spending limits, a step at a time, past the PIN (ADR-045).
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
      // Up and down stay in the panel. They never cross to the list, which
      // would put a page away. Down on the last row stays there, so one
      // press too many never skips past it; up from the first goes on to
      // the bar, in the looks that have it at the top.
      if ((action === "up" || action === "down") && inside) {
        if (!ctx.focus.move(action, panel) && action === "up") ctx.focus.move(action, links);
        return true;
      }
      // From the bar back toward Settings, with a page open: into the page,
      // not the list, which would put the page away.
      if ((action === "up" || action === "down") && shown.page && current && links.contains(current) && !ctx.focus.move(action, links)) {
        return ctx.focus.move(action, panel);
      }
      if (action === "left" && inside) {
        // Left along a row of cards first, then back: from a page to its
        // section's rows, from the rows to the list.
        if (ctx.focus.move("left", panel)) return true;
        if (shown.page) closePage();
        else ctx.focus.set(openItem());
        return true;
      }
      return false;
    },
  };
}
