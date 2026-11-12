#!/bin/bash

# Guards who gets AgenTV's signing key in this repo's workflows (audit M3
# and L8): a pull request's, a sync's and a release candidate's image run
# get no secrets at all and sign with a throwaway key, only the nightly run
# asks for AgenTV's own, and not when it's started by hand with an agentv-iso
# ref of its own. Inside image.yml the key is read only where release-key
# says so, only beside merged code, and never handed to a container.
#
# Merged code is agentv, or a whole commit agentv has. No tag is taken by
# its name, a release's neither: a branch can have the same name and a
# checkout takes the branch, and this repo carries Omarchy's own v1 to v4
# tags too. The nightly run hands over the commit a release's tag is on
# (release-checks-test.sh). And only a run whose every checkout is merged
# leaves anything in the cache for later runs.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

workflows="$ROOT/.github/workflows"
image="$workflows/image.yml"

# The job of a workflow that calls image.yml, from its name to the next job.
caller() {
  awk '
    /^  [a-z][a-z0-9-]*:$/ { if (found) exit; block = "" }
    { block = block $0 "\n" }
    /uses: \.\/\.github\/workflows\/image\.yml/ { found = 1 }
    END { if (found) printf "%s", block }
  ' "$1"
}
# Without its comments, so a comment that names a secret doesn't count.
code() {
  grep -v '^ *#' <<<"$1"
}

for name in check omarchy-sync omarchy-rc; do
  job=$(code "$(caller "$workflows/$name.yml")")
  [[ -n $job ]] || fail "M3 $name.yml calls image.yml"
  grep -q 'secrets' <<<"$job" && fail "M3 $name.yml hands image.yml no secrets" "$job"
  grep -q 'release-key' <<<"$job" && fail "M3 $name.yml never asks for AgenTV's own key" "$job"
  pass "M3 $name.yml hands image.yml no secrets, and never asks for AgenTV's own key"
  # With no key of AgenTV's, the newer agentv a run updates to is signed
  # with the run's throwaway key. Only a box with the run's own packages
  # trusts that, so image.yml refuses a channel's packages here.
  if ! grep -q 'update-test: false' <<<"$job"; then
    grep -q '^ *packages: build$' <<<"$job" ||
      fail "$name.yml checks an update with no key of AgenTV's, so it builds its own packages" "$job"
    pass "$name.yml checks an update with no key of AgenTV's, so it builds its own packages"
  fi
done

job=$(code "$(caller "$workflows/nightly.yml")")
grep -q 'release-key: ' <<<"$job" || fail "M3 the nightly run asks for AgenTV's own key" "$job"
grep -q 'secrets: inherit' <<<"$job" && fail "M3 the nightly run hands over the signing key and nothing else" "$job"
[[ $(grep -c 'secrets\.' <<<"$job") == 1 ]] || fail "M3 the nightly run hands over the signing key and nothing else" "$job"
grep -q '^ *AGENTV_SIGNING_KEY: .*secrets\.AGENTV_SIGNING_KEY' <<<"$job" ||
  fail "M3 the nightly run hands over the signing key and nothing else" "$job"
pass "M3 only the nightly run asks for AgenTV's own key, and hands over nothing else"

# Started by hand, the nightly run can check with an agentv-iso ref that
# isn't merged (its checks input). Then it gets no key, so it has nothing to
# sign an update or tested.json with, and it keeps no ISO.
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
for line in \
  "release-key: \${{ inputs.checks == '' }}" \
  "AGENTV_SIGNING_KEY: \${{ inputs.checks == '' && secrets.AGENTV_SIGNING_KEY || '' }}" \
  "update-test: \${{ inputs.checks == '' }}" \
  "nightly: \${{ matrix.tested && inputs.checks == '' }}" \
  "keep-iso: \${{ matrix.iso && inputs.checks == '' }}" \
  "keep-disk: \${{ matrix.iso && inputs.checks == '' }}"; do
  grep -qxF "      $line" <<<"$job" ||
    fail "M3 a nightly run started with its own agentv-iso ref gets no key and keeps no ISO or box" "missing: $line"$'\n'"$job"
done
pass "M3 a nightly run started with its own agentv-iso ref gets no key, and keeps no ISO and no box for later runs"

grep -rl 'secrets: inherit' "$workflows" | grep -v '/i18n' >"$SCRATCH/inherit" || true
[[ ! -s $SCRATCH/inherit ]] || fail "M3 no workflow hands every secret to another" "$(cat "$SCRATCH/inherit")"
pass "M3 no workflow hands every secret to another"

