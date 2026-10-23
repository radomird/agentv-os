#!/bin/bash

# Guards the switch between the TV session and Omarchy's desktop (ADR-031):
# bin/agentv-session picks the TV, or Omarchy's own session once after
# agentv desktop, and the desktop after three TV sessions that couldn't
# start; agentv desktop and agentv tv go each way; agentv-session-setup and
# the migration make the TV session the one the box logs in to.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the scripts under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
calls="$SCRATCH/calls"
mkdir -p "$bin" "$SCRATCH/home" "$SCRATCH/omarchy/default/wayland-sessions"
echo "boot-one" >"$SCRATCH/boot_id"
printf '[Desktop Entry]\nName=Omarchy\nExec=uwsm start -g -1 -e -D Hyprland hyprland.desktop\n' \
  >"$SCRATCH/omarchy/default/wayland-sessions/omarchy.desktop"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

fake start-hyprland 'echo "start-hyprland $* tv=$AGENTV_SESSION no-sd-target=$HYPRLAND_NO_SD_TARGET desktop=$XDG_CURRENT_DESKTOP" >>"$CALLS"'
fake Hyprland 'echo "Hyprland $*" >>"$CALLS"'
fake omarchy-cmd-present 'type -P "$1" >/dev/null'
fake systemctl 'echo "systemctl $*" >>"$CALLS"'
fake logger ':'
fake uwsm 'echo "uwsm $* tv=${AGENTV_SESSION:-}" >>"$CALLS"'
fake omarchy-hyprland-window-close-all 'echo "close-all" >>"$CALLS"'
fake sudo '"$@"'
fake hyprctl 'echo "hyprctl $*" >>"$CALLS"'
fake omarchy-done 'exit 0'

run() {
  rm -f "$calls"
  env PATH="$bin:$ROOT/bin:$PATH" HOME="$SCRATCH/home" XDG_STATE_HOME="$SCRATCH/home/.local/state" \
    CALLS="$calls" AGENTV_PATH="$ROOT" OMARCHY_PATH="$SCRATCH/omarchy" AGENTV_SESSION_DIRS="$SCRATCH/none" \
    AGENTV_BOOT_ID_FILE="$SCRATCH/boot_id" "$BASH" "$@"
}

state="$SCRATCH/home/.local/state/agentv"

# --- agentv-session ---------------------------------------------------------

run "$ROOT/bin/agentv-session" 2>/dev/null || true
grep -q "^start-hyprland -- --config $ROOT/session/hypr.lua tv=tv no-sd-target=1 desktop=AgenTV:Hyprland" "$calls" ||
  fail "with no note it starts the TV session with AgenTV's Hyprland setup" "$(cat "$calls")"
grep -qx "systemctl --user stop agentv-tv.target" "$calls" || fail "the TV session's units stop with it" "$(cat "$calls")"
pass "S1.1 with no note, the log-in starts the TV session, without graphical-session.target"

rm -f "$state/quick-exits"
mkdir -p "$state"
echo "desktop boot-one" >"$state/next-session"
run "$ROOT/bin/agentv-session" 2>/dev/null || true
[[ $(cat "$calls") == "uwsm start -g -1 -e -D Hyprland hyprland.desktop tv=" ]] ||
  fail "a note from this boot starts Omarchy's own session, as its entry says" "$(cat "$calls")"
[[ ! -f $state/next-session ]] || fail "the note counts once"
pass "S1.3 a note from agentv desktop starts Omarchy's own session, once"

echo "desktop boot-zero" >"$state/next-session"
run "$ROOT/bin/agentv-session" 2>/dev/null || true
grep -q "^start-hyprland" "$calls" || fail "a note from an earlier boot is ignored" "$(cat "$calls")"
[[ ! -f $state/next-session ]] || fail "and removed"
pass "S1.1 after a power on, the TV comes back even if the desktop was on"

rm -f "$state/quick-exits"
for _ in 1 2 3; do
  run "$ROOT/bin/agentv-session" 2>/dev/null || true
done
[[ $(cut -d' ' -f1 "$state/quick-exits") == 3 ]] || fail "quick exits are counted" "$(cat "$state/quick-exits")"
run "$ROOT/bin/agentv-session" 2>/dev/null || true
grep -q "^uwsm start" "$calls" || fail "after three TV sessions that ended at once, Omarchy's desktop starts" "$(cat "$calls")"
[[ ! -f $state/quick-exits ]] || fail "and the count starts again"
pass "three TV sessions in a row that end within 20 s start Omarchy's desktop, so the box can be fixed"

fake start-hyprland 'echo "desktop boot-one" >"$XDG_STATE_HOME/agentv/next-session"'
run "$ROOT/bin/agentv-session" 2>/dev/null || true
[[ ! -f $state/quick-exits ]] || fail "a session left for the desktop isn't counted as a failure"
pass "a TV session left for the desktop doesn't count as one that couldn't start"
rm -f "$state/next-session"

# --- agentv desktop ---------------------------------------------------------

fake agentv-screen 'echo "agentv-screen $*" >>"$CALLS"; exit "${SCREEN_STATUS:-0}"'
ln -sf "$ROOT/bin/agentv-desktop" "$bin/agentv-desktop"
ln -sf "$ROOT/bin/agentv-pin-check" "$bin/agentv-pin-check"
ln -sf "$ROOT/bin/agentv-tv" "$bin/agentv-tv"

