#!/bin/bash

# Guards .github/scripts/omarchy-sync, the daily half of S0.6, against a fake
# upstream: a new stable tag gets a branch that merges it and moves the base,
# a release candidate never counts, an up-to-date fork does nothing, and
# auto-merge is off for a new major version and for any change that isn't
# upstream's own. A tag cut as a sibling of the base's line gets the tag's
# tree plus AgenTV's files, and never merges itself. The agentv-iso way,
# merging omarchy-iso's release branch for the tag, too. Runs with
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
  [[ -z $(git config --local user.name || true) ]] || fail "a dry run leaves the repo's git identity alone"
  [[ $(git log -1 --format=%cn) == "github-actions[bot]" ]] || fail "the sync commits as the bot"
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

# A sibling line: 1.5 cut from 1.0.0 beside 1.0.x, as Omarchy cut 4.5 beside
# 4.0.x. It drops b.txt, which only the old line has, and edits a.txt the
# other way, so a merge with 1.0.1 would conflict.
(
  cd "$upstream"
  git switch -q -c v1-5-0 v1.0.0
  printf 'one\nTWO\nthree\n' >a.txt
  git rm -q b.txt
  printf 'new\n' >new.txt
  git add -A && git commit -qm "Omarchy 1.5.0" && git tag v1.5.0
  git switch -q quattro
)
fork "$SCRATCH/sibling" v1.0.1 ""
mkdir -p "$SCRATCH/sibling/odd dir"
(cd "$SCRATCH/sibling" && printf 'x\n' >"odd dir/ours too.txt" && git add -A && git commit -qm "More AgenTV" && git push -q origin agentv)
sync "$SCRATCH/sibling" --tag v1.5.0 || fail "a sibling line syncs" "$(cat "$SCRATCH/sibling.log")"
(
  cd "$SCRATCH/sibling"
  [[ $(cat .github/omarchy-base) == "v1.5.0" ]] || fail "it moves the base to the sibling tag"
  git merge-base --is-ancestor v1.5.0 HEAD || fail "the sibling tag is an ancestor, so later tags merge"
  [[ $(git log -1 --format=%P HEAD~1 | wc -w | tr -d ' ') == 2 ]] || fail "it's a merge commit"
  [[ ! -e b.txt ]] || fail "files only the old line has go"
  [[ $(cat a.txt) == $'one\nTWO\nthree' ]] || fail "upstream's files are the tag's own"
  [[ -f new.txt && -f ours.txt && -f "odd dir/ours too.txt" ]] || fail "the tag's files and AgenTV's are there"
  [[ -z $(git diff --diff-filter=MDT --name-only v1.5.0 HEAD) ]] || fail "nothing of the tag's is changed"
  [[ -z $(git status --porcelain) ]] || fail "the working tree is the commit's"
)
[[ $(outcome "$SCRATCH/sibling" sibling) == "true" && $(outcome "$SCRATCH/sibling" automerge) == "false" ]] ||
  fail "a sibling line never merges itself" "$(cat "$SCRATCH/sibling.out")"
pass "a tag cut beside the base's line gets its tree plus AgenTV's files, and waits for Radomir"

# A sibling line that has a file AgenTV added too stops, and says which.
(cd "$upstream" && git switch -q v1-5-0 && printf 'theirs\n' >ours.txt && git add -A &&
  git commit -qm "Omarchy 1.5.1" && git tag v1.5.1 && git switch -q quattro)
fork "$SCRATCH/clash" v1.0.1 ""
if sync "$SCRATCH/clash" --tag v1.5.1; then
  fail "a sibling line with one of AgenTV's files stops"
fi
grep -q "ours.txt" "$SCRATCH/clash.log" || fail "it names the file both have" "$(cat "$SCRATCH/clash.log")"
pass "a sibling line that has one of AgenTV's files stops and names it"

# A merge that conflicts says which files and why, and leaves no merge behind.
(cd "$upstream" && printf 'mine\n' >add.txt && git add -A && git commit -qm "Omarchy 1.0.2" && git tag v1.0.2)
fork "$SCRATCH/addadd" v1.0.1 ""
(cd "$SCRATCH/addadd" && printf 'agentv\n' >add.txt && git add -A && git commit -qm "AgenTV's add.txt" && git push -q origin agentv)
if sync "$SCRATCH/addadd" --tag v1.0.2; then
  fail "a merge that conflicts stops"
fi
grep -q "AA add.txt" "$SCRATCH/addadd.log" || fail "it names the file both added" "$(cat "$SCRATCH/addadd.log")"
pass "a merge where upstream added one of AgenTV's files stops and names it"

