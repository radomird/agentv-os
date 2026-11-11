#!/bin/bash

# Guards the builder's sandbox (builder/sandbox/, ADR-011, ADR-045, S6.3):
# model prices, the key relay keeping each build inside its caps with the
# key outside the sandbox, the filter's list, root's hand-over, and the
# units' sandbox settings, which only Radomir loosens.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/sandbox.test.mts"

# Boxes installed before: the migration closes the builds they have. It
# names the box's own folder, so sudo here sends find to a stand-in for it.
# The find itself is the real one.
migration=$(grep -l "find /var/lib/agentv/build" "$ROOT"/migrations/agentv/*.sh)
export CALLS="$SCRATCH/calls" BOX="$SCRATCH/box"
builds="$BOX/var/lib/agentv/build"
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/sudo" <<'STUB'
#!/bin/bash
echo "sudo $*" >>"$CALLS"
if [[ $1 == "find" && $2 == "/var/lib/agentv/build" ]]; then
  shift 2
  exec find "$BOX/var/lib/agentv/build" "$@"
fi
exec "$@"
STUB
cat >"$SCRATCH/bin/systemd-sysusers" <<'STUB'
#!/bin/bash
exit "${SYSUSERS_EXIT:-0}"
STUB
chmod 755 "$SCRATCH/bin/sudo" "$SCRATCH/bin/systemd-sysusers"
migrate() { PATH="$SCRATCH/bin:$PATH" bash -euo pipefail "$migration" 2>&1; }
modes() { find "$builds" -exec stat -c '%a %n' {} + | sort -k2; }

mkdir -p "$builds/local.blocks/1.0.0/src" "$builds/local.blocks/1.0.1" "$builds/local.clock/0.1.0"
echo "{}" >"$builds/local.blocks/1.0.0/state.json"
echo "a note" >"$builds/local.blocks/notes"
find "$builds" -type d -exec chmod 0755 {} +
find "$builds" -type f -exec chmod 0644 {} +

output=$(migrate) || fail "the migration runs" "$output"
grep -qx "sudo systemd-sysusers agentv-builder.conf" "$CALLS" || fail "the migration makes the builder's group first" "$(cat "$CALLS")"
for build in local.blocks/1.0.0 local.blocks/1.0.1 local.clock/0.1.0; do
  [[ $(stat -c %a "$builds/$build") == 750 ]] || fail "M5 $build is closed to everyone but the builder and its group" "$(modes)"
done
for kept in "" local.blocks local.clock local.blocks/1.0.0/src; do
  [[ $(stat -c %a "$builds/$kept") == 755 ]] || fail "only each build's own folder changes" "$(modes)"
done
[[ $(stat -c %a "$builds/local.blocks/notes") == 644 ]] || fail "a file beside the builds is left alone" "$(modes)"
pass "M5 boxes installed before get each build's folder closed, and nothing else changed"

modes >"$SCRATCH/once"
output=$(migrate) || fail "the migration runs again" "$output"
[[ $(modes) == "$(cat "$SCRATCH/once")" ]] || fail "running it again changes nothing" "$(modes)"
pass "running the migration again changes nothing"

# A box that never built anything, and one where the group can't be made:
# the update goes on.
rm -rf "$BOX/var/lib/agentv"
output=$(SYSUSERS_EXIT=1 migrate) || fail "a box with no builds is fine" "$output"
pass "a box with no builds, or where the group can't be made, still gets through the migration"
