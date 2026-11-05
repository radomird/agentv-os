// The TV's size (ADR-062, daemon/display.ts):
//   - GET /api/display: what's picked, and the mode, scale, canvas and the
//     sizes this TV offers;
//   - PUT /api/display with {"size"} or {"output"}: picks one, and the screen
//     daemon applies it at once. The answer is the new state, and the TV's
//     pages hear the display event.
// And for the screen daemon, which holds Hyprland in the TV session:
//   - POST /api/display/tv: the TV it sees, answered with what to set it to;
//   - GET /api/display/ask and POST /api/display/ask/<n>: the daemon's asks
//     to set it, one at a time (daemon/asks.ts).

import { Asks } from "../asks.ts";
import { cleanDisplayAnswer, Display, type DisplayAnswer, type DisplayAsk } from "../display.ts";
import type { Kit, Route } from "./kit.ts";

// How long a size change waits for the screen daemon to set it.
const APPLY_MS = 5000;

// The box check's verdict on 4K, from its own route (GET /api/box), or null
// while that isn't there or doesn't know.
async function fourKSmooth(kit: Kit): Promise<boolean | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${kit.port()}/api/box`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const box = (await response.json()) as { verdicts?: { fourKSmooth?: unknown } };
    return typeof box.verdicts?.fourKSmooth === "boolean" ? box.verdicts.fourKSmooth : null;
  } catch {
    return null;
  }
}

export function display(kit: Kit): Route {
  const model = new Display({ state: kit.state, on: () => kit.features.on("sizes"), fourKSmooth: () => fourKSmooth(kit) });
  const asks = new Asks<DisplayAsk, DisplayAnswer>({ clean: cleanDisplayAnswer, late: { ok: false, error: "the tv didn't answer in time: is its session running?", late: true } });

  return {
    async handle(method, path, request, response) {
      if (path === "/api/display" && method === "GET") {
        kit.json(response, 200, { ok: true, ...(await model.state()) });
        return true;
      }

      if (path === "/api/display" && method === "PUT") {
        const chosen = await model.choose(await kit.body(request));
        if (!chosen.ok) {
          kit.json(response, chosen.status, { ok: false, error: chosen.error });
          return true;
        }
        // Set now, when the TV session runs. It's kept either way, and the
        // next session starts at it.
        const target = await model.target();
        let applied = false;
        if (target) {
          const answer = await asks.ask({ target }, APPLY_MS);
          applied = answer.ok;
          if (!answer.ok) kit.log(`display: ${answer.error ?? "the tv didn't take the new size"}`);
          if (answer.live) await model.live(answer.live);
        }
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
        kit.json(response, 200, { ok: true, ask: await asks.take() });
        return true;
      }
      const answered = /^\/api\/display\/ask\/(\d+)$/.exec(path);
      if (answered && method === "POST") {
        const known = asks.answer(Number(answered[1]), await kit.body(request));
        kit.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "nothing is waiting for that answer" });
        return true;
      }
      return false;
    },

    close() {
      asks.close();
    },
  };
}

