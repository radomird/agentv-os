#!/bin/bash

# Guards bin/agentv: it routes to the longest matching agentv-* command, lists
# only the ones that aren't hidden, and refuses names that aren't plain words.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
mkdir -p "$bin"
cp "$ROOT/bin/agentv" "$bin/"
printf '#!/bin/bash\n# agentv:summary=Say hello\necho "hello $*"\n' >"$bin/agentv-hello"
printf '#!/bin/bash\n# agentv:summary=Say hello to the TV\necho "tv $*"\n' >"$bin/agentv-hello-tv"
printf '#!/bin/bash\n# agentv:summary=Secret\n# agentv:hidden=true\necho hidden\n' >"$bin/agentv-secret"
chmod +x "$bin"/agentv*

[[ $("$bin/agentv" hello world) == "hello world" ]] || fail "agentv hello routes to agentv-hello"
pass "agentv hello routes to agentv-hello"

[[ $("$bin/agentv" hello tv now) == "tv now" ]] || fail "the longest command wins"
pass "the longest command wins"

[[ $("$bin/agentv" secret) == "hidden" ]] || fail "a hidden command still runs"
pass "a hidden command still runs"

help=$("$bin/agentv" --help)
[[ $help == *"hello tv"*"Say hello to the TV"* ]] || fail "help lists commands with their summaries" "$help"
[[ $help != *secret* ]] || fail "help leaves hidden commands out" "$help"
pass "help lists commands, without the hidden ones"

"$bin/agentv" nope >/dev/null 2>&1 && fail "an unknown command fails"
"$bin/agentv" ../agentv-hello >/dev/null 2>&1 && fail "a path is not a command"
pass "unknown commands and paths fail"

for command in "$ROOT"/bin/agentv-*; do
  [[ -n $(sed -n '1,80s/^# agentv:summary=//p' "$command") ]] || fail "every agentv command has a summary: ${command##*/}"
done
pass "every agentv command has a summary"
