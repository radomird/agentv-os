#!/bin/bash

# Guards agentv-migrate: pending migrations run once each, oldest first, a
# failure stops there unmarked so the next update retries it, and a fresh
# install can mark them all as done. Updates in place (S0.5) run it, and it
# restarts AgenTV's services after them (agentv-restart, a stand-in here).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-migrate"
export AGENTV_PATH="$SCRATCH/agentv"
export AGENTV_MIGRATION_STATE="$SCRATCH/state"
log="$SCRATCH/ran"
export AGENTV_RESTART="$SCRATCH/restart"
printf '#!/bin/bash\necho restart >>"%s"\n' "$log" >"$AGENTV_RESTART"
chmod +x "$AGENTV_RESTART"
mkdir -p "$AGENTV_PATH/migrations"

printf 'echo second >>"%s"\n' "$log" >"$AGENTV_PATH/migrations/1800000000.sh"
printf 'echo first >>"%s"\n' "$log" >"$AGENTV_PATH/migrations/900000000.sh"

[[ $("$cmd" --pending) == $'900000000.sh\n1800000000.sh' ]] || fail "--pending lists them oldest first" "$("$cmd" --pending)"
pass "--pending lists them oldest first"

"$cmd" >/dev/null
[[ $(cat "$log") == $'first\nsecond\nrestart' ]] || fail "they run oldest first, then AgenTV's services restart" "$(cat "$log")"
pass "they run oldest first, then AgenTV's services restart"

"$cmd" >/dev/null
[[ $(cat "$log") == $'first\nsecond\nrestart\nrestart' ]] || fail "each runs once, and the services restart with none to run" "$(cat "$log")"
"$cmd" --pending >/dev/null && fail "nothing is pending after a run"
pass "each runs once, and the services restart after an update with none to run"

printf 'exit 3\n' >"$AGENTV_PATH/migrations/2000000000.sh"
"$cmd" >/dev/null 2>&1 && fail "a failing migration fails the run"
[[ $("$cmd" --pending) == "2000000000.sh" ]] || fail "a failed migration stays pending"
(( $(grep -c restart "$log") == 2 )) || fail "nothing restarts after a failed migration" "$(cat "$log")"
pass "a failed migration fails the run, stays pending, and restarts nothing"

# A service that didn't restart doesn't fail the update.
rm "$AGENTV_PATH/migrations/2000000000.sh"
printf '#!/bin/bash\nexit 1\n' >"$AGENTV_RESTART"
"$cmd" >/dev/null || fail "a restart that failed doesn't fail the run"
printf '#!/bin/bash\necho restart >>"%s"\n' "$log" >"$AGENTV_RESTART"
pass "a restart that failed doesn't fail the update"

rm -rf "$AGENTV_MIGRATION_STATE"
"$cmd" --mark-all-done
"$cmd" --pending >/dev/null && fail "--mark-all-done leaves nothing pending"
pass "--mark-all-done leaves nothing pending"

rm -rf "$AGENTV_PATH/migrations"
[[ $("$cmd") == "No AgenTV migrations to run" ]] || fail "no migrations folder is fine"
pass "no migrations folder is fine"
