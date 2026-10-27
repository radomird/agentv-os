// The key relay (ADR-011, ADR-045): the one place a build's requests to its
// AI provider pick up the household's key. It runs outside the sandbox, as
// its own user, with the key as a credential systemd hands it, so the
// builder never holds a key of any kind. Inside the sandbox, the CLI talks
// to the relay as if it were the provider, with a stand-in for a key.
//
// It passes on only the provider's model calls, refuses a model it can't
// price and any tool the provider would run itself, such as web search,
// which would go round the sandbox's filter. It reads what each answer
// used, prices it (prices.ts), and keeps the spend: each build's and the
// month's, across all agent work. Once either reaches its cap, the next
// request is refused, so a build stops within one request of its cap, on
// any provider, whether or not its CLI has a budget flag of its own.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import type { Provider } from "../build.ts";
import { cost, NO_USAGE, rateFor, type Usage } from "./prices.ts";

// What root says the running build is (bin/agentv-build-start), in a file
// only root can write.
export interface Ticket {
  build: string;
  id: string;
  version: string;
  dir: string;
  provider: Provider;
  path: "plan" | "key";
  recipe: string | null;
  origins?: string[]; // an approved plan's, when there's no recipe
  // Dollars, with a key: changeable behind the PIN (ADR-011).
  cap?: { build: number; month: number };
}

export const DEFAULT_CAP = { build: 5, month: 20 };

export interface Spend {
  month: string; // 2026-10
  spent: number;
  builds: Record<string, number>;
}

export const UPSTREAM: Record<Provider, string> = {
  claude: "https://api.anthropic.com",
  chatgpt: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

// The calls a CLI makes for a model's answer, and the free ones beside them.
const CALLS: Record<Provider, { method: string; path: RegExp; priced: boolean }[]> = {
  claude: [
    { method: "POST", path: /^\/v1\/messages(\?.*)?$/, priced: true },
    { method: "POST", path: /^\/v1\/messages\/count_tokens(\?.*)?$/, priced: false },
    { method: "GET", path: /^\/v1\/models(\/[\w.-]+)?(\?.*)?$/, priced: false },
  ],
  chatgpt: [
    { method: "POST", path: /^\/v1\/responses(\?.*)?$/, priced: true },
    { method: "GET", path: /^\/v1\/models(\/[\w.-]+)?(\?.*)?$/, priced: false },
  ],
  gemini: [
    { method: "POST", path: /^\/v1beta\/models\/[\w.-]+:(streamGenerateContent|generateContent)(\?.*)?$/, priced: true },
    { method: "POST", path: /^\/v1beta\/models\/[\w.-]+:countTokens(\?.*)?$/, priced: false },
    { method: "GET", path: /^\/v1beta\/models(\/[\w.-]+)?(\?.*)?$/, priced: false },
  ],
};

// The key's line in /etc/agentv/env (bin/agentv-key-store).
const KEY_VARS: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", chatgpt: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

export function keyFrom(env: string, provider: Provider): string | null {
  for (const line of env.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] === KEY_VARS[provider] && match[2]) return match[2].replace(/^"|"$/g, "");
  }
  return null;
}

const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"];
const AUTH = ["authorization", "x-api-key", "x-goog-api-key", "openai-organization", "openai-project", "anthropic-admin-key"];

// What's wrong with a request's tools: any the provider would run itself.
// The agent's tools are AgenTV's harness, which the CLI calls; a provider's
// own web search or code runner would reach the internet round the filter.
export function serverTools(provider: Provider, body: Record<string, unknown>): string | null {
  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    if (provider === "claude" && typeof tool.type === "string" && tool.type !== "custom") return tool.type;
    if (provider === "chatgpt" && typeof tool.type === "string" && tool.type !== "function" && tool.type !== "custom") return tool.type;
    if (provider === "gemini") {
      const own = Object.keys(tool).find((name) => name !== "functionDeclarations");
      if (own) return own;
    }
  }
  return null;
}

