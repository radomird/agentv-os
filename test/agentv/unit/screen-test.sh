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
