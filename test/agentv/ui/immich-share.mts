// A stand-in for an Immich server, as an album's shared link sees it, for
// the Immich album background's tests (daemon/immich-album.ts). It answers
// with Immich 2.0's own replies, recorded from its containers
// (test/agentv/fixtures/immich-share): the link, its album of two photos,
// and a photo's preview for either of them. Another key, or a photo that
// isn't in the album, gets Immich's own refusal.

import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const FIXTURES = join(ROOT, "test/agentv/fixtures/immich-share");

interface Recording {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  file?: string;
}

const recording = (name: string): Recording => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

export interface ImmichShare {
  // The album's shared link, as Immich's Share gives it.
  link: string;
  url: string;
  seen: string[];
  // Changes the link's reply from now on, as for a link to some photos, or
  // one with a password.
  editLink(change: (body: Record<string, unknown>) => void): void;
  close(): void;
}

export async function startImmichShare(): Promise<ImmichShare> {
  const seen: string[] = [];
  let link = recording("shared-link");
  const album = recording("album");
  const inAlbum = new Set(((album.body as { assets: { id: string }[] }).assets ?? []).map((asset) => asset.id));
  const albumId = (album.body as { id: string }).id;

  const send = (response: ServerResponse, reply: Recording) => {
    if (reply.file) return void response.writeHead(reply.status, { "Content-Type": reply.headers["content-type"] }).end(readFileSync(join(FIXTURES, reply.file)));
    response.writeHead(reply.status, { "Content-Type": reply.headers["content-type"] }).end(JSON.stringify(reply.body));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    seen.push(url.pathname + url.search);
    if (url.searchParams.get("key") !== "fixture-key") return send(response, recording("wrong-key"));
    if (url.pathname === "/api/shared-links/me") return send(response, link);
    if (url.pathname === `/api/albums/${albumId}`) return send(response, album);
    const preview = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(url.pathname);
    if (preview && url.searchParams.get("size") === "preview") return send(response, inAlbum.has(preview[1]) ? recording("preview") : recording("not-shared"));
    response.writeHead(404, { "Content-Type": "application/json" }).end('{"message":"Cannot GET","statusCode":404}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    link: `${url}/share/fixture-key`,
    url,
    seen,
    editLink: (change) => {
      link = structuredClone(link);
      change(link.body as Record<string, unknown>);
    },
    close: () => server.close(),
  };
}