# The files of upstream's that AgenTV keeps its own version of, listed in
# test/agentv/policy/upstream-exceptions, stay AgenTV's: when upstream's
# change would conflict, when it would merge in line by line, and on a
# sibling line, which is otherwise the tag's own tree.
# keeps <dir> <base> <a.txt's text>: a fork whose a.txt is AgenTV's own.
keeps() {
  fork "$1" "$2" ""
  (
    cd "$1"
    mkdir -p test/agentv/policy
    printf '# AgenTV keeps its own\na.txt # the policy\n' >test/agentv/policy/upstream-exceptions
    printf '%b' "$3" >a.txt
    git add -A && git commit -qm "AgenTV's own a.txt" && git push -q origin agentv
  )
}
keeps "$SCRATCH/kept" v1.0.0 'ours\n'
sync "$SCRATCH/kept" --tag v1.0.1 || fail "a sync goes through when upstream changes a file AgenTV keeps its own of" "$(cat "$SCRATCH/kept.log")"
[[ $(cat "$SCRATCH/kept/a.txt") == "ours" ]] || fail "AgenTV's version stays" "$(cat "$SCRATCH/kept/a.txt")"
git -C "$SCRATCH/kept" merge-base --is-ancestor v1.0.1 HEAD || fail "the tag is still merged"
[[ -z $(git -C "$SCRATCH/kept" status --porcelain) ]] || fail "no merge is left half done" "$(git -C "$SCRATCH/kept" status --porcelain)"
[[ $(outcome "$SCRATCH/kept" automerge) == "true" ]] || fail "it may still merge itself" "$(cat "$SCRATCH/kept.out")"
pass "a file AgenTV keeps its own of stays AgenTV's when upstream changes theirs, and the sync isn't held up"

keeps "$SCRATCH/kept-lines" v1.0.0 'ONE\ntwo\nthree\n'
sync "$SCRATCH/kept-lines" --tag v1.0.1 || fail "a sync goes through when upstream's change would merge in" "$(cat "$SCRATCH/kept-lines.log")"
[[ $(cat "$SCRATCH/kept-lines/a.txt") == $'ONE\ntwo\nthree' ]] || fail "upstream's lines aren't mixed into AgenTV's file" "$(cat "$SCRATCH/kept-lines/a.txt")"
[[ $(outcome "$SCRATCH/kept-lines" automerge) == "true" ]] || fail "it may still merge itself" "$(cat "$SCRATCH/kept-lines.out")"
pass "upstream's lines never mix into a file AgenTV keeps its own of"

keeps "$SCRATCH/kept-sibling" v1.0.1 'ours\n'
sync "$SCRATCH/kept-sibling" --tag v1.5.0 || fail "a sibling line syncs with a kept file" "$(cat "$SCRATCH/kept-sibling.log")"
(
  cd "$SCRATCH/kept-sibling"
  [[ $(cat a.txt) == "ours" ]] || fail "a sibling line doesn't put upstream's file back" "$(cat a.txt)"
  [[ -f new.txt && ! -e b.txt ]] || fail "the rest is the tag's tree"
  [[ $(git diff --diff-filter=MDT --name-only v1.5.0 HEAD) == "a.txt" ]] || fail "only the kept file differs from the tag"
  [[ -z $(git status --porcelain) ]] || fail "the working tree is the commit's"
)
[[ $(outcome "$SCRATCH/kept-sibling" automerge) == "false" ]] || fail "a sibling line still waits for Radomir"
pass "a sibling line keeps AgenTV's version of those files too"

# agentv-iso: omarchy-iso has no tags, so it follows omarchy-iso's release
# branch for the tag Omarchy cut, and keeps the release it followed beside the
# base commit. No branch for the tag yet means nothing to do.
first=$(git -C "$upstream" rev-parse v1.0.0)
(cd "$upstream" && git branch v1-0-1 v1.0.1 && git commit -q --allow-empty -m "quattro moves on")
fork "$SCRATCH/iso" "$first" v1.0.0 omacom/omarchy-iso
sync "$SCRATCH/iso" --tag v1.0.1 || fail "the ISO fork syncs" "$(cat "$SCRATCH/iso.log")"
(
  cd "$SCRATCH/iso"
  [[ $(cat .github/omarchy-base) == "$(git -C "$upstream" rev-parse v1-0-1)" ]] || fail "the ISO fork's base is the release branch's head, not quattro's"
  [[ $(cat .github/omarchy-release) == "v1.0.1" ]] || fail "the ISO fork records the release it followed"
)
pass "S0.6 the ISO fork merges the release branch for the tag and records the release"

fork "$SCRATCH/iso-wait" "$first" v1.0.0 omacom/omarchy-iso
sync "$SCRATCH/iso-wait" --tag v1.0.2 || fail "an ISO fork with no release branch to follow runs" "$(cat "$SCRATCH/iso-wait.log")"
[[ $(outcome "$SCRATCH/iso-wait" opened) == "false" ]] || fail "no release branch means nothing to open"
grep -q "no v1-0-2 branch" "$SCRATCH/iso-wait.log" || fail "it says it waits for the release branch" "$(cat "$SCRATCH/iso-wait.log")"
pass "the ISO fork waits for omarchy-iso's release branch"