// Usage, as each provider reports it, added up over an answer's events. A
// streamed answer reports it as it goes; the last count of each kind wins.
export class Meter {
  usage: Usage = { ...NO_USAGE };
  seen = false;
  private provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  read(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, any>;
    const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    if (this.provider === "claude") {
      // message_start has the input; message_delta the output so far. An
      // answer that isn't streamed has both in its usage.
      const usage = e.type === "message_start" ? e.message?.usage : e.type === "message_delta" ? e.usage : e.type === "message" ? e.usage : null;
      if (!usage) return;
      this.seen = true;
      if (usage.input_tokens !== undefined) this.usage.input = n(usage.input_tokens);
      if (usage.cache_read_input_tokens !== undefined) this.usage.cacheRead = n(usage.cache_read_input_tokens);
      if (usage.cache_creation !== undefined) {
        this.usage.cacheWrite5m = n(usage.cache_creation?.ephemeral_5m_input_tokens);
        this.usage.cacheWrite1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
      } else if (usage.cache_creation_input_tokens !== undefined) {
        this.usage.cacheWrite5m = n(usage.cache_creation_input_tokens);
      }
      if (usage.output_tokens !== undefined) this.usage.output = n(usage.output_tokens);
      return;
    }
    if (this.provider === "chatgpt") {
      // The Responses API: response.completed, .incomplete or .failed carry
      // the whole answer's usage, and so does an answer that isn't streamed.
      const usage = e.response?.usage ?? (e.object === "response" ? e.usage : null);
      if (!usage) return;
      this.seen = true;
      const cached = n(usage.input_tokens_details?.cached_tokens);
      this.usage.cacheRead = cached;
      this.usage.input = Math.max(0, n(usage.input_tokens) - cached);
      this.usage.output = n(usage.output_tokens);
      return;
    }
    // Gemini: each chunk has usageMetadata so far; thinking is billed as
    // output.
    const usage = e.usageMetadata;
    if (!usage) return;
    this.seen = true;
    const cached = n(usage.cachedContentTokenCount);
    this.usage.cacheRead = cached;
    this.usage.input = Math.max(0, n(usage.promptTokenCount) + n(usage.toolUsePromptTokenCount) - cached);
    this.usage.output = n(usage.candidatesTokenCount) + n(usage.thoughtsTokenCount);
  }

  // Server-sent events, as they come, whole lines at a time.
  private buffer = "";
  sse(chunk: string): void {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      try {
        this.read(JSON.parse(line.slice(5).trim()));
      } catch {}
    }
  }

  // A whole JSON answer, or Gemini's array of chunks.
  json(text: string): void {
    try {
      const body = JSON.parse(text);
      for (const part of Array.isArray(body) ? body : [body]) this.read(part);
    } catch {}
  }
}

export interface RelayOptions {
  ticket: () => Ticket | null;
  key: (provider: Provider) => string | null;
  spendPath: string;
  upstream?: Partial<Record<Provider, string>>; // for the tests, on http
  log?: (line: string) => void;
  now?: () => Date;
}

export class Relay {
  readonly server: Server;
  private options: RelayOptions;
  private log: (line: string) => void;

