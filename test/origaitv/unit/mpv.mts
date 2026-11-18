// A stand-in for mpv on its socket, for Music's player (daemon/music.ts):
// a playlist, a pause flag, and a clock that runs while a track plays. A
// track that reaches its end gives way to the next one, and the last one to
// nothing, as mpv does when it's started to wait. A seek is answered at
// once and is there a little later, which is how mpv does it too.

import { createServer, type Server } from "node:net";

export interface StandInMpv {
  server: Server;
  // Every command it got, in order.
  commands: unknown[][];
  // Where the track that plays is, in seconds, or null with nothing loaded.
  place(): number | null;
  // Which entry of its playlist plays, or -1.
  index(): number;
  close(): void;
}

export interface StandInMpvOptions {
  // How long every track runs, in seconds.
  duration?: number;
  // How long a seek takes to land.
  seekMs?: number;
}

export function standInMpv(socket: string, options: StandInMpvOptions = {}): StandInMpv {
  const duration = options.duration ?? 2;
  const commands: unknown[][] = [];
  const state = { playlist: [] as string[], pos: -1, pause: true, from: 0, since: Date.now() };
  const put = (seconds: number) => {
    state.from = seconds;
    state.since = Date.now();
  };
  const place = () => state.from + (state.pause ? 0 : (Date.now() - state.since) / 1000);
  const go = (pos: number) => {
    state.pos = pos;
    put(0);
  };
  // A track that ran out: the next one from its start, or nothing.
  const settle = () => {
    if (state.playlist.length === 0 || place() < duration) return;
    if (state.pos + 1 < state.playlist.length) go(state.pos + 1);
    else {
      state.playlist = [];
      state.pos = -1;
    }
  };
  const server = createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const { command, request_id } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        commands.push(command);
        settle();
        let data: unknown = null;
        let error = "success";
        const [name, a, b] = command;
        if (name === "loadfile") {
          if (b === "replace") {
            state.playlist = [a];
            go(0);
          } else state.playlist.push(a);
        } else if (name === "set_property" && a === "pause") {
          put(place());
          state.pause = b;
        } else if (name === "cycle" && a === "pause") {
          put(place());
          state.pause = !state.pause;
        } else if (name === "playlist-next") {
          if (state.pos + 1 < state.playlist.length) go(state.pos + 1);
        } else if (name === "playlist-prev") {
          if (state.pos > 0) go(state.pos - 1);
        } else if (name === "stop") {
          state.playlist = [];
          state.pos = -1;
        } else if (name === "seek") {
          if (state.playlist.length === 0 || typeof a !== "number" || !String(b).startsWith("absolute")) error = "error running command";
          else setTimeout(() => put(a), options.seekMs ?? 0).unref();
        } else if (name === "get_property") {
          const loaded = state.playlist.length > 0;
          data = { "playlist-pos": state.pos, "time-pos": loaded ? Math.min(place(), duration) : null, duration: loaded ? duration : null, pause: state.pause, "idle-active": !loaded }[a as string];
        }
        connection.write(`${JSON.stringify({ request_id, error, data })}\n`);
      }
    });
  });
  server.listen(socket);
  return {
    server,
    commands,
    place: () => (settle(), state.playlist.length > 0 ? place() : null),
    index: () => (settle(), state.pos),
    close: () => void server.close(),
  };
}
