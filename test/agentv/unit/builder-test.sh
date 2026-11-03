#!/bin/bash

# Guards the builder (builder/, ADR-046, S6.9): the recipes, the harness
# offering each step only its tools, and the runner walking the steps in
# order, with the stand-in provider replaying recorded builds.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/builder.test.mts"
