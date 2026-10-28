// The Model Context Protocol, the little of it the harness needs: a server
// on standard input and output, one JSON-RPC message a line, that lists its
// tools and runs them. Every provider's CLI (claude, codex, gemini) starts
// the harness this way and calls only what it lists.

import { createInterface } from "node:readline";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

// A tool's answer the agent should read as a failure.
export class ToolError extends Error {}

interface Message {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
}

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// Serves tools on input and output until input ends. Every call, and every
// call to a tool that isn't there, goes to seen.
export function serve(
  tools: ToolSpec[],
  options: { name: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; seen?: (call: { tool: string; args: unknown; ok: boolean; answer: string }) => void },
): Promise<void> {
  const output = options.output ?? process.stdout;
  const send = (message: object) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const lines = createInterface({ input: options.input ?? process.stdin });
  let queue = Promise.resolve();

  const handle = async (message: Message) => {
    const { id, method, params } = message;
    const reply = (result: object) => id !== undefined && send({ id, result });
    const fail = (code: number, text: string) => id !== undefined && send({ id, error: { code, message: text } });
    switch (method) {
      case "initialize": {
        const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : VERSIONS[0];
        reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name, version: "1" } });
        return;
      }
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return;
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const tool = byName.get(name);
        if (!tool) {
          const answer = `${name} isn't a tool in this step`;
          options.seen?.({ tool: name, args, ok: false, answer });
          reply({ content: [{ type: "text", text: answer }], isError: true });
          return;
        }
        try {
          const answer = await tool.run(args);
          options.seen?.({ tool: name, args, ok: true, answer });
          reply({ content: [{ type: "text", text: answer }] });
        } catch (error) {
          const answer = error instanceof ToolError ? error.message : `${name} didn't work: ${(error as Error).message}`;
          options.seen?.({ tool: name, args, ok: false, answer });
          reply({ content: [{ type: "text", text: answer }], isError: true });
        }
        return;
      }
      default:
        if (method?.startsWith("notifications/")) return;
        fail(-32601, `${String(method)} isn't something this server does`);
    }
  };

  return new Promise((resolve) => {
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: "that isn't JSON" } });
        return;
      }
      queue = queue.then(() => handle(message)).catch(() => {});
    });
    lines.on("close", () => void queue.then(() => resolve()));
  });
}

// --- A client, for the stand-in provider and the tests -----------------------

export interface Client {
  list(): Promise<{ name: string }[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }>;
  close(): void;
}

export function client(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, close: () => void): Client {
  let next = 0;
  const waiting = new Map<number, (message: any) => void>();
  createInterface({ input }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } catch {
      // not ours
    }
  });
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = request("initialize", { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: "agentv-stand-in", version: "1" } }).then(() =>
    output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`),
  );
  return {
    async list() {
      await ready;
      return (await request("tools/list")).tools;
    },
    async call(name, args) {
      await ready;
      const result = await request("tools/call", { name, arguments: args });
      return { text: (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n"), error: result.isError === true };
    },
    close,
  };
}
