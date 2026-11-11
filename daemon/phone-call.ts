// agentv-phone-call: a paired phone's requests from the box itself, for
// checking the box (the image checks, and a look by hand). It pairs with a
// code from the TV and keeps the phone's key in a file, then signs and
// seals each request as the companion's page does (daemon/phone-client.ts).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pair, PhoneClient, type Kept } from "./phone-client.ts";

const USAGE = `Usage: agentv-phone-call pair <code> [<name>]
       agentv-phone-call pair-new [<name>]
       agentv-phone-call [--errors] <key-file> <METHOD> <path> [<json> | @<file> <content-type>]

pair takes the code on the TV. pair-new has the box show a new code first,
as Settings → Phones does, with the adult PIN from AGENTV_PIN when one is
set. Both print the path of a key file. The last form sends one request as
that phone and prints the answer. It exits 22 when the box answers 400 or more,
and prints that answer only with --errors.`;

const local = process.env.AGENTV_URL ?? `http://127.0.0.1:${process.env.AGENTV_PORT ?? 3000}`;
const base = process.env.AGENTV_PHONE_URL ?? `http://127.0.0.1:${process.env.AGENTV_LAN_PORT ?? 3001}`;

// Has the box show a new code, as its own Settings does on its local port.
// Once setup is done and a PIN is set, that takes the PIN's grant. The PIN
// comes from the environment, never from the command line.
async function newCode(): Promise<string> {
  const post = async (path: string, body: unknown, grant?: string) => {
    const response = await fetch(`${local}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: (await response.json().catch(() => ({}))) as { pin?: boolean; grant?: string; error?: string; pairing?: { code?: string } } };
  };
  let asked = await post("/api/phones/pair", {});
  if (asked.status === 403 && asked.data.pin) {
    const pin = process.env.AGENTV_PIN;
    if (!pin) throw new Error("the box has an adult PIN set, so a new pairing code needs it: give it in AGENTV_PIN");
    const checked = await post("/api/pin/check", { pin });
    if (!checked.data.grant) throw new Error(`the box didn't take the PIN in AGENTV_PIN: ${checked.data.error ?? checked.status}`);
    asked = await post("/api/phones/pair", {}, checked.data.grant);
  }
  const code = asked.data.pairing?.code;
  if (!code) throw new Error(`the box gave no pairing code: ${asked.data.error ?? asked.status}`);
  return code;
}

async function main(args: string[]): Promise<number> {
  if ((args[0] === "pair" && args.length >= 2 && args.length <= 3) || (args[0] === "pair-new" && args.length <= 2)) {
    const [code, name] = args[0] === "pair" ? [args[1], args[2]] : [await newCode(), args[1]];
    const kept = await pair(base, { code }, name ?? "a check");
    // A folder of its own, which only this user reads, as the key is the phone.
    const path = join(mkdtempSync(join(tmpdir(), "agentv-phone-")), "key.json");
    writeFileSync(path, JSON.stringify(kept), { mode: 0o600 });
    console.log(path);
    return 0;
  }
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
    console.error(`agentv-phone-call: the box answered ${answer.status}`);
    return 22;
  }
  process.stdout.write(answer.body);
  if (answer.sealed) process.stdout.write("\n");
  return answer.status >= 400 ? 22 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`agentv-phone-call: ${error.message}`);
    process.exit(1);
  },
);
