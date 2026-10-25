#!/bin/bash

# Guards signing in on the TV (ADR-032, board 15) and logos on every tile:
# the screen daemon asking an app whether it's signed in (daemon/signin.ts),
# the daemon keeping the answer for the app's tile, and a site's own icon
# fetched on the box for an app with none (daemon/site-icon.ts).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/signin.test.mts"
