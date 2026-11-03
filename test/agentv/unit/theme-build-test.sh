#!/bin/bash

# Guards the theme check (builder/theme.ts, S6.4): a theme the agent made
# holds only its colours, its icon set and its pictures, names every colour
# Omarchy's templates use, reads from the couch, and its scenes keep to
# themselves.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/theme-build.test.mts"
