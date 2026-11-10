#!/bin/bash

# Guards who gets AgenTV's signing key in this repo's workflows (audit M3
# and L8): a pull request's and a sync's image run get no secrets at all and
# sign with a throwaway key, only the nightly run asks for AgenTV's own, and
# inside image.yml the key is read only where release-key says so and never
# handed to a container.

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

for name in check omarchy-sync; do
  job=$(code "$(caller "$workflows/$name.yml")")
  [[ -n $job ]] || fail "M3 $name.yml calls image.yml"
  grep -q 'secrets' <<<"$job" && fail "M3 $name.yml hands image.yml no secrets" "$job"
  grep -q 'release-key' <<<"$job" && fail "M3 $name.yml never asks for AgenTV's own key" "$job"
  pass "M3 $name.yml hands image.yml no secrets, and never asks for AgenTV's own key"
done

job=$(code "$(caller "$workflows/nightly.yml")")
grep -q 'release-key: true' <<<"$job" || fail "M3 the nightly run asks for AgenTV's own key" "$job"
grep -q 'secrets: inherit' <<<"$job" && fail "M3 the nightly run hands over the signing key and nothing else" "$job"
[[ $(grep -c 'secrets\.' <<<"$job") == 1 ]] || fail "M3 the nightly run hands over the signing key and nothing else" "$job"
# shellcheck disable=SC2016 # the workflow's own expression, not the shell's
grep -qF 'AGENTV_SIGNING_KEY: ${{ secrets.AGENTV_SIGNING_KEY }}' <<<"$job" ||
  fail "M3 the nightly run hands over the signing key and nothing else" "$job"
pass "M3 only the nightly run asks for AgenTV's own key, and hands over nothing else"

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

grep -q 'required: true' <<<"$(sed -n '/^    secrets:$/,/^$/p' "$image")" &&
  fail "M3 a caller doesn't have to hand image.yml the key"
pass "M3 a caller doesn't have to hand image.yml the key"

# No container gets a key: bin/build signs nothing, and bin/sign runs on its
# own afterwards.
leaks=$(grep -n -- '-e AGENTV_SIGNING_KEY' <<<"$body" || true)
[[ -z $leaks ]] || fail "L8 no container is handed the signing key" "$leaks"
pass "L8 no container is handed the signing key"

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
