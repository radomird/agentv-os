// Setup's own routes for phase 2 (track 7), on each of the daemon's three
// listeners: the TV's pages (127.0.0.1:3000), a paired phone on the home
// network (3001), and the setup hotspot's captive page (3002). The daemon
// adds them with one line in each of its handlers.
//
// - The phone's own time zone, which the captive page and the companion send
//   once, for the location step to start from (ADR-059).
// - The location step: where it starts, a country's time zones, and a
//   country picked, which sets the zone or asks which one (Q167, Q199). The
//   TV's page and the phone use the same answers.
// - The AI step: each provider's own icon, fetched on the box (ADR-069), and
//   a plan's sign-in started right there, its link as a QR code and a code
//   the provider's page gives handed back (ADR-070). Settings → AI can use
//   the same.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CountryPlace, CountryState } from "../country.ts";
import { countries, countryOf } from "../country.ts";
import { called, decide, phoneZone, startOn, zoneChoices } from "../location.ts";
import type { Setup, SetupState } from "../setup.ts";
import { type Ai, OFFERS, type Provider } from "../ai.ts";
import type { AiIcons } from "../ai-icons.ts";
import type { PlanSignIn } from "../plan-sign-in.ts";

// What these routes may use of the daemon.
export interface SetupHost {
  setup(): Setup;
  country(): CountryPlace;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  broadcast(event: string, data: unknown): void;
  log(line: string): void;
  // Past the PIN, once there is one, and an adult's: false once it has
  // answered the refusal.
  adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean>;
  ai(): Ai;
  aiIcons(): AiIcons;
  planSignIn(): PlanSignIn;
  // A QR code for a link, as SVG, or null without qrencode.
  qr(text: string): Promise<string | null>;
  send(response: ServerResponse, type: string, body: string | Buffer, headers?: Record<string, string>): void;
}

export type Listener = "tv" | "phone" | "captive";

export class SetupRoutes {
  private host: SetupHost;

  constructor(host: SetupHost) {
    this.host = host;
  }

