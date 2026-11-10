#!/bin/bash

# Guards the rule that a TV with no adult PIN never asks for one (ADR-087):
# every guarded and adult-only request goes through with none set, nothing
# the daemon answers names a PIN, and no lock outlives the PIN.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/no-pin.test.mts"
