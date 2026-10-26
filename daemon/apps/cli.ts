// `agentv app install | list | remove`: the box's apps from the command line.
// The daemon uses the same installer for setup's app picker, and the builder
// will use installLocal for the apps it builds (ADR-039).
//
// Usage: node cli.ts install <id> [--index <folder-or-url>]
//        node cli.ts install --local <folder> [--yes]
//        node cli.ts list
//        node cli.ts remove <id>
// AGENTV_STATE (/var/lib/agentv) holds the apps; AGENTV_KEYRING overrides
// AgenTV's key, and AGENTV_INDEX_URL the index from the package's settings.
// AGENTV_BIN_DIR is where agentv-pin-check is, and AGENTV_PIN_CHECK replaces
// it for the tests.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Manifest } from "../../apps/contract/manifest.ts";
import { IndexError } from "./index.ts";
import { installFromIndex, installLocal, readInstalled, removeApp } from "./install.ts";

const AGENTV_PATH = process.env.AGENTV_PATH ?? "/usr/share/agentv";
const appsDir = join(process.env.AGENTV_STATE ?? "/var/lib/agentv", "apps");
const pinCheck = process.env.AGENTV_PIN_CHECK ?? join(process.env.AGENTV_BIN_DIR ?? "/usr/bin", "agentv-pin-check");
const USAGE = "Usage: agentv app install <app-id> [--index <folder-or-url>] | --local <folder> [--yes]";

// A KEY=value line from the package's settings file.
async function setting(key: string): Promise<string | undefined> {
  const text = await readFile(join(AGENTV_PATH, "settings"), "utf8").catch(() => "");
  return text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

// What an app built on this box can reach, in plain words, as the adult
// approving it sees it (ADR-011).
function reach(manifest: Manifest): string {
  if (manifest.tv.runtime === "native") return `It runs ${(manifest.tv.exec ?? []).join(" ")} in a window of its own.`;
  const origins = manifest.tv.origins ?? [];
  const fixed = origins.filter((origin) => !origin.startsWith("{")).map((origin) => origin.replace(/^https?:\/\//, ""));
  const asked = origins.length > fixed.length ? ["the addresses its setup asks you for"] : [];
  const all = [...fixed, ...asked];
  if (all.length === 0) return "It can't reach anything outside this TV.";
  const list = all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
  return `It can reach ${list}, and nothing else.`;
}

// The adult's yes for an app built on this box (ADR-011, ADR-039): what it
// can reach, then a question when there's a terminal to ask in (--yes
// answers it), then the adult PIN when one is set, which agentv-pin-check
// asks for here, takes from the grant the TV or the phone gave, or asks for
// on the TV.
function approver(from: string, yes: boolean): (manifest: Manifest) => Promise<boolean> {
  return async (manifest) => {
    console.log(`${manifest.name} ${manifest.version} (${manifest.id}), from ${from}.`);
    console.log(reach(manifest));
    if (!yes) {
      if (!process.stdin.isTTY) throw new IndexError("there's no terminal to ask in, so add --yes to install it without the question");
      const question = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await question.question("Install it? [y/N] ");
      question.close();
      if (!/^y(es)?$/i.test(answer.trim())) return false;
    }
    // With no terminal, agentv-pin-check asks on the TV of whoever ran sudo:
    // root has no TV session of its own to ask in.
    const sudoer = /^\d+$/.test(process.env.SUDO_UID ?? "") && !process.env.XDG_RUNTIME_DIR;
    const env = sudoer ? { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.env.SUDO_UID}` } : process.env;
    const pin = spawnSync(pinCheck, ["app-install"], { stdio: "inherit", env });
    if (pin.error) throw new IndexError(`couldn't ask for the adult PIN (${pin.error.message})`);
    if (pin.status !== 0) throw new IndexError("that needs the adult PIN, so nothing was installed");
    return true;
  };
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "install" && rest.includes("--local")) {
    const yes = rest.includes("--yes");
    const others = rest.filter((arg) => arg !== "--yes");
    if (others.length !== 2 || others[0] !== "--local" || others[1].startsWith("-")) {
      console.error(USAGE);
      return 2;
    }
    const app = await installLocal(others[1], appsDir, approver(resolve(others[1]), yes));
    console.log(`Installed ${app.name} ${app.version} (${app.id}). It's in Apps on the TV, where its details put it on home.`);
    return 0;
  }
  if (command === "install") {
    const at = rest.indexOf("--index");
    const flag = at >= 0 ? rest.splice(at, 2)[1] : undefined;
    const id = rest[0];
    if (!id || rest.length > 1 || id.startsWith("-")) {
      console.error(USAGE);
      return 2;
    }
    const source = flag ?? process.env.AGENTV_INDEX_URL ?? (await setting("AGENTV_INDEX_URL"));
    if (!source) throw new IndexError("this box has no app index set up yet");
    const app = await installFromIndex(id, source, appsDir, process.env.AGENTV_KEYRING);
    console.log(`Installed ${app.name} ${app.version} (${app.id}).`);
    return 0;
  }
  if (command === "list") {
    const record = await readInstalled(appsDir);
    for (const app of Object.values(record).sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`${app.id} ${app.version} ${app.tier}`);
    }
    return 0;
  }
  if (command === "remove") {
    if (rest.length !== 1) {
      console.error("Usage: agentv app remove <app-id>");
      return 2;
    }
    await removeApp(rest[0], appsDir);
    console.log(`Removed ${rest[0]}.`);
    return 0;
  }
  console.error("Usage: agentv app install <app-id> | install --local <folder> | list | remove <app-id>");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error instanceof IndexError ? `Couldn't do it: ${error.message}.` : `Something went wrong: ${error.message}`);
    process.exit(1);
  },
);
