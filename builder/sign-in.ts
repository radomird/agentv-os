// A plan's sign-in (ADR-022, ADR-040), the first time the builder runs:
// the provider's own CLI, unmodified, signs in as agentv-builder in the
// builder's sandbox, and keeps what it gets in its own files in the
// builder's home. AgenTV runs the CLI's sign-in command in a terminal of its
// own, shows the link it prints (as a QR code on the TV and a link on the
// phone), and types into its prompt the code the person pastes on the
// phone. It reads nothing else the CLI prints, and keeps none of it.
//
// agentv-builder-sign-in@.service runs this as agentv-builder. It writes how
// the sign-in stands to status.json in its folder (/run/agentv-build/sign-in),
// which root's hand-over made for it, and reads the code from input there,
// which root writes from what the daemon handed over.
//
// Usage: node sign-in.ts <provider>

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIS, SIGN_IN, signInEnv } from "./providers.ts";
import { forward } from "./sandbox/forward.ts";
import { PROXY_PORT } from "./sandbox/ports.ts";
import type { Provider } from "./build.ts";

export interface SignInStatus {
  provider: Provider;
  state: "starting" | "waiting" | "done" | "failed";
  url?: string; // the CLI's own link, to open on the phone
  code?: string; // a device code to enter on that page, when the CLI gives one
  pastes: boolean; // whether the provider's page gives a code to paste back
  reason?: string;
  at: string;
}

export interface SignInOptions {
  home: string; // the builder's home, where the CLI and its sign-in live
  folder: string; // where status.json and input are
  proxy?: string; // the sandbox's way out
  minutes?: number; // how long the person has
  stop?: AbortSignal; // a stop from the TV, or the box's own
  log?: (line: string) => void;
}

// A link, once whatever came after it shows it's whole.
const URL_IN = /https:\/\/[^\s"'<>\x1b]+(?=\s)/;
// A device code as the CLIs show them: letters and digits in two groups.
const CODE_IN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
// A terminal's colours and cursor moves.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-Z]/g;

// The CLI where root fetched it, in the builder's home.
function cliFor(provider: Provider, home: string): string {
  return join(home, ".local/bin", CLIS[provider]);
}

// Whether the plan's CLI says it's signed in: true or false, or null for a
// plan AgenTV has no sign-in for yet.
export function signedIn(provider: Provider, o: { home: string; proxy?: string }): Promise<boolean | null> {
  const spec = SIGN_IN[provider];
  if (!spec) return Promise.resolve(null);
  const cli = cliFor(provider, o.home);
  if (!existsSync(cli)) return Promise.resolve(false);
  return new Promise((done) => {
    execFile(cli, spec.status, { env: signInEnv(provider, o.home, o.proxy), timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      done(spec.signedIn(`${stdout}${stderr}`, code));
    });
  });
}

function write(path: string, data: unknown): void {
  writeFileSync(`${path}.next`, JSON.stringify(data));
  renameSync(`${path}.next`, path);
}

// The sign-in, from the CLI's link to its own word that it's signed in.
export async function signIn(provider: Provider, o: SignInOptions): Promise<SignInStatus> {
  const spec = SIGN_IN[provider];
  const statusPath = join(o.folder, "status.json");
  const inputPath = join(o.folder, "input");
  const log = o.log ?? ((line: string) => console.log(line));
  let status: SignInStatus = { provider, state: "starting", pastes: spec?.pastes ?? false, at: new Date().toISOString() };
  const set = (change: Partial<SignInStatus>) => {
    status = { ...status, ...change, at: new Date().toISOString() };
    write(statusPath, status);
    return status;
  };
  set({});
  if (!spec) return set({ state: "failed", reason: `${provider}'s plan is coming soon` });
  rmSync(inputPath, { force: true });
  const cli = cliFor(provider, o.home);
  if (!existsSync(cli)) return set({ state: "failed", reason: `${CLIS[provider]} isn't on the box yet` });

  // The CLI in a terminal of its own, as it expects: script gives it one,
  // wide enough that its link stays on one line, and its keys come from
  // this pipe.
  const quoted = [cli, ...spec.login].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("script", ["-qfec", `stty cols 500 rows 40; exec ${quoted}`, "/dev/null"], {
    env: { ...signInEnv(provider, o.home, o.proxy), TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let seen = "";
  const heard = (chunk: Buffer) => {
    if (status.url) return;
    // Only the link, and a device code, are taken from what it prints.
    seen = (seen + chunk.toString("utf8").replace(ESCAPES, "")).slice(-8000);
    const url = URL_IN.exec(seen)?.[0];
    if (!url) return;
    const code = spec.pastes ? undefined : CODE_IN.exec(seen)?.[0];
    if (!spec.pastes && !code) return;
    seen = "";
    log(`${provider}'s sign-in is waiting for the person on their phone`);
    set({ state: "waiting", url, ...(code ? { code } : {}) });
  };
  child.stdout.on("data", heard);
  child.stderr.on("data", heard);

  // The code the person pasted on the phone, as root hands it over.
  const timer = setInterval(() => {
    if (!existsSync(inputPath)) return;
    let code = "";
    try {
      code = readFileSync(inputPath, "utf8").trim();
    } catch {}
    rmSync(inputPath, { force: true });
    if (code && /^[\x21-\x7e]{1,512}$/.test(code)) {
      log(`${provider}'s sign-in got the code from the phone`);
      child.stdin.write(`${code}\r`);
    }
  }, 300);
  let why = "";
  const end = (reason: string) => {
    why ||= reason;
    child.kill("SIGTERM");
  };
  const limit = setTimeout(() => end(`it took longer than ${o.minutes ?? 15} minutes`), (o.minutes ?? 15) * 60_000);
  const stopped = () => end("it was stopped");
  o.stop?.addEventListener("abort", stopped);
  const exit = await new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
  clearInterval(timer);
  clearTimeout(limit);
  o.stop?.removeEventListener("abort", stopped);
  rmSync(inputPath, { force: true });

  // The CLI's own word on it, not what its sign-in printed.
  const ok = await signedIn(provider, o);
  if (ok) {
    log(`${provider}'s plan is signed in`);
    return set({ state: "done", url: undefined, code: undefined });
  }
  return set({ state: "failed", url: undefined, code: undefined, reason: why || (exit === 0 ? "the sign-in didn't finish" : "the sign-in stopped before it finished") });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const provider = process.argv[2] as Provider;
  if (!provider || !(provider in CLIS)) {
    console.error("Usage: node sign-in.ts <claude|chatgpt|gemini|grok|muse>");
    process.exit(2);
  }
  const net = process.env.AGENTV_BUILD_NET ?? "/run/agentv-build-net";
  const server = await forward(PROXY_PORT, join(net, "proxy.sock"));
  // A stop from the TV says so, rather than leaving the link up.
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  const done = await signIn(provider, {
    home: process.env.HOME ?? "/var/lib/agentv/builder",
    folder: process.env.AGENTV_SIGN_IN ?? "/run/agentv-build/sign-in",
    proxy: `http://127.0.0.1:${PROXY_PORT}`,
    stop: stop.signal,
  });
  server.close();
  process.exit(done.state === "done" ? 0 : 1);
}
