// `agentv app install | list | remove`: the box's apps from the command line.
// The daemon uses the same installer for setup's app picker.
//
// Usage: node cli.ts install <id> [--index <folder-or-url>]
//        node cli.ts list
//        node cli.ts remove <id>
// AGENTV_STATE (/var/lib/agentv) holds the apps; AGENTV_KEYRING overrides
// AgenTV's key, and AGENTV_INDEX_URL the index from the package's settings.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexError } from "./index.ts";
import { installFromIndex, readInstalled, removeApp } from "./install.ts";

const AGENTV_PATH = process.env.AGENTV_PATH ?? "/usr/share/agentv";
const appsDir = join(process.env.AGENTV_STATE ?? "/var/lib/agentv", "apps");

// A KEY=value line from the package's settings file.
async function setting(key: string): Promise<string | undefined> {
  const text = await readFile(join(AGENTV_PATH, "settings"), "utf8").catch(() => "");
  return text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "install") {
    const at = rest.indexOf("--index");
    const flag = at >= 0 ? rest.splice(at, 2)[1] : undefined;
    const id = rest[0];
    if (!id || rest.length > 1) {
      console.error("Usage: agentv app install <app-id> [--index <folder-or-url>]");
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
  console.error("Usage: agentv app install <app-id> | list | remove <app-id>");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error instanceof IndexError ? `Couldn't do it: ${error.message}.` : `Something went wrong: ${error.message}`);
    process.exit(1);
  },
);
