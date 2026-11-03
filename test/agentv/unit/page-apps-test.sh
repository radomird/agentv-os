#!/bin/bash

# Guards page apps on the box (ADR-043): each served from its own origin
# under the policy its manifest gives, the app kit's calls checked against
# the manifest, storage with its quota, the filter home's Chromium goes
# through, and the photos and music from Music's sources, read-only.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/page-apps.test.mts"
node_test "$ROOT/test/agentv/unit/net-filter.test.mts"
node_test "$ROOT/test/agentv/unit/page-media.test.mts"
