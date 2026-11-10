#!/bin/bash

# Guards agentv-tested, the box's half of S0.7: an update goes ahead only when
# every pending package the signed tested.json lists is at its tested version,
# packages it doesn't list aren't held, and a list with a bad signature, or
# none, holds everything.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-tested"
# Where the box keeps the date of the newest list it has taken: root's
# place, and the owner's own.
export AGENTV_UPDATE_STATE="$SCRATCH/update" XDG_STATE_HOME="$SCRATCH/home-state"
export GNUPGHOME="$SCRATCH/gnupg"
mkdir -m 700 "$GNUPGHOME"

# A throwaway key standing in for AgenTV's, and one standing in for anyone else's.
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key "AgenTV test key" ed25519 sign never 2>/dev/null
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key "Someone else" ed25519 sign never 2>/dev/null
gpg --batch --armor --export "AgenTV test key" >"$SCRATCH/agentv.gpg"
export AGENTV_KEYRING="$SCRATCH/agentv.gpg"

sign() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase '' --local-user "$2" \
    --detach-sign --output "$1.sig" "$1"
}

cat >"$SCRATCH/tested.json" <<'JSON'
{"schema": 1, "date": "2026-10-22T03:00:00Z", "agentv": "0.1.0", "omarchy": "4.0.6",
 "packages": {"omarchy": "4.0.7-1", "chromium": "142.0.1-1", "linux": "6.17.4.arch1-1"}}
JSON
sign "$SCRATCH/tested.json" "AgenTV test key"

printf '%s\n' "omarchy 4.0.6-1 -> 4.0.7-1" "chromium 141.0.9-1 -> 142.0.1-1" >"$SCRATCH/tested-only"
"$cmd" --tested "$SCRATCH/tested.json" --pending "$SCRATCH/tested-only" >/dev/null ||
  fail "S0.7 an update of tested versions goes ahead"
pass "S0.7 an update of tested versions goes ahead"

printf '%s\n' "omarchy 4.0.6-1 -> 4.0.7-1" "linux 6.17.3.arch1-1 -> 6.17.5.arch1-1" >"$SCRATCH/one-untested"
output=$("$cmd" --tested "$SCRATCH/tested.json" --pending "$SCRATCH/one-untested") &&
  fail "S0.7 an untested version holds back the whole update" "$output"
[[ $output == *"linux 6.17.5.arch1-1 (tested: 6.17.4.arch1-1)"* ]] ||
  fail "S0.7 it says which version is waiting" "$output"
pass "S0.7 an untested version holds back the whole update, and it says which"

printf '%s\n' "steam 1.0.0.84-1 -> 1.0.0.85-1" >"$SCRATCH/unlisted"
"$cmd" --tested "$SCRATCH/tested.json" --pending "$SCRATCH/unlisted" >/dev/null ||
  fail "a package the nightly run never installs isn't held"
pass "a package the nightly run never installs isn't held"

: >"$SCRATCH/nothing"
"$cmd" --tested "$SCRATCH/tested.json" --pending "$SCRATCH/nothing" >/dev/null ||
  fail "nothing pending is fine"
pass "nothing pending is fine"

# Then the night passes with the new kernel.
sed 's/6.17.4.arch1-1/6.17.5.arch1-1/' "$SCRATCH/tested.json" >"$SCRATCH/next.json"
sign "$SCRATCH/next.json" "AgenTV test key"
"$cmd" --tested "$SCRATCH/next.json" --pending "$SCRATCH/one-untested" >/dev/null ||
  fail "S0.7 the held version goes ahead once tested.json lists it"
pass "S0.7 the held version goes ahead once tested.json lists it"

cp "$SCRATCH/tested.json.sig" "$SCRATCH/next.json.sig"
"$cmd" --tested "$SCRATCH/next.json" --pending "$SCRATCH/one-untested" >/dev/null 2>&1 &&
  fail "a changed tested.json with an old signature holds everything"
pass "a changed tested.json with an old signature holds everything"

sign "$SCRATCH/next.json" "Someone else"
"$cmd" --tested "$SCRATCH/next.json" --pending "$SCRATCH/tested-only" >/dev/null 2>&1 &&
  fail "a tested.json signed by another key holds everything"
pass "a tested.json signed by another key holds everything"

