#!/bin/bash

# Guards a native app's icon from its installed package
# (daemon/package-icon.ts): its desktop entry's icon, largest first.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/package-icon.test.mts"
