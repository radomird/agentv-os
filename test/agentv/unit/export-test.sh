#!/bin/bash

# Guards Export (daemon/export.ts, ADR-045): the package as a zip any unzip
# reads, without its fixtures, offered on the TV and saved on an adult's
# phone, and never for an app that drives a service's own site.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/export.test.mts"
