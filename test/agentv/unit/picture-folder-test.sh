#!/bin/bash

# Guards a folder's pictures as the background (daemon/picture-folder.ts,
# ADR-012): only pictures, nothing hidden or linked from outside, and the
# daemon keeps them as the folder's.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/picture-folder.test.mts"
