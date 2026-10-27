#!/bin/bash

# Guards agentv-key-store (S4.6): the key the daemon was handed goes into the
# env file, root's alone, replacing any provider key and keeping the other
# lines; key.json says which provider has one, with no key in it; a drop
# with no provider takes it off; and nothing it prints has the key.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_ETC="$SCRATCH/etc" AGENTV_KEY_DROP="$SCRATCH/drop/key.json"
mkdir -p "$SCRATCH/drop" "$AGENTV_ETC"
KEY="sk-ant-api03-$(printf 'a%.0s' {1..40})"
store() {
  "$ROOT/bin/agentv-key-store" >"$SCRATCH/out" 2>&1
}
drop() {
  printf '%s' "$1" >"$AGENTV_KEY_DROP"
}

store || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_ETC/env ]] || fail "and writes nothing"

printf 'TMDB_API_KEY=tmdb123\nOPENAI_API_KEY=sk-old-key-000000000000000\n' >"$AGENTV_ETC/env"
drop "{\"provider\":\"claude\",\"key\":\"$KEY\"}"
store || fail "a key for claude is kept" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_KEY_DROP ]] || fail "the drop is gone"
[[ $(cat "$AGENTV_ETC/env") == $'TMDB_API_KEY=tmdb123\n'"ANTHROPIC_API_KEY=$KEY" ]] || fail "it replaces the provider key and keeps the other lines" "$(cat "$AGENTV_ETC/env")"
[[ $(stat -c %a "$AGENTV_ETC/env") == 600 ]] || fail "S4.6 the env file is its owner's alone" "$(stat -c %a "$AGENTV_ETC/env")"
jq -e '.set == true and .provider == "claude" and (.at | length > 0)' "$AGENTV_ETC/key.json" >/dev/null || fail "key.json says claude has a key" "$(cat "$AGENTV_ETC/key.json")"
[[ $(stat -c %a "$AGENTV_ETC/key.json") == 644 ]] || fail "and the TV can read it"
if grep -q "$KEY" "$AGENTV_ETC/key.json" "$SCRATCH/out"; then fail "S4.6 the key is in nothing but the env file"; fi
pass "S4.6 a key handed over goes into the env file, its owner's alone, and nowhere else"

# Something that would be read as more than a key isn't taken.
drop '{"provider":"chatgpt","key":"sk-x\nEVIL=1 and some more"}'
if store; then fail "a key with a new line in it is refused"; fi
grep -q "^ANTHROPIC_API_KEY=$KEY$" "$AGENTV_ETC/env" || fail "and the key before stays"
if grep -q EVIL "$AGENTV_ETC/env"; then fail "and nothing of it gets in"; fi
jq -e '.provider == "claude" and .error == "that doesn'"'"'t look like a key"' "$AGENTV_ETC/key.json" >/dev/null || fail "key.json says why" "$(cat "$AGENTV_ETC/key.json")"
drop '{"provider":"someone","key":"abc"}'
if store; then fail "a provider it doesn't know is refused"; fi
pass "a drop that isn't a key for a provider it knows changes nothing"

# Grok's and Muse's keys (ADR-047) take the provider key's place, each by
# the name its CLI reads.
GROK="xai-$(printf 'g%.0s' {1..40})"
MUSE="LLM_$(printf 'u%.0s' {1..40})"
drop "{\"provider\":\"grok\",\"key\":\"$GROK\"}"
store || fail "a key for grok is kept" "$(cat "$SCRATCH/out")"
[[ $(cat "$AGENTV_ETC/env") == $'TMDB_API_KEY=tmdb123\n'"XAI_API_KEY=$GROK" ]] || fail "grok's is XAI_API_KEY, in the place of claude's" "$(cat "$AGENTV_ETC/env")"
jq -e '.set == true and .provider == "grok"' "$AGENTV_ETC/key.json" >/dev/null || fail "key.json names grok"
drop "{\"provider\":\"muse\",\"key\":\"$MUSE\"}"
store || fail "a key for muse is kept" "$(cat "$SCRATCH/out")"
[[ $(cat "$AGENTV_ETC/env") == $'TMDB_API_KEY=tmdb123\n'"META_API_KEY=$MUSE" ]] || fail "muse's is META_API_KEY, in the place of grok's" "$(cat "$AGENTV_ETC/env")"
jq -e '.set == true and .provider == "muse"' "$AGENTV_ETC/key.json" >/dev/null || fail "key.json names muse"
[[ $(stat -c %a "$AGENTV_ETC/env") == 600 ]] || fail "the env file is still its owner's alone"
if grep -q "$GROK\|$MUSE" "$AGENTV_ETC/key.json" "$SCRATCH/out"; then fail "their keys are in nothing but the env file"; fi
pass "ADR-047 grok's key is kept as XAI_API_KEY and muse's as META_API_KEY, one provider at a time"

drop '{"provider":null}'
store || fail "a drop with no provider takes the key off"
[[ $(cat "$AGENTV_ETC/env") == "TMDB_API_KEY=tmdb123" ]] || fail "only the provider key goes" "$(cat "$AGENTV_ETC/env")"
jq -e '.set == false and .provider == null' "$AGENTV_ETC/key.json" >/dev/null || fail "key.json says there's none"
pass "a drop with no provider takes the key off, and keeps the rest"

for word in ConfigurationDirectory=agentv ProtectSystem=strict NoNewPrivileges=yes; do
  grep -qx "$word" "$ROOT/system/agentv-key.service" || fail "agentv-key.service has $word"
done
grep -qx "PathExists=/var/lib/private/agentv/daemon/key-drop/key.json" "$ROOT/system/agentv-key.path" || fail "agentv-key.path watches the daemon's drop"
pass "agentv-key.path starts the move as root when the daemon leaves a key"
