#!/bin/bash

# Guards Settings → Omarchy desktop's password: the daemon checks it and
# hands it to root on a socket, root checks the PIN again and feeds it to
# chpasswd on stdin, and SSH takes passwords again once it's set.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/desktop-password.test.mts"