body=$(code "$(cat "$image")")
# Every read of the secret is behind release-key.
reads=$(grep -n 'secrets\.AGENTV_SIGNING_KEY' <<<"$body" || true)
[[ -n $reads ]] || fail "M3 image.yml still signs tested.json with AgenTV's key"
ungated=$(grep -v "inputs.release-key && secrets.AGENTV_SIGNING_KEY || ''" <<<"$reads" || true)
[[ -z $ungated ]] || fail "M3 image.yml reads AgenTV's key only when release-key is set" "$ungated"
pass "M3 image.yml reads AgenTV's key only when release-key is set"

[[ $(grep -cF "environment: \${{ inputs.release-key && 'release' || '' }}" <<<"$body") == 2 ]] ||
  fail "M3 the two jobs that sign take the key from the release environment, and only with release-key"
pass "M3 the two jobs that sign take the key from the release environment, and only with release-key"

# The step that says which key a run gets, once for each job that signs.
# With AgenTV's own, everything checked out beside it is merged: agentv, or
# a release's tag. This runs the step's own script, which stops or goes on
# before it would make a throwaway key.
awk -v dir="$SCRATCH" '
  /^      - / { on = 0 }
  /^      - name: The key this run.s packages are signed with$/ { on = 1; n++; next }
  on && /^        run: \|$/ { script = 1; next }
  on && script { sub(/^          /, ""); print >(dir "/guard-" n ".sh"); next }
  on { print >(dir "/guard-" n ".yml") }
  /^      - / { script = 0 }
' "$image"
[[ -s $SCRATCH/guard-2.sh && ! -e $SCRATCH/guard-3.sh ]] || fail "M3 each of the two jobs that sign says which key it gets"
# GitHub's answer to whether a commit is on agentv's branch, for made-up
# commits: one agentv-iso's agentv has, one that's ahead of it on a branch,
# and one agentv-os's agentv has. It also knows where tags are, the way
# GitHub does, to show that nobody asks: a tag is never taken by its name.
on=1111111111111111111111111111111111111111
ahead=2222222222222222222222222222222222222222
os_on=4444444444444444444444444444444444444444
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/gh" <<GH
#!/bin/bash
echo "\$*" >>"$SCRATCH/gh.calls"
case "\$*" in
  "api repos/owner/agentv-iso/compare/$on...agentv --jq .status") echo ahead ;;
  "api repos/owner/agentv-iso/compare/$ahead...agentv --jq .status") echo behind ;;
  "api repos/owner/agentv-os/compare/$os_on...agentv --jq .status") echo identical ;;
  "api repos/owner/agentv-"*"/git/ref/tags/"*) echo "commit $on" ;;
  "api repos/owner/agentv-"*"/compare/"*"...agentv --jq .status") echo behind ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
GH
chmod +x "$SCRATCH/bin/gh"
# guard <os ref> <iso ref> <update checks> [NAME=value...]: a nightly run on
# agentv with the key, with those refs.
guard() {
  local os=$1 iso=$2 update=$3
  shift 3
  : >"$SCRATCH/guard.out"
  env RELEASE_KEY=true PACKAGES=stable PKGS_REF=main GITHUB_REF=refs/heads/agentv GITHUB_STEP_SUMMARY=/dev/null \
    GITHUB_OUTPUT="$SCRATCH/guard.out" RUNNER_TEMP="$SCRATCH/none" OS_REF="$os" ISO_REF="$iso" UPDATE_CHECKS="$update" \
    OWNER=owner GH_TOKEN=token PATH="$SCRATCH/bin:$PATH" "$@" \
    bash -euo pipefail "$script" >"$SCRATCH/guard.log" 2>&1
}
# A tag is never taken by its name, whichever way it's written and whoever
# it belongs to: a release's, a candidate's, one of Omarchy's own, with
# refs/tags/ in front or not. A branch can carry the same name.
tag_names=(
  "agentv v0.2.0 agentv" "agentv agentv-v1.0.0 agentv" "agentv agentv-v1.0.0-rc1 agentv"
  "agentv-v1.0.0 agentv ''" "v4.0.6 agentv ''" "v0.2.0 agentv ''" "agentv agentv v0.2.0"
  "agentv refs/tags/agentv-v1.0.0 agentv" "agentv refs/tags/v0.2.0 agentv" "refs/tags/v4.0.6 agentv ''"
  "agentv refs/heads/agentv agentv" "agentv tags/agentv-v1.0.0 agentv"
)

