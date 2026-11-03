#!/bin/bash

# Guards what the daemon keeps for the home screen (daemon/home.ts), then
# agentv-theme-sync and the migration that brings the theme to older boxes.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/home.test.mts"
type -P node >/dev/null || exit 0

# --- agentv-theme-sync ----------------------------------------------------------

flags=()
[[ -n $(node -p 'process.features.typescript || ""' 2>/dev/null) ]] || flags+=(--experimental-strip-types)
port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
AGENTV_PATH="$ROOT" OMARCHY_PATH="$ROOT" AGENTV_DAEMON_STATE="$SCRATCH/state" AGENTV_APPS="$SCRATCH/apps" AGENTV_LAN_PORT=0 AGENTV_SETUP_PORT=0 \
  node ${flags[@]+"${flags[@]}"} --disable-warning=ExperimentalWarning "$ROOT/daemon/server.ts" --port "$port" >"$SCRATCH/daemon.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null && break
  sleep 0.1
done

theme="$SCRATCH/home/.local/state/omarchy/current/theme"
mkdir -p "$theme"
cp "$ROOT/themes/catppuccin-latte/colors.toml" "$theme/colors.toml"
sync_theme() {
  HOME="$SCRATCH/home" AGENTV_PATH="$ROOT" AGENTV_PORT=$port OMARCHY_PATH="$ROOT" PATH="$ROOT/bin:$PATH" "$ROOT/bin/agentv-theme-sync"
}

out=$(sync_theme 2>&1) || fail "agentv-theme-sync hands a theme to the daemon" "$out"
css=$(curl -fsS "http://127.0.0.1:$port/api/theme.css")
if ! grep -qx '  --background: #eff1f5;' <<<"$css" || ! grep -qx '  --accent: #1e66f5;' <<<"$css"; then
  fail "a theme with no launcher.css yet is rendered from its colours" "$css"
fi
pass "agentv-theme-sync renders the TV's colours from a theme that has no launcher.css yet"

printf ':root {\n  --accent: #123456;\n}\n' >"$theme/launcher.css"
sync_theme >/dev/null 2>&1 || fail "agentv-theme-sync takes the theme's own launcher.css"
[[ $(curl -fsS "http://127.0.0.1:$port/api/theme.css") == $':root {\n  --accent: #123456;\n}' ]] ||
  fail "the theme's own launcher.css is what the TV gets"
pass "agentv-theme-sync hands over the launcher.css Omarchy rendered"

# The theme's name goes with its colours, so Look knows which it is (ADR-048).
names="$SCRATCH/home/.local/state/omarchy/current/theme.name"
echo "catppuccin-latte" >"$names"
sync_theme >/dev/null 2>&1 || fail "agentv-theme-sync hands over the theme's name"
[[ $(curl -fsS "http://127.0.0.1:$port/api/themes" | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).current))') == "catppuccin-latte" ]] ||
  fail "the TV says which theme it has from the name the hook sent"
echo "my+theme_2.0" >"$names"
sync_theme >/dev/null 2>&1 || fail "agentv-theme-sync hands over a name with a +"
[[ $(cat "$SCRATCH/state/theme-name") == "my+theme_2.0" ]] || fail "a theme's name keeps its +" "$(cat "$SCRATCH/state/theme-name" 2>&1)"
echo "Not A Name" >"$names"
sync_theme >/dev/null 2>&1 || fail "agentv-theme-sync hands the colours over without a name Omarchy wouldn't allow"
[[ ! -e $SCRATCH/state/theme-name ]] || fail "a name Omarchy wouldn't allow isn't kept"
pass "agentv-theme-sync hands over the theme's name with its colours"

out=$(HOME="$SCRATCH/home" AGENTV_PATH="$ROOT" AGENTV_PORT=1 PATH="$ROOT/bin:$PATH" "$ROOT/bin/agentv-theme-sync" 2>&1) && fail "agentv-theme-sync says when the daemon isn't there"
[[ $out == *"AgenTV's daemon didn't take the theme's colours" ]] || fail "agentv-theme-sync says when the daemon isn't there" "$out"
pass "agentv-theme-sync says when the daemon isn't there"

# --- The migration, for boxes installed before ------------------------------

mkdir -p "$SCRATCH/fakebin" "$SCRATCH/old"
printf '#!/bin/bash\necho synced >>"%s/calls"\n' "$SCRATCH" >"$SCRATCH/fakebin/agentv-theme-sync"
chmod +x "$SCRATCH/fakebin/agentv-theme-sync"
migration=$(grep -l "launcher.css.tpl" "$ROOT"/migrations/agentv/*.sh)
HOME="$SCRATCH/old" AGENTV_PATH="$ROOT" PATH="$SCRATCH/fakebin:$PATH" bash "$migration"
[[ $(readlink "$SCRATCH/old/.config/omarchy/themed/launcher.css.tpl") == "$ROOT/config/omarchy/themed/launcher.css.tpl" ]] ||
  fail "the migration links AgenTV's template where Omarchy renders the theme"
cmp -s "$SCRATCH/old/.config/omarchy/hooks/theme-set.d/agentv" "$ROOT/config/omarchy/hooks/theme-set.d/agentv" ||
  fail "the migration adds the theme-set hook"
[[ $(cat "$SCRATCH/calls") == "synced" ]] || fail "the migration hands over the theme the box has"
pass "boxes installed before get the template, the hook and their theme's colours"
