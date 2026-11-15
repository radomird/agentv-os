#!/bin/bash

# Guards daemon/screen.ts, OrigaiTV's screen daemon (ADR-031), with Node's own
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

if ! node ${flags[@]+"${flags[@]}"} --test --test-reporter=tap "$ROOT/test/origaitv/unit/screen.test.mts" >"$SCRATCH/tap" 2>&1; then
  fail "the screen daemon's tests pass" "$(grep -E '^(not ok|# |  ---|    )' "$SCRATCH/tap" | head -n 60)"
fi
grep -E '^ok ' "$SCRATCH/tap" | sed -E 's/^ok [0-9]+ - /ok - /'

# origaitv screen's own requests, to a stand-in for the daemon's socket client.
fake_path="$SCRATCH/origaitv"
mkdir -p "$fake_path/daemon"
echo 'console.log(process.argv[2]);' >"$fake_path/daemon/screen-call.ts"
screen() {
  ORIGAITV_PATH="$fake_path" "$ROOT/bin/origaitv-screen" "$@"
}
[[ $(screen back down 1700000000123) == '{"cmd":"back","edge":"down","at":1700000000123}' ]] ||
  fail "origaitv screen back down sends the press and when it happened" "$(screen back down 1700000000123 2>&1)"
[[ $(screen back up 5) == '{"cmd":"back","edge":"up","at":5}' ]] || fail "origaitv screen back up sends the release"
[[ $(screen quit origaitv.games) == '{"cmd":"quit","app":"origaitv.games"}' ]] || fail "origaitv screen quit names the app"
[[ $(screen apps add) == '{"cmd":"apps","page":"add"}' ]] || fail "origaitv screen apps add asks for Apps' add an app"
for bad in "back" "back left 1" "back down soon" "quit" "apps settings" "apps add more"; do
  # shellcheck disable=SC2086 # each case is words on purpose
  if screen $bad >/dev/null 2>&1; then fail "origaitv screen $bad is refused"; fi
done
pass "origaitv screen sends Back's presses and releases, and quit"

[[ $(screen pin desktop) == '{"cmd":"pin","action":"desktop"}' ]] || fail "origaitv screen pin names the action"
if screen pin 'x; y' >/dev/null 2>&1; then fail "origaitv screen pin takes only an action's name"; fi
pass "S4.5 origaitv screen pin asks for the PIN on the TV, for an action"

[[ $(screen app local.player) == '{"cmd":"app","app":"local.player"}' ]] || fail "origaitv screen app names the app"
if screen app >/dev/null 2>&1; then fail "origaitv screen app with no id is refused"; fi
pass "origaitv screen app opens an installed app by its id"
[[ $(screen app local.player '{"kind":"episode","title":"Spring","season":1,"episode":2}') == '{"cmd":"app","app":"local.player","item":{"id":"origaitv-screen","kind":"episode","title":"Spring","season":1,"episode":2}}' ]] ||
  fail "origaitv screen app passes an item on, with an id" "$(screen app local.player '{"kind":"episode","title":"Spring","season":1,"episode":2}')"
if screen app local.player '"Spring"' >/dev/null 2>&1; then fail "an item that isn't an object with a title is refused"; fi
pass "origaitv screen app opens an item in an app through its playback.open (S3.2)"
