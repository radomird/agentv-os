#!/bin/bash

# Guards the art picker (daemon/art.ts, ADR-012): The Met, the Art Institute
# of Chicago and Wikimedia Commons searched through their own APIs, only
# works free to show, thumbnails from their own image hosts, and a work
# picked kept as the background with its credit.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/art.test.mts"
