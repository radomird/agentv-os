#!/bin/bash

# Guards an Immich album as the background (daemon/immich-album.ts,
# ADR-012), through its shared link, against Immich's recorded replies.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/immich-album.test.mts"
