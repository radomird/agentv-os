// A stand-in for the museum archives the art picker asks (daemon/art.ts):
// The Met's collection API with its recorded replies, and the Art Institute
// of Chicago's and Wikimedia Commons' with replies written to their
// documented shapes (test/agentv/fixtures/art/README.md). The pictures'
// addresses point back here, and each one is a small JPEG.

import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const FIXTURES = join(ROOT, "test/agentv/fixtures/art");

export interface Archives {
  // What the daemon's art option takes.
  options: { endpoints: Record<"met" | "aic" | "commons", string>; imageHosts: string[] };
  seen: { url: string; headers: IncomingHttpHeaders }[];
  // Each archive's API answers this status instead, as when it's down.
  down(status: number | null): void;
  close(): void;
}

const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

export async function startArchives(): Promise<Archives> {
  const seen: Archives["seen"] = [];
  let status: number | null = null;
  let here = "";
  // The recorded replies, with their pictures on this server.
  const local = (text: string) =>
    text
      .replaceAll("https://images.metmuseum.org/", `${here}/met-images/`)
      .replaceAll("https://www.artic.edu/iiif/2", `${here}/iiif/2`)
      .replaceAll("https://upload.wikimedia.org/", `${here}/upload/`);
  const json = (response: import("node:http").ServerResponse, text: string) => response.writeHead(200, { "Content-Type": "application/json" }).end(local(text));
  const jpeg = (response: import("node:http").ServerResponse, name: string) => response.writeHead(200, { "Content-Type": "image/jpeg" }).end(readFileSync(join(FIXTURES, name)));

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    seen.push({ url: url.pathname + url.search, headers: request.headers });
    const api = /^\/(met|aic|commons)(\/|$)/.test(url.pathname);
    if (api && status) return void response.writeHead(status, { "Content-Type": "text/html" }).end("<html>no</html>");

    // The Met: the search for "sea", and each recorded work.
    if (url.pathname === "/met/v1.1/search") {
      return void json(response, url.searchParams.get("q") === "sea" ? read("met-search.json") : '{"total":0,"objectIDs":null}');
    }
    const met = /^\/met\/v1\/objects\/(\d+)$/.exec(url.pathname);
    if (met) {
      try {
        return void json(response, read(`met-object-${met[1]}.json`));
      } catch {
        return void response.writeHead(404, { "Content-Type": "application/json" }).end('{"message":"Not a valid object"}');
      }
    }
    // The Art Institute: its search, and one work by its id.
    if (url.pathname === "/aic/artworks/search") return void json(response, read("aic-search.json"));
    const aic = /^\/aic\/artworks\/(\d+)$/.exec(url.pathname);
    if (aic) {
      const all = JSON.parse(read("aic-search.json"));
      const work = all.data.find((one: { id: number }) => String(one.id) === aic[1]);
      if (!work) return void response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
      return void json(response, JSON.stringify({ data: work, config: all.config }));
    }
    // Commons: its search, and one file by its page id.
    if (url.pathname === "/commons") {
      const all = JSON.parse(read("commons-search.json"));
      const id = url.searchParams.get("pageids");
      if (id) all.query.pages = all.query.pages.filter((page: { pageid: number }) => String(page.pageid) === id);
      return void json(response, JSON.stringify(all));
    }

    // The pictures.
    if (url.pathname.startsWith("/met-images/")) return void jpeg(response, "sea.jpg");
    if (url.pathname.startsWith("/iiif/2/")) return void jpeg(response, "lilies.jpg");
    if (url.pathname.includes("Not_free") || url.pathname.endsWith(".svg.png")) return void response.writeHead(404).end();
    if (url.pathname.startsWith("/upload/")) return void jpeg(response, url.pathname.includes("Harbour") ? "harbour.jpg" : "lilies.jpg");
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  here = `http://127.0.0.1:${port}`;
  return {
    options: { endpoints: { met: `${here}/met`, aic: `${here}/aic`, commons: `${here}/commons` }, imageHosts: [`127.0.0.1:${port}`] },
    seen,
    down: (next) => (status = next),
    close: () => server.close(),
  };
}
