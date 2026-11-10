#!/bin/bash

# Guards paired phones (daemon/phones.ts), the daemon's phone listener, how
# a phone's requests are signed and sealed (daemon/phone-channel.ts and the
# page's own companion-web/seal.ts), and
# the screen daemon's side of the phone's keys and text (daemon/remote.ts).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/phones.test.mts"
node_test "$ROOT/test/agentv/unit/seal.test.mts"
node_test "$ROOT/test/agentv/unit/phone-channel.test.mts"
node_test "$ROOT/test/agentv/unit/remote.test.mts"
