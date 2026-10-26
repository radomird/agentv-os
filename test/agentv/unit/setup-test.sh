#!/bin/bash

# Guards TV setup's step (stage 5, S5.6): kept in setup.json so a restart, an
# update or a reboot comes back to it, with no step skipped, what the setup
# screens and the phones hear, and the keyboard's way onto the Wi-Fi.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/setup.test.mts"
