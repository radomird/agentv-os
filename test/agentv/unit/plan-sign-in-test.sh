#!/bin/bash

# Guards a plan's sign-in at the builder's first run (ADR-040, S6.5): the
# provider's own CLI signs in with stand-ins for Claude Code and Codex, root
# starts it and hands over the phone's code, the daemon goes on after it, and
# the plan's tokens stay in the CLI's own files.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/plan-sign-in.test.mts"
