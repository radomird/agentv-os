#!/bin/bash

# Guards paired phones (daemon/phones.ts), the daemon's phone listener, and
# the screen daemon's side of the phone's keys and text (daemon/remote.ts).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/phones.test.mts"
node_test "$ROOT/test/agentv/unit/remote.test.mts"
