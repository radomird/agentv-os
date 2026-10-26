#!/bin/bash

# Guards the adult PIN (daemon/pin.ts, ADR-009, S4.5): the hash, the wait
# after wrong tries, grants, the lock, and the daemon's guarded requests.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/pin.test.mts"
