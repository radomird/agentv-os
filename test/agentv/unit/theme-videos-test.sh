#!/bin/bash

# Guards Omarchy's dynamic backgrounds on the TV (ADR-064, T6): a theme's
# video backgrounds and intros found as Omarchy finds them, served from where
# they are in parts, never copied, an intro due once a session and after a
# theme change, and Omarchy's intros switch followed.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/theme-videos.test.mts"
