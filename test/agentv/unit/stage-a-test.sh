#!/bin/bash

# Guards a streaming service's stage A tools in the harness (ADR-011): look
# and fetch_sample on declared origins only, what they keep only where the
# step writes, and contract_tests's word on what's missing. Layer 4 runs
# them in Chromium against a stand-in service.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/stage-a.test.mts"
