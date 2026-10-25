#!/bin/bash

# Guards the ledger (daemon/ledger.ts), the screen daemon's playback watch
# (daemon/playback.ts) and the daemon's ledger requests: a row within 10 s,
# one row per viewer (S3.3), and viewers' roles.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/ledger.test.mts"
