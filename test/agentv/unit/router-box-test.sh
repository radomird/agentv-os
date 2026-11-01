#!/bin/bash

# Guards where the router runs on the box (daemon/router-serve.ts,
# daemon/router-client.ts, system/agentv-router*.service): the back end
# setup chose, the key the router's alone, the plan's CLI as the builder
# with its providers' hosts its only way out, and a cap on how fast it's
# asked.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/router-box.test.mts"
