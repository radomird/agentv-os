#!/bin/bash

# Guards the builder's sandbox (builder/sandbox/, ADR-011, ADR-045, S6.3):
# model prices, the key relay keeping each build inside its caps with the
# key outside the sandbox, the filter's list, root's hand-over, and the
# units' sandbox settings, which only Radomir loosens.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/sandbox.test.mts"
