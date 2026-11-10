#!/bin/bash

# Guards .github/scripts/omarchy-rc, which picks the Omarchy release candidate
# the scheduled run tries (ADR-085), against a fake upstream: nothing to try
# with no candidate, with one no newer than the base, or with one whose
# release is out already. A candidate ahead of the base is tried, the newest
# one, and it only ever reads.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

script="$ROOT/.github/scripts/omarchy-rc"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

upstream="$SCRATCH/omarchy"
git init -q -b quattro "$upstream"
release() {
  (cd "$upstream" && git commit -q --allow-empty -m "Omarchy $1" && git tag "$1")
}
release v1.0.0

# The fork: only what the script reads.
fork="$SCRATCH/fork"
git init -q "$fork"
mkdir -p "$fork/.github"
printf 'v1.0.0\n' >"$fork/.github/omarchy-base"

look() {
  (cd "$fork" && OMARCHY_RELEASES_URL="$upstream" GITHUB_OUTPUT="$SCRATCH/out" "$script" "$@") >"$SCRATCH/log" 2>&1
}
outcome() {
  sed -n "s/^$1=//p" "$SCRATCH/out" | tail -n 1
}
before() {
  : >"$SCRATCH/out"
  git -C "$fork" status --porcelain >"$SCRATCH/status-before"
}

before
look || fail "it runs with no candidate upstream" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "false" ]] || fail "no candidate means nothing to try" "$(cat "$SCRATCH/out")"
grep -q "no release candidate" "$SCRATCH/log" || fail "it says there's none" "$(cat "$SCRATCH/log")"
pass "with no release candidate there's nothing to try, and it says so"

# The base's own candidates are old news.
(cd "$upstream" && git tag v1.0.0-rc1 && git tag v1.0.0-rc2)
before
look || fail "it runs with the base's own candidates" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "false" && $(outcome tag) == "v1.0.0-rc2" ]] ||
  fail "a candidate no newer than the base isn't tried" "$(cat "$SCRATCH/out")"
pass "a candidate for the release AgenTV is on isn't tried"

release v1.1.0-rc1
release v1.1.0-rc2
release v1.1.0-rc10
before
look || fail "it runs with a newer candidate" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "true" ]] || fail "a candidate ahead of the base is tried" "$(cat "$SCRATCH/out")"
[[ $(outcome tag) == "v1.1.0-rc10" ]] || fail "the newest candidate is picked, rc10 after rc2" "$(cat "$SCRATCH/out")"
[[ $(outcome version) == "1.1.0" ]] || fail "the version is the release's, without v or rc" "$(cat "$SCRATCH/out")"
pass "a candidate ahead of the base is tried: the newest one, by its release's version"

[[ $(git -C "$fork" status --porcelain) == "$(cat "$SCRATCH/status-before")" ]] || fail "it changes nothing in the repo"
[[ $(cat "$fork/.github/omarchy-base") == "v1.0.0" ]] || fail "it never moves the base"
[[ -z $(git -C "$fork" for-each-ref) ]] || fail "it makes no branch or tag" "$(git -C "$fork" for-each-ref)"
pass "it only looks: no branch, no tag, and the base stays"

before
look --tag v1.1.0-rc1 || fail "a candidate named by hand runs" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "true" && $(outcome tag) == "v1.1.0-rc1" ]] || fail "a candidate named by hand is the one tried" "$(cat "$SCRATCH/out")"
pass "a candidate named by hand is the one tried"

for bad in v1.1.0 'v1.1.0-rc1; id' v9.9.9-rc1; do
  before
  if look --tag "$bad"; then
    fail "$bad is refused"
  fi
  [[ -z $(outcome run) ]] || fail "$bad says nothing to run" "$(cat "$SCRATCH/out")"
done
pass "a tag that isn't one of Omarchy's release candidates is refused"

# Once the release is out, the daily sync has it.
release v1.1.0
before
look || fail "it runs once the release is out" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "false" ]] || fail "a candidate whose release is out isn't tried" "$(cat "$SCRATCH/out")"
grep -q "is out" "$SCRATCH/log" || fail "it says the release is out" "$(cat "$SCRATCH/log")"
pass "a candidate whose release is out is left to the daily sync"

release v2.0.0-rc1
before
look || fail "it runs with a new major's candidate" "$(cat "$SCRATCH/log")"
[[ $(outcome run) == "true" && $(outcome tag) == "v2.0.0-rc1" && $(outcome version) == "2.0.0" ]] ||
  fail "the next release's candidate is tried" "$(cat "$SCRATCH/out")"
pass "the next release's candidate is tried"
