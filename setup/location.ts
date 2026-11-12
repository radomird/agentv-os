// Location (design page D3, step 5 of 12): where the TV is, confirmed with
// one press. It starts on the country of the phone's own time zone, which
// the captive page and the companion send, or else on the box's own. Another
// country is picked with the phone's keyboard or the arrows. A country whose
// time zones really differ asks which one, unless the phone's zone is in it.
// The time and what's new follow it, and Settings changes it later.
//
// This is the step with setup's own switch on; setup/country.ts is phase
// 1's, with it off.

import type { Country } from "../launcher/api.ts";
import { countryPicker } from "../launcher/country-picker.ts";
import { h } from "../launcher/dom.ts";
import { setup, type LocationInfo, type Start, type ZoneAsk } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// Kept while setup is on this step: where it starts and every country, so
// the pick page draws at once, and the question the last pick asked.
let known: LocationInfo | null = null;
let asked: ZoneAsk | null = null;

const time = (zone: string) => new Date().toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
const city = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");
// A time zone's name as the daemon sends it, in lower case, with its
// capitals: "hawaii-aleutian" is "Hawaii-Aleutian". One that has capitals
// already stays as it is.
const proper = (text: string) => (/\p{Lu}/u.test(text) ? text : text.replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase()));
// A location as a sentence starts with it: "The Netherlands", "Norway".
const place = (at: { name: string; called: string }) => (/^the /i.test(at.called) ? `The ${at.name}` : at.name);

async function load(): Promise<LocationInfo | null> {
  known = await setup.location().catch(() => null);
  return known;
}

// What the bar says on the right: the phone that's helping, if one is.
function info(ctx: Ctx): string {
  return ctx.info.phones.length ? "Phone paired" : "";
}

// A page of this step: the prompt, the headline, its one line, and what to
// press.
function page(ctx: Ctx, command: string, title: string, line: string, ...rest: HTMLElement[]): { el: HTMLElement; headline: HTMLElement; line: HTMLElement } {
  const [prompt, headline] = heading(command, title, ctx.reduced());
  if (title.length > 16) headline.classList.add("long");
  const said = h("p", { class: "setup-line" }, line);
  return { el: h("div", { class: "setup-page d3" }, prompt, headline, said, ...rest), headline, line: said };
}

// A country confirmed or picked, or a zone chosen: on to the AI, or to the
// question of which zone.
async function choose(ctx: Ctx, code: string, zone?: string): Promise<void> {
  let answer;
  try {
    const set = await ctx.guarded("changing location", (grant) => setup.setLocation(code, zone, grant));
    if (!set) return;
    answer = set.value;
  } catch (error) {
    ctx.toast((error as Error).message, "fail");
    ctx.sounds.play("failure");
    return;
  }
  if (answer.ask) {
    asked = answer.ask;
    ctx.open("country/zone");
    return;
  }
  await ctx.finish("country");
}

function line(start: Start): string {
  return `Guessed from ${start.from === "phone" ? "your phone" : "the clock"} · ${time(start.zone)} in ${city(start.zone)}`;
}

export async function location(ctx: Ctx): Promise<View> {
  const state = await load();
  if (!state?.start) return pickLocation(ctx);
  let start = state.start;
  const yes = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void choose(ctx, start.code) }, "Yes");
  const other = h("button", { class: "button", "data-focus": true, "data-action": "country-other", onclick: () => ctx.open("country/pick") }, "Another location");
  const drawn = page(ctx, "agentv location", `${place(start)}?`, line(start), h("div", { class: "setup-actions" }, yes, other));
  return {
    el: drawn.el,
    first: yes,
    info: info(ctx),
    heard(event, data) {
      if (event === "phones") {
        void ctx.refresh().then(() => ctx.status(info(ctx)));
      }
      // The phone's zone came after the step was drawn: start from it.
      if (event === "location") {
        const next = (data as { start?: Start | null }).start;
        if (!next || (next.code === start.code && next.zone === start.zone)) return;
        start = next;
        drawn.headline.textContent = `${place(start)}?`;
        drawn.headline.setAttribute("aria-label", `${place(start)}?`);
        drawn.line.textContent = line(start);
      }
    },
  };
}

export async function pickLocation(ctx: Ctx): Promise<View> {
  const state = known ?? (await load());
  const countries: Country[] = state?.countries ?? [];
  const picker = countryPicker(countries, state?.start?.code ?? null, (c) => void choose(ctx, c.code));
  const drawn = page(ctx, "agentv location --pick", "Pick your location", "Type on your phone, or use the arrows", picker.el);
  return { el: drawn.el, first: picker.first, info: info(ctx) };
}

// Which of the country's time zones, each with its city and the time there.
export function zoneQuestion(ctx: Ctx): View {
  const question = asked;
  if (!question) {
    void Promise.resolve().then(() => ctx.open("country", "back"));
    return { el: h("div", { class: "setup-page d3" }), info: info(ctx) };
  }
  const cards = question.zones.map((zone) =>
    h(
      "button",
      { class: "zone", "data-focus": true, "data-zone": zone.zone, onclick: () => void choose(ctx, question.code, zone.zone) },
      h("span", { class: "zone-name" }, proper(zone.name)),
      h("span", { class: "zone-where" }, `${city(zone.zone)} · ${time(zone.zone)}`),
    ),
  );
  const drawn = page(ctx, "agentv location --zone", "Which time zone?", `${place(question)} has ${question.zones.length}`, h("div", { class: "zones" }, ...cards));
  return { el: drawn.el, first: cards[0], info: info(ctx) };
}
