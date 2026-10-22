#!/bin/bash

# Guards .github/scripts/omarchy-sync, the daily half of S0.6, against a fake
# upstream: a new stable tag gets a branch that merges it and moves the base,
# a release candidate never counts, an up-to-date fork does nothing, and
# auto-merge is off for a new major version and for any change that isn't
# upstream's own. The agentv-iso way, merging quattro's head, too. Runs with
# --dry-run, so nothing is pushed.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

script="$ROOT/.github/scripts/omarchy-sync"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# Upstream: Omarchy, with a release, a newer release and a release candidate.
upstream="$SCRATCH/omarchy"
git init -q -b quattro "$upstream"
(
  cd "$upstream"
  printf 'one\ntwo\nthree\n' >a.txt
  printf 'b\n' >b.txt
  git add -A && git commit -qm "Omarchy 1.0.0" && git tag v1.0.0
  printf 'one\ntwo\nTHREE\n' >a.txt
  git commit -qam "Omarchy 1.0.1" && git tag v1.0.1
  printf 'rc\n' >c.txt
  git add -A && git commit -qm "Omarchy 1.1.0 rc" && git tag v1.1.0-rc1
)

# fork <dir> <base> <release file or ""> [<upstream name>]: a fork on agentv
# with AgenTV's files added, pushed to a bare origin, and a clone of it.
fork() {
  local dir="$1" base="$2" release="$3" name="${4:-omacom/omarchy}"

  git clone -q --bare "$upstream" "$dir.git"
  git clone -q "$dir.git" "$dir"
  (
    cd "$dir"
    git switch -q -c agentv "$base"
    mkdir -p .github
    printf '%s\n' "$base" >.github/omarchy-base
    printf '%s\n' "$name" >.github/omarchy-upstream
    [[ -n $release ]] && printf '%s\n' "$release" >.github/omarchy-release
    printf 'ours\n' >ours.txt
    git add -A && git commit -qm "Add AgenTV"
    git push -q origin agentv
  )
}

sync() {
  (cd "$1" && OMARCHY_RELEASES_URL="$upstream" OMARCHY_UPSTREAM_URL="$upstream" \
    GITHUB_OUTPUT="$1.out" "$script" --dry-run "${@:2}") >"$1.log" 2>&1
}

outcome() {
  sed -n "s/^$2=//p" "$1.out" | tail -n 1
}

fork "$SCRATCH/os" v1.0.0 ""
sync "$SCRATCH/os" || fail "the sync runs" "$(cat "$SCRATCH/os.log")"
[[ $(outcome "$SCRATCH/os" tag) == "v1.0.1" ]] || fail "a release candidate never counts" "$(cat "$SCRATCH/os.out")"
pass "S0.6 the newest stable tag is picked, never a release candidate"

(
  cd "$SCRATCH/os"
  [[ $(git branch --show-current) == "omarchy-sync/v1.0.1" ]] || fail "it works on omarchy-sync/<tag>"
  [[ $(cat .github/omarchy-base) == "v1.0.1" ]] || fail "it moves the base"
  git merge-base --is-ancestor v1.0.1 HEAD || fail "it merges the tag"
  [[ -f ours.txt ]] || fail "AgenTV's files stay"
  (( $(git rev-list --count --merges origin/agentv..HEAD) == 1 )) || fail "it merges, never rebases"
)
[[ $(outcome "$SCRATCH/os" automerge) == "true" ]] || fail "a clean minor release merges itself" "$(cat "$SCRATCH/os.out")"
pass "S0.6 a new stable tag gets a merge, the base moves, and it may merge itself"

fork "$SCRATCH/current" v1.0.1 ""
sync "$SCRATCH/current" || fail "an up-to-date fork runs" "$(cat "$SCRATCH/current.log")"
[[ $(outcome "$SCRATCH/current" opened) == "false" ]] || fail "an up-to-date fork does nothing"
pass "an up-to-date fork does nothing"

# A merge that combines both sides is no longer upstream's file.
fork "$SCRATCH/edited" v1.0.0 ""
(cd "$SCRATCH/edited" && printf 'ONE\ntwo\nthree\n' >a.txt && git commit -qam "Edit upstream" && git push -q origin agentv)
sync "$SCRATCH/edited" || fail "a fork with an edited upstream file still syncs" "$(cat "$SCRATCH/edited.log")"
[[ $(outcome "$SCRATCH/edited" automerge) == "false" ]] || fail "a change that isn't upstream's turns auto-merge off"
pass "S0.6 a change that isn't upstream's turns auto-merge off"

(cd "$upstream" && printf 'two\n' >major.txt && git add -A && git commit -qm "Omarchy 2" && git tag v2.0.0)
fork "$SCRATCH/major" v1.0.1 ""
sync "$SCRATCH/major" || fail "a major release syncs" "$(cat "$SCRATCH/major.log")"
[[ $(outcome "$SCRATCH/major" tag) == "v2.0.0" && $(outcome "$SCRATCH/major" automerge) == "false" ]] ||
  fail "a new major version never merges itself" "$(cat "$SCRATCH/major.out")"
pass "S0.6 a new major version gets a pull request that never merges itself"

# agentv-iso: no tags of its own, so it follows quattro's head when Omarchy
# tags a release, and keeps the release it followed beside the base commit.
first=$(git -C "$upstream" rev-parse v1.0.0)
fork "$SCRATCH/iso" "$first" v1.0.0 omacom/omarchy-iso
sync "$SCRATCH/iso" --tag v1.0.1 || fail "the ISO fork syncs" "$(cat "$SCRATCH/iso.log")"
(
  cd "$SCRATCH/iso"
  [[ $(cat .github/omarchy-base) == "$(git -C "$upstream" rev-parse quattro)" ]] || fail "the ISO fork's base is quattro's head"
  [[ $(cat .github/omarchy-release) == "v1.0.1" ]] || fail "the ISO fork records the release it followed"
)
pass "S0.6 the ISO fork merges quattro's head and records the release"
