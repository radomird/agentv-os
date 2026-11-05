#!/bin/bash

# Guards the new phone remote (track 8 of the phase 2 plan): what's typed
# on the phone reaching the TV's field as it's typed, play and pause in
# every app, and their routes on the daemon.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/remote-text.test.mts"
node_test "$ROOT/test/agentv/unit/remote-play.test.mts"
