#!/bin/bash

# Guards the app contract's checks (apps/contract/manifest.ts) with Node's own
# test runner, and `origaitv app validate` on the command line (S2.2).

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

if ! type -P node >/dev/null; then
  [[ -n ${CI:-} ]] && fail "Node is installed" "the app contract's tests need Node 22.18 or newer"
  echo "skip - the app contract's tests (Node isn't installed)"
  exit 0
fi

# Node 22.6 to 22.17 runs TypeScript only when asked.
flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)

if ! node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning --test --test-reporter=tap \
  "$ROOT/test/origaitv/unit/apps.test.mts" >"$SCRATCH/tap" 2>&1; then
  fail "the app contract's tests pass" "$(grep -E '^(not ok|# |  ---|    )' "$SCRATCH/tap" | head -n 60)"
fi
grep -E '^ok ' "$SCRATCH/tap" | sed -E 's/^ok [0-9]+ - /ok - /'

validate() {
  ORIGAITV_PATH="$ROOT" "$ROOT/bin/origaitv-app-validate" "$@"
}

sample="$ROOT/test/origaitv/fixtures/apps/sample"
out=$(validate --official "$sample") || fail "origaitv app validate passes the sample app" "$out"
[[ $out == "ok - origaitv.sample 1.0.0 (official): $sample" ]] || fail "it says which app passed, and as what" "$out"
pass "origaitv app validate passes the sample app as an official app"

cp -R "$sample" "$SCRATCH/linked"
ln -s /etc/passwd "$SCRATCH/linked/passwd"
cp -R "$sample" "$SCRATCH/unsafe"
jq '.entryPoints.tvApp = "../app.ts"' "$sample/manifest.json" >"$SCRATCH/unsafe/manifest.json"

status=0
out=$(validate "$SCRATCH/linked" "$SCRATCH/unsafe" "$sample" 2>&1) || status=$?
(( status == 1 )) || fail "origaitv app validate exits 1 when a package fails" "exit $status: $out"
grep -q "symlinks aren't allowed in an app package: passwd" <<<"$out" ||
  fail "S2.2 origaitv app validate rejects a symlink" "$out"
grep -q "the entry point tvApp has '..' in it: '../app.ts'" <<<"$out" ||
  fail "S2.2 origaitv app validate rejects an unsafe entry path" "$out"
grep -q "the id 'origaitv.sample' uses origaitv.\*, which is only for OrigaiTV's own apps" <<<"$out" ||
  fail "S2.2 origaitv app validate rejects a third-party origaitv.* id" "$out"
pass "S2.2 origaitv app validate rejects a symlink, an unsafe entry path and a third-party origaitv.* id"

status=0
validate >/dev/null 2>&1 || status=$?
(( status == 2 )) || fail "origaitv app validate with no package is a usage error" "exit $status"
pass "origaitv app validate with no package says how to use it"
