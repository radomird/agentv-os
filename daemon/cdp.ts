// The Chrome DevTools Protocol over a pipe (--remote-debugging-pipe): the
// browser reads commands on its fd 3 and answers on its fd 4, each message
// JSON ending in a NUL. Only the process that started the browser holds the
// pipe, so nothing else on the box can drive the home screen this way, and
// no debugging port is open.

import type { Readable, Writable } from "node:stream";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class CdpPipe {
  private out: Writable;
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private sessions = new Map<string, string>();

  constructor(out: Writable, input: Readable) {
    this.out = out;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    const fail = () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("the browser closed its DevTools pipe"));
      }
      this.pending.clear();
    };
    input.on("close", fail);
    input.on("error", fail);
    out.on("error", fail);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (waiting) {
        this.pending.delete(message.id);
        if (message.error) {
          waiting.reject(new Error(message.error.message ?? "DevTools error"));
        } else {
          waiting.resolve(message.result);
        }
      }
    }
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }

  // Runs an expression in the first page whose URL starts with prefix, and
  // returns its value, awaiting it when it's a promise.
  async evaluate(prefix: string, expression: string): Promise<any> {
    let session = this.sessions.get(prefix);
    if (!session) {
      const { targetInfos } = await this.send("Target.getTargets");
      const page = targetInfos.find((t: any) => t.type === "page" && String(t.url).startsWith(prefix));
      if (!page) {
        throw new Error(`no page at ${prefix}`);
      }
      ({ sessionId: session } = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
      this.sessions.set(prefix, session!);
    }
    try {
      const reply = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (reply.exceptionDetails) {
        throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      }
      return reply.result.value;
    } catch (error) {
      // A reloaded page is a new target; attach again next time.
      this.sessions.delete(prefix);
      throw error;
    }
  }
}
