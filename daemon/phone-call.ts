// origaitv-phone-call: a paired phone's requests from the box itself, for
// checking the box (the image checks, and a look by hand). It pairs with a
// code from the TV and keeps the phone's key in a file, then signs and
// seals each request as the companion's page does (daemon/phone-client.ts).
// It can be a phone in game mode too: a controller that presses what it's
// told, and says how long each press took to reach the TV's controller.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Button, buttons, BUTTONS, type PadState, STICK } from "./pad-wire.ts";
import { pair, PadRefused, PhoneClient, type Kept, type PhonePad } from "./phone-client.ts";

const USAGE = `Usage: origaitv-phone-call pair <code> [<name>]
       origaitv-phone-call pair-new [<name>]
       origaitv-phone-call [--errors] <key-file> <METHOD> <path> [<json> | @<file> <content-type>]
       origaitv-phone-call <key-file> pad [<step>...]

pair takes the code on the TV. pair-new has the box show a new code first,
as Settings → Phones does, with the PIN from ORIGAITV_PIN when one is
set. Both print the path of a key file. The third form sends one request as
that phone and prints the answer. It exits 22 when the box answers 400 or more,
and prints that answer only with --errors.

pad opens game mode as that phone, does each step in turn, and closes it.
A step is one of:
  a:0.2            hold a button for that many seconds, then let go. The
                   buttons are a, b, x, y, l1, r1, l2, r2, view, menu and
                   home, and a+b holds two.
  stick:1,-1:0.5   push the stick right and up for that long. Each of the
                   two is from -1 to 1, where right and down are above 0.
  wait:2           do nothing for that long
  time:200         press and let go of A that many times, and say how long
                   a press took to reach the TV's controller
It prints a line of JSON for each step, with how long its press took, there
and back, in milliseconds. It exits 22 when the box says no to game mode.`;

const local = process.env.ORIGAITV_URL ?? `http://127.0.0.1:${process.env.ORIGAITV_PORT ?? 3000}`;
const base = process.env.ORIGAITV_PHONE_URL ?? `http://127.0.0.1:${process.env.ORIGAITV_LAN_PORT ?? 3001}`;

// Has the box show a new code, as its own Settings does on its local port.
// Once setup is done and a PIN is set, that takes the PIN's grant. The PIN
// comes from the environment, never from the command line.
async function newCode(): Promise<string> {
  const post = async (path: string, body: unknown, grant?: string) => {
    const response = await fetch(`${local}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: (await response.json().catch(() => ({}))) as { pin?: boolean; grant?: string; error?: string; pairing?: { code?: string } } };
  };
  let asked = await post("/api/phones/pair", {});
  if (asked.status === 403 && asked.data.pin) {
    const pin = process.env.ORIGAITV_PIN;
    if (!pin) throw new Error("the box has a PIN set, so a new pairing code needs it: give it in ORIGAITV_PIN");
    const checked = await post("/api/pin/check", { pin });
    if (!checked.data.grant) throw new Error(`the box didn't take the PIN in ORIGAITV_PIN: ${checked.data.error ?? checked.status}`);
    asked = await post("/api/phones/pair", {}, checked.data.grant);
  }
  const code = asked.data.pairing?.code;
  if (!code) throw new Error(`the box gave no pairing code: ${asked.data.error ?? asked.status}`);
  return code;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Holds a state for a while. A phone that's holding still says so every
// second, or the TV takes its controller away after five.
async function hold(pad: PhonePad, state: PadState, seconds: number): Promise<void> {
  for (let left = seconds * 1000; left > 0; left -= 1000) {
    await sleep(Math.min(left, 1000));
    if (left > 1000) pad.send(state);
  }
}

// One step of `pad`, and what to print for it. Null for a step that isn't
// one.
async function step(pad: PhonePad, text: string): Promise<object | null> {
  const idle = { buttons: 0, x: 0, y: 0 };
  const [what, ...rest] = text.split(":");
  const seconds = Number(rest.at(-1));
  if (!(seconds >= 0)) return null;
  if (what === "wait" && rest.length === 1) {
    await hold(pad, idle, seconds);
    return { step: text };
  }
  if (what === "time" && rest.length === 1 && Number.isInteger(seconds) && seconds > 0) {
    const times: number[] = [];
    for (let n = 0; n < seconds; n++) {
      times.push(await pad.timed({ buttons: buttons("a"), x: 0, y: 0 }));
      await sleep(15);
      await pad.timed(idle);
      await sleep(15);
    }
    times.sort((a, b) => a - b);
    const at = (part: number) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * part))] * 100) / 100;
    return { step: text, presses: times.length, median: at(0.5), p95: at(0.95), slowest: at(1) };
  }
  let state: PadState;
  if (what === "stick" && rest.length === 2) {
    const [x, y] = rest[0].split(",").map(Number);
    if (!(Math.abs(x) <= 1) || !(Math.abs(y) <= 1)) return null;
    state = { buttons: 0, x: Math.round(x * STICK), y: Math.round(y * STICK) };
  } else if (rest.length === 1 && what.split("+").every((name) => (BUTTONS as readonly string[]).includes(name))) {
    state = { buttons: buttons(...(what.split("+") as Button[])), x: 0, y: 0 };
  } else {
    return null;
  }
  const down = await pad.timed(state);
  await hold(pad, state, seconds);
  const up = await pad.timed(idle);
  return { step: text, ms: [Math.round(down * 100) / 100, Math.round(up * 100) / 100] };
}

