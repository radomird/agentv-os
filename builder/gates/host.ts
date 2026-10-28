// AgenTV's test TV (builder/gates/, ADR-043): a page like home that holds
// one page app in its frame with home's own kit host, plays the remote, a
// gamepad and Back to it, and runs the tests and AgenTV's checks. The
// builder drives it over Chromium's DevTools pipe (builder/gates/testtv.ts),
// and the kit's calls go to the test TV's server, which answers them as the
// daemon does, from the app's manifest.

import { KitHost } from "../../launcher/kit-host.ts";

interface Plan {
  app: string;
  origin: string; // the app's own, like http://local.blocks.app.localhost:4000
  declared: string[];
}

interface Probe {
  now: number;
  listening: { input: number; back: boolean; pause: number };
  errors: string[];
  requests: { url: string; declared: boolean }[];
  frames: number;
  median: number; // ms between frames
  longest: number;
  memory: number;
}

export interface Check {
  id: string;
  ok: boolean;
  says: string;
}

// What AgenTV asks of every page app.
export const FPS_MIN = 50;
export const LONGEST_MS = 200;
export const MEMORY_MB = 256;
export const READY_MS = 10_000;

const plan: Plan = await (await fetch("/plan")).json();
const frame = document.getElementById("app") as HTMLIFrameElement;
let ready = false;
let left = false;
let calls: { call: string; args: unknown[] }[] = [];
let index = -1;
let names: string[] = [];
let readyWait: (() => void) | null = null;
let loaded: (() => void) | null = null;
let result: ((value: unknown) => void) | null = null;

async function kit(call: string, args: unknown[]): Promise<unknown> {
  const answer = await (await fetch("/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ call, args }) })).json();
  if (answer.error) throw new Error(answer.error);
  return answer.value;
}

const host = new KitHost(frame, plan.app, {
  daemon: (_app, call, args) => {
    calls.push({ call, args });
    return kit(call, args);
  },
  media: (_app, call, args) => {
    calls.push({ call, args });
    return kit(call, args);
  },
  ready: () => {
    calls.push({ call: "ready", args: [] });
    ready = true;
    readyWait?.();
  },
  exit: () => {
    calls.push({ call: "exit", args: [] });
    left = true;
  },
});

async function snapshot() {
  const { storage, tile } = await (await fetch("/state")).json();
  return { storage, tile, ready, left, calls };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function input(button: string, down: boolean, source = "remote", pad?: number): Promise<void> {
  host.input({ button: button as never, down, source: source as never, ...(pad === undefined ? {} : { pad }) });
}

async function press(button: string, source = "remote", pad?: number): Promise<void> {
  await input(button, true, source, pad);
  await pause(60);
  await input(button, false, source, pad);
  await pause(40);
}

// What the frame's runner asks for, and the answer it waits on.
window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow || !event.data || typeof event.data.agentvTest !== "number") return;
  const message = event.data;
  const reply = (value: unknown) => frame.contentWindow?.postMessage({ agentvTest: message.agentvTest, value }, "*");
  switch (message.op) {
    case "which":
      names = Array.isArray(message.names) ? message.names.map(String) : [];
      reply({ index, declared: plan.declared });
      loaded?.();
      return;
    case "started":
      await waitReady(5000);
      reply(await snapshot());
      return;
    case "press":
      await press(message.button, message.source, message.pad);
      return reply({ state: await snapshot() });
    case "down":
    case "up":
      await input(message.button, message.op === "down", message.source, message.pad);
      await pause(40);
      return reply({ state: await snapshot() });
    case "back": {
      const kept = await host.back();
      if (!kept) left = true;
      return reply({ kept, state: await snapshot() });
    }
    case "state":
      return reply({ state: await snapshot() });
    case "result":
      result?.(message);
      return;
  }
});

function waitReady(ms: number): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(ready), ms);
    readyWait = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

// The app afresh: test is the one to run in it, or -1 for none.
function load(test: number): Promise<void> {
  ready = false;
  left = false;
  calls = [];
  index = test;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    loaded = () => {
      clearTimeout(timer);
      resolve();
    };
    frame.src = `${plan.origin}/`;
  });
}

