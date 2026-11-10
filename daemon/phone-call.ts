// agentv-phone-call: a paired phone's requests from the box itself, for
// checking the box (the image checks, and a look by hand). It pairs with a
// code from the TV and keeps the phone's key in a file, then signs and
// seals each request as the companion's page does (daemon/phone-client.ts).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pair, PhoneClient, type Kept } from "./phone-client.ts";

const USAGE = `Usage: agentv-phone-call pair <code> [<name>]
       agentv-phone-call [--errors] <key-file> <METHOD> <path> [<json> | @<file> <content-type>]

pair prints the path of a key file. The other form sends one request as that
phone and prints the answer. It exits 22 when the box answers 400 or more,
and prints that answer only with --errors.`;

const base = process.env.AGENTV_PHONE_URL ?? `http://127.0.0.1:${process.env.AGENTV_LAN_PORT ?? 3001}`;

async function main(args: string[]): Promise<number> {
  if (args[0] === "pair" && args.length >= 2 && args.length <= 3) {
    const kept = await pair(base, { code: args[1] }, args[2] ?? "a check");
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
  const answer = body?.startsWith("@")
    ? await phone.call(method.toUpperCase(), path, readFileSync(body.slice(1)), { type })
    : await phone.call(method.toUpperCase(), path, body === undefined ? undefined : Buffer.from(body));
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
