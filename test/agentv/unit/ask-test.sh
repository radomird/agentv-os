#!/bin/bash

# Guards the Ask box building apps (daemon/executors/make.ts,
# daemon/routes/ask.ts): make reaches the builder's confirm, a change waits
# for an adult's ok, a child is told to ask a grown-up, no AI says where to
# set one up, and with the askbuilds switch off nothing changes.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/ask.test.mts"