for n in 1 2; do
  script=$SCRATCH/guard-$n.sh
  step=$(cat "$SCRATCH/guard-$n.yml")
  # shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
  for line in 'OS_REF: ${{ inputs.ref }}' 'ISO_REF: ${{ inputs.iso-ref }}' 'UPDATE_CHECKS: ${{ inputs.update-checks }}'; do
    grep -qF "$line" <<<"$step" || fail "M3 the step that picks the key is told every ref the run checks out" "$step"
  done
  grep -q '^ *if: .*inputs\.release-key' <<<"$step" || fail "M3 a run with release-key never skips the step that checks it" "$step"

  guard agentv agentv "" || fail "M3 the night's own refs get AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  guard agentv "$on" agentv || fail "M3 a commit agentv-iso's agentv has, updated to agentv, gets AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  guard "$os_on" "$on" agentv || fail "M3 agentv-os at a commit its agentv has gets AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  : >"$SCRATCH/gh.calls"
  for refs in "agentv fix/checks ''" "agentv $on fix/checks" "fix/os agentv ''" "agentv v0.2.0-rc1 ''" \
    "agentv 0123456789abcdef0123456789abcdef01234567 ''" "agentv 'agentv x' ''" \
    "agentv $ahead agentv" "agentv agentv $ahead" "$on agentv ''" "agentv ${on:0:9} agentv" \
    "${tag_names[@]}"; do
    eval "set -- $refs"
    guard "$@" && fail "M3 AgenTV's key is never beside an unmerged ref" "passed with agentv-os $1, agentv-iso $2, update checks ${3:-none}"
    grep -q "AgenTV's own key signs only" "$SCRATCH/guard.log" ||
      fail "M3 AgenTV's key is never beside an unmerged ref" "$(cat "$SCRATCH/guard.log")"
  done
  grep -q '/git/' "$SCRATCH/gh.calls" && fail "nobody asks where a tag is: a tag's name is never taken" "$(grep '/git/' "$SCRATCH/gh.calls")"
  guard agentv agentv "" PKGS_REF=fix/pkgs && fail "M3 AgenTV's key signs only with agentv-pkgs' main"
  guard agentv agentv "" GITHUB_REF=refs/heads/fix && fail "M3 AgenTV's key signs only on agentv"
  guard agentv agentv "" PACKAGES=build && fail "M3 AgenTV's key never signs packages built in the run"
done
pass "M3 AgenTV's key is only ever beside agentv or a whole commit agentv has, in agentv-os and agentv-iso"
pass "no tag is taken by its name, a release's neither, nor one of Omarchy's: whoever wants a release's checks hands over its commit"

grep -q 'required: true' <<<"$(sed -n '/^    secrets:$/,/^$/p' "$image")" &&
  fail "M3 a caller doesn't have to hand image.yml the key"
pass "M3 a caller doesn't have to hand image.yml the key"

# No container gets a key: bin/build signs nothing, and bin/sign runs on its
# own afterwards.
leaks=$(grep -n -- '-e AGENTV_SIGNING_KEY' <<<"$body" || true)
[[ -z $leaks ]] || fail "L8 no container is handed the signing key" "$leaks"
pass "L8 no container is handed the signing key"

# bin/sign runs from the agentv-pkgs checkout right after a container has
# built there, so the container can read that checkout and not change it.
mounts=$(grep -n 'pkgs:/' <<<"$body" || true)
[[ $(grep -c . <<<"$mounts") == 4 ]] || fail "M3 each of the four builds mounts agentv-pkgs" "$mounts"
# shellcheck disable=SC2016 # the workflow's own $PWD, not this shell's
writable=$(grep -v -- '-v "\$PWD/pkgs:/src:ro" ' <<<"$mounts" || true)
[[ -z $writable ]] || fail "M3 a build's container can't change agentv-pkgs, where bin/sign runs from" "$writable"
pass "M3 a build's container can't change agentv-pkgs, where bin/sign runs from"

