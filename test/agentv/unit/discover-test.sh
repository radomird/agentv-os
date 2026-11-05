#!/bin/bash

# Guards how the box finds servers and shares on the home network
# (daemon/discover.ts): each way of hearing them on what real servers
# answered, and a look against stand-ins on this machine.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/discover.test.mts"
