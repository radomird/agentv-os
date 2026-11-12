#!/bin/bash

# Guards .github/scripts/release-checks, which finds the agentv-iso commit a
# release was tagged with, so the nightly run checks the release with its
# own checks: agentv-v1.0.0 from 1.0 on, v0.2.0 for a 0.x release, never a
# candidate's tag or a v tag for 1.0 and later, and the commit handed back,
# not the name. With no tag it says so and exits 3, which the nightly run
# turns into a failed night, where it used to check with tonight's checks
# and say nothing. Also reads nightly.yml, to see that it does.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

script="$ROOT/.github/scripts/release-checks"
nightly="$ROOT/.github/workflows/nightly.yml"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# A stand-in agentv-iso: four commits on agentv, and a branch.
iso="$SCRATCH/agentv-iso"
git init -q -b agentv "$iso"
commit() {
  (cd "$iso" && echo "$1" >"$1.txt" && git add -A && git commit -qm "$1")
  git -C "$iso" rev-parse HEAD
}
first=$(commit first)
second=$(commit second)
third=$(commit third)
fourth=$(commit fourth)
tag() { git -C "$iso" tag "$@"; }

# found <version>: the tag and the commit the script wrote, as "tag commit".
status=0
run() {
  : >"$SCRATCH/out"
  status=0
  GITHUB_OUTPUT="$SCRATCH/out" "$script" "$@" >"$SCRATCH/log" 2>&1 || status=$?
}
found() {
  echo "$(sed -n 's/^tag=//p' "$SCRATCH/out") $(sed -n 's/^checks=//p' "$SCRATCH/out")"
}

tag v0.2.0 "$first"
run 0.2.0 "$iso"
[[ $status == 0 && $(found) == "v0.2.0 $first" ]] ||
  fail "a 0.x release is found by its v tag" "status $status: $(found)"$'\n'"$(cat "$SCRATCH/log")"
pass "a 0.x release is found by its v tag, and handed back as the commit it's on"

# From 1.0 on the tag says agentv. One with a message of its own, as a
# release's tag can be, is followed to its commit.
tag -a -m "AgenTV 1.0.0" agentv-v1.0.0 "$third"
run 1.0.0 "$iso"
[[ $status == 0 && $(found) == "agentv-v1.0.0 $third" ]] ||
  fail "1.0.0 is found by agentv-v1.0.0" "status $status: $(found)"$'\n'"$(cat "$SCRATCH/log")"
[[ $(git -C "$iso" rev-parse agentv-v1.0.0) != "$third" ]] || fail "the stand-in's 1.0.0 tag has a message of its own"
pass "1.0.0 is found by agentv-v1.0.0, and a tag with a message of its own is followed to its commit"

# A v tag for 1.0 or later is never AgenTV's: in agentv-os those are
# Omarchy's, and the rule is the same in both repos.
tag v1.1.0 "$second"
run 1.1.0 "$iso"
[[ $status == 3 ]] || fail "v1.1.0 isn't taken for AgenTV 1.1.0's tag" "status $status: $(found)"
grep -q "agentv-iso has no agentv-v1.1.0 tag" "$SCRATCH/log" || fail "it says which tag it looked for" "$(cat "$SCRATCH/log")"
[[ ! -s $SCRATCH/out ]] || fail "with no tag it hands nothing back" "$(cat "$SCRATCH/out")"
pass "a v tag for 1.0 or later isn't AgenTV's, so 1.1.0 has no tag, and it says so with exit 3"

# A candidate's tag isn't the release's.
tag agentv-v1.2.0-rc1 "$fourth"
run 1.2.0 "$iso"
[[ $status == 3 ]] || fail "a candidate's tag isn't the release's" "status $status: $(found)"
pass "a candidate's tag isn't the release's"

# A 0.x release tagged both ways: the agentv-v tag stands for it.
tag v0.3.0 "$second"
tag agentv-v0.3.0 "$fourth"
run 0.3.0 "$iso"
[[ $status == 0 && $(found) == "agentv-v0.3.0 $fourth" ]] || fail "one version tagged both ways goes by its agentv-v tag" "status $status: $(found)"
pass "a 0.x release tagged both ways goes by its agentv-v tag"

run 0.9.0 "$iso"
[[ $status == 3 ]] || fail "a 0.x release with no tag exits 3" "status $status"
grep -q "agentv-iso has no agentv-v0.9.0 or v0.9.0 tag" "$SCRATCH/log" || fail "it names both ways a 0.x tag is written" "$(cat "$SCRATCH/log")"
pass "a 0.x release with no tag names both ways its tag could be written"

# A branch called like the tag doesn't count, and neither does a tag that
# only starts the same.
git -C "$iso" branch agentv-v2.0.0 "$second"
tag agentv-v2.0.0-rc1 "$third"
tag agentv-v2.0.01 "$third"
run 2.0.0 "$iso"
[[ $status == 3 ]] || fail "a branch named like the tag isn't the tag" "status $status: $(found)"
pass "a branch named like the release's tag isn't its tag"

# Not being able to ask isn't the same as no tag: the night stops.
run 1.0.0 "$SCRATCH/no-such-repo"
[[ $status == 1 ]] || fail "a repository that can't be listed exits 1, not 3" "status $status"
for odd in 1.0 1.0.0-rc1 v1.0.0 "1.0.0 x" "" 01.0.0 1.00.0; do
  run "$odd" "$iso"
  [[ $status == 1 ]] || fail "'$odd' isn't a release's version" "status $status"
done
pass "it stops, with exit 1, when it can't ask or the version isn't a release's"