async function gameMode(phone: PhoneClient, steps: string[]): Promise<number> {
  let pad: PhonePad;
  try {
    pad = await phone.pad();
  } catch (error) {
    if (!(error instanceof PadRefused)) throw error;
    console.error(`origaitv-phone-call: the box answered ${error.status}${error.data.error ? `: ${error.data.error}` : ""}`);
    return 22;
  }
  console.log(JSON.stringify({ controller: pad.slot }));
  let code = 0;
  for (const text of steps) {
    const did = await step(pad, text);
    if (!did) {
      console.error(`origaitv-phone-call: ${text} isn't a step`);
      code = 2;
      break;
    }
    console.log(JSON.stringify(did));
  }
  const closed = await pad.close();
  console.log(JSON.stringify({ closed: closed.code }));
  return code;
}

async function main(args: string[]): Promise<number> {
  if ((args[0] === "pair" && args.length >= 2 && args.length <= 3) || (args[0] === "pair-new" && args.length <= 2)) {
    const [code, name] = args[0] === "pair" ? [args[1], args[2]] : [await newCode(), args[1]];
    const kept = await pair(base, { code }, name ?? "a check");
    // A folder of its own, which only this user reads, as the key is the phone.
    const path = join(mkdtempSync(join(tmpdir(), "origaitv-phone-")), "key.json");
    writeFileSync(path, JSON.stringify(kept), { mode: 0o600 });
    console.log(path);
    return 0;
  }
  if (args.length >= 2 && args[1] === "pad") return gameMode(new PhoneClient(base, JSON.parse(readFileSync(args[0], "utf8")) as Kept), args.slice(2));
  const errors = args[0] === "--errors";
  if (errors) args = args.slice(1);
  const [file, method, path, body, type] = args;
  if (!file || !method || !path?.startsWith("/") || args.length > 5 || (body?.startsWith("@") ? !type : type !== undefined)) {
    console.error(USAGE);
    return 2;
  }
  const phone = new PhoneClient(base, JSON.parse(readFileSync(file, "utf8")) as Kept);
  // What comes back is printed as it is, so a picture or a file may be asked
  // for.
  const answer = body?.startsWith("@")
    ? await phone.call(method.toUpperCase(), path, readFileSync(body.slice(1)), { type })
    : await phone.call(method.toUpperCase(), path, body === undefined ? undefined : Buffer.from(body), { file: true });
  if (answer.status >= 400 && !errors) {
    console.error(`origaitv-phone-call: the box answered ${answer.status}`);
    return 22;
  }
  process.stdout.write(answer.body);
  if (answer.sealed) process.stdout.write("\n");
  return answer.status >= 400 ? 22 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`origaitv-phone-call: ${error.message}`);
    process.exit(1);
  },
);