  // True when the request was one of these routes, and it's answered.
  async handle(on: Listener, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const method = request.method;
    const path = url.pathname;
    const prefix = on === "phone" ? "/api/phone" : "/api/setup";

    // The phone's own time zone: from the captive page as it joins the
    // hotspot, and from the companion once it's paired. Only while setup
    // is on.
    if (method === "POST" && on !== "tv" && path === `${prefix}/zone`) {
      if ((await this.state()).done) {
        this.host.json(response, 409, { ok: false, error: "Setup is done" });
        return true;
      }
      const zone = await phoneZone(((await this.host.body(request)) as { zone?: unknown } | undefined)?.zone);
      if (!zone) {
        this.host.json(response, 400, { ok: false, error: 'send {"zone": "Europe/Amsterdam"}, the phone\'s time zone' });
        return true;
      }
      const state = await this.host.setup().setPhoneZone(zone);
      this.host.log(`the phone setting the tv up is in ${zone}`);
      this.host.broadcast("location", await this.where(state));
      this.host.json(response, 200, { ok: true, zone });
      return true;
    }

    if (on === "captive") return false;

    // A provider's own icon, from its site, or 404 for its name alone.
    const icon = /^\/api\/(?:phone\/)?ai\/icon\/([a-z]+)$/.exec(path);
    if (method === "GET" && icon && path.startsWith(on === "phone" ? "/api/phone/" : "/api/ai/")) {
      const provider = icon[1];
      const found = Object.hasOwn(OFFERS, provider) ? await this.host.aiIcons().icon(provider as Provider) : null;
      if (!found) {
        this.host.json(response, 404, { ok: false, error: "no icon: show the name" });
        return true;
      }
      this.host.send(response, found.type, found.body, { "Cache-Control": "max-age=86400", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return true;
    }

    // The plan's sign-in: how it stands, started from the AI step, the code
    // the provider's page gave, and its link as a QR code.
    const signIn = on === "phone" ? "/api/phone/ai/sign-in" : "/api/ai/sign-in";
    if (method === "GET" && path === signIn) {
      this.host.json(response, 200, { ok: true, signIn: await this.signInState() });
      return true;
    }
    if (method === "POST" && on === "tv" && path === signIn) {
      if (!(await this.host.adult(request, response, "the plan's sign-in"))) return true;
      const ai = await this.host.ai().read();
      if (!ai.provider || ai.path !== "plan") {
        this.host.json(response, 409, { ok: false, error: "Pick a plan first" });
        return true;
      }
      if (!ai.accepted) {
        this.host.json(response, 409, { ok: false, error: `Accept ${OFFERS[ai.provider].name}'s terms first` });
        return true;
      }
      await this.host.planSignIn().start(ai.provider);
      this.host.log(`setup started ${OFFERS[ai.provider].plan.name}'s sign-in`);
      this.host.json(response, 200, { ok: true, signIn: await this.signInState() });
      return true;
    }
    if (method === "POST" && path === `${signIn}/code`) {
      if (!(await this.host.adult(request, response, "the plan's sign-in"))) return true;
      const result = await this.host.planSignIn().code(((await this.host.body(request)) as { code?: unknown } | undefined)?.code);
      if (result.error) {
        this.host.json(response, 400, { ok: false, error: result.error });
        return true;
      }
      this.host.log(`the plan's sign-in got a code from the ${on === "phone" ? "phone" : "tv"}`);
      this.host.json(response, 200, { ok: true });
      return true;
    }
    if (method === "GET" && on === "tv" && path === `${signIn}/qr`) {
      const url = (await this.signInState())?.now?.url;
      const svg = url ? await this.host.qr(url) : null;
      if (!svg) {
        this.host.json(response, 404, { ok: false, error: url ? "there's no qr code without qrencode" : "nothing is signing in" });
        return true;
      }
      this.host.send(response, "image/svg+xml", svg, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return true;
    }

    // Where the location step starts, and every country to pick from.
    if (method === "GET" && path === `${prefix}/location`) {
      this.host.json(response, 200, { ok: true, ...(await this.where(await this.state())), countries: await countries() });
      return true;
    }

    // A country's time zones, one for each different clock.
    if (method === "GET" && path === `${prefix}/zones`) {
      const country = await countryOf(url.searchParams.get("code") ?? "");
      if (!country) {
        this.host.json(response, 400, { ok: false, error: "a country is two capital letters the tz database knows, such as NO" });
        return true;
      }
      this.host.json(response, 200, { ok: true, code: country.code, name: country.name, called: called(country.code, country.name), zones: await zoneChoices(country.code) });
      return true;
    }

    // A country, confirmed or picked, and the zone if the question asked
    // it: the box's country and time zone follow, or the answer asks which
    // zone. An adult's, past the PIN once there is one. From the phone it
    // finishes the step too, so the TV moves on.
    if (method === "PUT" && path === `${prefix}/location`) {
      if (!(await this.host.adult(request, response, "the location"))) return true;
      const body = ((await this.host.body(request)) ?? {}) as { code?: unknown; zone?: unknown };
      const state = await this.state();
      const box = await this.host.country().read();
      const decided = await decide(body.code, body.zone, state.phoneZone, box.zone);
      if ("error" in decided) {
        this.host.json(response, 400, { ok: false, error: decided.error });
        return true;
      }
      if ("ask" in decided) {
        this.host.json(response, 200, { ok: true, ask: { code: decided.code, name: decided.name, called: decided.called, zones: decided.ask } });
        return true;
      }
      const set = await this.host.country().set(body.code, decided.zone);
      if (!set.state) {
        this.host.json(response, 400, { ok: false, error: set.error });
        return true;
      }
      this.host.broadcast("country", set.state);
      this.host.broadcast("whats-new", {});
      let setup: SetupState | undefined;
      if (on === "phone" && !state.done && state.step === "country") {
        setup = (await this.host.setup().finish("country")).state;
        if (setup) this.host.broadcast("setup", setup);
      }
      this.host.json(response, 200, { ok: true, location: set.state satisfies CountryState, ...(setup ? { setup } : {}) });
      return true;
    }

    return false;
  }

  // The plan's sign-in, for the provider the household picked: null when
  // none was started for it.
  private async signInState() {
    const [ai, now] = await Promise.all([this.host.ai().read(), this.host.planSignIn().state()]);
    return now && now.provider === ai.provider && ai.path === "plan" ? now : null;
  }

  private state(): Promise<SetupState> {
    return this.host.setup().read();
  }

  // Where the step starts, from the phone's zone or the box's country.
  private async where(state: SetupState): Promise<{ start: Awaited<ReturnType<typeof startOn>>; phoneZone: string | null }> {
    const box = await this.host.country().read();
    return { start: await startOn(state.phoneZone, { code: box.code, zone: box.zone }), phoneZone: state.phoneZone };
  }
}
