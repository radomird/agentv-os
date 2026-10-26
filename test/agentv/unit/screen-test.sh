#!/bin/bash

# Guards daemon/screen.ts, AgenTV's screen daemon (ADR-031), with Node's own
# test runner: what's in front, what stays out of sight, and the home screen
# coming back after a crash (S1.1, S1.6). The box runs it on Arch's nodejs,
# which runs TypeScript as it is; so does any Node from 22.18 on.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

if ! type -P node >/dev/null; then
  [[ -n ${CI:-} ]] && fail "Node is installed" "the screen daemon's tests need Node 22.18 or newer"
  echo "skip - the screen daemon's tests (Node isn't installed)"
  exit 0
fi

# Node 22.6 to 22.17 runs TypeScript only when asked.
flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)

if ! node ${flags[@]+"${flags[@]}"} --test --test-reporter=tap "$ROOT/test/agentv/unit/screen.test.mts" >"$SCRATCH/tap" 2>&1; then
  fail "the screen daemon's tests pass" "$(grep -E '^(not ok|# |  ---|    )' "$SCRATCH/tap" | head -n 60)"
fi
grep -E '^ok ' "$SCRATCH/tap" | sed -E 's/^ok [0-9]+ - /ok - /'

# agentv screen's own requests, to a stand-in for the daemon's socket client.
fake_path="$SCRATCH/agentv"
mkdir -p "$fake_path/daemon"
echo 'console.log(process.argv[2]);' >"$fake_path/daemon/screen-call.ts"
screen() {
  AGENTV_PATH="$fake_path" "$ROOT/bin/agentv-screen" "$@"
}
[[ $(screen back down 1700000000123) == '{"cmd":"back","edge":"down","at":1700000000123}' ]] ||
  fail "agentv screen back down sends the press and when it happened" "$(screen back down 1700000000123 2>&1)"
[[ $(screen back up 5) == '{"cmd":"back","edge":"up","at":5}' ]] || fail "agentv screen back up sends the release"
[[ $(screen quit agentv.games) == '{"cmd":"quit","app":"agentv.games"}' ]] || fail "agentv screen quit names the app"
for bad in "back" "back left 1" "back down soon" "quit"; do
  # shellcheck disable=SC2086 # each case is words on purpose
  if screen $bad >/dev/null 2>&1; then fail "agentv screen $bad is refused"; fi
done
pass "agentv screen sends Back's presses and releases, and quit"

[[ $(screen pin desktop) == '{"cmd":"pin","action":"desktop"}' ]] || fail "agentv screen pin names the action"
if screen pin 'x; y' >/dev/null 2>&1; then fail "agentv screen pin takes only an action's name"; fi
pass "S4.5 agentv screen pin asks for the PIN on the TV, for an action"

[[ $(screen app local.player) == '{"cmd":"app","app":"local.player"}' ]] || fail "agentv screen app names the app"
if screen app >/dev/null 2>&1; then fail "agentv screen app with no id is refused"; fi
pass "agentv screen app opens an installed app by its id"
[[ $(screen app local.player '{"kind":"episode","title":"Spring","season":1,"episode":2}') == '{"cmd":"app","app":"local.player","item":{"id":"agentv-screen","kind":"episode","title":"Spring","season":1,"episode":2}}' ]] ||
  fail "agentv screen app passes an item on, with an id" "$(screen app local.player '{"kind":"episode","title":"Spring","season":1,"episode":2}')"
if screen app local.player '"Spring"' >/dev/null 2>&1; then fail "an item that isn't an object with a title is refused"; fi
pass "agentv screen app opens an item in an app through its playback.open (S3.2)"
