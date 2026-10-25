#!/bin/bash

# Guards AgenTV's built-in apps in the daemon (daemon/home.ts, place.ts):
# Clock and Weather on home and in their details, the place from the box's
# time zone, Settings → Weather, and that no installed app passes for one.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/builtins.test.mts"
