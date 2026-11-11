#!/bin/bash

# Guards the one idle screen (T17.1): the terminal screensaver is gone from
# AgenTV's files, and the migration makes a TV that had picked it forget the
# pick and keep the rest of its settings.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

[[ ! -e $ROOT/bin/agentv-screensaver ]] || fail "bin/agentv-screensaver is gone"
found=$(grep -rln "agentv-screensaver\|org\.agentv\.screensaver\|screensaver-after" "$ROOT"/bin/agentv* "$ROOT"/daemon "$ROOT"/launcher "$ROOT"/session "$ROOT"/system "$ROOT"/install/tv 2>/dev/null || true)
[[ -z $found ]] || fail "nothing of AgenTV's starts or names the terminal screensaver" "$found"
pass "T17.1 the terminal screensaver is gone: no command, no window, nothing that starts one"

migration=$(grep -l "The terminal screensaver is gone" "$ROOT"/migrations/agentv/*.sh)
[[ -n $migration ]] || fail "there's a migration for a TV that had picked it"

# sudo and pkill as far as the migration uses them, with no root here.
mkdir -p "$SCRATCH/bin" "$SCRATCH/state"
printf '#!/bin/bash\nexec "$@"\n' >"$SCRATCH/bin/sudo"
printf '#!/bin/bash\necho "$*" >>"%s/pkill.log"\n' "$SCRATCH" >"$SCRATCH/bin/pkill"
chmod +x "$SCRATCH/bin/sudo" "$SCRATCH/bin/pkill"
run_migration() {
  AGENTV_DAEMON_STATE="$SCRATCH/state" PATH="$SCRATCH/bin:$PATH" bash "$migration"
}

if ! type -P jq >/dev/null; then
  [[ -n ${CI:-} ]] && fail "jq is installed"
  echo "skip - the migration's own run (jq isn't installed)"
  exit 0
fi

settings="$SCRATCH/state/settings.json"
printf '{"sound":{"on":true,"volume":0.4},"idleMinutes":30,"ambient":"terminal","spoken":false}\n' >"$settings"
chmod 600 "$settings"
run_migration || fail "the migration runs"
[[ $(jq -c . "$settings") == '{"sound":{"on":true,"volume":0.4},"idleMinutes":30,"spoken":false}' ]] ||
  fail "the pick goes and the rest stays" "$(cat "$settings")"
[[ $(stat -c %a "$settings") == 600 ]] || fail "the file keeps its mode" "$(stat -c %a "$settings")"
[[ ! -e $settings.next ]] || fail "nothing is left beside it"
grep -q -- "org.agentv.screensaver" "$SCRATCH/pkill.log" || fail "one still running is stopped" "$(cat "$SCRATCH/pkill.log" 2>&1)"
pass "T17.1 a TV that had picked the terminal screensaver forgets the pick, and keeps the rest of its settings"

# Again, and on a TV that never picked it, or has no settings yet: nothing
# changes and nothing fails.
before=$(cat "$settings")
run_migration || fail "the migration runs twice"
[[ $(cat "$settings") == "$before" ]] || fail "a second run changes nothing"
rm -f "$settings"
run_migration || fail "the migration runs with no settings yet"
[[ ! -e $settings ]] || fail "it makes no settings file of its own"
pass "T17.1 the migration changes nothing the second time, or on a TV with no settings yet"
