#!/bin/bash

# Guards straight to the TV (ADR-060): bin/agentv-boot-splash keeps Plymouth's
# last frame up as it lets go of the screen at boot, and quits it once home
# has drawn; the TV session draws the same splash, in the colour Plymouth
# drew, until the screen daemon ends it, and only in the boot that kept it;
# and Plymouth waits for first boot's work.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
calls="$SCRATCH/calls"
theme="$SCRATCH/theme"
note="$SCRATCH/run/agentv-boot-splash"
mkdir -p "$bin" "$theme" "$SCRATCH/run"
cp "$ROOT/default/plymouth/omarchy.script" "$theme/omarchy.script"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}
fake plymouth 'echo "plymouth $*" >>"$CALLS"; [[ $1 != --ping ]] || [[ -n ${PLYMOUTH_UP:-} ]]'
fake systemd-run 'echo "systemd-run $*" >>"$CALLS"'
fake systemctl 'echo "systemctl $*" >>"$CALLS"'
fake logger ':'
fake quickshell 'echo "quickshell $* background=$AGENTV_SPLASH_BACKGROUND logo=$AGENTV_SPLASH_LOGO" >>"$CALLS"'
fake qs 'echo "qs $*" >>"$CALLS"; exit 1'

splash() {
  rm -f "$calls"
  env PATH="$bin:$PATH" CALLS="$calls" AGENTV_PATH=/usr/share/agentv \
    AGENTV_BOOT_SPLASH_NOTE="$note" AGENTV_SPLASH_THEME="$theme" \
    "$BASH" "$ROOT/bin/agentv-boot-splash" "$@" >"$SCRATCH/out" 2>&1
}

# --- quit at boot, and release once home has drawn ---------------------------

rm -f "$note"
splash quit || fail "quit runs" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$calls") == "plymouth deactivate" && -f $note ]] ||
  fail "Plymouth lets go of the screen but keeps its last frame up, and the boot gets its note" "$(cat "$calls")"
grep -qx "systemd-run --no-block --quiet --collect --on-active=120 --unit=agentv-boot-splash-fallback /usr/bin/plymouth quit" "$calls" ||
  fail "and quits by itself two minutes later if nothing releases it" "$(cat "$calls")"
pass "T2.1 Plymouth keeps the splash up for the TV session, with a way out if it never comes"

PLYMOUTH_UP=1 splash release || fail "release runs" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$calls") == "plymouth quit --retain-splash" ]] || fail "release quits Plymouth, leaving the screen as the TV session drew it" "$(cat "$calls")"
[[ ! -e $note ]] || fail "and the boot's note goes, so a TV session started again later has no splash"
splash release || fail "release runs with nothing to release" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "plymouth --ping" ]] || fail "with Plymouth gone, release does nothing" "$(cat "$calls")"
pass "T2.1 once home has drawn, Plymouth quits and leaves the screen as it is, and the splash is the boot's alone"

# --- tv, as the TV session starts --------------------------------------------

rm -f "$note"
splash tv || fail "tv runs without the note"
[[ ! -f $calls ]] || fail "without the boot's note, the TV session draws no splash" "$(cat "$calls")"
: >"$note"
splash tv || fail "tv runs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "quickshell -p /usr/share/agentv/session/splash background=#1a1b26 logo=$theme/logo.png" ]] ||
  fail "with the note, the TV session draws Plymouth's logo on Plymouth's background" "$(cat "$calls")"
sed -i 's/^Window.SetBackgroundTopColor(.*);/Window.SetBackgroundTopColor(0.157, 0.157, 0.157);/' "$theme/omarchy.script"
splash tv
[[ $(cat "$calls") == *"background=#282828 "* ]] || fail "another theme's splash colour comes through" "$(cat "$calls")"
pass "T2.1 the TV session draws the splash, in the colour Plymouth drew, only when the boot kept it"

splash "done" || fail "done never fails, splash or not" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'qs ipc -n -p /usr/share/agentv/session/splash call splash done\nsystemctl start --no-block agentv-boot-splash-release.service' ]] ||
  fail "done ends the splash, then lets Plymouth quit, now that home has drawn" "$(cat "$calls")"
