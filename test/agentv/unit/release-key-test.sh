#!/bin/bash

# Guards who gets AgenTV's signing key in this repo's workflows (audit M3
# and L8): a pull request's, a sync's and a release candidate's image run
# get no secrets at all and sign with a throwaway key, only the nightly run
# asks for AgenTV's own, and not when it's started by hand with an agentv-iso
# ref of its own. Inside image.yml the key is read only where release-key
# says so, only beside merged code, and never handed to a container.

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
  "keep-iso: \${{ matrix.iso && inputs.checks == '' }}"; do
  grep -qxF "      $line" <<<"$job" ||
    fail "M3 a nightly run started with its own agentv-iso ref gets no key and keeps no ISO" "missing: $line"$'\n'"$job"
done
pass "M3 a nightly run started with its own agentv-iso ref gets no key and keeps no ISO"

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
# GitHub's answer to whether a commit is on agentv-iso's agentv, for two
# made-up commits: one agentv has, and one that's ahead of it on a branch.
on=1111111111111111111111111111111111111111
ahead=2222222222222222222222222222222222222222
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/gh" <<GH
#!/bin/bash
case "\$*" in
  "api repos/owner/agentv-iso/compare/$on...agentv --jq .status") echo ahead ;;
  "api repos/owner/agentv-iso/compare/$ahead...agentv --jq .status") echo behind ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
GH
chmod +x "$SCRATCH/bin/gh"
# guard <os ref> <iso ref> <update checks> [NAME=value...]: a nightly run on
# agentv with the key, with those refs.
guard() {
  local os=$1 iso=$2 update=$3
  shift 3
  env RELEASE_KEY=true PACKAGES=stable PKGS_REF=main GITHUB_REF=refs/heads/agentv GITHUB_STEP_SUMMARY=/dev/null \
    RUNNER_TEMP="$SCRATCH/none" OS_REF="$os" ISO_REF="$iso" UPDATE_CHECKS="$update" \
    OWNER=owner GH_TOKEN=token PATH="$SCRATCH/bin:$PATH" "$@" \
    bash -euo pipefail "$script" >"$SCRATCH/guard.log" 2>&1
}
for n in 1 2; do
  script=$SCRATCH/guard-$n.sh
  step=$(cat "$SCRATCH/guard-$n.yml")
  # shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
  for line in 'OS_REF: ${{ inputs.ref }}' 'ISO_REF: ${{ inputs.iso-ref }}' 'UPDATE_CHECKS: ${{ inputs.update-checks }}'; do
    grep -qF "$line" <<<"$step" || fail "M3 the step that picks the key is told every ref the run checks out" "$step"
  done
  grep -q '^ *if: .*inputs\.release-key' <<<"$step" || fail "M3 a run with release-key never skips the step that checks it" "$step"
  # shellcheck disable=SC2016 # the workflow's own expression, not the shell's
  grep -qxF "          GH_TOKEN: \${{ inputs.release-key && github.token || '' }}" <<<"$step" ||
    fail "M3 the step that picks the key has a token only in a run that asks for the key" "$step"

  guard agentv agentv "" || fail "M3 the night's own refs get AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  guard agentv v0.2.0 agentv || fail "M3 a release's tag, updated to agentv, gets AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  guard agentv "$on" agentv || fail "M3 a commit agentv-iso's agentv has, updated to agentv, gets AgenTV's key" "$(cat "$SCRATCH/guard.log")"
  for refs in "agentv fix/checks ''" "agentv v0.2.0 fix/checks" "fix/os agentv ''" "agentv v0.2.0-rc1 ''" \
    "agentv 0123456789abcdef0123456789abcdef01234567 ''" "agentv 'agentv x' ''" \
    "agentv $ahead agentv" "agentv agentv $ahead" "$on agentv ''" "agentv ${on:0:9} agentv"; do
    eval "set -- $refs"
    guard "$@" && fail "M3 AgenTV's key is never beside an unmerged ref" "passed with agentv-os $1, agentv-iso $2, update checks ${3:-none}"
    grep -q "AgenTV's own key signs only" "$SCRATCH/guard.log" ||
      fail "M3 AgenTV's key is never beside an unmerged ref" "$(cat "$SCRATCH/guard.log")"
  done
  guard agentv agentv "" PKGS_REF=fix/pkgs && fail "M3 AgenTV's key signs only with agentv-pkgs' main"
  guard agentv agentv "" GITHUB_REF=refs/heads/fix && fail "M3 AgenTV's key signs only on agentv"
  guard agentv agentv "" PACKAGES=build && fail "M3 AgenTV's key never signs packages built in the run"
done
pass "M3 AgenTV's key is only ever beside agentv, a release's tag or a commit agentv has, in agentv-os and agentv-iso"

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
