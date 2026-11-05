#!/bin/bash

# Guards setup's location step: it starts from the phone's own time zone,
# a country's time zones are grouped by what the clock does, and only a
# country whose zones differ asks which one, unless the phone's is in it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/location.test.mts"
