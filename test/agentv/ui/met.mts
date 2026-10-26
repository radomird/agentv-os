// A stand-in for MET Norway's Locationforecast, for the tests of the
// built-in Weather app: it answers with a recorded reply whose steps are
// moved to start this hour, so the weather "now" is the recorded first step
// whenever the test runs. Amsterdam's, recorded on 2026-10-25: partly
// cloudy with 11.2 m/s of wind, so windy, at 12°.

import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

export interface Met {
  url: string; // the forecast's address, as the weather's forecastUrl
  seen: { url: string; headers: IncomingHttpHeaders }[];
  down(on: boolean): void;
  // Another place's recorded reply from now on, as when MET updates its
  // forecast, and how long each reply says it's good for.
  serve(place: string): void;
  // The same, but only after the next reply: MET publishing a new forecast
  // just after someone asked.
  serveAfterNext(place: string): void;
  expiresIn(ms: number): void;
  close(): void;
}

export function recordedReply(place = "amsterdam"): { zone: string; recorded: string; body: unknown } {
  return JSON.parse(readFileSync(join(ROOT, `test/agentv/fixtures/met/${place}.json`), "utf8"));
}

export function shifted(body: unknown, at = Date.now()): unknown {
  const copy = structuredClone(body) as { properties: { timeseries: { time: string }[] } };
  const first = new Date(copy.properties.timeseries[0].time).getTime();
  const hour = Math.floor(at / 3_600_000) * 3_600_000;
  for (const step of copy.properties.timeseries) step.time = new Date(new Date(step.time).getTime() - first + hour).toISOString();
  return copy;
}

export async function startMet(place = "amsterdam"): Promise<Met> {
  let reply = recordedReply(place);
  const seen: Met["seen"] = [];
  let next: ReturnType<typeof recordedReply> | null = null;
  let isDown = false;
  let expiresMs = 30 * 60_000;
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    if (isDown) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", Expires: new Date(Date.now() + expiresMs).toUTCString() });
    response.end(JSON.stringify(shifted(reply.body)));
    if (next) {
      reply = next;
      next = null;
    }
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return {
    url: `http://127.0.0.1:${port}/weatherapi/locationforecast/2.0/compact`,
    seen,
    down: (on) => {
      isDown = on;
    },
    serve: (other) => {
      reply = recordedReply(other);
    },
    serveAfterNext: (other) => {
      next = recordedReply(other);
    },
    expiresIn: (ms) => {
      expiresMs = ms;
    },
    close: () => server.close(),
  };
}
