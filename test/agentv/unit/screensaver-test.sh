#!/bin/bash

# Guards the terminal screensaver (bin/agentv-screensaver, ADR-049, S5.9):
# Omarchy's ttfx effect on the branding text, in the theme's colours from
# Omarchy's own helper, again and again until a key ends it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

# Omarchy, as far as the screensaver uses it: the theme's colours as OSC
# sequences, and ttfx, which notes how it was run and plays for a moment.
omarchy="$SCRATCH/omarchy"
mkdir -p "$omarchy/bin" "$SCRATCH/home/.config/omarchy/branding"
printf '#!/bin/bash\nprintf "\\033]11;#1a1b26\\007"\n' >"$omarchy/bin/omarchy-theme-osc"
printf '#!/bin/bash\necho "$*" >>"%s/ttfx.log"\nsleep 0.3\n' "$SCRATCH" >"$omarchy/bin/ttfx"
chmod +x "$omarchy/bin/omarchy-theme-osc" "$omarchy/bin/ttfx"
echo "AGENTV" >"$SCRATCH/home/.config/omarchy/branding/screensaver.txt"
echo "OMARCHY" >"$omarchy/logo.txt"

run() {
  HOME="$SCRATCH/home" OMARCHY_PATH="$omarchy" "$ROOT/bin/agentv-screensaver" <"$SCRATCH/keys" >"$SCRATCH/out" 2>&1 &
  saver=$!
}

mkfifo "$SCRATCH/keys"
exec 3<>"$SCRATCH/keys"
run
sleep 1
kill -0 "$saver" 2>/dev/null || fail "it keeps going until a key"
(( $(wc -l <"$SCRATCH/ttfx.log") >= 2 )) || fail "the effect runs again and again" "$(cat "$SCRATCH/ttfx.log")"
printf 'x' >&3
for _ in $(seq 1 30); do kill -0 "$saver" 2>/dev/null || break; sleep 0.1; done
kill -0 "$saver" 2>/dev/null && fail "a key ends it"
wait "$saver" || fail "it ends cleanly on a key"
pass "S5.9 the screensaver runs Omarchy's effect until a key ends it"

grep -q $'\e]11;#1a1b26\a' "$SCRATCH/out" || fail "it's in the theme's colours, from Omarchy's own helper" "$(od -c "$SCRATCH/out" | head)"
args=$(head -n 1 "$SCRATCH/ttfx.log")
[[ $args == "-i $SCRATCH/home/.config/omarchy/branding/screensaver.txt "* ]] || fail "on Omarchy's branding text, AgenTV's wordmark" "$args"
[[ $args == *"--random-effect"* && $args == *"--anchor-canvas c"* && $args == *"--canvas-width 0 --canvas-height 0"* ]] ||
  fail "with Omarchy's own screensaver settings" "$args"
pass "S5.9 in the theme's colours, on the branding text, as Omarchy's screensaver runs it"

# With no branding text of the person's own, Omarchy's logo.
rm "$SCRATCH/home/.config/omarchy/branding/screensaver.txt" "$SCRATCH/ttfx.log"
run
sleep 0.5
printf 'x' >&3
wait "$saver" || true
[[ $(head -n 1 "$SCRATCH/ttfx.log") == "-i $omarchy/logo.txt "* ]] || fail "without branding text it shows Omarchy's logo" "$(cat "$SCRATCH/ttfx.log")"
pass "without branding text of its own, it shows the logo Omarchy has"
