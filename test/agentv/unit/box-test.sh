#!/bin/bash

# Guards the box check (ADR-061): the parsers on recorded readings, the TV's
# EDID among them, the verdicts setup tailors itself by, the readers on a
# made-up machine, Widevine from the TV session, and the daemon's routes.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/box.test.mts"
