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
  private listeners = new Map<string, ((params: any, sessionId?: string) => void)[]>();

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
      if (typeof message.method === "string" && message.id === undefined) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
        continue;
      }
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

  // Calls listener for each event of this method.
  on(method: string, listener: (params: any, sessionId?: string) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  // A session on the first page whose URL starts with prefix.
  private async attach(prefix: string): Promise<string> {
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
    return session!;
  }

  // Gives the page at prefix a function, window[name](json), that calls
  // handler here, and answers it through window[name + "Reply"](id, json). It
  // stays through reloads of the page. Only this pipe's holder can add one.
  async bind(prefix: string, name: string, handler: (request: any) => Promise<object>): Promise<void> {
    const session = await this.attach(prefix);
    this.on("Runtime.bindingCalled", async (params, sessionId) => {
      if (params.name !== name || sessionId !== session) return;
      let request: any;
      try {
        request = JSON.parse(params.payload);
      } catch {
        return;
      }
      const reply = await handler(request).catch((error: Error) => ({ ok: false, error: error.message }));
      const expression = `window.${name}Reply?.(${Number(request.id)}, ${JSON.stringify(JSON.stringify(reply))})`;
      await this.send("Runtime.evaluate", { expression, contextId: params.executionContextId }, session).catch(() => {});
    });
    await this.send("Runtime.addBinding", { name }, session);
  }

  // Runs an expression in the first page whose URL starts with prefix, and
  // returns its value, awaiting it when it's a promise.
  async evaluate(prefix: string, expression: string): Promise<any> {
    const session = await this.attach(prefix);
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
