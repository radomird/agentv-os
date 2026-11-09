#!/bin/bash

# Guards sleep as a setting (daemon/sleep.ts, ADR-072, T13.2): it sleeps once
# the TV has been off for its time, never with the setting off or past an
# inhibitor, sets the wake alarm for the night's update, and notices a wake.
# Also the inhibitor a build or a download holds (daemon/inhibit.ts).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/sleep.test.mts"