# The steps with the key in their environment run bin/sign or sign
# tested.json, and nothing that builds or installs.
steps=$(awk '
  /^      - / { if (has) printf "%s", step; step = ""; has = 0 }
  { step = step $0 "\n" }
  /secrets\.AGENTV_SIGNING_KEY/ { has = 1 }
  END { if (has) printf "%s", step }
' <<<"$body")
busy=$(grep -nE 'docker |pacman|makepkg|git (fetch|clone)|curl |image/ci' <<<"$steps" || true)
[[ -z $busy ]] || fail "L8 a step that holds the key only signs" "$busy"
pass "L8 a step that holds the key only signs"

grep -q 'pkgs/bin/test-key' <<<"$body" || fail "M3 a run without release-key makes its own throwaway key"
[[ $(grep -c 'AGENTV_TEST_KEY=/test-key/public.asc' <<<"$body") == 4 ]] ||
  fail "M3 every build of a run with a throwaway key gets its public half"
pass "M3 a run without release-key makes a throwaway key, and each of its builds trusts it"

# A night with a failed check keeps no ISO: agentv-iso publishes the newest
# night's as edge. Edge's ISO goes by its package's version, so the last
# job takes back the exact name the box's job kept it under, with its
# checksum, and nothing else of the run.
take_back=$(awk '
  /^      - name: Take back the ISO$/ { found = 1; next }
  found && /^      - name: / { exit }
  found && /^        run: \|$/ { running = 1; next }
  running { sub(/^          /, ""); print }
' "$image")
[[ -n $take_back ]] || fail "image.yml has a step that takes back the ISO"
# It runs whenever a check failed and the run was to keep its ISO, after a
# failed or cancelled step too.
grep -A1 '^      - name: Take back the ISO$' "$image" | grep -qxF "        if: always() && steps.passed.outputs.passed != 'true' && inputs.keep-iso" ||
  fail "the take-back runs whenever a check failed and the run was to keep its ISO" "$(grep -A1 '^      - name: Take back the ISO$' "$image")"
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
grep -q 'ISO_NAME: \${{ needs.box.outputs.iso-name }}' "$image" || fail "the take-back is told the name the box's job kept the ISO under"
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
grep -q '^      iso-name: \${{ steps.name.outputs.name }}$' "$image" || fail "the box's job says what it kept the ISO as"
fake="$SCRATCH/take-back"
mkdir -p "$fake/bin"
cat >"$fake/bin/gh" <<'GH'
#!/bin/bash
if [[ $2 == "-X" ]]; then
  echo "${4##*/}" >>"$TAKEN"
else
  cat "$ARTIFACTS"
fi
GH
chmod +x "$fake/bin/gh"
printf '%s\t%s\n' 11 image-box-7-1-0 12 agentv-0.2.0.r456.g40edb94c6-x86_64 13 agentv-0.2.0.r456.g40edb94c6-x86_64.sha256 \
  14 agentv-0.2.0.r456.g40edb94c6-x86_64-old 15 image-edge-7-1 >"$fake/artifacts"
taken() {
  : >"$fake/taken"
  (cd "$fake" && PATH="$fake/bin:$PATH" ARTIFACTS="$fake/artifacts" TAKEN="$fake/taken" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=7 \
    GITHUB_STEP_SUMMARY=/dev/null ISO_NAME="$1" bash -euo pipefail -c "$take_back") >"$fake/out" 2>&1
}
taken agentv-0.2.0.r456.g40edb94c6-x86_64 || fail "the take-back runs" "$(cat "$fake/out")"
[[ $(sort "$fake/taken" | paste -sd' ') == "12 13" ]] ||
  fail "a failed night's ISO and its checksum are taken back by the name they were kept under, and nothing else" "$(cat "$fake/taken" "$fake/out")"
taken "" || fail "with no ISO kept there's nothing to take back" "$(cat "$fake/out")"
[[ ! -s $fake/taken ]] || fail "with no ISO kept nothing is deleted" "$(cat "$fake/taken")"
taken agentv-0.2.0.r999.gabcdef012-x86_64 && fail "an ISO that was kept and can't be found fails the job out loud" "$(cat "$fake/out")"
[[ ! -s $fake/taken ]] || fail "an ISO that can't be found deletes nothing" "$(cat "$fake/taken")"
pass "a failed night's ISO is taken back by the exact name it was kept under, with its checksum and nothing else, and one that can't be found fails out loud"

# A run that's refused the key is refused before any job in the release
# environment starts: a job of its own, which names no environment, checks
# nothing out and runs nothing of the repo, does the same check first, and
# both jobs that can hold the key wait for it.
refs=$(awk '/^  refs:$/ { on = 1; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on' "$image")
[[ -n $refs ]] || fail "image.yml checks the refs in a job of its own"
refs_code=$(code "$refs")
for word in "environment:" "uses:" "secrets."; do
  grep -qF -- "$word" <<<"$refs_code" && fail "the job that checks the refs has no environment, no checkout and nothing of the repo to run" "$word"
done
grep -qE '(^|[ "(])(os|iso|pkgs)/' <<<"$refs_code" && fail "the job that checks the refs runs nothing from a checkout" "$refs_code"
for job in image box; do
  # Read whole first: grep -q stops at the first match, and awk would be cut
  # off mid-print, which this shell counts as a failure of the pipe.
  body_of=$(awk -v job="  $job:" '$0 == job { on = 1; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on' "$image")
  grep -qx '    needs: refs' <<<"$body_of" ||
    fail "the $job job, which can be in the release environment, waits for the refs to be checked"
  # Waiting isn't enough: a job that says always() runs after a job it
  # needs has failed.
  grep -E '^    if: ' <<<"$body_of" | grep -qE 'always\(\)|cancelled\(\)|failure\(\)' &&
    fail "the $job job doesn't run when the refs were refused" "$(grep -E '^    if: ' <<<"$body_of")"
done
# The last job writes the report from a checkout of the same ref, with a
# token that can write. It runs after failed checks, but not after a
# refusal.
finish_if=$(awk '$0 == "  finish:" { on = 1; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on && /^    if: / { print; exit }' "$image")
[[ $finish_if == "    if: always() && needs.refs.result == 'success' && "* ]] ||
  fail "the last job, which checks the ref out again, doesn't run when the refs were refused" "$finish_if"
script=$SCRATCH/refs.sh
awk '/^        run: \|$/ { on = 1; next } on { sub(/^          /, ""); print }' <<<"$refs" >"$script"
guard agentv agentv "" || fail "the night's own refs pass the job that checks them" "$(cat "$SCRATCH/guard.log")"
guard agentv "$on" agentv || fail "a commit agentv has passes the job that checks the refs" "$(cat "$SCRATCH/guard.log")"
for refs_tried in "agentv fix/checks ''" "fix/os agentv ''" "agentv agentv $ahead" "agentv $ahead agentv" "${tag_names[@]}"; do
  eval "set -- $refs_tried"
  guard "$@" && fail "an unmerged ref stops the run before a job that can hold the key starts" "passed with agentv-os $1, agentv-iso $2, update checks ${3:-none}"
done
guard agentv agentv "" PKGS_REF=fix/pkgs && fail "the job that checks the refs wants agentv-pkgs' main"
guard agentv agentv "" GITHUB_REF=refs/heads/fix && fail "the job that checks the refs wants the run on agentv"
guard fix/os fix/checks "" RELEASE_KEY=false || fail "a run that doesn't ask for the key isn't held up" "$(cat "$SCRATCH/guard.log")"
pass "a run that asks for AgenTV's key has its refs checked in a job with no environment and no checkout, before the jobs that can hold the key"

# The same job says, for every run, whether everything it checks out is
# merged. Only then does a run leave its root image's slow part or its box
# in the cache, where every pull request and the next night start from.
merged_is() {
  local want=$1
  shift
  guard "$@" || fail "a run that doesn't ask for the key isn't stopped by the job that checks the refs" "$(cat "$SCRATCH/guard.log")"
  [[ $(cat "$SCRATCH/guard.out") == "merged=$want" ]] ||
    fail "the job that checks the refs says merged=$want for: $*" "$(cat "$SCRATCH/guard.out" "$SCRATCH/guard.log")"
}
merged_is true agentv agentv "" RELEASE_KEY=false
merged_is true agentv "$on" agentv RELEASE_KEY=false PACKAGES=build
merged_is true "$os_on" "$on" "" RELEASE_KEY=false
merged_is false agentv refs/tags/agentv-v1.0.0 agentv RELEASE_KEY=false
merged_is false fix/os agentv "" RELEASE_KEY=false
merged_is false agentv fix/checks "" RELEASE_KEY=false
merged_is false agentv agentv "$ahead" RELEASE_KEY=false
merged_is false agentv agentv-v1.0.0 "" RELEASE_KEY=false
merged_is false agentv agentv "" RELEASE_KEY=false PKGS_REF=fix/pkgs
merged_is false agentv agentv "" RELEASE_KEY=false GITHUB_REF=refs/pull/7/merge
guard agentv agentv "" && [[ $(cat "$SCRATCH/guard.out") == "merged=true" ]] || fail "a run with the key and merged refs is merged"
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
{
  grep -qx '      merged: ${{ steps.refs.outputs.merged }}' <<<"$refs" || fail "the job that checks the refs hands on whether they're merged"
  [[ $(grep -c "inputs.keep-disk && .*needs.refs.outputs.merged == 'true'" "$image") == 2 ]] ||
    fail "both places that keep the installed box want every checkout merged"
  grep -qx '    needs: \[refs, box, checks\]' "$image" || fail "the last job, which keeps the night's box, is told whether the refs are merged"
}
root_step=$(awk '
  /^      - name: Which root image it used$/ { found = 1; next }
  found && /^      - name: / { exit }
  found && /^        run: \|$/ { running = 1; next }
  running { sub(/^          /, ""); print }
' "$image")
[[ -n $root_step ]] || fail "image.yml has the step that says which root image it used"
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
grep -q 'MERGED: \${{ needs.refs.outputs.merged }}' "$image" || fail "the step that keeps the root image is told whether the refs are merged"
mkdir -p "$SCRATCH/root/iso/release/root-cache" "$SCRATCH/root/iso/test-runs"
echo abc123 >"$SCRATCH/root/iso/release/root-cache/key"
echo built >"$SCRATCH/root/iso/release/root-cache/how"
# root_saved <merged> <ref>: does a run that built its own root image keep it?
root_saved() {
  : >"$SCRATCH/root.out"
  (cd "$SCRATCH/root" && env MERGED="$1" GITHUB_REF="$2" HAD="" GITHUB_OUTPUT="$SCRATCH/root.out" GITHUB_STEP_SUMMARY=/dev/null \
    bash -euo pipefail -c "$root_step") >"$SCRATCH/root.log" 2>&1 || fail "the step that says which root image it used runs" "$(cat "$SCRATCH/root.log")"
  grep -qx 'save=true' "$SCRATCH/root.out"
}
root_saved true refs/heads/agentv || fail "a run on agentv whose checkouts are all merged keeps its root image" "$(cat "$SCRATCH/root.out")"
root_saved false refs/heads/agentv && fail "a run on agentv with an unmerged checkout keeps no root image for later runs" "$(cat "$SCRATCH/root.log")"
root_saved "" refs/heads/agentv && fail "a run that wasn't told its refs are merged keeps no root image"
root_saved true refs/heads/fix && fail "a run on another branch keeps no root image, as before"
pass "only a run whose every checkout is merged leaves a root image or a box in the cache for later runs"

# "Re-run failed jobs" that then passes leaves a green run with no ISO: the
# first try took it back. The run says so, where it used to say nothing.
no_iso=$(awk '
  /^      - name: Say when a run that passed has no ISO$/ { found = 1; next }
  found && /^      - name: / { exit }
  found && /^        run: \|$/ { running = 1; next }
  running { sub(/^          /, ""); print }
' "$image")
[[ -n $no_iso ]] || fail "image.yml says when a run that passed has no ISO"
grep -A1 '^      - name: Say when a run that passed has no ISO$' "$image" |
  grep -qxF "        if: always() && steps.passed.outputs.passed == 'true' && inputs.keep-iso && inputs.checks == ''" ||
  fail "it's said for a run that passed and was to keep its ISO"
said() {
  (cd "$fake" && PATH="$fake/bin:$PATH" ARTIFACTS="$fake/artifacts" TAKEN="$fake/taken" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=7 \
    GITHUB_STEP_SUMMARY="$fake/summary" ISO_NAME="$1" bash -euo pipefail -c "$no_iso") >"$fake/out" 2>&1 || fail "the step runs" "$(cat "$fake/out")"
  grep -q '^::warning title=This run passed and has no ISO::' "$fake/out"
}
said agentv-0.2.0.r456.g40edb94c6-x86_64 && fail "a run that still has its ISO isn't called one without" "$(cat "$fake/out")"
said agentv-0.2.0.r999.gabcdef012-x86_64 || fail "a run whose ISO was taken back says it has none" "$(cat "$fake/out")"
said "" || fail "a run that kept no ISO at all says it has none" "$(cat "$fake/out")"
pass "a run that only passed on a re-run says it has no ISO, and that nothing is published from it"
