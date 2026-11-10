#!/bin/bash

# Guards what the daemon says about a tile that can't get its content yet
# (daemon/home.ts): that it's waiting, and "tiles" once it's there (T17.1).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/loading.test.mts"
