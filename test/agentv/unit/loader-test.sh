#!/bin/bash

# Guards the app loader and its per-app worker (daemon/apps/loader.ts,
# worker.ts): each app in a process of its own that reads only its own
# package, starts no processes and reaches only its declared origins, with a
# time limit and a typed failure on every call.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/loader.test.mts"
