#!/bin/bash

# The household's models for asking and building (ADR-103, T19.1): kept
# with the AI, from the provider's list, and the asking one sent to both
# router services.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/model-defaults.test.mts"
