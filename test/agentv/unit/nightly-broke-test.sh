#!/bin/bash

# Guards .github/scripts/nightly-broke, which says in the Nightly's issue
# what broke: each failed leg's failed checks with the line that says why,
# including a wait that timed out with no "not ok" row (2026-10-31), and
# nothing about a leg that passed. The logs are cut from those nights' runs,
# colours and all.

# shellcheck disable=SC2016 # the backticks are Markdown, not commands
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

script="$ROOT/.github/scripts/nightly-broke"
e=$(printf '\033')

# same <what> <expected> <actual>
same() {
  if [[ $3 == "$2" ]]; then
    pass "$1"
  else
    fail "$1" "$3"
  fi
}

# leg <folder> <leg>: an artifact's folder, with image.log from stdin.
leg() {
  mkdir -p "$1/image-$2-41292857060-1"
  cat >"$1/image-$2-41292857060-1/image.log"
}

# 2026-10-31: the stable leg stopped while it waited for SSH, with no "not ok".
night="$SCRATCH/1031"
leg "$night" stable <<LOG
${e}[1;35m==> s0.1-welcome-test.sh${e}[0m
ok - S0.1 the welcome screen is on the TV (daemon /health)
${e}[1;35m==> edge-switch-test.sh${e}[0m
    ... waiting for SSH (274s)
Timed out after 300s waiting for SSH
${e}[1;35m==> Stopping test VM${e}[0m

1 AgenTV image check(s) failed:
  edge-switch-test.sh
##[error]Process completed with exit code 1.
LOG
leg "$night" edge <<LOG
${e}[1;35m==> edge-switch-test.sh${e}[0m
ok - edge doesn't wait for the nightly run
LOG
out=$("$script" "$night")
expected='**stable**: 1 image check failed.
- `edge-switch-test.sh`: Timed out after 300s waiting for SSH'
same "a check that timed out waiting is named, with the wait, and a leg that passed isn't" "$expected" "$out"

# 2026-11-01: two checks failed, each with its own row, and a later pass
# (the update's checks) failed one more with no row that says why.
night="$SCRATCH/1101"
leg "$night" stable <<LOG
${e}[1;35m==> s1.3-switch-test.sh${e}[0m
${e}[1;35m==> On its own, with every CPU: it times the box against a bar${e}[0m
ok - S1.3 the TV to Omarchy's desktop with the keys takes under 10 s (took 8 s)
not ok - S1.3 Omarchy's desktop back to the TV with the keys takes under 10 s (took 10 s)
${e}[1;35m==> s1.3-switch FAILED: 1 assertion(s).${e}[0m
${e}[1;35m==> s3.8-weather-test.sh${e}[0m
fail S3.9 the weather tiles don't match MET for oslo (59.92, 10.75): large: today shows partly-cloudy, MET says cloudy
not ok - S3.9 agentv selftest finds the medium and large tiles as MET's days

2 AgenTV image check(s) failed:
  s1.3-switch-test.sh
  s3.8-weather-test.sh
${e}[1;35m==> update-tv-test.sh${e}[0m
${e}[1;35m==> Stopping test VM${e}[0m

1 AgenTV image check(s) failed:
  update-tv-test.sh
LOG
out=$("$script" "$night")
expected='**stable**: 3 image checks failed.
- `s1.3-switch-test.sh`: not ok - S1.3 Omarchy'"'"'s desktop back to the TV with the keys takes under 10 s (took 10 s)
- `s3.8-weather-test.sh`: not ok - S3.9 agentv selftest finds the medium and large tiles as MET'"'"'s days
- `update-tv-test.sh`: no line says why; its output is in the run'"'"'s log'
same "each failed check has its row, from every pass, and one with none says so" "$expected" "$out"

# A run that stopped before any check: the build or the install.
night="$SCRATCH/build"
leg "$night" edge <<LOG
==> ERROR: Failed to build the ISO
##[error]Process completed with exit code 1.
LOG
nothing="No image check said what broke, so the build or the install may have stopped first."
same "a run that stopped before the checks says so" "$nothing" "$("$script" "$night")"

# No artifacts at all, say when the download failed.
same "with no logs at all, it still says something" "$nothing" "$("$script" "$SCRATCH/nothing-here")"
