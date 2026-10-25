#!/bin/bash

# Guards Settings → Power on the box side (ADR-033): the polkit rules that let
# the owner restart and power off, and start the update units, from the TV
# session, and nothing else; and AgenTV's units stopping within a few seconds.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/power.test.mts"
