#!/bin/bash

# Guards bin/agentv-update's way to Omarchy's update: the repository line
# first, then the nightly run's tested.json on stable (ADR-026), and straight
# through on edge, which takes every green build (ADR-025), or with --untested.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

# agentv-update and agentv-channel as the package installs them, side by side,
# with fakes for the steps that need a real box.
bin="$SCRATCH/bin"
calls="$SCRATCH/calls"
mkdir -p "$bin"
cp "$ROOT/bin/agentv-update" "$ROOT/bin/agentv-channel" "$bin/"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

fake sudo 'exec "$@"'
fake agentv-pacman-conf 'echo pacman-conf >>"$CALLS"'
fake agentv-tested 'echo tested >>"$CALLS"; [[ -f $HOLD ]] && exit 1; exit 0'
fake omarchy-update 'echo "omarchy-update $*" >>"$CALLS"'
fake agentv-update-confirm 'echo confirm >>"$CALLS"; [[ ! -f $DECLINE ]]'

fake_agentv_path "$SCRATCH/agentv" stable

# update <channel or ""> [args...]
update() {
  local channel="$1"
  shift
  rm -rf "${SCRATCH:?}/etc" "${calls:?}"
  mkdir -p "$SCRATCH/etc"
  [[ -n $channel ]] && echo "$channel" >"$SCRATCH/etc/channel"
  env PATH="$bin:$PATH" CALLS="$calls" HOLD="$SCRATCH/hold" DECLINE="$SCRATCH/decline" \
    AGENTV_PATH="$SCRATCH/agentv" AGENTV_ETC="$SCRATCH/etc" \
    "$bin/agentv-update" "$@" >"$SCRATCH/out" 2>&1
}

rm -f "$SCRATCH/hold"
update "" -y || fail "stable updates when tested.json allows it" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'pacman-conf\ntested\nomarchy-update -y' ]] || fail "stable checks tested.json, then runs omarchy update -y" "$(cat "$calls")"
pass "stable puts the repository back, checks tested.json, then runs omarchy update"

touch "$SCRATCH/hold"
! update "" -y || fail "stable waits when tested.json holds it back"
! grep -q omarchy-update "$calls" || fail "nothing is updated while it waits"
pass "stable waits for the nightly run when an update isn't tested"

update "" -y --untested || fail "--untested goes ahead" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'pacman-conf\nomarchy-update -y' ]] || fail "--untested skips tested.json" "$(cat "$calls")"
pass "--untested skips tested.json"

update edge -y || fail "edge goes ahead even when tested.json would hold it" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'pacman-conf\nomarchy-update -y' ]] || fail "edge skips tested.json" "$(cat "$calls")"
grep -q "^On edge: taking AgenTV's newest green build" "$SCRATCH/out" || fail "edge says why it doesn't wait" "$(cat "$SCRATCH/out")"
pass "edge takes the newest green build without waiting for the nightly run"

rm -f "$SCRATCH/hold"
update "" || fail "an update without -y goes ahead once it's confirmed" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'pacman-conf\ntested\nconfirm\nomarchy-update -y' ]] ||
  fail "without -y, AgenTV asks, then Omarchy's update runs without asking again" "$(cat "$calls")"
pass "without -y, AgenTV's own question comes first, and Omarchy's update doesn't ask again"

touch "$SCRATCH/decline"
! update "" || fail "a no stops the update"
! grep -q omarchy-update "$calls" || fail "nothing is updated after a no"
rm -f "$SCRATCH/decline"
pass "a no to AgenTV's question updates nothing"
