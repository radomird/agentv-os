#!/bin/bash

# Guards the three looks' plumbing (ADR-063): the feature switches, the look
# the box is drawn in, and the all apps tile and Clock leaving home.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/looks.test.mts"
