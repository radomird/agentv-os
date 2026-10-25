// The box side of Settings → Power (ADR-033, S2.18): what AgenTV's polkit
// rules allow, run in a stand-in for polkit, and that AgenTV's long-running
// units stop within a few seconds, so none holds a restart or a power-off up.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dirname, "../../..");
const YES = "yes";

// Runs a rules file the way polkit does, and answers an action for a subject.
function rules(file: string) {
  const added: ((action: unknown, subject: unknown) => unknown)[] = [];
  runInNewContext(readFileSync(join(ROOT, "system/polkit", file), "utf8"), { polkit: { addRule: (rule: (typeof added)[0]) => added.push(rule), Result: { YES } } });
  return (id: string, groups: string[], lookup: Record<string, string> = {}) => {
    const action = { id, lookup: (key: string) => lookup[key] };
    const subject = { isInGroup: (group: string) => groups.includes(group) };
    return added.map((rule) => rule(action, subject)).find((answer) => answer !== undefined) ?? null;
  };
}

test("S2.18 the owner (wheel) may restart and power off from the TV session, with other sessions open, never past a block", () => {
  const power = rules("50-agentv-power.rules");
  for (const id of ["power-off", "power-off-multiple-sessions", "reboot", "reboot-multiple-sessions"]) {
    assert.equal(power(`org.freedesktop.login1.${id}`, ["wheel"]), YES, id);
    assert.equal(power(`org.freedesktop.login1.${id}`, ["users"]), null, `${id} isn't for someone outside wheel`);
  }
  for (const id of ["power-off-ignore-inhibit", "reboot-ignore-inhibit", "suspend", "set-reboot-to-firmware-setup"]) {
    assert.equal(power(`org.freedesktop.login1.${id}`, ["wheel"]), null, `${id} is polkit's own call`);
  }
  assert.equal(power("org.freedesktop.systemd1.manage-units", ["wheel"], { verb: "start", unit: "poweroff.target" }), null);
});

test("the update rule still allows only starting the three update units", () => {
  const update = rules("50-agentv-update.rules");
  const unit = (verb: string, name: string, groups = ["wheel"]) => update("org.freedesktop.systemd1.manage-units", groups, { verb, unit: name });
  assert.equal(unit("start", "agentv-update-tv.service"), YES);
  assert.equal(unit("start", "agentv-update-tv.service", ["users"]), null);
  assert.equal(unit("stop", "agentv-update-tv.service"), null);
  assert.equal(unit("start", "sshd.service"), null);
});

test("S2.18 AgenTV's long-running units stop within a few seconds", () => {
  for (const unit of ["system/agentv-daemon.service", "system/user/agentv-screen.service", "system/user/agentv-input.service", "system/user/agentv-toast.service"]) {
    const found = /^TimeoutStopSec=(\d+)s$/m.exec(readFileSync(join(ROOT, unit), "utf8"));
    assert.ok(found && Number(found[1]) <= 5, `${unit} stops within 5 s`);
  }
});
