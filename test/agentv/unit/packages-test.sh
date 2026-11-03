#!/bin/bash

# Guards npm packages in built apps (builder/packages.ts, ADR-044): the
# guards on by default, malware refused even with safeguards off, install
# scripts only under bubblewrap, the bundle, the nightly OSV.dev re-check,
# and the builder's requests through its filter.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/packages.test.mts"
