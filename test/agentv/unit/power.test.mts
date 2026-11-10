// The box side of Settings → Power (ADR-033, S2.18): what AgenTV's polkit
// rules allow, run in a stand-in for polkit, and that AgenTV's long-running
// units stop within a few seconds, so none holds a restart or a power-off up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dirname, "../../..");
const YES = "yes";
const scratch = mkdtempSync(join(tmpdir(), "agentv-power-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The files a rule reads, here instead of in /etc.
const files = new Map<string, string>();

// Runs a rules file the way polkit does, and answers an action for a
// subject. polkit.spawn runs the command as polkit would, on the files above.
function rules(file: string) {
  const added: ((action: unknown, subject: unknown) => unknown)[] = [];
  const spawn = (argv: string[]) => execFileSync(argv[0], argv.slice(1).map((arg) => files.get(arg) ?? arg), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  runInNewContext(readFileSync(join(ROOT, "system/polkit", file), "utf8"), { polkit: { addRule: (rule: (typeof added)[0]) => added.push(rule), Result: { YES }, spawn } });
  return (id: string, groups: string[], lookup: Record<string, string> = {}, user = "radomir") => {
    const action = { id, lookup: (key: string) => lookup[key] };
    const subject = { user, isInGroup: (group: string) => groups.includes(group) };
    return added.map((rule) => rule(action, subject)).find((answer) => answer !== undefined) ?? null;
  };
}

// The owner is who SDDM logs in to the TV session, as agentv-session-setup
// writes it. Every rule reads it from there.
const autologin = join(scratch, "zz-agentv-autologin.conf");
files.set("/etc/sddm.conf.d/zz-agentv-autologin.conf", autologin);
function ownerIs(name: string | null) {
  if (name === null) rmSync(autologin, { force: true });
  else writeFileSync(autologin, `[Autologin]\n${name === "" ? "" : `User=${name}\n`}Session=agentv.desktop\nRelogin=true\n`);
}

test("S2.18 the owner may restart and power off from the TV session, with other sessions open, never past a block", () => {
  const power = rules("50-agentv-power.rules");
  ownerIs("radomir");
  // T2.2: and ask for the boot menu on the next boot, before restarting.
  for (const id of ["power-off", "power-off-multiple-sessions", "reboot", "reboot-multiple-sessions", "set-reboot-to-boot-loader-menu"]) {
    assert.equal(power(`org.freedesktop.login1.${id}`, ["wheel"]), YES, id);
    assert.equal(power(`org.freedesktop.login1.${id}`, ["wheel"], {}, "alice"), null, `L5 ${id} isn't for another admin`);
    assert.equal(power(`org.freedesktop.login1.${id}`, ["users"], {}, "alice"), null, `${id} isn't for someone outside wheel`);
  }
  for (const id of ["power-off-ignore-inhibit", "reboot-ignore-inhibit", "suspend", "set-reboot-to-firmware-setup"]) {
    assert.equal(power(`org.freedesktop.login1.${id}`, ["wheel"]), null, `${id} is polkit's own call`);
  }
  assert.equal(power("org.freedesktop.systemd1.manage-units", ["wheel"], { verb: "start", unit: "poweroff.target" }), null);
  ownerIs(null);
  assert.equal(power("org.freedesktop.login1.reboot", ["wheel"]), null, "with no owner written, it's polkit's own call");
});

test("T2.1 the owner may start the boot splash's release from the TV session, and nothing else with it", () => {
  const splash = rules("50-agentv-splash.rules");
  ownerIs("radomir");
  const unit = (verb: string, name: string, user = "radomir") => splash("org.freedesktop.systemd1.manage-units", ["wheel"], { verb, unit: name }, user);
  assert.equal(unit("start", "agentv-boot-splash-release.service"), YES);
  assert.equal(unit("start", "agentv-boot-splash-release.service", "alice"), null, "L5 not for another admin");
  assert.equal(unit("stop", "agentv-boot-splash-release.service"), null);
  assert.equal(unit("start", "plymouth-quit.service"), null);
});

test("H1 only the owner's own account may start the three update units, and nothing else with them", () => {
  const update = rules("50-agentv-update.rules");
  ownerIs("radomir");
  const unit = (verb: string, name: string, user = "radomir", groups = ["wheel"]) => update("org.freedesktop.systemd1.manage-units", groups, { verb, unit: name }, user);
  for (const name of ["agentv-update-check.service", "agentv-update-tv.service", "agentv-go-back.service"]) {
    assert.equal(unit("start", name), YES, name);
    assert.equal(unit("start", name, "alice"), null, `${name} isn't for another admin: polkit asks for their password`);
    assert.equal(unit("start", name, "radomi"), null, `${name} goes by the whole name`);
    assert.equal(unit("start", name, "alice", ["users"]), null);
    assert.equal(unit("stop", name), null);
  }
  assert.equal(unit("start", "sshd.service"), null);
  assert.equal(unit("start", "agentv-update-after.service"), null);
  // With no owner written, or an empty one, nobody starts them without a password.
  ownerIs(null);
  assert.equal(unit("start", "agentv-update-tv.service"), null);
  ownerIs("");
  assert.equal(unit("start", "agentv-update-tv.service", ""), null);
  // The rule never goes by the admin group again.
  for (const file of ["50-agentv-update.rules", "50-agentv-power.rules", "50-agentv-splash.rules", "50-agentv-sleep.rules"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, "system/polkit", file), "utf8"), /isInGroup/, file);
  }
});

test("S2.18 AgenTV's long-running units stop within a few seconds", () => {
  for (const unit of ["system/agentv-daemon.service", "system/user/agentv-screen.service", "system/user/agentv-input.service", "system/user/agentv-toast.service"]) {
    const found = /^TimeoutStopSec=(\d+)s$/m.exec(readFileSync(join(ROOT, unit), "utf8"));
    assert.ok(found && Number(found[1]) <= 5, `${unit} stops within 5 s`);
  }
});

test("T13.2 with sleep on, the owner may suspend from the TV session and set the wake alarm, never past an inhibitor", () => {
  const sleep = rules("50-agentv-sleep.rules");
  ownerIs("radomir");
  for (const id of ["suspend", "suspend-multiple-sessions"]) {
    assert.equal(sleep(`org.freedesktop.login1.${id}`, ["wheel"], {}, "radomir"), YES, id);
    assert.equal(sleep(`org.freedesktop.login1.${id}`, ["wheel"], {}, "alice"), null, `${id} isn't for another admin`);
    assert.equal(sleep(`org.freedesktop.login1.${id}`, ["wheel"], {}, "radomi"), null, `${id} goes by the whole name`);
  }
  // With no owner written, nobody suspends past polkit's own question.
  rmSync(autologin);
  assert.equal(sleep("org.freedesktop.login1.suspend", ["wheel"], {}, "radomir"), null);
  writeFileSync(autologin, "[Autologin]\nSession=agentv.desktop\n");
  assert.equal(sleep("org.freedesktop.login1.suspend", ["wheel"], {}, ""), null);
  for (const id of ["suspend-ignore-inhibit", "hibernate", "power-off", "reboot"]) {
    assert.equal(sleep(`org.freedesktop.login1.${id}`, ["wheel"]), null, `${id} is polkit's own call`);
  }
  ownerIs("radomir");
  const unit = (verb: string, name: string, user = "radomir") => sleep("org.freedesktop.systemd1.manage-units", ["wheel"], { verb, unit: name }, user);
  assert.equal(unit("start", "agentv-wake.timer"), YES);
  assert.equal(unit("stop", "agentv-wake.timer"), YES);
  assert.equal(unit("start", "agentv-wake.timer", "alice"), null, "L5 the wake alarm isn't for another admin");
  assert.equal(unit("enable", "agentv-wake.timer"), null);
  assert.equal(unit("start", "agentv-wake.service"), null);
  assert.equal(unit("start", "suspend.target"), null);
});

test("T13.2 the wake alarm wakes the box for the night's update window, and is never enabled", () => {
  const timer = readFileSync(join(ROOT, "system/agentv-wake.timer"), "utf8");
  assert.match(timer, /^OnCalendar=\*-\*-\* 02:00:00$/m, "at the start of the 02:00 to 05:00 window");
  assert.match(timer, /^WakeSystem=true$/m);
  assert.doesNotMatch(timer, /^\[Install\]/m, "the screen daemon starts it, only before it sleeps");
  assert.match(readFileSync(join(ROOT, "system/agentv-wake.service"), "utf8"), /^ExecStart=\/usr\/bin\/true$/m);
});

test("T13.2 installing apps holds the box awake", () => {
  const unit = readFileSync(join(ROOT, "system/agentv-setup-apps.service"), "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/systemd-inhibit --what=sleep --who=AgenTV "--why=installing apps" --mode=block \/usr\/bin\/agentv-setup-apps$/m);
});
