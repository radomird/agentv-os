// Every screen setup can show, by its route: a step's id, as daemon/setup.ts
// orders them, or a step's id and one of its pages. Each screen is one line.
// Another track adds its step here and in daemon/setup.ts's order, and a
// page of a step here alone.

import { aiStep, path } from "./ai.ts";
import { aiStep2, ways } from "./ai2.ts";
import type { Provider } from "./api.ts";
import { addYourOwn, apps } from "./apps.ts";
import { art, background, folder, photos } from "./background.ts";
import { country, pick as pickCountry } from "./country.ts";
import { goal } from "./goal.ts";
import { location, pickLocation, zoneQuestion } from "./location.ts";
import type { Ctx, View } from "./main.ts";
import { people, person } from "./people.ts";
import { ready } from "./ready.ts";
import { theme } from "./theme.ts";
import { welcome, wifi } from "./welcome.ts";

export type Screen = (ctx: Ctx, page: string) => View | Promise<View>;

// With setup's own switch on, a step's phase 2 screen, and phase 1's with it
// off.
const two = (now: Screen, before: Screen): Screen => (ctx, page) => (ctx.info.numbers ? now(ctx, page) : before(ctx, page));

// "step/*" is any page of that step, with the page's own part of the route.
export const SCREENS: Record<string, Screen> = {
  welcome: welcome,
  "welcome/wifi": wifi,
  ready: ready,
  // track 3: box: box,
  country: two(location, country),
  "country/pick": two(pickLocation, pickCountry),
  "country/zone": zoneQuestion,
  ai: two(aiStep2, aiStep),
  "ai/*": two(
    (ctx, page) => ways(ctx, page as Provider),
    (ctx, page) => path(ctx, page as Provider),
  ),
  people: people,
  "people/*": person,
  goal: goal,
  apps: apps,
  "apps/add": (ctx) => addYourOwn(ctx),
  // track 9 and track 10: their pages of apps, as "apps/<page>": <screen>,
  // tracks 5 and 4: look: look,
  theme: theme,
  "theme/own": (ctx) => addYourOwn(ctx, "theme"),
  background: background,
  "background/photos": photos,
  "background/art": art,
  "background/folder": folder,
};

// The screen for a route: its own line, else its step's "step/*", else the
// welcome screen.
export function screenFor(route: string): { screen: Screen; page: string } {
  const [step, page = ""] = route.split("/");
  const screen = SCREENS[route] ?? SCREENS[`${step}/*`] ?? SCREENS.welcome;
  return { screen, page };
}
