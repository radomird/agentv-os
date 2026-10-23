#!/bin/bash

# Guards the signed app index and the installer (daemon/apps/) with Node's own
# test runner, then agentv app install, list and remove on the command line: a
# sample app installs from a signed test index, and a tampered index is
# refused (S2.1). A throwaway key made here stands in for AgenTV's.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

for tool in node gpg gpgv git; do
  if ! type -P "$tool" >/dev/null; then
    [[ -n ${CI:-} ]] && fail "$tool is installed" "the app index's tests need node, gpg, gpgv and git"
    echo "skip - the app index's tests ($tool isn't installed)"
    exit 0
  fi
done

# Node 22.6 to 22.17 runs TypeScript only when asked.
flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)

if ! node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning --test --test-reporter=tap \
  "$ROOT/test/agentv/unit/index.test.mts" >"$SCRATCH/tap" 2>&1; then
  fail "the app index's tests pass" "$(grep -E '^(not ok|# |  ---|    )' "$SCRATCH/tap" | head -n 60)"
fi
grep -E '^ok ' "$SCRATCH/tap" | sed -E 's/^ok [0-9]+ - /ok - /'

# A throwaway key, a repo with the sample app, and an index that pins it.
export GNUPGHOME="$SCRATCH/gnupg" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key 'AgenTV test <test@agentv.invalid>' ed25519 sign never 2>/dev/null
gpg --batch --armor --export test@agentv.invalid >"$SCRATCH/agentv.asc"

cp -R "$ROOT/test/agentv/fixtures/apps/sample" "$SCRATCH/repo"
git -C "$SCRATCH/repo" init --quiet
git -C "$SCRATCH/repo" add -A
git -C "$SCRATCH/repo" -c user.name=AgenTV -c user.email=test@agentv.invalid commit --quiet -m "Sample 1.0.0"
commit=$(git -C "$SCRATCH/repo" rev-parse HEAD)

mkdir "$SCRATCH/index"
jq -n --arg repo "file://$SCRATCH/repo" --arg commit "$commit" '{
  schema: 1, date: "2026-10-23T00:00:00Z",
  apps: [{id: "agentv.sample", tier: "official", name: "Sample", version: "1.0.0", repo: $repo, commit: $commit}]
}' >"$SCRATCH/index/index.json"
gpg --batch --quiet --detach-sign --output "$SCRATCH/index/index.json.sig" "$SCRATCH/index/index.json"

app() {
  AGENTV_PATH="$ROOT" AGENTV_STATE="$SCRATCH/state" AGENTV_KEYRING="$SCRATCH/agentv.asc" \
    "$ROOT/bin/agentv-app-$1" "${@:2}"
}
mkdir "$SCRATCH/state"

out=$(app install agentv.sample --index "$SCRATCH/index" 2>&1) || fail "S2.1 agentv app install installs from a signed index" "$out"
[[ $out == "Installed Sample 1.0.0 (agentv.sample)." ]] || fail "agentv app install says what it installed" "$out"
[[ -f $SCRATCH/state/apps/agentv.sample/manifest.json ]] || fail "the app lands in the box's apps folder"
[[ $(app list) == "agentv.sample 1.0.0 official" ]] || fail "agentv app list shows the app and its tier" "$(app list)"
pass "S2.1 agentv app install installs the sample app from a signed test index, and agentv app list shows it"

out=$(app remove agentv.sample 2>&1) || fail "agentv app remove removes the app" "$out"
[[ ! -e $SCRATCH/state/apps/agentv.sample && -z $(app list) ]] || fail "agentv app remove leaves nothing of the app"
pass "agentv app remove takes the app off the box"

sed -i.bak 's/"1.0.0"/"9.9.9"/' "$SCRATCH/index/index.json"
status=0
out=$(app install agentv.sample --index "$SCRATCH/index" 2>&1) || status=$?
(( status == 1 )) || fail "S2.1 agentv app install refuses a tampered index" "exit $status: $out"
[[ $out == "Couldn't do it: the app index isn't signed by AgenTV's key, so nothing was installed." ]] ||
  fail "S2.1 it says why, in plain words" "$out"
[[ ! -e $SCRATCH/state/apps/agentv.sample ]] || fail "S2.1 nothing is installed from a tampered index"
pass "S2.1 agentv app install refuses a tampered index and installs nothing"

# The repo has no package settings file, so there's no index to install from.
status=0
out=$(unset AGENTV_INDEX_URL; app install agentv.sample 2>&1) || status=$?
(( status == 1 )) || fail "agentv app install without an index fails" "exit $status: $out"
[[ $out == "Couldn't do it: this box has no app index set up yet." ]] || fail "agentv app install without an index says so" "$out"
pass "agentv app install without an index says so"
