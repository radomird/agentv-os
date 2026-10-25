#!/bin/bash

# Guards the provider key through the daemon (daemon/key.ts, S4.6), with
# agentv-key-store doing the move as root.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/key.test.mts"