let nextProbe = 0;
function probe(since = 0): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const id = ++nextProbe;
    const timer = setTimeout(() => reject(new Error("the app's frame didn't answer")), 3000);
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.agentvProbe !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", heard);
      resolve(event.data.value);
    };
    window.addEventListener("message", heard);
    frame.contentWindow?.postMessage({ agentvProbe: id, since }, "*");
  });
}

// What the builder calls, over the DevTools pipe.
const testTv = {
  // The app, until it says it's drawn: and the tests it brings.
  async start(): Promise<{ ready: boolean; ms: number; names: string[] }> {
    const started = performance.now();
    await load(-1);
    const ok = await waitReady(READY_MS);
    return { ready: ok, ms: Math.round(performance.now() - started), names };
  },

  // AgenTV's own checks, on the app start() opened.
  async checks(): Promise<Check[]> {
    const checks: Check[] = [];
    const add = (id: string, ok: boolean, says: string) => checks.push({ id, ok, says });
    add("ready", ready, ready ? "it says it's drawn with agentv.ready()" : `it didn't call agentv.ready() within ${READY_MS / 1000} seconds`);

    for (const button of ["up", "down", "left", "right", "ok"]) await press(button, "remote");
    await pause(300);
    let seen = await probe();
    add("remote", seen.listening.input > 0 && !left, seen.listening.input > 0 ? "it takes the remote's buttons from agentv.input.on" : "it doesn't listen to its buttons with agentv.input.on");
    for (const button of ["ok", "x", "y", "lb", "rb", "start"]) await press(button, "gamepad", 0);
    await pause(300);
    add("gamepad", !left, left ? "a gamepad's buttons made it leave" : "it takes a gamepad's buttons and stays");

    // Three seconds with a press now and then: the frames it drew, and the
    // longest the page was held.
    const from = (await probe()).now;
    for (let i = 0; i < 6; i++) {
      await press(i % 2 ? "left" : "right", "remote");
      await pause(400);
    }
    seen = await probe(from);
    const fps = seen.median > 0 ? 1000 / seen.median : 0;
    add(
      "frames",
      seen.frames < 2 || fps >= FPS_MIN,
      seen.frames < 2 ? "it drew nothing while it waited, which is fine" : `it drew ${Math.round(fps)} frames a second${fps >= FPS_MIN ? "" : `, and needs ${FPS_MIN}`}`,
    );
    add("held", seen.longest <= LONGEST_MS, seen.longest <= LONGEST_MS ? "nothing held the page for long" : `something held the page for ${Math.round(seen.longest)} ms, and the most is ${LONGEST_MS}`);
    const mb = seen.memory / 1024 / 1024;
    add("memory", mb <= MEMORY_MB, `it uses ${Math.round(mb)} mb${mb <= MEMORY_MB ? "" : `, and the most is ${MEMORY_MB}`}`);
    const undeclared = seen.requests.filter((r) => !r.declared).map((r) => r.url);
    add("requests", undeclared.length === 0, undeclared.length ? `it asked for what it didn't declare: ${[...new Set(undeclared)].slice(0, 5).join(", ")}` : "it asked only for what it declared");
    add("errors", seen.errors.length === 0, seen.errors.length ? `it threw: ${seen.errors.slice(0, 3).join("; ")}` : "nothing threw");

    // Back: answered in time, and out by the fourth press.
    let out = false;
    let answered = true;
    for (let i = 0; i < 4 && !out; i++) {
      const started = performance.now();
      const kept = await host.back();
      if (!kept && performance.now() - started > 290 && seen.listening.back) answered = false;
      out = !kept;
    }
    add("back", out && answered, !out ? "Back didn't leave it by the fourth press" : answered ? "Back is answered in time, and leaves it" : "its Back took longer than 300 ms to answer");
    return checks;
  },

  // One test, in the app afresh.
  async test(i: number): Promise<{ name: string; ok: boolean; failed: string[] }> {
    await load(i);
    const answer = (await Promise.race([
      new Promise((resolve) => {
        result = resolve;
      }),
      pause(30_000).then(() => ({ name: names[i] ?? `test ${i + 1}`, ok: false, failed: ["it didn't finish within 30 seconds"] })),
    ])) as { name: string; ok: boolean; failed: string[] };
    result = null;
    return { name: answer.name, ok: answer.ok, failed: answer.failed ?? [] };
  },
};

(window as unknown as { testTv: typeof testTv }).testTv = testTv;
