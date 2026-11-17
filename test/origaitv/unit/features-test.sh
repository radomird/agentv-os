#!/bin/bash

# Guards the feature switches (daemon/features.ts) with Node's own test
# runner, then runs the daemon the way its unit does and checks origaitv
# feature list, on and off: every track's switch is listed, the screens' on
# by default and the iPhone app's off, off works on any channel and lasts
# through a restart, on puts a switch back to its default, a switch that's
# off by default turns on only on edge, and each says when the daemon isn't
# there.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/features.test.mts"
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
    export ORIGAITV_PORT=$port
    ORIGAITV_PATH="$SCRATCH/root" ORIGAITV_DAEMON_STATE="$SCRATCH/state" ORIGAITV_LAN_PORT=0 ORIGAITV_SETUP_PORT=0 \
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
  fake_origaitv_path "$SCRATCH/root" "$1"
}

channel stable
start
out=$("$ROOT/bin/origaitv" feature list) || fail "origaitv feature list works" "$out"
expected=$(printf '%-12s on\n' boxcheck sizes looks dynamicbg setup2 remote2 starter discover askbuilds; printf '%-12s off\n' announce)
[[ $out == "$expected" ]] || fail "T12.1 origaitv feature list shows every track's switch, the screens' on and the iPhone app's off" "$out"
pass "T12.1 origaitv feature list shows every track's switch, the screens' on by default and the iPhone app's off"

out=$("$ROOT/bin/origaitv" feature off looks) || fail "on stable, origaitv feature off works" "$out"
[[ $out == "looks is off." ]] || fail "it says what it did" "$out"
[[ $("$ROOT/bin/origaitv" feature list | grep '^looks') == "looks        off" ]] || fail "origaitv feature list shows it off"
[[ $(jq -c . "$SCRATCH/state/features.json") == '{"looks":false}' ]] || fail "it's kept in features.json in the daemon's state" "$(cat "$SCRATCH/state/features.json")"
grep -q "switches changed: looks off" "$SCRATCH/daemon.log" || fail "the daemon's log says so" "$(cat "$SCRATCH/daemon.log")"
pass "on stable, origaitv feature off turns a switch off, kept in the daemon's state"

stop
start
[[ $("$ROOT/bin/origaitv" feature list | grep '^looks') == "looks        off" ]] || fail "a switch stays off after the daemon restarts"
channel edge
[[ $("$ROOT/bin/origaitv" feature list | grep '^looks') == "looks        off" ]] || fail "and on edge too"
channel stable
out=$("$ROOT/bin/origaitv" feature on looks) || fail "origaitv feature on puts it back, on stable too" "$out"
[[ $out == "looks is on." && ! -e $SCRATCH/state/features.json ]] || fail "and leaves nothing to keep" "$out"
pass "a switch stays off after a restart and on either channel, and origaitv feature on puts it back to its default anywhere"

# A switch that's off by default: only an edge box turns it on, and a box
# that goes back to stable shows it off again.
status=0
out=$("$ROOT/bin/origaitv" feature on announce 2>&1) || status=$?
(( status == 1 )) && [[ $out == "Switches only turn on on edge. Run origaitv channel edge, then origaitv update, and try again." ]] ||
  fail "on stable, a switch that's off by default doesn't turn on" "$out"
[[ ! -e $SCRATCH/state/features.json ]] || fail "and nothing is kept"
channel edge
out=$("$ROOT/bin/origaitv" feature on announce) || fail "on edge it turns on" "$out"
[[ $out == "announce is on." && $(jq -c . "$SCRATCH/state/features.json") == '{"announce":true}' ]] || fail "and it's kept in features.json" "$out"
channel stable
[[ $("$ROOT/bin/origaitv" feature list | grep '^announce') == "announce     off" ]] || fail "back on stable, it shows off again"
channel edge
[[ $("$ROOT/bin/origaitv" feature list | grep '^announce') == "announce     on" ]] || fail "and on again on edge"
out=$("$ROOT/bin/origaitv" feature off announce) || fail "origaitv feature off puts it back to its default" "$out"
[[ $out == "announce is off." && ! -e $SCRATCH/state/features.json ]] || fail "and leaves nothing to keep" "$out"
channel stable
pass "a switch that's off by default turns on only on edge, and shows off again on stable"

status=0
out=$("$ROOT/bin/origaitv" feature on nope 2>&1) || status=$?
(( status == 1 )) && [[ $out == "There's no switch called \"nope\". The switches are boxcheck, sizes, looks, dynamicbg, setup2, remote2, starter, discover, askbuilds, announce." ]] ||
  fail "a name that isn't a switch is refused, with the names" "$out"
for wrong in "" "Looks" "looks extra" '../x'; do
  status=0
  # shellcheck disable=SC2086 # the words are the point
  out=$("$ROOT/bin/origaitv" feature off $wrong 2>&1) || status=$?
  (( status == 2 )) && [[ $out == Usage:* ]] || fail "origaitv feature off $wrong shows how to use it" "$out"
done
pass "a name that isn't a switch, or no name, says how to use it"

stop
for words in "list" "on looks" "off looks"; do
  status=0
  # shellcheck disable=SC2086 # the words are the point
  out=$("$ROOT/bin/origaitv" feature $words 2>&1) || status=$?
  (( status == 1 )) && [[ $out == *"isn't answering"* ]] || fail "origaitv feature $words says when the daemon isn't there" "$out"
done
pass "origaitv feature list, on and off say when the daemon isn't there"
