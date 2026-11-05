#!/bin/bash

# Guards the box's country (ADR-055): the tz database's countries, the
# time zone a country takes (Q167), the setting setup confirms and Settings
# changes, the zone handed to root only when it moves, and setup's step.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/country.test.mts"