run "$bin/agentv-desktop" || fail "agentv desktop goes from the TV session" "$(cat "$calls")"
[[ $(cat "$state/next-session") == "desktop boot-one" ]] || fail "it leaves a note for this boot"
grep -qx "agentv-screen end" "$calls" || fail "the screen daemon closes the apps and ends the session" "$(cat "$calls")"
pass "S1.3 agentv desktop leaves a note for the next log-in and ends the TV session"

rm -f "$state/next-session"
SCREEN_STATUS=2 run "$bin/agentv-desktop" 2>/dev/null && fail "with no TV session, agentv desktop says it can't"
[[ ! -f $state/next-session ]] || fail "and leaves no note behind"
pass "with no TV session on, agentv desktop says so and leaves no note"

# --- agentv tv --------------------------------------------------------------

run "$bin/agentv-tv" || fail "agentv tv in the TV session"
[[ $(cat "$calls") == "agentv-screen home" ]] || fail "in the TV session it only puts the home screen in front" "$(cat "$calls")"
pass "in the TV session, agentv tv puts the home screen in front"

SCREEN_STATUS=2 run "$bin/agentv-tv" || fail "agentv tv on the desktop"
{ grep -qx "close-all" "$calls" && grep -q "^uwsm stop" "$calls"; } ||
  fail "on Omarchy's desktop it closes the windows and ends the session" "$(cat "$calls")"
pass "S1.3 on Omarchy's desktop, agentv tv closes its windows and ends its session"

# --- agentv-desktop-hook ----------------------------------------------------

loader="$SCRATCH/home/.local/state/omarchy/toggles/hypr/agentv-back-to-tv.lua"
run "$ROOT/bin/agentv-desktop-hook" --install
{ grep -q "dofile(path)" "$loader" && grep -q "local path = \"$ROOT/session/desktop.lua\"" "$loader"; } ||
  fail "--install writes a loader for Back to TV in Omarchy's toggles folder" "$(cat "$loader")"
{ grep -q 'SUPER + CTRL + Home' "$ROOT/session/desktop.lua" && grep -q '"agentv tv"' "$ROOT/session/desktop.lua"; } ||
  fail "Back to TV is Super+Ctrl+Home, running agentv tv"
pass "Back to TV on Omarchy's desktop is Super+Ctrl+Home, loaded from Omarchy's toggles folder"

rm -f "$loader"
run "$ROOT/bin/agentv-desktop-hook"
[[ -f $loader ]] || fail "the desktop's post-boot hook puts a missing loader back"
grep -q "hyprctl eval dofile" "$calls" || fail "and this session gets the key straight away" "$(cat "$calls")"
pass "a desktop that missed the loader gets it, and the key, when it starts"

grep -qx "agentv-desktop-hook" "$ROOT/config/omarchy/hooks/post-boot.d/agentv" ||
  fail "the desktop's post-boot hook runs agentv-desktop-hook"
grep -q "agentv-tv" "$ROOT/config/omarchy/hooks/post-boot.d/agentv" &&
  fail "the desktop no longer opens the TV"
pass "Omarchy's desktop no longer opens the TV; its post-boot hook only adds Back to TV"

# --- agentv-session-setup and the migration ---------------------------------

me=$(id -un)
AGENTV_SDDM_CONF_DIR="$SCRATCH/sddm.conf.d" AGENTV_STATE="$SCRATCH/var" run "$ROOT/bin/agentv-session-setup" "$me" ||
  fail "agentv-session-setup runs"
[[ $(cat "$SCRATCH/sddm.conf.d/agentv-autologin.conf") == $'[Autologin]\nUser='"$me"$'\nSession=agentv.desktop\nRelogin=true' ]] ||
  fail "SDDM logs the owner in to the TV session, and back in after every log-out" "$(cat "$SCRATCH/sddm.conf.d/agentv-autologin.conf")"
[[ -d $SCRATCH/var/chromium-home && $(stat -c %a "$SCRATCH/var/chromium-home" 2>/dev/null || stat -f %Lp "$SCRATCH/var/chromium-home") == 700 ]] ||
  fail "the home screen's profile belongs to the owner alone"
pass "S1.1 SDDM logs the owner in to the TV session, and the home screen gets its own profile"

AGENTV_SDDM_CONF_DIR="$SCRATCH/sddm.conf.d" AGENTV_STATE="$SCRATCH/var" run "$ROOT/bin/agentv-session-setup" "no-such-user-here" 2>/dev/null &&
  fail "an unknown owner is refused"
pass "an unknown owner is refused"

fake agentv-session-setup 'echo "agentv-session-setup $*" >>"$CALLS"'
migration=$(grep -l "agentv-session-setup" "$ROOT"/migrations/agentv/*.sh)
mkdir -p "$SCRATCH/home/.config/omarchy/hooks/post-boot.d"
echo "agentv-tv" >"$SCRATCH/home/.config/omarchy/hooks/post-boot.d/agentv"
rm -f "$loader"
run -euo pipefail "$migration" || fail "the TV session migration runs" "$(cat "$calls")"
grep -qx "agentv-session-setup $me" "$calls" || fail "it makes the TV session the one the box logs in to" "$(cat "$calls")"
cmp -s "$ROOT/config/omarchy/hooks/post-boot.d/agentv" "$SCRATCH/home/.config/omarchy/hooks/post-boot.d/agentv" ||
  fail "the desktop's post-boot hook stops opening the TV"
[[ -f $loader ]] || fail "the desktop gets Back to TV"
pass "the migration moves a box installed before onto the TV session"
