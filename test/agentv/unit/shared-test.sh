#!/bin/bash

# Guards what phones share to the TV (ADR-050, S5.10): a link, a photo or a
# video, checked to be what it says, kept with who sent it until someone
# takes it off, asked about only with home in front and nothing playing, and
# a child's profile takes them only once an adult allowed it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/shared.test.mts"
grep -Eq '^StateDirectory=.* agentv/shared( |$)' "$ROOT/system/agentv-daemon.service" || fail "the daemon keeps what's shared in /var/lib/agentv/shared"
pass "the daemon has a folder of its own for what's shared"
