#!/bin/bash

# Guards agentv-pin-check (ADR-009, S4.5) against a real daemon: everything
# goes ahead with no PIN set; with one, only the TV's grant, the PIN typed in
# a terminal or the PIN entered on the TV lets an action through.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

type -P node >/dev/null || exit 0
flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}
port=$(free_port)
AGENTV_PATH="$ROOT" AGENTV_DAEMON_STATE="$SCRATCH/state" AGENTV_LAN_PORT=0 AGENTV_SETUP_PORT=0 \
  node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning "$ROOT/daemon/server.ts" --port "$port" >"$SCRATCH/daemon.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
url="http://127.0.0.1:$port"
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$url/health" 2>/dev/null && break
  sleep 0.1
done

# The TV, as agentv screen pin reaches it: it answers with SCREEN_REPLY.
cat >"$SCRATCH/screen" <<'SH'
#!/bin/bash
echo "$*" >>"$CALLS"
reply=${SCREEN_REPLY:-'{"ok":false}'}
echo "$reply"
[[ $(jq -r .ok <<<"$reply") == "true" ]]
SH
chmod +x "$SCRATCH/screen"
export CALLS="$SCRATCH/calls"
check() {
  AGENTV_PORT=$port AGENTV_SCREEN="$SCRATCH/screen" "$ROOT/bin/agentv-pin-check" "$@" </dev/null
}

check desktop 2>"$SCRATCH/err" || fail "with no pin set, an action goes ahead" "$(cat "$SCRATCH/err")"
[[ ! -s $CALLS ]] || fail "and nothing is asked on the TV"
pass "S4.5 with no PIN set, agentv-pin-check lets an action go ahead"

curl -fsS -o /dev/null -X PUT -H 'Content-Type: application/json' -d '{"pin":"4826"}' "$url/api/pin" || fail "a pin can be set"
grant=$(curl -fsS -H 'Content-Type: application/json' -d '{"pin":"4826"}' "$url/api/pin/check" | jq -r .grant)

if check desktop 2>"$SCRATCH/err"; then fail "S4.5 with a pin set, an action with no pin is refused"; fi
[[ $(cat "$SCRATCH/err") == "That needs the adult PIN." ]] || fail "it says why" "$(cat "$SCRATCH/err")"
[[ $(cat "$CALLS") == "pin desktop" ]] || fail "with no terminal, it asks on the TV" "$(cat "$CALLS")"
pass "S4.5 with a PIN set and no terminal, agentv-pin-check asks on the TV, and refuses when it isn't entered"

AGENTV_PIN_GRANT=$grant check power || fail "the TV's grant lets an action through"
: >"$CALLS"
if AGENTV_PIN_GRANT=made-up check power 2>/dev/null; then fail "a made-up grant doesn't"; fi
SCREEN_REPLY="{\"ok\":true,\"grant\":\"$grant\"}" check desktop || fail "the pin entered on the TV does"
SCREEN_REPLY='{"ok":true,"grant":"made-up"}' check desktop 2>/dev/null && fail "a grant the daemon didn't give doesn't"
pass "S4.5 the grant the TV got for the PIN lets an action through, and nothing else does"

if type -P script >/dev/null; then
  terminal() {
    printf '%s\n' "$@" | AGENTV_PORT=$port AGENTV_SCREEN="$SCRATCH/screen" script -qec "$ROOT/bin/agentv-pin-check desktop" /dev/null >"$SCRATCH/out" 2>&1
  }
  terminal 4826 || fail "the pin typed in a terminal lets an action through" "$(cat "$SCRATCH/out")"
  terminal 0000 1111 2222 && fail "three wrong pins in a terminal don't" "$(cat "$SCRATCH/out")"
  grep -q "That's not the pin" "$SCRATCH/out" || fail "and it says so" "$(cat "$SCRATCH/out")"
  pass "S4.5 in a terminal, agentv-pin-check asks for the PIN there"
fi

if grep -q 4826 "$SCRATCH/daemon.log"; then fail "the daemon never logs the pin" "$(cat "$SCRATCH/daemon.log")"; fi
pass "S4.5 the PIN isn't in the daemon's log"

kill "$pid"
wait "$pid" 2>/dev/null || true
down=$(free_port)
AGENTV_PORT=$down "$ROOT/bin/agentv-pin-check" desktop 2>/dev/null </dev/null || fail "with the daemon down, Omarchy's desktop still goes ahead, to fix the box"
if AGENTV_PORT=$down "$ROOT/bin/agentv-pin-check" power 2>/dev/null </dev/null; then fail "but nothing else does"; fi
if "$ROOT/bin/agentv-pin-check" 'x; y' 2>/dev/null; then fail "an action is a name"; fi
pass "with AgenTV's daemon down, only Omarchy's desktop goes ahead, so the box can be fixed"
