#!/bin/bash

# Guards .github/scripts/nightly-checks, which picks the agentv-iso commit
# that checks edge's package in the nightly run: agentv-iso as it was before
# the first branch that reached agentv-os after the package, even when
# agentv-iso merged it a few seconds first (2026-11-11), with agentv-iso's
# own merges before that kept, and a branch name used again long before not
# counted. A package from agentv-os's newest commit gets agentv-iso's agentv.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

script="$ROOT/.github/scripts/nightly-checks"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# repo <dir>: a repository with one commit on agentv.
repo() {
  git init -q -b agentv "$1"
  (cd "$1" && echo base >base.txt && git add -A && GIT_COMMITTER_DATE="@1700000000 +0000" git commit -qm base)
}

# pr <dir> <number> <branch> <seconds after the base>: a one-commit branch
# merged into agentv, the way GitHub merges a pull request.
pr() {
  (
    cd "$1"
    export GIT_AUTHOR_DATE="@$((1700000000 + $4)) +0000" GIT_COMMITTER_DATE="@$((1700000000 + $4)) +0000"
    git switch -q -c "$3" agentv
    echo "$3 $4" >"${3//\//-}.txt"
    git add -A && git commit -qm "Change on $3"
    git switch -q agentv
    git merge -q --no-ff -m "Merge pull request #$2 from owner/$3" "$3"
    git branch -q -D "$3"
  )
}

# version <dir>: edge's package version for agentv-os's agentv as it is now.
version() {
  echo "0.2.0.r9.g$(git -C "$1" rev-parse --short=9 agentv)"
}

# picked <key>: what the last run wrote for it.
picked() {
  sed -n "s/^$1=//p" "$SCRATCH/out"
}

run() {
  : >"$SCRATCH/out"
  GITHUB_OUTPUT="$SCRATCH/out" "$script" "$@" 2>"$SCRATCH/err"
}

day=86400
os="$SCRATCH/os"
iso="$SCRATCH/iso"
repo "$os"
repo "$iso"

# Months ago, a branch name both repos will use again.
pr "$os" 1 fix/again 100
pr "$iso" 1 fix/again 100
# The change edge's package was built from, with its checks.
pr "$iso" 2 northstar/guide 50000
pr "$os" 2 northstar/guide 50003
package=$(version "$os")
built=$(git -C "$os" rev-parse agentv)
# A fix to agentv-iso's own checks, then two changes the package doesn't
# have: agentv-iso merged the first a few seconds before agentv-os did.
pr "$iso" 3 fix/ocr 60000
before=$(git -C "$iso" rev-parse agentv)
pr "$iso" 4 northstar/wifi 70000
pr "$os" 3 northstar/wifi 70004
pr "$os" 4 northstar/hold 80000
pr "$iso" 5 northstar/hold 80002
# Merged again in agentv-os, long after agentv-iso's merge of that name.
pr "$os" 5 fix/again $((100 + 30 * day))

run "$package" "$os" "$iso" || fail "nightly-checks picks the checks for edge's package" "$(cat "$SCRATCH/err")"
[[ $(picked built) == "$built" ]] || fail "nightly-checks says which agentv-os commit the package came from" "$(cat "$SCRATCH/out")"
[[ $(picked checks) == "$before" ]] ||
  fail "edge's package is checked with agentv-iso from before the first branch that came after it" "$(cat "$SCRATCH/out")"
[[ $(picked newer) == "northstar/wifi northstar/hold" ]] || fail "nightly-checks names the branches that came after the package" "$(cat "$SCRATCH/out")"
pass "edge's package is checked with agentv-iso from before the first branch that came after it, with its own fixes before that, and a branch name used again a month later doesn't count"

run "$(version "$os")" "$os" "$iso" || fail "a package from agentv-os's agentv gets agentv-iso's agentv" "$(cat "$SCRATCH/err")"
[[ $(picked checks) == "agentv" && -z $(picked newer) ]] || fail "a package from agentv-os's agentv gets agentv-iso's agentv" "$(cat "$SCRATCH/out")"
pass "a package from agentv-os's agentv gets agentv-iso's agentv"

run 0.2.0 "$os" "$iso" && fail "a version that names no commit stops the run" "$(cat "$SCRATCH/out")"
grep -q "doesn't name the agentv-os commit" "$SCRATCH/err" || fail "a version that names no commit stops the run" "$(cat "$SCRATCH/err")"
run 0.2.0.r9.g0123456789 "$os" "$iso" && fail "a commit agentv-os's agentv doesn't have stops the run" "$(cat "$SCRATCH/out")"
grep -q "has no commit 0123456789" "$SCRATCH/err" || fail "a commit agentv-os's agentv doesn't have stops the run" "$(cat "$SCRATCH/err")"
pass "a version that names no commit on agentv-os's agentv stops the run"
