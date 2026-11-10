#!/bin/bash

# Guards the feature switches (daemon/features.ts) with Node's own test
# runner, then runs the daemon the way its unit does and checks agentv
# feature list, on and off: every track's switch is listed, on by default,
# off works on any channel and lasts through a restart, on puts a switch back
# to its default, and each says when the daemon isn't there. The rule that
# only edge turns on a switch that's off by default is features.test.mts's,
# since no switch is off by default now.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/features.test.mts"
type -P node >/dev/null || exit 0

flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
# start: the daemon on a free port, a new one each time, since another test
# running beside this one can take a port between its pick and the listen,
# and does across a restart. A port taken that way is tried again.
start() {
  local _attempt
  for _attempt in 1 2 3; do
    port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
    export AGENTV_PORT=$port
    AGENTV_PATH="$SCRATCH/root" AGENTV_DAEMON_STATE="$SCRATCH/state" AGENTV_LAN_PORT=0 AGENTV_SETUP_PORT=0 \
      node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning "$ROOT/daemon/server.ts" --port "$port" >"$SCRATCH/daemon.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 50); do
      curl -fsS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null && return 0
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    grep -q EADDRINUSE "$SCRATCH/daemon.log" || break
  done
  fail "the daemon starts" "$(cat "$SCRATCH/daemon.log")"
}
stop() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap 'stop; rm -rf "$SCRATCH"' EXIT
# The channel, as the package says it: the daemon reads it each time.
channel() {
  fake_agentv_path "$SCRATCH/root" "$1"
}

channel stable
start
out=$("$ROOT/bin/agentv" feature list) || fail "agentv feature list works" "$out"
expected=$(printf '%-12s on\n' boxcheck sizes looks dynamicbg setup2 remote2 starter discover askbuilds)
[[ $out == "$expected" ]] || fail "T12.1 agentv feature list shows every track's switch, on" "$out"
pass "T12.1 agentv feature list shows every track's switch, each on by default"

out=$("$ROOT/bin/agentv" feature off looks) || fail "on stable, agentv feature off works" "$out"
[[ $out == "looks is off." ]] || fail "it says what it did" "$out"
[[ $("$ROOT/bin/agentv" feature list | grep '^looks') == "looks        off" ]] || fail "agentv feature list shows it off"
[[ $(jq -c . "$SCRATCH/state/features.json") == '{"looks":false}' ]] || fail "it's kept in features.json in the daemon's state" "$(cat "$SCRATCH/state/features.json")"
grep -q "switches changed: looks off" "$SCRATCH/daemon.log" || fail "the daemon's log says so" "$(cat "$SCRATCH/daemon.log")"
pass "on stable, agentv feature off turns a switch off, kept in the daemon's state"

stop
start
[[ $("$ROOT/bin/agentv" feature list | grep '^looks') == "looks        off" ]] || fail "a switch stays off after the daemon restarts"
channel edge
[[ $("$ROOT/bin/agentv" feature list | grep '^looks') == "looks        off" ]] || fail "and on edge too"
channel stable
out=$("$ROOT/bin/agentv" feature on looks) || fail "agentv feature on puts it back, on stable too" "$out"
[[ $out == "looks is on." && ! -e $SCRATCH/state/features.json ]] || fail "and leaves nothing to keep" "$out"
pass "a switch stays off after a restart and on either channel, and agentv feature on puts it back to its default anywhere"

status=0
out=$("$ROOT/bin/agentv" feature on nope 2>&1) || status=$?
(( status == 1 )) && [[ $out == "There's no switch called \"nope\". The switches are boxcheck, sizes, looks, dynamicbg, setup2, remote2, starter, discover, askbuilds." ]] ||
  fail "a name that isn't a switch is refused, with the names" "$out"
for wrong in "" "Looks" "looks extra" '../x'; do
  status=0
  # shellcheck disable=SC2086 # the words are the point
  out=$("$ROOT/bin/agentv" feature off $wrong 2>&1) || status=$?
  (( status == 2 )) && [[ $out == Usage:* ]] || fail "agentv feature off $wrong shows how to use it" "$out"
done
pass "a name that isn't a switch, or no name, says how to use it"

stop
for words in "list" "on looks" "off looks"; do
  status=0
  # shellcheck disable=SC2086 # the words are the point
  out=$("$ROOT/bin/agentv" feature $words 2>&1) || status=$?
  (( status == 1 )) && [[ $out == *"isn't answering"* ]] || fail "agentv feature $words says when the daemon isn't there" "$out"
done
pass "agentv feature list, on and off say when the daemon isn't there"
