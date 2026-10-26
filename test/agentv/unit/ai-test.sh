#!/bin/bash

# Guards the AI provider and its terms (ADR-022, ADR-023, S5.5): each
# provider's terms for a plan and for a key, an acceptance only for the terms
# the TV shows, by an adult on a phone past the PIN, kept with who and when,
# the key only after it, and the CLI's first run heard about only then.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/ai.test.mts"
