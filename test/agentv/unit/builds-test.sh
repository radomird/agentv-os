#!/bin/bash

# Guards the household's builds (daemon/builds.ts) and root's side of them
# (builder/sandbox/hand-over.ts): ask, confirm, a plan, approval behind the
# PIN, install as Local, the version before kept for rollback, and removal.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/builds.test.mts"
