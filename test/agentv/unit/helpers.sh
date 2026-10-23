#!/bin/bash

# Shared helpers for AgenTV's unit tests (ADR-019, layer 2). Source it from a
# test; test/agentv/unit/run runs every *-test.sh here. Runs on bash 3.2 too.

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  echo "source test/agentv/unit/helpers.sh from a test; don't run it" >&2
  exit 1
fi

# shellcheck disable=SC2034 # the tests that source this use it
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

pass() {
  printf 'ok - %s\n' "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  [[ -n ${2:-} ]] && printf '%s\n' "$2" | sed 's/^/    /' >&2
  exit 1
}

# A package's settings file, as the PKGBUILD writes it.
fake_agentv_path() {
  local dir="$1" channel="${2:-stable}"

  mkdir -p "$dir"
  cat >"$dir/settings" <<SETTINGS
AGENTV_VERSION=0.1.0
AGENTV_CHANNEL=$channel
AGENTV_REPO_URL=https://example.invalid/agentv-pkgs/releases/download
AGENTV_TESTED_URL=https://example.invalid/agentv-os/releases/download/tested
SETTINGS
}

# node_test <file.mts>: runs a TypeScript test file with Node's own test
# runner and prints a line per passing test, or fails with the failures. Node
# 22.6 to 22.17 runs TypeScript only when asked. Without Node it skips, except
# in CI.
node_test() {
  local file="$1" flags=()

  if ! type -P node >/dev/null; then
    [[ -n ${CI:-} ]] && fail "Node is installed" "${file##*/} needs Node 22.18 or newer"
    echo "skip - ${file##*/} (Node isn't installed)"
    return 0
  fi
  [[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
  if ! node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning --test --test-reporter=tap \
    "$file" >"$SCRATCH/tap" 2>&1; then
    fail "${file##*/} passes" "$(grep -E '^(not ok|# |  ---|    )' "$SCRATCH/tap" | head -n 60)"
  fi
  grep -E '^ok ' "$SCRATCH/tap" | sed -E 's/^ok [0-9]+ - /ok - /'
}
