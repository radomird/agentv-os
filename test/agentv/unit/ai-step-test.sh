#!/bin/bash

# Guards setup's AI step: each provider's own icon, fetched from its site
# and kept on the box, and a plan's sign-in started from setup without a
# build, through the builder's drop.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/ai-step.test.mts"
