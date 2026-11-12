#!/bin/bash

# Guards .github/actions/arch-pin, which builds and checks every leg of an
# image run in the Arch container agentv-iso's agentv pins (ARCH_PIN in its
# test/agentv/image/ci), also a leg that checks with an agentv-iso from
# before the pin, as the nightly's stable leg does (2026-11-12): it pulls the
# pinned digest and tags it :latest before the leg's ci runs, does nothing
# when the pin is empty, and stops when the pin isn't Arch's image by digest
# or can't be read. And every job of image.yml that runs the image checks
# does that first.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

action="$ROOT/.github/actions/arch-pin/action.yml"
image="$ROOT/.github/workflows/image.yml"
digest=ghcr.io/archlinux/archlinux@sha256:6f868a470dfd2d8a0aefc62a18ff189877c54442d0d57419986a9cd915154ee2

# The action's own script.
awk '/^      run: \|$/ { on = 1; next } on && /^    - / { on = 0 } on { sub(/^        /, ""); print }' "$action" >"$SCRATCH/pin.sh"
[[ -s $SCRATCH/pin.sh ]] || fail "the arch-pin action has a script"

# Stand-ins: gh answers with agentv-iso's ci as $CI has it, or fails without
# it, and docker writes down what it's asked.
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/gh" <<'GH'
#!/bin/bash
[[ $* == *"repos/owner/agentv-iso/contents/test/agentv/image/ci?ref=agentv"* && -n ${CI_TEXT+set} ]] || exit 1
printf '%s\n' "$CI_TEXT"
GH
cat >"$SCRATCH/bin/docker" <<'DOCKER'
#!/bin/bash
echo "docker $*" >>"$DOCKER_LOG"
DOCKER
chmod +x "$SCRATCH/bin/gh" "$SCRATCH/bin/docker"

# pin [CI_TEXT=...]: runs the script as the action does.
pin() {
  : >"$SCRATCH/docker.log"
  : >"$SCRATCH/summary"
  env OWNER=owner GH_TOKEN=token DOCKER_LOG="$SCRATCH/docker.log" GITHUB_STEP_SUMMARY="$SCRATCH/summary" \
    PATH="$SCRATCH/bin:$PATH" "$@" bash -euo pipefail "$SCRATCH/pin.sh" >"$SCRATCH/out" 2>&1
}

pin CI_TEXT="$(printf 'set -euo pipefail\nARCH_PIN=%s # base-20261110.0.623834\n' "$digest")" ||
  fail "a pinned digest is pulled and tagged" "$(cat "$SCRATCH/out")"
[[ $(cat "$SCRATCH/docker.log") == "docker pull -q $digest"$'\n'"docker tag $digest ghcr.io/archlinux/archlinux:latest" ]] ||
  fail "the pinned digest becomes the leg's :latest" "$(cat "$SCRATCH/docker.log")"
grep -qF "$digest" "$SCRATCH/summary" || fail "the summary says which container the leg builds in" "$(cat "$SCRATCH/summary")"
pass "a leg builds and checks in the container agentv-iso's agentv pins, and says so"

pin CI_TEXT=$'ARCH_PIN=\nmore' || fail "an empty pin is fine" "$(cat "$SCRATCH/out")"
[[ ! -s $SCRATCH/docker.log ]] || fail "an empty pin leaves Arch's :latest alone" "$(cat "$SCRATCH/docker.log")"
pass "an empty pin leaves Arch's :latest alone"

for bad in ghcr.io/archlinux/archlinux:latest "ghcr.io/someone/archlinux@sha256:${digest##*sha256:}" "$digest;true"; do
  pin CI_TEXT="ARCH_PIN=$bad" && fail "a pin that isn't Arch's image by digest stops the leg" "$bad"
  [[ ! -s $SCRATCH/docker.log ]] || fail "a pin that isn't Arch's image by digest stops the leg" "$bad: $(cat "$SCRATCH/docker.log")"
done
pin && fail "a pin that can't be read stops the leg"
grep -q "Couldn't read agentv-iso" "$SCRATCH/out" || fail "a pin that can't be read stops the leg" "$(cat "$SCRATCH/out")"
pass "a pin that isn't Arch's image by digest, or can't be read, stops the leg"

# Every job that runs the image checks pins first: the one a stable leg runs
# in (image), the box job and the parts.
jobs=$(awk '
  /^  [a-z-]+:$/ { job = $1; sub(/:$/, "", job) }
  /uses: \.\/os\/\.github\/actions\/arch-pin$/ && !(job in ci) { pinned[job] = 1 }
  /image\/ci( |$)/ && !(job in ci) { ci[job] = 1; print job, (job in pinned) ? "pinned" : "unpinned" }
' "$image")
[[ $(grep -c . <<<"$jobs") == 3 ]] || fail "image.yml has three jobs that run the image checks" "$jobs"
grep -q '^image pinned$' <<<"$jobs" || fail "the job a stable leg runs in pins Arch's container before its checks" "$jobs"
grep -q 'unpinned' <<<"$jobs" && fail "every job that runs the image checks pins Arch's container first" "$jobs"
pass "every job that runs the image checks, a stable leg's included, pins Arch's container first"