grep -qx 'ExecStart=/usr/bin/agentv-boot-splash release' "$ROOT/system/agentv-boot-splash-release.service" ||
  fail "the release has a unit of its own, for the screen daemon to start"
rm -f "$note"
splash "done" || fail "done runs without the note" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "qs ipc -n -p /usr/share/agentv/session/splash call splash done" ]] || fail "without the note, there's no Plymouth to release" "$(cat "$calls")"
splash nope && fail "an unknown part is refused"
pass "T2.1 done ends the splash and releases Plymouth, and doesn't fail when there's none"

: >"$note"
splash desktop || fail "desktop runs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "systemctl start --no-block agentv-boot-splash-release.service" ]] ||
  fail "leaving for Omarchy's desktop before home has drawn lets Plymouth go" "$(cat "$calls")"
rm -f "$note"
splash desktop || fail "desktop runs without the note" "$(cat "$SCRATCH/out")"
[[ ! -f $calls ]] || fail "once home has drawn, Omarchy's desktop has no Plymouth to release" "$(cat "$calls")"
pass "T2.1 Omarchy's desktop started during the splash releases Plymouth, so the TV after it has no splash"

# --- where it hooks in ---------------------------------------------------------

dropin="$ROOT/system/plymouth-quit.service.d/agentv.conf"
grep -qx 'After=agentv-firstboot.service' "$dropin" || fail "Plymouth stays up through first boot's work"
[[ $(grep '^ExecStart=' "$dropin") == $'ExecStart=\nExecStart=-/usr/bin/agentv-boot-splash quit' ]] ||
  fail "Plymouth's quit is agentv-boot-splash's, and a failure doesn't hold the boot" "$(grep '^ExecStart=' "$dropin")"
pass "T2.1 Plymouth waits for first boot's work, and quits through agentv-boot-splash"

hypr="$ROOT/session/hypr.lua"
start=$(sed -n '/^hl.on("hyprland.start", function()$/,/^end)$/p' "$hypr" | grep -m 1 'hl.exec_cmd(')
[[ $start == '  hl.exec_cmd("agentv-boot-splash tv")' ]] || fail "the TV session starts the splash before anything else" "$start"
# Plymouth quitting as the session starts turns the screen black until the
# session's first frame, a second or more later.
grep -q 'agentv-boot-splash-release' "$hypr" && fail "the TV session's start doesn't release Plymouth: home's drawing does"
grep -qF 'background_color = splash_background() or "rgb(1a1b26)",' "$hypr" || fail "the TV session's first frame takes the splash's colour"
grep -qF 'io.open("/run/agentv-boot-splash", "r")' "$hypr" || fail "hypr.lua reads the boot's note"
grep -qF 'NOTE=${AGENTV_BOOT_SPLASH_NOTE:-/run/agentv-boot-splash}' "$ROOT/bin/agentv-boot-splash" ||
  fail "the note hypr.lua reads is the one agentv-boot-splash leaves"
if type -P lua >/dev/null; then
  lua -e 'hl = setmetatable({}, { __index = function() return function() return {} end end }); hl.dsp = setmetatable({}, { __index = function() return function() end end })' \
    -e "dofile('$hypr')" >"$SCRATCH/lua.out" 2>&1 || fail "hypr.lua still runs" "$(cat "$SCRATCH/lua.out")"
fi
pass "T2.1 the TV session starts the splash first, with its first frame in the splash's colour"

qml="$ROOT/session/splash/shell.qml"
for line in 'WlrLayershell.layer: WlrLayer.Overlay' 'WlrLayershell.keyboardFocus: WlrKeyboardFocus.None' 'mask: Region {}' \
  'target: "splash"' 'function done(): string'; do
  grep -qF "$line" "$qml" || fail "the splash covers everything, never takes the keyboard or the mouse, and answers done" "$line"
done
grep -qF 'interval: 90000' "$qml" || fail "the splash ends by itself"
pass "the TV session's splash is over everything, takes no input, ends on done or by itself"
