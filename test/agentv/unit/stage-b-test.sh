#!/bin/bash

# Guards a streaming service's stage B (ADR-011): the builder's way out and
# the daemon let a build see the service's signed-in pages only in stage B,
# on its declared origins, through the screen daemon, and the daemon starts
# stage B by itself once the household signed in.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/stage-b.test.mts"
