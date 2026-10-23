// `agentv app validate`: checks app packages against the app contract
// (manifest.ts) and says what's wrong with each, in plain words.
//
// Usage: node validate.ts [--official | --local] <package-dir>...
//   --official  the package is one of AgenTV's own apps (agentv.*)
//   --local     the package was built on this box (local.*)
// Without either, it's checked as a community app, whose id starts with its
// author. Exits 0 when every package passes, 1 when one doesn't, 2 on bad
// usage.

import { validatePackage, type Tier } from "./manifest.ts";

// Type stripping is still marked experimental in Node; its warning isn't
// for the person running this.
process.removeAllListeners("warning");

const args = process.argv.slice(2);
let tier: Tier = "community";
const dirs: string[] = [];
for (const arg of args) {
  if (arg === "--official") tier = "official";
  else if (arg === "--local") tier = "local";
  else if (arg === "-h" || arg === "--help") {
    console.log("Usage: agentv app validate [--official | --local] <package-dir>...");
    process.exit(0);
  } else if (arg.startsWith("-")) {
    console.error(`agentv app validate: unknown option ${arg}`);
    process.exit(2);
  } else dirs.push(arg);
}
if (dirs.length === 0) {
  console.error("Usage: agentv app validate [--official | --local] <package-dir>...");
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  const { manifest, problems } = validatePackage(dir, tier);
  if (manifest) {
    console.log(`ok - ${manifest.id} ${manifest.version} (${tier}): ${dir}`);
  } else {
    failed = true;
    console.error(`not ok - ${dir}`);
    for (const problem of problems) console.error(`    ${problem}`);
  }
}
process.exit(failed ? 1 : 0);
