#!/bin/bash

# Guards the router's eval (test/agentv/evals/router) with no key: the
# phrase set has 20 phrasings a request across kinds and 20 that can't be
# routed (S7.1, S7.3), the scorer reads answers fairly, and the runner
# scores a stand-in provider end to end.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/router-evals.test.mts"