# The nightly run uses it, hands the commit over, and a missing tag fails
# the night and reaches its issue.
# shellcheck disable=SC2016 # the workflow's own expressions, not the shell's
{
  grep -qF '.github/scripts/release-checks "$stable"' "$nightly" || fail "the nightly run asks release-checks which agentv-iso the release was tagged with"
  grep -qF 'refs/tags/v$stable' "$nightly" && fail "the nightly run no longer looks the tag up by its old name itself"
  grep -qF 'echo "untagged=$untagged" >>"$GITHUB_OUTPUT"' "$nightly" || fail "the nightly run says when the release has no tag"
  grep -qF 'untagged: ${{ steps.which.outputs.untagged }}' "$nightly" || fail "and hands that on to its other jobs"
}
job() { awk -v job="  $1:" '$0 == job { on = 1; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on' "$nightly"; }
untagged=$(job untagged)
grep -qF "if: needs.which.outputs.untagged != ''" <<<"$untagged" || fail "a job runs when the release has no tag" "$untagged"
grep -qx '          exit 1' <<<"$untagged" || fail "and fails the night" "$untagged"
grep -qx '    needs: \[which, image, untagged\]' <<<"$(job issue)" || fail "the night's issue waits for it"
# shellcheck disable=SC2016 # the workflow's own variable, not this shell's
grep -qF 'echo "$UNTAGGED"' <<<"$(job issue)" || fail "and says what it said"
grep -qF "needs.untagged.result == 'skipped'" <<<"$(job fixed)" || fail "a night with an untagged release closes no issue"
pass "the nightly run fails, and says why in its issue, when the release has no tag in agentv-iso"

# The step's own lines, with stand-ins for what it calls: with a tag the
# release's leg is handed the commit, and without one tonight's checks and
# the reason.
awk '
  /^      - id: which$/ { on = 1; next }
  on && /^        run: \|$/ { script = 1; next }
  on && script && /^  [a-z]/ { exit }
  on && script { sub(/^          /, ""); print }
' "$nightly" >"$SCRATCH/which.sh"
[[ -s $SCRATCH/which.sh ]] || fail "nightly.yml has the step that picks what to test"
mkdir -p "$SCRATCH/bin" "$SCRATCH/work/.github/scripts" "$SCRATCH/temp"
cat >"$SCRATCH/bin/gh" <<'GH'
#!/bin/bash
# gh release view <channel> ...: the channel's files.
case $3 in
  stable) echo "agentv-$STABLE-1-any.pkg.tar.zst" ;;
  edge) echo "agentv-0.2.0.r9.g123456789-1-any.pkg.tar.zst" ;;
esac
GH
cat >"$SCRATCH/work/.github/scripts/nightly-checks" <<'CHECKS'
#!/bin/bash
printf 'built=%s\nchecks=agentv\nnewer=\n' 1234567890123456789012345678901234567890 >>"$GITHUB_OUTPUT"
CHECKS
cat >"$SCRATCH/work/.github/scripts/release-checks" <<CHECKS
#!/bin/bash
exec "$script" "\$1" "$iso"
CHECKS
chmod +x "$SCRATCH/bin/gh" "$SCRATCH/work/.github/scripts/"*
which() {
  : >"$SCRATCH/which.out"
  (cd "$SCRATCH/work" && env PATH="$SCRATCH/bin:$PATH" STABLE="$1" CHECKS="" PKGS=owner/agentv-pkgs GH_TOKEN=token \
    GITHUB_REPOSITORY_OWNER=owner RUNNER_TEMP="$SCRATCH/temp" GITHUB_OUTPUT="$SCRATCH/which.out" GITHUB_STEP_SUMMARY="$SCRATCH/which.summary" \
    bash -e "$SCRATCH/which.sh") >"$SCRATCH/which.log" 2>&1
}
leg() { sed -n 's/^runs=//p' "$SCRATCH/which.out" | jq -r ".[] | select(.packages == \"stable\") | .$1"; }

which 1.0.0 || fail "the step runs for a tagged release" "$(cat "$SCRATCH/which.log")"
[[ $(leg checks) == "$third" && $(leg update) == "agentv" ]] ||
  fail "a tagged release is checked with the commit its tag is on, and its update with agentv" "$(cat "$SCRATCH/which.out")"
grep -q '^untagged=' "$SCRATCH/which.out" && fail "a tagged release isn't called untagged" "$(cat "$SCRATCH/which.out")"
pass "the nightly run checks a tagged release with the commit its tag is on, and its update with tonight's checks"

which 1.1.0 || fail "the step runs for a release with no tag" "$(cat "$SCRATCH/which.log")"
[[ $(leg checks) == "agentv" && -z $(leg update) ]] || fail "a release with no tag is still checked, with tonight's checks" "$(cat "$SCRATCH/which.out")"
grep -q '^untagged=AgenTV 1.1.0 is the stable release, and agentv-iso has no agentv-v1.1.0 tag' "$SCRATCH/which.out" ||
  fail "and the step says the release has no tag" "$(cat "$SCRATCH/which.out")"
pass "a release with no tag in agentv-iso is still checked, and the run is told to fail and why"

cat >"$SCRATCH/work/.github/scripts/release-checks" <<'CHECKS'
#!/bin/bash
echo "release-checks: couldn't list agentv-iso's tags" >&2
exit 1
CHECKS
which 1.0.0 && fail "when agentv-iso's tags can't be listed, the night stops there" "$(cat "$SCRATCH/which.out")"
grep -q '^runs=' "$SCRATCH/which.out" && fail "and nothing is tested with checks nobody picked" "$(cat "$SCRATCH/which.out")"
pass "when agentv-iso's tags can't be listed, the night stops instead of guessing"
