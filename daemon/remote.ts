// The phone's d-pad and keyboard on the TV (ADR-008, stage 4): the daemon
// takes them from a paired phone, and this, in the TV session's screen
// daemon, holds its stream open and hands each one to the virtual input
// device (input.py), so they reach whatever's in front. What's typed can be
// a password, so it's never logged (ADR-032).

import { createConnection } from "node:net";
import { join } from "node:path";

export interface RemoteOptions {
  url: string; // the daemon's stream: http://127.0.0.1:3000/api/remote
  // Who takes the stream: the screen daemon ("1"), or Omarchy's desktop
  // ("desktop"), while it's on, for the phone's trackpad (ADR-037).
  as?: "1" | "desktop";
  // Hands one request to the virtual input device: {"key": "up"}, {"text": ...}.
  send?: (request: Record<string, unknown>) => Promise<void>;
  // What the TV session does for a phone, past the PIN the daemon checked:
  // {"cmd": "update-install"}, Install now from the phone (S4.8).
  command?: (cmd: string) => Promise<void>;
  log?: (line: string) => void;
  retryMs?: number;
}

// One JSON line to input.py's socket, and its answer.
export function sendInput(request: Record<string, unknown>, socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`, "agentv", "input.sock")): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let answer = "";
    connection.setEncoding("utf8");
    connection.setTimeout(10_000, () => connection.destroy(new Error("the virtual input device didn't answer")));
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (chunk: string) => {
      answer += chunk;
      if (!answer.includes("\n")) return;
      connection.end();
      if (answer.trim() === "ok") resolve();
      // input.py's errors never name what was typed.
      else reject(new Error(answer.trim()));
    });
    connection.on("error", (error) => reject(new Error(`the virtual input device isn't there (${(error as NodeJS.ErrnoException).code ?? error.message})`)));
  });
}

export class RemoteInput {
  private url: string;
  private as: string;
  private send: (request: Record<string, unknown>) => Promise<void>;
  private command: (cmd: string) => Promise<void>;
  private log: (line: string) => void;
  private retryMs: number;
  private stopped = false;
  private abort?: AbortController;
  // One at a time, in order, so typed text comes out as it was typed.
  private chain: Promise<void> = Promise.resolve();
  private failed = "";

  constructor(options: RemoteOptions) {
    this.url = options.url;
    this.as = options.as ?? "1";
    this.send = options.send ?? ((request) => sendInput(request));
    this.command = options.command ?? (async () => {});
    this.log = options.log ?? ((line) => console.log(line));
    this.retryMs = options.retryMs ?? 2000;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  // Waits for what's been sent so far, for the tests.
  idle(): Promise<void> {
    return this.chain;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(this.url, { headers: { "X-AgenTV-Screen": this.as }, signal: this.abort.signal });
        if (!response.ok || !response.body) throw new Error(`the daemon answered ${response.status}`);
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (data) this.take(data.slice(6));
          }
        }
      } catch (error) {
        if (this.stopped) return;
        const message = (error as Error).message;
        if (message !== this.failed) this.log(`phone input: ${message}; trying again`);
        this.failed = message;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
  }

  private take(json: string): void {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(json);
    } catch {
      return;
    }
    const cmd = typeof request.cmd === "string" ? request.cmd : null;
    this.chain = this.chain
      .then(() => (cmd ? this.command(cmd) : this.send(request)))
      .then(() => {
        this.failed = "";
      })
      .catch((error: Error) => {
        // Never the text itself: only what went wrong.
        this.log(`phone input: ${error.message}`);
      });
  }
}
