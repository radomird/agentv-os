#!/bin/bash

# Guards agentv-migrate: pending migrations run once each, oldest first, a
# failure stops there unmarked so the next update retries it, and a fresh
# install can mark them all as done. Updates in place (S0.5) run it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-migrate"
export AGENTV_PATH="$SCRATCH/agentv"
export AGENTV_MIGRATION_STATE="$SCRATCH/state"
log="$SCRATCH/ran"
mkdir -p "$AGENTV_PATH/migrations"

printf 'echo second >>"%s"\n' "$log" >"$AGENTV_PATH/migrations/1800000000.sh"
printf 'echo first >>"%s"\n' "$log" >"$AGENTV_PATH/migrations/900000000.sh"

[[ $("$cmd" --pending) == $'900000000.sh\n1800000000.sh' ]] || fail "--pending lists them oldest first" "$("$cmd" --pending)"
pass "--pending lists them oldest first"

"$cmd" >/dev/null
[[ $(cat "$log") == $'first\nsecond' ]] || fail "they run oldest first" "$(cat "$log")"
pass "they run oldest first"

"$cmd" >/dev/null
(( $(wc -l <"$log") == 2 )) || fail "each runs once" "$(cat "$log")"
"$cmd" --pending >/dev/null && fail "nothing is pending after a run"
pass "each runs once"

printf 'exit 3\n' >"$AGENTV_PATH/migrations/2000000000.sh"
"$cmd" >/dev/null 2>&1 && fail "a failing migration fails the run"
[[ $("$cmd" --pending) == "2000000000.sh" ]] || fail "a failed migration stays pending"
pass "a failed migration fails the run and stays pending"

rm -rf "$AGENTV_MIGRATION_STATE"
"$cmd" --mark-all-done
"$cmd" --pending >/dev/null && fail "--mark-all-done leaves nothing pending"
pass "--mark-all-done leaves nothing pending"

rm -rf "$AGENTV_PATH/migrations"
[[ $("$cmd") == "No AgenTV migrations to run" ]] || fail "no migrations folder is fine"
pass "no migrations folder is fine"
