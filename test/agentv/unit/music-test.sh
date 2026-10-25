#!/bin/bash

# Guards the built-in Music app and the storage layer under it
# (daemon/music.ts, daemon/storage.ts): tags and covers from the fixture
# folder, the library, search, an incremental rescan, folders, USB drives and
# shares through stand-ins for lsblk, udisksctl and gio, the player against a
# stand-in for mpv's socket, and the ledger rows it writes (S3.6).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/music.test.mts"
