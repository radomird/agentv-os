#!/bin/bash

# Guards bin/agentv-quiet-first-run: Omarchy's first-run notifications that
# have no marker are dismissed until Omarchy's first run, network check
# included, is done, and then it stops (ADR-029).

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
state="$SCRATCH/state"
mkdir -p "$bin" "$state"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

# Each dismiss is logged; first run finishes after a few of them.
fake omarchy-notification-dismiss 'echo "$1" >>"$STATE/dismissed"'
fake omarchy-done '[[ $1 == check && $2 == first-run-user && $(wc -l <"$STATE/dismissed" 2>/dev/null || echo 0) -ge 6 ]]'
fake pgrep '[[ ! -f $STATE/network-check ]] && exit 1; exit 0'

run() {
  env PATH="$bin:$PATH" STATE="$state" AGENTV_QUIET_INTERVAL=0.05 AGENTV_QUIET_SECONDS="${1:-20}" \
    "$BASH" "$ROOT/bin/agentv-quiet-first-run"
}

run
grep -qx "Learn Keybindings" "$state/dismissed" || fail "it dismisses Learn Keybindings"
grep -qx "Update System" "$state/dismissed" || fail "it dismisses Update System"
! grep -Eqv '^(Learn Keybindings|Update System)$' "$state/dismissed" || fail "it dismisses nothing else, such as Setup Wi-Fi"
(( $(wc -l <"$state/dismissed") < 20 )) || fail "it stops once Omarchy's first run is done"
pass "it dismisses Omarchy's keybinding and update notices until first run is done, and then stops"

rm -f "$state/dismissed"
touch "$state/network-check"
# SECONDS ticks in whole seconds, so a 3 s deadline means 2 to 3 s of work.
start=$SECONDS
run 3
(( SECONDS - start <= 5 )) || fail "it gives up at its deadline"
(( $(wc -l <"$state/dismissed") > 6 )) || fail "it keeps going while the network check runs"
pass "it keeps going while first run's network check still runs, up to its deadline"
