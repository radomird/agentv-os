#!/bin/bash

# Guards agentv-restart, which every update runs after AgenTV's migrations:
# AgenTV's daemon, then the TV session's units under agentv-tv.target, on the
# version now installed, unless the box restarts anyway for a new kernel or
# because Omarchy's update says so. systemctl, sudo and the daemon are
# stand-ins here; the image layer updates a box for real.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-restart"
fakes="$SCRATCH/bin"
export CALLS="$SCRATCH/calls" STATE="$SCRATCH/state"
mkdir -p "$fakes" "$STATE" "$SCRATCH/modules/6.17.1-arch1-1" "$SCRATCH/home/.local/state/omarchy"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$fakes/$1"
  chmod +x "$fakes/$1"
}
fake uname 'echo 6.17.1-arch1-1'
fake sudo 'echo "sudo $*" >>"$CALLS"; [[ ! -f $STATE/daemon-fails ]] || exit 1; "$@"'
fake systemctl '
case "$*" in
  "is-active --quiet agentv-daemon.service") [[ ! -f $STATE/no-daemon ]] ;;
  "--user is-active --quiet agentv-tv.target") [[ ! -f $STATE/no-tv ]] ;;
  *) echo "systemctl $* (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-})" >>"$CALLS" ;;
esac'
fake curl '[[ ! -f $STATE/daemon-down ]]'
fake id 'echo 1000'

run() {
  : >"$CALLS"
  env -u XDG_RUNTIME_DIR PATH="$fakes:$PATH" HOME="$SCRATCH/home" AGENTV_MODULES_DIR="$SCRATCH/modules" AGENTV_RESTART_WAIT=0 \
    "$BASH" "$cmd" >"$SCRATCH/out" 2>&1
}

run || fail "a box after an update restarts AgenTV's services" "$(cat "$SCRATCH/out")"
[[ $(cat "$CALLS") == $'sudo systemctl restart agentv-daemon.service\nsystemctl restart agentv-daemon.service (XDG_RUNTIME_DIR=)\nsystemctl --user restart agentv-tv.target (XDG_RUNTIME_DIR=/run/user/1000)' ]] ||
  fail "the daemon, then the TV session's units, in the TV session's systemd" "$(cat "$CALLS")"
pass "after an update, the daemon restarts, then the TV session's units, in the session's own systemd"

touch "$STATE/no-tv"
run || fail "with the TV session off, only the daemon" "$(cat "$SCRATCH/out")"
! grep -q "agentv-tv.target" "$CALLS" || fail "nothing of a TV session that isn't on" "$(cat "$CALLS")"
rm "$STATE/no-tv"
pass "on Omarchy's desktop, only the daemon restarts"

touch "$STATE/daemon-fails"
! run || fail "a daemon that didn't restart is a failure"
grep -q "AgenTV's daemon didn't restart" "$SCRATCH/out" || fail "it says the daemon didn't restart" "$(cat "$SCRATCH/out")"
grep -q "agentv-tv.target" "$CALLS" || fail "the TV session's units still restart" "$(cat "$CALLS")"
rm "$STATE/daemon-fails"
touch "$STATE/daemon-down"
! run || fail "a daemon that doesn't answer after restarting is a failure"
grep -q "didn't answer within 0 s" "$SCRATCH/out" || fail "it says the daemon didn't answer" "$(cat "$SCRATCH/out")"
rm "$STATE/daemon-down"
pass "a daemon that doesn't restart or answer says so, and the TV's units restart anyway"

# A new kernel, or Omarchy's flag: the box restarts, so nothing does now.
rm -rf "$SCRATCH/modules/6.17.1-arch1-1"
run || fail "a new kernel isn't a failure" "$(cat "$SCRATCH/out")"
[[ ! -s $CALLS ]] || fail "nothing restarts before a new kernel's restart" "$(cat "$CALLS")"
grep -q "start again with the box" "$SCRATCH/out" || fail "it says the box restarts" "$(cat "$SCRATCH/out")"
mkdir -p "$SCRATCH/modules/6.17.1-arch1-1"
touch "$SCRATCH/home/.local/state/omarchy/reboot-required"
run || fail "Omarchy's flag isn't a failure" "$(cat "$SCRATCH/out")"
[[ ! -s $CALLS ]] || fail "nothing restarts when Omarchy's update wants the box restarted" "$(cat "$CALLS")"
pass "with a new kernel, or when Omarchy's update says the box needs restarting, it leaves it to that"
