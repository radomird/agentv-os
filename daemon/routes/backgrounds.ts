// The Omarchy theme's videos, from the TV session to home (ADR-064,
// daemon/theme-videos.ts):
// - GET (or HEAD) /api/backgrounds/video/<id>: a video background or an intro,
//   in the parts home asks for, streamed from where the TV session serves it;
// - POST /api/backgrounds/intro with { due, how, why }: what home did with the
//   intro that was due, played or the still, and why.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Backgrounds } from "../backgrounds.ts";
import { streamVideo } from "../theme-videos.ts";

export interface BackgroundRoutes {
  backgrounds: Backgrounds;
  body: (request: IncomingMessage) => Promise<unknown>;
  json: (response: ServerResponse, status: number, data: unknown) => void;
}

// True when the request was one of these, and has been answered.
export async function backgroundVideoRoutes(kit: BackgroundRoutes, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const method = request.method;
  const video = /^\/api\/backgrounds\/video\/([0-9a-f]{16})$/.exec(path);
  if (video && (method === "GET" || method === "HEAD")) {
    const found = await kit.backgrounds.video(video[1]);
    if (!found) kit.json(response, 404, { ok: false, error: "no such video" });
    else streamVideo(found.base, found.id, request, response);
    return true;
  }
  if (method === "POST" && path === "/api/backgrounds/intro") {
    const result = await kit.backgrounds.introShown(await kit.body(request));
    if (!result.state) kit.json(response, 400, { ok: false, error: result.error });
    else kit.json(response, 200, { ok: true, introShown: result.state.theme.introShown });
    return true;
  }
  return false;
}