rm -f "$SCRATCH/next.json.sig"
"$cmd" --tested "$SCRATCH/next.json" --pending "$SCRATCH/tested-only" >/dev/null 2>&1 &&
  fail "an unsigned tested.json holds everything"
pass "an unsigned tested.json holds everything"

# L4: a good signature says who made a list, not that it's the latest. A
# list older than the newest this box has taken is refused, whatever the
# box's clock says, and the same one again is fine.
fresh() {
  rm -rf "$AGENTV_UPDATE_STATE" "$XDG_STATE_HOME"
}
dated() {
  jq --arg date "$2" '.date = $date' "$SCRATCH/tested.json" >"$SCRATCH/$1.json"
  sign "$SCRATCH/$1.json" "AgenTV test key"
}
dated monday 2026-11-02T03:00:00Z
dated tuesday 2026-11-03T03:00:00Z

fresh
"$cmd" --tested "$SCRATCH/monday.json" --pending "$SCRATCH/tested-only" >/dev/null ||
  fail "L4 the first list a box ever sees is fine"
[[ $(cat "$AGENTV_UPDATE_STATE/tested-seen") == "2026-11-02T03:00:00Z" ]] || fail "L4 the box keeps its date"
pass "L4 the first list a box ever sees is fine, and the box keeps its date"

"$cmd" --tested "$SCRATCH/tuesday.json" --pending "$SCRATCH/tested-only" >/dev/null ||
  fail "L4 a newer list is fine"
[[ $(cat "$AGENTV_UPDATE_STATE/tested-seen") == "2026-11-03T03:00:00Z" ]] || fail "L4 the newest date moves on"
"$cmd" --tested "$SCRATCH/tuesday.json" --pending "$SCRATCH/tested-only" >/dev/null ||
  fail "L4 the same list again is fine"
pass "L4 a newer list is fine, and so is the same one again"

status=0
output=$("$cmd" --tested "$SCRATCH/monday.json" --pending "$SCRATCH/tested-only" 2>&1) || status=$?
(( status == 1 )) || fail "L4 an older list with a good signature is refused once a newer one was seen" "$output"
[[ $output == *"older than the one this box already has"* && $output == *"so the update waits"* ]] ||
  fail "L4 it says why, in the words the TV's update looks for" "$output"
[[ $(cat "$AGENTV_UPDATE_STATE/tested-seen") == "2026-11-03T03:00:00Z" ]] || fail "L4 a refused list changes nothing"
pass "L4 an older list with a good signature is refused once a newer one was seen"

# Seen by root's daily check, asked again by the owner's agentv update,
# who can't write root's folder and keeps their own.
fresh
mkdir -p "$SCRATCH/roots"
echo "2026-11-03T03:00:00Z" >"$SCRATCH/roots/tested-seen"
AGENTV_UPDATE_STATE="$SCRATCH/roots" "$cmd" --tested "$SCRATCH/monday.json" --pending "$SCRATCH/tested-only" >/dev/null 2>&1 &&
  fail "L4 what root's check saw counts for the owner's update too"
mkdir -p "$XDG_STATE_HOME/agentv"
echo "2026-11-03T03:00:00Z" >"$XDG_STATE_HOME/agentv/tested-seen"
AGENTV_UPDATE_STATE="$SCRATCH/nowhere/../nowhere" "$cmd" --tested "$SCRATCH/monday.json" --pending "$SCRATCH/tested-only" >/dev/null 2>&1 &&
  fail "L4 and so does what the owner's own update saw"
pass "L4 what either root's check or the owner's update saw counts"

# A date that isn't a date can't be put in order, and a scribbled note of
# what was seen doesn't lock the box out.
fresh
jq 'del(.date)' "$SCRATCH/tested.json" >"$SCRATCH/undated.json"
sign "$SCRATCH/undated.json" "AgenTV test key"
"$cmd" --tested "$SCRATCH/undated.json" --pending "$SCRATCH/tested-only" >/dev/null 2>&1 &&
  fail "L4 a list with no date is refused"
mkdir -p "$AGENTV_UPDATE_STATE"
echo "9999 not a date" >"$AGENTV_UPDATE_STATE/tested-seen"
"$cmd" --tested "$SCRATCH/monday.json" --pending "$SCRATCH/tested-only" >/dev/null ||
  fail "L4 a note that isn't a date is ignored"
pass "L4 a list with no date is refused, and a note that isn't a date is ignored"
