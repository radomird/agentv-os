#!/bin/bash

# Guards what's new and new episodes (stage 8, S8.1, S8.2): TMDB's few
# read-only paths through the router's service, which alone holds the key;
# the household's apps matched to TMDB's services; the last 7 days on them,
# a child's only family titles on their own apps; and a show's air dates
# against the ledger, yes or no with the next date. TMDB is a stand-in.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/tmdb.test.mts"
