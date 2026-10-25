#!/bin/bash

# Guards the built-in Weather app (apps/builtin/agentv.weather): MET Norway's
# symbol and the wind to its ten scenes, the weather now and seven days from
# recorded replies, each tile size, and the app in its own worker against a
# stand-in for MET (S3.8, S3.9).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/weather.test.mts"
