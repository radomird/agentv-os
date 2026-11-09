// Whether the TV is on (ADR-004, ADR-031): the HDMI connector's status first,
// then the audio sink. Many TVs keep the connector "connected" in standby,
// but stop offering their audio, which shows in the HDMI audio's ELD as
// monitor_present 0. A box with no HDMI audio to ask goes by the connector
// alone. Null when there's no screen connector to read at all.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Connectors a TV can be on: not a laptop's own panel.
const EXTERNAL = /^card\d+-(HDMI|DP|DVI|VGA|Virtual)-/;

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function tvOn(drm = "/sys/class/drm", asound = "/proc/asound"): boolean | null {
  const connectors = existsSync(drm) ? readdirSync(drm).filter((name) => EXTERNAL.test(name)) : [];
  const statuses = connectors.map((name) => read(join(drm, name, "status")).trim()).filter(Boolean);
  if (statuses.length === 0) return null;
  if (!statuses.includes("connected")) return false;

  const elds: string[] = [];
  if (existsSync(asound)) {
    for (const card of readdirSync(asound).filter((name) => /^card\d+$/.test(name))) {
      for (const file of readdirSync(join(asound, card)).filter((name) => name.startsWith("eld#"))) {
        elds.push(read(join(asound, card, file)));
      }
    }
  }
  if (elds.length === 0) return true;
  return elds.some((eld) => /^monitor_present\s+1$/m.test(eld));
}

// Calls changed on each hotplug of a screen connector, as the kernel tells
// udev: a TV plugged in, or one that drops and raises its hotplug line as it
// goes to standby and comes back. The screen daemon listens while the TV's
// output is off, when the HDMI audio can't say the TV is back (ADR-072).
// Returns how to stop listening.
export function watchHotplug(changed: () => void, command = ["udevadm", "monitor", "--kernel", "--subsystem-match=drm"]): () => void {
  const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => {});
  let rest = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    if (lines.some((line) => /^KERNEL\[[^\]]*\]\s+change\s/.test(line))) changed();
  });
  return () => child.kill();
}