  constructor(options: RelayOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  listen(where: number | string = 0, host = "127.0.0.1"): Promise<number | string> {
    return new Promise((resolve) => {
      if (typeof where === "string") this.server.listen(where, () => resolve(where));
      else this.server.listen(where, host, () => resolve((this.server.address() as { port: number }).port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private month(): string {
    return (this.options.now?.() ?? new Date()).toISOString().slice(0, 7);
  }

  // This month's spend, a new month starting from nothing.
  spend(): Spend {
    const month = this.month();
    try {
      const spend = JSON.parse(readFileSync(this.options.spendPath, "utf8")) as Spend;
      if (spend.month === month && typeof spend.spent === "number") return { month, spent: spend.spent, builds: spend.builds ?? {} };
    } catch {}
    return { month, spent: 0, builds: {} };
  }

  private add(build: string, dollars: number): Spend {
    const spend = this.spend();
    spend.spent = Math.round((spend.spent + dollars) * 1e6) / 1e6;
    spend.builds[build] = Math.round(((spend.builds[build] ?? 0) + dollars) * 1e6) / 1e6;
    mkdirSync(dirname(this.options.spendPath), { recursive: true });
    const next = `${this.options.spendPath}.next`;
    writeFileSync(next, `${JSON.stringify(spend, null, 2)}\n`, { mode: 0o644 });
    renameSync(next, this.options.spendPath);
    return spend;
  }

  // Why a build may not ask for more, if it may not.
  private capped(ticket: Ticket): string | null {
    const cap = { ...DEFAULT_CAP, ...ticket.cap };
    const spend = this.spend();
    if ((spend.builds[ticket.build] ?? 0) >= cap.build) return "the build reached its spend cap";
    if (spend.spent >= cap.month) return "this month's agent spend reached its cap";
    return null;
  }

  private refuse(response: ServerResponse, provider: Provider | null, status: number, message: string): void {
    this.log(`refused: ${message}`);
    // Shaped like the provider's own errors, so its CLI says why it stopped.
    const body =
      provider === "claude"
        ? { type: "error", error: { type: status === 403 ? "permission_error" : "invalid_request_error", message } }
        : provider === "gemini"
          ? { error: { code: status, message, status: status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT" } }
          : { error: { message, type: status === 403 ? "insufficient_quota" : "invalid_request_error" } };
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = this.options.ticket();
    if (!ticket || ticket.path !== "key") return this.refuse(response, ticket?.provider ?? null, 403, "no build with a key is running");
    const provider = ticket.provider;
    const url = request.url ?? "/";
    const call = CALLS[provider].find((c) => c.method === request.method && c.path.test(url));
    if (!call) return this.refuse(response, provider, 403, `${request.method} ${url.split("?")[0]} isn't a call the builder makes`);

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
      if (chunks.reduce((sum, c) => sum + c.length, 0) > 32 * 1024 * 1024) return this.refuse(response, provider, 413, "that request is too big");
    }
    const raw = Buffer.concat(chunks);

    let model = "";
    let fast = false;
    if (call.priced) {
      const why = this.capped(ticket);
      if (why) return this.refuse(response, provider, 403, why);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return this.refuse(response, provider, 400, "that request isn't JSON");
      }
      const own = serverTools(provider, body);
      if (own) return this.refuse(response, provider, 400, `the provider's own ${own} tool isn't allowed: the builder reaches the internet only through its filter`);
      model = provider === "gemini" ? (/^\/v1beta\/models\/([\w.-]+):/.exec(url)?.[1] ?? "") : String(body.model ?? "");
      if (!rateFor(provider, model)) return this.refuse(response, provider, 400, `the relay doesn't know what ${model || "that model"} costs, so it can't keep the build inside its cap`);
      fast = provider === "claude" && body.speed === "fast";
    }

    const key = this.options.key(provider);
    if (!key) return this.refuse(response, provider, 403, "there's no key for this provider on the box");
    const headers: IncomingHttpHeaders = { ...request.headers };
    for (const name of [...HOP, ...AUTH]) delete headers[name];
    if (provider === "claude") headers["x-api-key"] = key;
    else if (provider === "chatgpt") headers.authorization = `Bearer ${key}`;
    else headers["x-goog-api-key"] = key;
    headers["content-length"] = String(raw.length);

    const base = new URL(this.options.upstream?.[provider] ?? UPSTREAM[provider]);
    const meter = new Meter(provider);
    const send = base.protocol === "http:" ? httpRequest : httpsRequest;
    const upstream = send(
      { host: base.hostname, port: base.port || (base.protocol === "http:" ? 80 : 443), method: request.method, path: url, headers },
      (answer) => {
        const type = String(answer.headers["content-type"] ?? "");
        const back = { ...answer.headers };
        for (const name of HOP) delete back[name];
        response.writeHead(answer.statusCode ?? 502, back);
        let text = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => {
          if (call.priced) {
            if (type.includes("event-stream")) meter.sse(chunk);
            else if (text.length < 64 * 1024 * 1024) text += chunk;
          }
          response.write(chunk);
        });
        answer.on("end", () => {
          if (call.priced) {
            if (!type.includes("event-stream")) meter.json(text);
            meter.sse("\n");
            this.charge(ticket, model, meter, fast);
          }
          response.end();
        });
        answer.on("error", () => response.destroy());
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) this.refuse(response, provider, 502, `the provider didn't answer: ${error.message}`);
      else response.destroy();
    });
    upstream.end(raw);
  }

  private charge(ticket: Ticket, model: string, meter: Meter, fast: boolean): void {
    if (!meter.seen) return;
    const rate = rateFor(ticket.provider, model);
    const dollars = rate ? cost(rate, meter.usage, fast) : null;
    // A prompt too long to price uses up what's left of the build's cap.
    const cap = { ...DEFAULT_CAP, ...ticket.cap };
    const charged = dollars ?? Math.max(0, cap.build - (this.spend().builds[ticket.build] ?? 0));
    const spend = this.add(ticket.build, charged);
    this.log(`${ticket.build} ${model}: $${charged.toFixed(4)}, $${spend.builds[ticket.build].toFixed(2)} this build, $${spend.spent.toFixed(2)} this month`);
  }
}
