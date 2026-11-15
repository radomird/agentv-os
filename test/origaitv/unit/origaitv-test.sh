#!/bin/bash

# Guards bin/origaitv: it routes to the longest matching origaitv-* command, lists
# only the ones that aren't hidden, and refuses names that aren't plain words.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
mkdir -p "$bin"
cp "$ROOT/bin/origaitv" "$bin/"
printf '#!/bin/bash\n# origaitv:summary=Say hello\necho "hello $*"\n' >"$bin/origaitv-hello"
printf '#!/bin/bash\n# origaitv:summary=Say hello to the TV\necho "tv $*"\n' >"$bin/origaitv-hello-tv"
printf '#!/bin/bash\n# origaitv:summary=Secret\n# origaitv:hidden=true\necho hidden\n' >"$bin/origaitv-secret"
chmod +x "$bin"/origaitv*

[[ $("$bin/origaitv" hello world) == "hello world" ]] || fail "origaitv hello routes to origaitv-hello"
pass "origaitv hello routes to origaitv-hello"

[[ $("$bin/origaitv" hello tv now) == "tv now" ]] || fail "the longest command wins"
pass "the longest command wins"

[[ $("$bin/origaitv" secret) == "hidden" ]] || fail "a hidden command still runs"
pass "a hidden command still runs"

help=$("$bin/origaitv" --help)
[[ $help == *"hello tv"*"Say hello to the TV"* ]] || fail "help lists commands with their summaries" "$help"
[[ $help != *secret* ]] || fail "help leaves hidden commands out" "$help"
pass "help lists commands, without the hidden ones"

"$bin/origaitv" nope >/dev/null 2>&1 && fail "an unknown command fails"
"$bin/origaitv" ../origaitv-hello >/dev/null 2>&1 && fail "a path is not a command"
pass "unknown commands and paths fail"

for command in "$ROOT"/bin/origaitv-*; do
  [[ -n $(sed -n '1,80s/^# origaitv:summary=//p' "$command") ]] || fail "every origaitv command has a summary: ${command##*/}"
done
pass "every origaitv command has a summary"
