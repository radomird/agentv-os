#!/bin/bash

# Guards a theme your agent made (daemon/made-themes.ts, S6.4): root puts it
# in place checked again, the screen daemon hands it to Omarchy as the
# person's and sets it, and the daemon asks for that once a version, lists
# it in Look, and takes it away when it's removed.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/made-themes.test.mts"
