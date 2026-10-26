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

# --- agentv app install --local (ADR-039) --------------------------------------

# The sample app as the box's agent would leave it, and a stand-in for
# agentv-pin-check that says yes, or no once told to.
cp -R "$ROOT/test/agentv/fixtures/apps/sample" "$SCRATCH/built"
jq '.id = "local.sample"' "$ROOT/test/agentv/fixtures/apps/sample/manifest.json" >"$SCRATCH/built/manifest.json"
cat >"$SCRATCH/pin-check" <<'PIN'
#!/bin/bash
echo "$*${XDG_RUNTIME_DIR:+ in $XDG_RUNTIME_DIR}" >>"$PIN_LOG"
[[ ! -f $PIN_NO ]]
PIN
chmod +x "$SCRATCH/pin-check"
export PIN_LOG="$SCRATCH/pin.log" PIN_NO="$SCRATCH/pin-no"

local_app() {
  env -u XDG_RUNTIME_DIR AGENTV_PIN_CHECK="$SCRATCH/pin-check" AGENTV_PATH="$ROOT" AGENTV_STATE="$SCRATCH/state" \
    "$ROOT/bin/agentv-app-install" --local "$@"
}

# Runs agentv app install --local in a terminal of its own, answering the
# question with $1.
in_terminal() {
  local answer=$1
  shift
  python3 - "$answer" env -u XDG_RUNTIME_DIR AGENTV_PATH="$ROOT" AGENTV_STATE="$SCRATCH/state" AGENTV_PIN_CHECK="$SCRATCH/pin-check" \
    "$ROOT/bin/agentv-app-install" --local "$@" <<'PY'
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
os.write(fd, (sys.argv[1] + "\n").encode())
out = b""
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode().replace("\r", ""))
sys.exit(os.waitstatus_to_exitcode(status))
PY
}

: >"$PIN_LOG"
out=$(local_app "$SCRATCH/built" --yes </dev/null 2>&1) || fail "ADR-039 agentv app install --local installs an app built on this box" "$out"
[[ $out == "Sample 1.0.0 (local.sample), from $SCRATCH/built."*"It can reach the addresses its setup asks you for, and nothing else."* ]] ||
  fail "it says what the app is, where it's from and what it can reach, before it asks" "$out"
[[ $(tail -n 1 <<<"$out") == "Installed Sample 1.0.0 (local.sample). It's in Apps on the TV, where its details put it on home." ]] ||
  fail "it says what it installed, and where to find it on the TV" "$out"
[[ $(cat "$PIN_LOG") == "app-install" ]] || fail "--yes answers the question, and the adult PIN is still asked for" "$(cat "$PIN_LOG")"
[[ -f $SCRATCH/state/apps/local.sample/manifest.json && ! -e $SCRATCH/state/apps/local.sample/fixtures ]] ||
  fail "the app lands in the box's apps folder, without its fixtures" "$(ls -R "$SCRATCH/state/apps")"
[[ $(app list) == "local.sample 1.0.0 local" ]] || fail "agentv app list shows it as a local app" "$(app list)"
pass "ADR-039 agentv app install --local installs an app built on this box as a local app, after the adult PIN"

out=$(app remove local.sample 2>&1) || fail "agentv app remove removes a local app" "$out"
[[ ! -e $SCRATCH/state/apps/local.sample && -z $(app list) ]] || fail "agentv app remove leaves nothing of the local app"
pass "ADR-039 agentv app remove takes a local app off the box"

touch "$PIN_NO"
status=0
out=$(local_app "$SCRATCH/built" --yes </dev/null 2>&1) || status=$?
(( status == 1 )) || fail "ADR-039 without the adult PIN, nothing is installed" "exit $status: $out"
[[ $(tail -n 1 <<<"$out") == "Couldn't do it: that needs the adult PIN, so nothing was installed." ]] || fail "it says the PIN was needed" "$out"
[[ ! -e $SCRATCH/state/apps/local.sample && -z $(app list) ]] || fail "nothing of the app is on the box without the PIN"
rm -f "$PIN_NO"
pass "ADR-039 agentv app install --local installs nothing without the adult PIN"

# Through sudo with no terminal, the PIN is asked for on the TV of whoever ran
# sudo, since root has no TV session of its own.
: >"$PIN_LOG"
out=$(SUDO_UID=4242 local_app "$SCRATCH/built" --yes </dev/null 2>&1) || fail "an install through sudo works" "$out"
[[ $(cat "$PIN_LOG") == "app-install in /run/user/4242" ]] || fail "the PIN is asked for in sudo's person's TV session" "$(cat "$PIN_LOG")"
app remove local.sample >/dev/null
pass "ADR-039 through sudo, the adult PIN is asked for on the TV of the person who ran it"

: >"$PIN_LOG"
status=0
out=$(local_app "$SCRATCH/built" </dev/null 2>&1) || status=$?
(( status == 1 )) || fail "with no terminal and no --yes, nothing is installed" "exit $status: $out"
[[ $(tail -n 1 <<<"$out") == "Couldn't do it: there's no terminal to ask in, so add --yes to install it without the question." ]] ||
  fail "it says to add --yes" "$out"
[[ ! -s $PIN_LOG && -z $(app list) ]] || fail "it asks for nothing and installs nothing"
pass "ADR-039 with no terminal to ask in, agentv app install --local needs --yes"

if type -P python3 >/dev/null; then
  status=0
  out=$(in_terminal n "$SCRATCH/built" 2>&1) || status=$?
  (( status == 1 )) || fail "no to the question installs nothing" "exit $status: $out"
  grep -q "Install it? \[y/N\]" <<<"$out" || fail "it asks in the terminal" "$out"
  grep -q "Couldn't do it: local.sample wasn't approved, so nothing was installed." <<<"$out" || fail "it says nothing was installed" "$out"
  [[ ! -s $PIN_LOG && -z $(app list) ]] || fail "a no asks for no PIN and installs nothing"
  out=$(in_terminal y "$SCRATCH/built" 2>&1) || fail "yes to the question installs it" "$out"
  [[ $(app list) == "local.sample 1.0.0 local" && $(cat "$PIN_LOG") == "app-install" ]] || fail "a yes, then the PIN, installs it" "$out"
  app remove local.sample >/dev/null
  pass "ADR-039 in a terminal, agentv app install --local asks first, and installs only on a yes"
else
  [[ -n ${CI:-} ]] && fail "python3 is installed" "the terminal check needs python3"
  echo "skip - agentv app install --local in a terminal (python3 isn't installed)"
fi

jq '.id = "agentv.sample"' "$ROOT/test/agentv/fixtures/apps/sample/manifest.json" >"$SCRATCH/built/manifest.json"
: >"$PIN_LOG"
status=0
out=$(local_app "$SCRATCH/built" --yes </dev/null 2>&1) || status=$?
(( status == 1 )) || fail "a folder that isn't a local app isn't installed" "exit $status: $out"
grep -q "an app built on this box has an id that starts with local., not 'agentv.sample'" <<<"$out" || fail "it says why" "$out"
[[ ! -s $PIN_LOG && -z $(app list) ]] || fail "it asks for nothing and installs nothing"
pass "ADR-039 agentv app install --local checks the folder as a local app before anyone is asked"

status=0
out=$(app install --local 2>&1) || status=$?
(( status == 2 )) || fail "agentv app install --local with no folder is a usage error" "exit $status: $out"
pass "agentv app install --local with no folder says how to use it"
