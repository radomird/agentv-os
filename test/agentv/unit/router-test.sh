#!/bin/bash

# Guards the router and its providers (daemon/router.ts, daemon/providers/,
# ADR-013, ADR-023, ADR-047) on recorded replies: the brief and the schema,
# each provider's API and a plan's CLI, and a sentence it can't route
# coming back as none, never a guess (S7.3).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/router.test.mts"
