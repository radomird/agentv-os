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
const city = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ").toLowerCase();
const HOW_MANY = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

async function load(): Promise<LocationInfo | null> {
  known = await setup.location().catch(() => null);
  return known;
}

// What the bar says on the right: the phone that's helping, if one is.
function info(ctx: Ctx): string {
  return ctx.info.phones.length ? "phone paired" : "";
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
  const grant = await ctx.grant("the location");
  if (grant === null) return;
  let answer;
  try {
    answer = await setup.setLocation(code, zone, grant || undefined);
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
  return `from ${start.from === "phone" ? "your phone's" : "this box's"} time zone · ${time(start.zone)} in ${city(start.zone)}`;
}

export async function location(ctx: Ctx): Promise<View> {
  const state = await load();
  if (!state?.start) return pickLocation(ctx);
  let start = state.start;
  const yes = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void choose(ctx, start.code) }, "↵ yes");
  const other = h("button", { class: "button", "data-focus": true, "data-action": "country-other", onclick: () => ctx.open("country/pick") });
  const label = () => (other.textContent = ctx.info.phones.length ? "pick another on your phone" : "pick another");
  label();
  const drawn = page(ctx, "agentv location", `${start.called}?`, line(start), h("div", { class: "setup-actions" }, yes, other));
  return {
    el: drawn.el,
    first: yes,
    info: info(ctx),
    heard(event, data) {
      if (event === "phones") {
        void ctx.refresh().then(() => {
          label();
          ctx.status(info(ctx));
        });
      }
      // The phone's zone came after the step was drawn: start from it.
      if (event === "location") {
        const next = (data as { start?: Start | null }).start;
        if (!next || (next.code === start.code && next.zone === start.zone)) return;
        start = next;
        drawn.headline.textContent = `${start.called}?`;
        drawn.headline.setAttribute("aria-label", `${start.called}?`);
        drawn.line.textContent = line(start);
      }
    },
  };
}

export async function pickLocation(ctx: Ctx): Promise<View> {
  const state = known ?? (await load());
  const countries: Country[] = state?.countries ?? [];
  const picker = countryPicker(countries, state?.start?.code ?? null, (c) => void choose(ctx, c.code));
  const drawn = page(ctx, "agentv location --pick", "pick the country.", "type it on your phone, or move with the arrows", picker.el);
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
      h("span", { class: "zone-name" }, zone.name),
      h("span", { class: "zone-where" }, `${zone.city} · ${time(zone.zone)}`),
    ),
  );
  const many = HOW_MANY[question.zones.length] ?? String(question.zones.length);
  const drawn = page(ctx, "agentv location --zone", "which time zone?", `${question.called} has ${many}`, h("div", { class: "zones" }, ...cards));
  return { el: drawn.el, first: cards[0], info: info(ctx) };
}
