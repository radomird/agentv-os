#!/bin/bash

# Guards Export's push to a repo of the person's own (daemon/github.ts,
# ADR-045): AgenTV's own repos refused, the person's sign-in found with gh
# or an SSH key, the app pushed as their commit and never forced, and the
# phone asking for it behind the PIN each time.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/github.test.mts"
