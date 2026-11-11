#!/bin/bash

# Guards Settings, controllers (ADR-084): reading what BlueZ says, the rule
# that only a game controller is ever listed, paired or removed, pairing and
# removing on a stand-in BlueZ, the adult guard on the daemon's routes, and
# the box check's count following a controller that comes or goes.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/controllers.test.mts"
