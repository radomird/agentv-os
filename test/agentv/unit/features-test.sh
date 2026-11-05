#!/bin/bash

# Guards the switches for what's still being built (daemon/features.ts):
# every one off by default, listed by GET /api/features and agentv feature,
# and changed on edge only.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/features.test.mts"
