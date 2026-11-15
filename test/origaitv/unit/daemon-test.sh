#!/bin/bash

# Guards OrigaiTV's daemon (daemon/server.ts) with Node's own test runner, then
# runs it the way its unit does and checks what the image checks and the
# selftest read: the welcome page, /health, and origaitv setup skip and reset.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/server.test.mts"
type -P node >/dev/null || exit 0

flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
ORIGAITV_PATH="$ROOT" ORIGAITV_DAEMON_STATE="$SCRATCH/state" ORIGAITV_LAN_PORT=0 ORIGAITV_SETUP_PORT=0 \
  node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning "$ROOT/daemon/server.ts" --port "$port" >"$SCRATCH/daemon.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT

url="http://127.0.0.1:$port"
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$url/health" 2>/dev/null && break
  sleep 0.1
done

health=$(curl -fsS "$url/health") || fail "/health answers" "$(cat "$SCRATCH/daemon.log")"
[[ $(jq -r '.ok, .screen, .welcome_shown' <<<"$health" | paste -sd ' ' -) == "true welcome false" ]] ||
  fail "S0.1 /health starts on the welcome screen, not yet shown" "$health"
grep -q "origaitv daemon on http://127.0.0.1:$port/" "$SCRATCH/daemon.log" || fail "the daemon says where it listens" "$(cat "$SCRATCH/daemon.log")"
pass "S0.1 the daemon runs as its unit runs it, and /health starts on the welcome screen"

page=$(curl -fsS "$url/")
[[ $page == *"<title>OrigaiTV setup</title>"* && $(curl -fsS "$url/setup/main.ts") == *"/api/welcome-shown"* ]] || fail "setup's page is served, and reports itself"
curl -fsS -o /dev/null -X POST "$url/api/welcome-shown" || fail "the welcome page can say it's drawn"
[[ $(curl -fsS "$url/health" | jq -r '.welcome_shown_count') == 1 ]] || fail "/health counts each time the welcome page is drawn"
pass "the welcome page is served, and /health counts each time it's drawn"

out=$(ORIGAITV_PORT=$port "$ROOT/bin/origaitv-setup-skip") || fail "origaitv setup skip works" "$out"
[[ $out == "Setup is marked done, so the TV shows the home screen." ]] || fail "origaitv setup skip says what it did" "$out"
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "home" ]] || fail "after origaitv setup skip, the TV is on the home screen"
[[ $(jq -r '.done' "$SCRATCH/state/setup.json") == "true" ]] || fail "setup's state is kept in the daemon's state folder"
out=$(ORIGAITV_PORT=$port "$ROOT/bin/origaitv-setup-reset") || fail "origaitv setup reset works" "$out"
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "welcome" ]] || fail "after origaitv setup reset, the TV is on the welcome page"
pass "origaitv setup skip and reset move the TV between the welcome page and home"

# With an adult PIN set, starting setup again needs it.
ORIGAITV_PORT=$port "$ROOT/bin/origaitv-setup-skip" >/dev/null || fail "origaitv setup skip works"
curl -fsS -o /dev/null -X PUT -H 'Content-Type: application/json' -d '{"pin": "4826"}' "$url/api/pin" || fail "a PIN is set"
status=0
out=$(ORIGAITV_PORT=$port "$ROOT/bin/origaitv-setup-reset" 2>&1) || status=$?
if (( status != 1 )) || [[ $out != *"ORIGAITV_PIN"* ]]; then fail "origaitv setup reset says it needs the PIN" "$out"; fi
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "home" ]] || fail "and setup stays done"
status=0
out=$(ORIGAITV_PORT=$port ORIGAITV_PIN=0000 "$ROOT/bin/origaitv-setup-reset" 2>&1) || status=$?
if (( status != 1 )) || [[ $out != *"Wrong PIN"* ]]; then fail "a wrong PIN is refused" "$out"; fi
# The PIN there starts setup again and nothing more: a wrong try on the TV's
# pad before it still counts after it.
curl -sS -o /dev/null -H 'Content-Type: application/json' -d '{"pin": "0000"}' "$url/api/pin/check"
tries=$(jq -r '.fails' "$SCRATCH/state/pin.json")
(( tries > 0 )) || fail "a wrong try on the pad is counted"
out=$(ORIGAITV_PORT=$port ORIGAITV_PIN=4826 "$ROOT/bin/origaitv-setup-reset") || fail "origaitv setup reset works with the PIN" "$out"
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "welcome" ]] || fail "with the PIN, the TV is on the welcome page"
[[ $(jq -r '.fails' "$SCRATCH/state/pin.json") == "$tries" ]] || fail "origaitv setup reset's PIN leaves the pad's wrong tries as they were" "$(jq -c 'del(.hash)' "$SCRATCH/state/pin.json")"
pass "with an adult PIN set, origaitv setup reset needs it, and its PIN does nothing else"

kill "$pid"
wait "$pid" 2>/dev/null || true
status=0
out=$(ORIGAITV_PORT=$port "$ROOT/bin/origaitv-setup-skip" 2>&1) || status=$?
if (( status != 1 )) || [[ $out != *"isn't answering"* ]]; then
  fail "origaitv setup skip says when the daemon isn't there" "$out"
fi
pass "origaitv setup skip says when the daemon isn't there"

# Boxes installed before it restart the daemon at their next update.
mkdir -p "$SCRATCH/bin"
printf '#!/bin/bash\necho "sudo $*" >>"%s/calls"\n' "$SCRATCH" >"$SCRATCH/bin/sudo"
chmod +x "$SCRATCH/bin/sudo"
migration=$(grep -l "origaitv-daemon.service" "$ROOT"/migrations/origaitv/*.sh)
PATH="$SCRATCH/bin:$PATH" bash "$migration"
[[ $(cat "$SCRATCH/calls") == "sudo systemctl try-restart origaitv-daemon.service" ]] ||
  fail "the migration restarts the daemon" "$(cat "$SCRATCH/calls")"
pass "an update restarts the daemon, so a box runs the new one without waiting for a reboot"

# And they get the watch for a lost network started, which otherwise waits
# for a restart of the box.
: >"$SCRATCH/calls"
migration=$(grep -l "origaitv-hotspot-watch.service" "$ROOT"/migrations/origaitv/*.sh)
PATH="$SCRATCH/bin:$PATH" bash "$migration"
[[ $(cat "$SCRATCH/calls") == "sudo systemctl start origaitv-hotspot-watch.service" ]] ||
  fail "the migration starts the watch for a lost network" "$(cat "$SCRATCH/calls")"
pass "an update starts the watch for a lost network on a box installed before it"
