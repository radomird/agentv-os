// The TV's size (ADR-062, daemon/display.ts):
//   - GET /api/display: what's picked, and the mode, scale, canvas and the
//     sizes this TV offers;
//   - PUT /api/display with {"size"} or {"output"}: picks one, and the screen
//     daemon applies it at once. The answer is the new state, and the TV's
//     pages hear the display event. A child's profile needs the adult PIN
//     for it, as for the look.
// And for the screen daemon, which holds Hyprland in the TV session:
//   - POST /api/display/tv: the TV it sees, answered with what to set it to;
//   - GET /api/display/ask and POST /api/display/ask/<n>: the daemon's asks
//     to set it, one at a time (daemon/asks.ts).
//
// When the box check finds the box can't keep 4K smooth (ADR-061), follow()
// moves the TV to 1080p output at once, unless someone picked the output.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Asks } from "../asks.ts";
import { cleanDisplayAnswer, Display, type DisplayAnswer, type DisplayAsk } from "../display.ts";

// How long a size change waits for the screen daemon to set it.
const APPLY_MS = 5000;
// How long the box check's verdict is kept here before it's read again.
const VERDICT_MS = 10 * 60_000;

export interface DisplayKit {
  state: string; // the daemon's state: display.json goes in it
  sizes(): Promise<boolean>; // the sizes switch
  // The box check's kept verdict on 4K: true or false once it has measured
  // this box, null before.
  fourKSmooth(): Promise<boolean | null>;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  broadcast(event: string, data: unknown): void;
  log(line: string): void;
  // True when the active profile may change it, having answered otherwise.
  adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean>;
}

export class DisplayRoutes {
  private kit: DisplayKit;
  private model: Display;
  private asks = new Asks<DisplayAsk, DisplayAnswer>({ clean: cleanDisplayAnswer, late: { ok: false, error: "the tv didn't answer in time: is its session running?", late: true } });
  private verdict: { at: number; value: Promise<boolean | null> } | null = null;

  constructor(kit: DisplayKit) {
    this.kit = kit;
    this.model = new Display({ state: kit.state, on: () => kit.sizes(), fourKSmooth: () => this.fourKSmooth() });
  }

  private fourKSmooth(): Promise<boolean | null> {
    if (!this.verdict || Date.now() - this.verdict.at > VERDICT_MS) {
      this.verdict = { at: Date.now(), value: this.kit.fourKSmooth().catch(() => null) };
    }
    return this.verdict.value;
  }

  // Sets the TV to what the daemon says now, when its session runs, and
  // tells the TV's pages. Whether the screen daemon set it.
  private async apply(): Promise<boolean> {
    const target = await this.model.target();
    if (!target) return false;
    const answer = await this.asks.ask({ target }, APPLY_MS);
    if (!answer.ok) this.kit.log(`display: ${answer.error ?? "the tv didn't take the new size"}`);
    if (answer.live) await this.model.live(answer.live);
    return answer.ok;
  }

  // The box check has news: its verdict is read again, and the TV follows
  // it if it changes what the TV should run at.
  async follow(): Promise<void> {
    this.verdict = null;
    const target = await this.model.target();
    if (!target || (await this.model.runs(target))) return;
    await this.apply();
    const state = await this.model.state();
    this.kit.log(`display: the box check moved the tv to ${state.mode}, scale ${state.scale}`);
    this.kit.broadcast("display", state);
  }

  async handle(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const { kit, model } = this;
    if (path === "/api/display" && method === "GET") {
      kit.json(response, 200, { ok: true, ...(await model.state()) });
      return true;
    }

    if (path === "/api/display" && method === "PUT") {
      if (!(await kit.adult(request, response, "changing the size"))) return true;
      const chosen = await model.choose(await kit.body(request));
      if (!chosen.ok) {
        kit.json(response, chosen.status, { ok: false, error: chosen.error });
        return true;
      }
      // Set now, when the TV session runs. It's kept either way, and the
      // next session starts at it.
      const applied = await this.apply();
      const state = await model.state();
      kit.log(`display: ${state.size}, ${state.output}${state.mode ? ` (${state.mode}, scale ${state.scale})` : ""}`);
      kit.broadcast("display", state);
      kit.json(response, 200, { ok: true, ...state, applied });
      return true;
    }

    if (path === "/api/display/tv" && method === "POST") {
      const said = await model.reported(await kit.body(request));
      if (!said.ok) {
        kit.json(response, 400, { ok: false, error: said.error });
        return true;
      }
      if (said.changed) kit.broadcast("display", await model.state());
      kit.json(response, 200, { ok: true, target: await model.target() });
      return true;
    }

    if (path === "/api/display/ask" && method === "GET") {
      kit.json(response, 200, { ok: true, ask: await this.asks.take() });
      return true;
    }
    const answered = /^\/api\/display\/ask\/(\d+)$/.exec(path);
    if (answered && method === "POST") {
      const known = this.asks.answer(Number(answered[1]), await kit.body(request));
      kit.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "nothing is waiting for that answer" });
      return true;
    }
    return false;
  }

  close(): void {
    this.asks.close();
  }
}
