#!/bin/bash

# How much of a plan is used, in % (ADR-103, T19.1): only the windows leave
# Omarchy's usage check, which the plan's service runs as the builder.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/plan-usage.test.mts"
