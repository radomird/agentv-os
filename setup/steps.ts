// Every screen setup can show, by its route: a step's id, as daemon/setup.ts
// orders them, or a step's id and one of its pages. Each screen is one line.
// Another track adds its step here and in daemon/setup.ts's order, and a
// page of a step here alone.

import { aiStep, path } from "./ai.ts";
import type { Provider } from "./api.ts";
import { addYourOwn, apps } from "./apps.ts";
import { art, background, folder, photos } from "./background.ts";
import { country, pick as pickCountry } from "./country.ts";
import { goal } from "./goal.ts";
import { look } from "./look.ts";
import type { Ctx, View } from "./main.ts";
import { people, person } from "./people.ts";
import { ready } from "./ready.ts";
import { serverPage } from "./servers.ts";
import { theme } from "./theme.ts";
import { welcome, wifi } from "./welcome.ts";

export type Screen = (ctx: Ctx, page: string) => View | Promise<View>;

// "step/*" is any page of that step, with the page's own part of the route.
export const SCREENS: Record<string, Screen> = {
  welcome: welcome,
  "welcome/wifi": wifi,
  ready: ready,
  // track 3: box: box,
  country: country,
  "country/pick": pickCountry,
  ai: aiStep,
  "ai/*": (ctx, page) => path(ctx, page as Provider),
  people: people,
  "people/*": person,
  goal: goal,
  apps: apps,
  "apps/add": (ctx) => addYourOwn(ctx),
  "apps/network": serverPage,
  // track 9: its page of apps, as "apps/<page>": <screen>,
  look: look,
  theme: theme,
  "theme/colours": theme,
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
