#!/bin/bash

# Guards a service's own profiles for who's watching (ADR-009): the screen
# daemon opening the profile picked for children when a child watches and
# listing them for an adult (daemon/service-profiles.ts), and the daemon
# keeping the list and the pick, past the adult PIN.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/service-profiles.test.mts"
