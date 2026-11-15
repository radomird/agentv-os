#!/bin/bash

# Guards the backgrounds (ADR-012, S5.3): a photo from a paired phone becomes
# the TV's background with its credit, only a picture and not too big, the
# oldest going once there are too many, and the TV hears it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/backgrounds.test.mts"
grep -Eqx 'StateDirectory=origaitv/daemon origaitv/backgrounds( .*)?' "$ROOT/system/origaitv-daemon.service" || fail "the daemon keeps the backgrounds in /var/lib/origaitv/backgrounds"
pass "the daemon has a folder of its own for the backgrounds"
