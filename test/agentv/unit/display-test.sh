#!/bin/bash

# The TV's resolution and its three sizes (ADR-062): the rules and
# /api/display (daemon/display.ts), and the TV session's monitor lines
# (session/hypr.lua), which start the session at the mode and scale the
# screen daemon kept, and take nothing else from that file.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/display.test.mts"

hypr="$ROOT/session/hypr.lua"
grep -qF 'hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })' "$hypr" ||
  fail "the TV session starts at Hyprland's own mode and scale when there's nothing kept"
grep -qF 'hl.monitor({ output = kept.output, mode = kept.mode, position = "auto", scale = kept.scale })' "$hypr" ||
  fail "and at the kept mode and scale when there is"

lua=$(type -P lua5.4 || type -P lua || true)
if [[ -z $lua ]]; then
  # CI installs Lua for this, so there it's a failure, not a skip.
  [[ -n ${CI:-} ]] && fail "Lua is installed" "the TV session's monitor lines need lua5.4 to run"
  pass "the TV session's monitor lines are there (no Lua here to run them)"
  exit 0
fi

# hypr.lua with a stand-in hl that prints each monitor rule.
cat >"$SCRATCH/run.lua" <<'LUA'
local function noop() return noop end
local stub = setmetatable({}, { __index = function() return noop end })
hl = setmetatable({
  monitor = function(rule) print(rule.output .. "|" .. tostring(rule.mode) .. "|" .. tostring(rule.scale)) end,
  dsp = stub,
}, { __index = function() return noop end })
dofile(arg[1])
LUA
rules() {
  XDG_STATE_HOME="$SCRATCH/state" HOME="$SCRATCH/home" "$lua" "$SCRATCH/run.lua" "$hypr"
}

[[ $(rules) == "|preferred|auto" ]] || fail "with nothing kept, only Hyprland's own" "$(rules)"
mkdir -p "$SCRATCH/state/agentv"
echo "HDMI-A-1 3840x2160@60 2.4" >"$SCRATCH/state/agentv/display"
[[ $(rules) == $'|preferred|auto\nHDMI-A-1|3840x2160@60|2.4' ]] || fail "the session starts at the kept mode and scale" "$(rules)"
for bad in 'HDMI"}) os.exit(1) --x 3840x2160@60 2' "HDMI-A-1 3840x2160@60 0" "HDMI-A-1 3840x2160@60 9" "HDMI-A-1 preferred 2" "HDMI-A-1 3840x2160@60 2 extra"; do
  printf '%s\n' "$bad" >"$SCRATCH/state/agentv/display"
  [[ $(rules) == "|preferred|auto" ]] || fail "a kept line that isn't a plain mode and scale is ignored" "$bad: $(rules)"
done
rm -rf "$SCRATCH/state"
mkdir -p "$SCRATCH/home/.local/state/agentv"
echo "DP-2 1920x1080@59.94 1.2" >"$SCRATCH/home/.local/state/agentv/display"
[[ $(XDG_STATE_HOME="" HOME="$SCRATCH/home" "$lua" "$SCRATCH/run.lua" "$hypr" | tail -n 1) == "DP-2|1920x1080@59.94|1.2" ]] ||
  fail "without XDG_STATE_HOME, the line is in ~/.local/state"
pass "the TV session starts at the kept mode and scale, and ignores anything else in that file"
