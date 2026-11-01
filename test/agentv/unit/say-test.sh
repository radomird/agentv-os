#!/bin/bash

# Guards what a sentence said to the TV does (daemon/say.ts,
# daemon/executors/): play X across kinds through every app's search, one
# clear best or up to three to choose from on the TV and the phone,
# continue from the ledger, and "i didn't get that" with nothing done for a
# sentence the router can't route (S7.3).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/say.test.mts"
