#!/bin/bash

# Guards the listening bar's daemon side (daemon/listening.ts, ADR-054): a
# paired phone's box words go to the TV's pages and the TV session as they
# change, the daemon keeps none of them, the bar goes on Back, on closing
# and after a while with no words, and a sent sentence's thinking and
# outcome take it over.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/listening.test.mts"
