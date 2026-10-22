#!/bin/bash

# Guards agentv-tested, the box's half of S0.7: an update goes ahead only when
# every pending package the signed tested.json lists is at its tested version,
# packages it doesn't list aren't held, and a list with a bad signature, or
# none, holds everything.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-tested"
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
