// Hyprland's IPC, for AgenTV's screen daemon (ADR-031): hyprctl for requests
// and Hyprland's event socket for what happens (https://wiki.hypr.land/ipc/).
// The real one talks to the TV session's Hyprland; the unit tests hand the
// screen daemon a fake with the same shape.

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";

export interface Client {
  address: string;
  pid: number;
  class: string;
  initialClass: string;
  title: string;
  workspace: { id: number; name: string };
  fullscreen: number;
  mapped: boolean;
}

export interface Monitor {
  name: string;
  width: number;
  height: number;
  refreshRate: number;
  focused: boolean;
  // The special workspace shown on it, with an empty name when there's none.
  specialWorkspace?: { id: number; name: string };
}

export interface Layer {
  namespace: string;
  pid: number;
}

export interface Hyprland {
  clients(): Promise<Client[]>;
  monitors(): Promise<Monitor[]>;
  layers(): Promise<Layer[]>;
  // A Lua dispatcher expression, such as hl.dsp.focus({ window = "address:0x1" }).
  dispatch(expression: string): Promise<void>;
  // Calls handler with each event's name and data, such as
  // "openwindow" and "0x1,special:agentv-held,foot,foot".
  events(handler: (name: string, data: string) => void, closed: () => void): void;
}

// A Lua string literal, for a value put into a dispatcher expression.
export function lua(value: string): string {
  return JSON.stringify(value);
}

function hyprctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("hyprctl", args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`hyprctl ${args.join(" ")}: ${stderr || error.message}`.trim()));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function json<T>(what: string): Promise<T> {
  return JSON.parse(await hyprctl(["-j", what])) as T;
}

export function connect(): Hyprland {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!signature || !runtime) {
    throw new Error("HYPRLAND_INSTANCE_SIGNATURE and XDG_RUNTIME_DIR have to be set; the TV session imports them at start");
  }

  return {
    clients: () => json<Client[]>("clients"),
    monitors: () => json<Monitor[]>("monitors"),

    async layers() {
      // { "DP-1": { "levels": { "3": [ { "namespace": ..., "pid": ... } ] } } }
      const outputs = await json<Record<string, { levels: Record<string, Layer[]> }>>("layers");
      const all: Layer[] = [];
      for (const output of Object.values(outputs)) {
        for (const level of Object.values(output.levels ?? {})) {
          all.push(...level);
        }
      }
      return all;
    },

    async dispatch(expression) {
      const out = (await hyprctl(["dispatch", expression])).trim();
      if (out !== "ok" && out !== "") {
        throw new Error(`hyprctl dispatch ${expression}: ${out}`);
      }
    },

    events(handler, closed) {
      const socket = createConnection(join(runtime, "hypr", signature, ".socket2.sock"));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const split = line.indexOf(">>");
          if (split > 0) {
            handler(line.slice(0, split), line.slice(split + 2));
          }
        }
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", closed);
    },
  };
}
