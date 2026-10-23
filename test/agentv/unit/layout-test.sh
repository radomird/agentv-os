#!/bin/bash

# Guards the home grid's rules (launcher/layout.ts), which the launcher and the
# daemon share: three sizes on a 4 × 3 grid, moving, resizing and no room
# (S2.4, S2.5, S2.6).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/layout.test.mts"
