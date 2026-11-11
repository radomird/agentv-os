// Settings, controllers (ADR-084): Bluetooth game controllers, for the TV's
// own pages on 127.0.0.1.
//   - GET /api/controllers: whether the TV has Bluetooth, the controllers
//     paired with it, the ones nearby while it's looking, and the ones
//     plugged in with a cable;
//   - POST /api/controllers/look with {"on"}: starts looking, keeps it going
//     (the page asks every few seconds while it's open) or stops it;
//   - POST /api/controllers/pair with {"id"}: pairs one, so it comes back by
//     itself next time;
//   - DELETE /api/controllers/<id>: removes one;
//   - POST /api/controllers/power: turns Bluetooth on.
// Pairing, removing and turning Bluetooth on are an adult's, behind the PIN
// when one is set, as pairing a phone is. Anyone watching may see the list.
//
// BlueZ lets the person at the TV pair, not this daemon's own user, so each
// one is an ask the screen daemon takes, as the TV's owner, and answers
// (daemon/asks.ts, daemon/controllers.ts):
//   - GET /api/controllers/ask and POST /api/controllers/ask/<n>.
// It checks again there that a device is a game controller before it pairs
// or removes it, so nothing sent to these routes pairs a keyboard.
//
// The box check's count of gamepads is read fresh each time, and the TV's
// pages hear "box" after a change here, so it's right without a restart.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Asks } from "../asks.ts";
import type { Pad } from "../box.ts";
import { ADDRESS, cleanAnswer, type ControllerAnswer, type ControllerAsk } from "../controllers.ts";

export interface ControllersKit {
  // The game controllers the kernel has now, each with how it's connected.
  pads(): Promise<Pad[]>;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  broadcast(event: string, data: unknown): void;
  log(line: string): void;
  // True for an adult, past the PIN when one is set, having answered
  // otherwise.
  adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean>;
}

const LATE: ControllerAnswer = { ok: false, bluetooth: "none", looking: false, controllers: [], error: "the tv didn't answer in time: is its session running?" };

export class ControllerRoutes {
  private kit: ControllersKit;
  private asks = new Asks<ControllerAsk, ControllerAnswer>({ clean: cleanAnswer, late: LATE });
  private timers = new Set<ReturnType<typeof setTimeout>>();
  // How long the TV session gets to answer a quick ask.
  quickMs = 8000;

  constructor(kit: ControllersKit) {
    this.kit = kit;
  }

  close(): void {
    this.asks.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // What the page gets: the answer, and the controllers on a cable, which
  // need nothing. With no TV session to ask, Bluetooth is "away".
  private async state(answer: ControllerAnswer): Promise<object> {
    const usb = [...new Set((await this.kit.pads().catch(() => [])).filter((pad) => pad.bus !== "bluetooth").map((pad) => pad.name))].slice(0, 16);
    return { ...answer, bluetooth: answer === LATE ? "away" : answer.bluetooth, usb };
  }

  // The box check counts a controller once the kernel has it, a moment
  // after it connects, so the pages hear now and once more.
  private changed(): void {
    const tell = () => {
      this.kit.broadcast("controllers", {});
      this.kit.broadcast("box", {});
    };
    tell();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      tell();
    }, 3000);
    timer.unref?.();
    this.timers.add(timer);
  }

  async handle(method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (path !== "/api/controllers" && !path.startsWith("/api/controllers/")) return false;
    const { kit } = this;
    const quick = this.quickMs;

    // The screen daemon's side.
    if (method === "GET" && path === "/api/controllers/ask") {
      kit.json(response, 200, { ok: true, ask: await this.asks.take() });
      return true;
    }
    const answered = /^\/api\/controllers\/ask\/(\d+)$/.exec(path);
    if (method === "POST" && answered) {
      const known = this.asks.answer(Number(answered[1]), await kit.body(request));
      kit.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "that ask isn't waiting" });
      return true;
    }

    if (method === "GET" && path === "/api/controllers") {
      kit.json(response, 200, await this.state(await this.asks.ask({ kind: "list" }, quick)));
      return true;
    }
    if (method === "POST" && path === "/api/controllers/look") {
      const on = ((await kit.body(request)) as { on?: unknown } | undefined)?.on === true;
      kit.json(response, 200, await this.state(await this.asks.ask({ kind: "look", on }, quick)));
      return true;
    }
    if (method === "POST" && path === "/api/controllers/power") {
      if (!(await kit.adult(request, response, "turning bluetooth on"))) return true;
      const answer = await this.asks.ask({ kind: "power" }, 20_000);
      if (answer.ok) kit.log("bluetooth was turned on from settings");
      kit.json(response, 200, await this.state(answer));
      return true;
    }
    if (method === "POST" && path === "/api/controllers/pair") {
      const id = ((await kit.body(request)) as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !ADDRESS.test(id)) {
        kit.json(response, 400, { ok: false, error: "id is a controller from the list" });
        return true;
      }
      if (!(await kit.adult(request, response, "pairing a controller"))) return true;
      // Pairing takes as long as the controller does.
      const answer = await this.asks.ask({ kind: "pair", id }, 100_000);
      kit.log(answer.ok ? "a controller was paired from settings" : `a controller didn't pair: ${answer.error ?? "no reason"}`);
      if (answer.ok) this.changed();
      kit.json(response, 200, await this.state(answer));
      return true;
    }
    const one = /^\/api\/controllers\/([0-9A-F]{2}(?::[0-9A-F]{2}){5})$/.exec(path);
    if (method === "DELETE" && one) {
      if (!(await kit.adult(request, response, "removing a controller"))) return true;
      const answer = await this.asks.ask({ kind: "remove", id: one[1] }, 25_000);
      kit.log(answer.ok ? "a controller was removed from settings" : `a controller wasn't removed: ${answer.error ?? "no reason"}`);
      if (answer.ok) this.changed();
      kit.json(response, 200, await this.state(answer));
      return true;
    }
    kit.json(response, 404, { ok: false, error: "not found" });
    return true;
  }
}
