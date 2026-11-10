#!/bin/bash

# Guards the migration for a TV with no voice of its own (T17.1): the old
# voice package comes off a TV that still has it, only once agentv no longer
# asks for it, and a TV without it is left alone.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

migration=$(grep -l "The TV ships with no voice of its own now" "$ROOT"/migrations/agentv/*.sh)
[[ -n $migration ]] || fail "there's a migration for a TV that still has the old voice"

# pacman and sudo as far as the migration uses them: which packages are on
# the box, what agentv depends on, and what was asked to be removed.
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/pacman" <<'PACMAN'
#!/bin/bash
case "$1" in
  -Q) grep -qx "$2" "$FAKE/installed" ;;
  -Qi) printf 'Name            : agentv\nDepends On      : %s\nOptional Deps   : None\n' "$(cat "$FAKE/depends")" ;;
  -Rns) echo "$*" >>"$FAKE/removed" ;;
esac
PACMAN
printf '#!/bin/bash\nexec "$@"\n' >"$SCRATCH/bin/sudo"
chmod +x "$SCRATCH/bin/pacman" "$SCRATCH/bin/sudo"
run_migration() {
  FAKE="$SCRATCH" PATH="$SCRATCH/bin:$PATH" bash "$migration"
}

# The old voice is on the box, and the new agentv doesn't ask for it.
printf 'agentv\nagentv-voice\n' >"$SCRATCH/installed"
echo "omarchy  agentv-keyring  pipewire" >"$SCRATCH/depends"
: >"$SCRATCH/removed"
run_migration || fail "the migration runs"
[[ $(cat "$SCRATCH/removed") == "-Rns --noconfirm agentv-voice" ]] || fail "the old voice is taken off" "$(cat "$SCRATCH/removed")"
pass "T17.1 a TV that still has the old voice has it taken off, once agentv no longer asks for it"

# An agentv that still depends on it: nothing is removed.
echo "omarchy  agentv-keyring  agentv-voice  pipewire" >"$SCRATCH/depends"
: >"$SCRATCH/removed"
run_migration || fail "the migration runs with the voice still needed"
[[ ! -s $SCRATCH/removed ]] || fail "a voice agentv still needs stays" "$(cat "$SCRATCH/removed")"

# A TV with no voice package: nothing to do, and nothing fails.
echo "agentv" >"$SCRATCH/installed"
echo "omarchy  agentv-keyring  pipewire" >"$SCRATCH/depends"
run_migration || fail "the migration runs on a TV with no voice"
[[ ! -s $SCRATCH/removed ]] || fail "nothing is removed from a TV with no voice"
pass "T17.1 a voice agentv still needs stays, and a TV without one is left alone"
