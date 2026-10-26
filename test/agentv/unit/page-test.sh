#!/bin/bash

# Guards an app's page.goto (daemon/page.ts): it returns once the new page
# has loaded, not while the page it's leaving is still there.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/page.test.mts"
