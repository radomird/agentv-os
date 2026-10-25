#!/bin/bash

# Guards layer 3's runner (test/agentv/contract/runner.mts): its patterns,
# recorded times moved to now, and that it fails an app that answers wrong,
# asks for what its fixtures don't have, or isn't a valid package (S3.1).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/contract.test.mts"
