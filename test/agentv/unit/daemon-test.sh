#!/bin/bash

# Guards AgenTV's daemon (daemon/server.ts) with Node's own test runner, then
# runs it the way its unit does and checks what the image checks and the
# selftest read: the welcome page, /health, and agentv setup skip and reset.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/server.test.mts"
type -P node >/dev/null || exit 0

flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
AGENTV_PATH="$ROOT" AGENTV_DAEMON_STATE="$SCRATCH/state" AGENTV_LAN_PORT=0 \
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
grep -q "agentv daemon on http://127.0.0.1:$port/" "$SCRATCH/daemon.log" || fail "the daemon says where it listens" "$(cat "$SCRATCH/daemon.log")"
pass "S0.1 the daemon runs as its unit runs it, and /health starts on the welcome screen"

page=$(curl -fsS "$url/")
[[ $page == *"<h1>Hi.</h1>"* && $page == *"/api/welcome-shown"* ]] || fail "the welcome page is served, and reports itself"
curl -fsS -o /dev/null -X POST "$url/api/welcome-shown" || fail "the welcome page can say it's drawn"
[[ $(curl -fsS "$url/health" | jq -r '.welcome_shown_count') == 1 ]] || fail "/health counts each time the welcome page is drawn"
pass "the welcome page is served, and /health counts each time it's drawn"

out=$(AGENTV_PORT=$port "$ROOT/bin/agentv-setup-skip") || fail "agentv setup skip works" "$out"
[[ $out == "Setup is marked done, so the TV shows the home screen." ]] || fail "agentv setup skip says what it did" "$out"
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "home" ]] || fail "after agentv setup skip, the TV is on the home screen"
[[ $(jq -r '.done' "$SCRATCH/state/setup.json") == "true" ]] || fail "setup's state is kept in the daemon's state folder"
out=$(AGENTV_PORT=$port "$ROOT/bin/agentv-setup-reset") || fail "agentv setup reset works" "$out"
[[ $(curl -fsS "$url/health" | jq -r '.screen') == "welcome" ]] || fail "after agentv setup reset, the TV is on the welcome page"
pass "agentv setup skip and reset move the TV between the welcome page and home"

kill "$pid"
wait "$pid" 2>/dev/null || true
status=0
out=$(AGENTV_PORT=$port "$ROOT/bin/agentv-setup-skip" 2>&1) || status=$?
if (( status != 1 )) || [[ $out != *"isn't answering"* ]]; then
  fail "agentv setup skip says when the daemon isn't there" "$out"
fi
pass "agentv setup skip says when the daemon isn't there"

# Boxes installed before it restart the daemon at their next update.
mkdir -p "$SCRATCH/bin"
printf '#!/bin/bash\necho "sudo $*" >>"%s/calls"\n' "$SCRATCH" >"$SCRATCH/bin/sudo"
chmod +x "$SCRATCH/bin/sudo"
migration=$(grep -l "agentv-daemon.service" "$ROOT"/migrations/agentv/*.sh)
PATH="$SCRATCH/bin:$PATH" bash "$migration"
[[ $(cat "$SCRATCH/calls") == "sudo systemctl try-restart agentv-daemon.service" ]] ||
  fail "the migration restarts the daemon" "$(cat "$SCRATCH/calls")"
pass "an update restarts the daemon, so a box runs the new one without waiting for a reboot"
