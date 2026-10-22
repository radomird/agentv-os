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
