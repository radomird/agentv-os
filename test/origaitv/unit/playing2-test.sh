#!/bin/bash

# Guards what's playing, in full (track 27 of the phase 2 plan, behind the
# playing2 switch): play and pause as two requests, previous, a jump to a
# place, where the thing is and its picture, in the TV session and on the
# daemon's routes.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/playing2.test.mts"
