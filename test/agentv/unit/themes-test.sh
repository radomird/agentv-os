#!/bin/bash

# Guards the looks setup and Settings offer (board 12, Q55, S5.2): Omarchy's
# own Tokyo Night, Gruvbox and Catppuccin Latte in their own colours, which
# one the TV has, and the user path unit that hands a new theme's colours to
# the TV as soon as Omarchy has swapped it in.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/themes.test.mts"

unit="$ROOT/system/user/agentv-theme.path"
grep -qx 'PathChanged=%h/.local/state/omarchy/current/theme.name' "$unit" || fail "agentv-theme.path watches the name Omarchy writes once a theme is swapped in"
grep -qx 'Unit=agentv-theme.service' "$unit" || fail "and starts the theme's hand-over"
grep -qx 'WantedBy=default.target' "$unit" || fail "in every session of the owner's, the TV's and Omarchy's desktop"
# omarchy-theme-set writes theme.name right after the new theme is in place,
# before its slower restarts and the theme-set hooks. The patterns are
# Omarchy's own lines, dollar signs and all.
# shellcheck disable=SC2016
swap='^mv "$NEXT_THEME_PATH" "$CURRENT_THEME_PATH"$'
name_at=$(grep -n 'current/theme.name"$' "$ROOT/bin/omarchy-theme-set" | head -n 1 | cut -d: -f1)
swap_at=$(grep -n "$swap" "$ROOT/bin/omarchy-theme-set" | cut -d: -f1)
hook_at=$(grep -n 'omarchy-hook theme-set' "$ROOT/bin/omarchy-theme-set" | cut -d: -f1)
if [[ -z $name_at || -z $swap_at || -z $hook_at ]] || (( swap_at > name_at || name_at > hook_at )); then
  fail "Omarchy writes theme.name after the swap and before its hooks" "swap $swap_at, name $name_at, hook $hook_at"
fi
pass "S5.2 agentv-theme.path hands the colours over as soon as Omarchy has swapped the theme in"
