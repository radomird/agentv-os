#!/bin/bash

# A model for each build (ADR-103, T19.1): the provider's list, the model
# kept with the build, root's check of it and each CLI's flag for it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/build-model.test.mts"
