#!/bin/bash

# Guards bin/agentv-update-confirm, AgenTV's own question before an update
# (ADR-029): AgenTV's and Omarchy's versions, the other packages, edge, and
# AgenTV's release notes, never Omarchy's.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
mkdir -p "$bin"
cp "$ROOT/bin/agentv-update-confirm" "$ROOT/bin/agentv-channel" "$bin/"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

fake checkupdates 'cat "$STATE/pending"; exit "$(cat "$STATE/status")"'
fake pacman 'case "$2" in agentv) echo "agentv 0.1.1-1" ;; omarchy) echo "omarchy 4.0.6-1" ;; *) exit 1 ;; esac'
fake gum '
case "$1" in
  style) shift; while [[ $1 == --* ]]; do shift 2; done; printf "%s\n" "$@" ;;
  confirm) [[ ! -f $STATE/decline ]] ;;
esac'

fake_agentv_path "$SCRATCH/agentv" stable
state="$SCRATCH/state"

# ask <channel or ""> <status> [pending lines...]
ask() {
  local channel="$1" status="$2"
  shift 2
  rm -rf "${state:?}" "${SCRATCH:?}/etc" && mkdir -p "$state" "$SCRATCH/etc"
  [[ -n $channel ]] && echo "$channel" >"$SCRATCH/etc/channel"
  printf '%s\n' "$@" >"$state/pending"
  echo "$status" >"$state/status"
  [[ -n ${DECLINE:-} ]] && touch "$state/decline"
  env PATH="$bin:$PATH" STATE="$state" AGENTV_PATH="$SCRATCH/agentv" AGENTV_ETC="$SCRATCH/etc" \
    "$BASH" "$bin/agentv-update-confirm" >"$SCRATCH/out" 2>&1
}

ask "" 0 "agentv 0.1.1-1 -> 0.1.2-1" "omarchy 4.0.6-1 -> 4.0.7-1" "linux 7.2.8-9 -> 7.2.9-1" "mesa 1-1 -> 2-1" ||
  fail "a yes goes ahead" "$(cat "$SCRATCH/out")"
grep -qx "• AgenTV 0.1.1-1 to 0.1.2-1" "$SCRATCH/out" || fail "it says where AgenTV goes" "$(cat "$SCRATCH/out")"
grep -qx "• Omarchy 4.0.6-1 to 4.0.7-1" "$SCRATCH/out" || fail "it says where Omarchy goes" "$(cat "$SCRATCH/out")"
grep -qx "• 2 other packages" "$SCRATCH/out" || fail "it counts the other packages" "$(cat "$SCRATCH/out")"
grep -qx "What's new: https://example.invalid/agentv-os/releases" "$SCRATCH/out" || fail "it points at AgenTV's release notes" "$(cat "$SCRATCH/out")"
! grep -q "omacom\|battery" "$SCRATCH/out" || fail "nothing of Omarchy's question is left" "$(cat "$SCRATCH/out")"
pass "it shows AgenTV's and Omarchy's next versions, the other packages and AgenTV's release notes"

ask "" 2 || fail "nothing to update is still a question" "$(cat "$SCRATCH/out")"
grep -qx "• AgenTV 0.1.1-1, already the newest" "$SCRATCH/out" || fail "it says AgenTV is the newest" "$(cat "$SCRATCH/out")"
! grep -q "other package" "$SCRATCH/out" || fail "no other packages, no line about them"
pass "with nothing new, it says so"

ask edge 1 || fail "an offline check still asks" "$(cat "$SCRATCH/out")"
grep -qx "• On edge: every green build, not only releases" "$SCRATCH/out" || fail "it says when it's edge" "$(cat "$SCRATCH/out")"
grep -q "^• Couldn't check for other updates" "$SCRATCH/out" || fail "it says when it couldn't look" "$(cat "$SCRATCH/out")"
pass "it says when the box is on edge, and when it couldn't check"

! DECLINE=1 ask "" 0 "agentv 0.1.1-1 -> 0.1.2-1" || fail "a no exits 1"
grep -qx "Update cancelled" "$SCRATCH/out" || fail "a no says it's cancelled" "$(cat "$SCRATCH/out")"
pass "a no cancels the update"
