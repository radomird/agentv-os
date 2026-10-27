#!/bin/bash

# Guards how the builder starts each provider's CLI for a step
# (builder/providers.ts, ADR-011, ADR-045, ADR-047): claude, codex, gemini,
# grok and muse, each with no tools of its own beside AgenTV's harness, no
# key, and a stop at its turns.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/providers.test.mts"
