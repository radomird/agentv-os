#!/bin/bash

# Guards profiles (daemon/profiles.ts, ADR-009, S4.2): the owner first, one
# viewer at a time, kids' apps, and what needs the parent PIN.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/profiles.test.mts"
