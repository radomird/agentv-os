#!/bin/bash

# Guards ADR-032's settings for the services' Chromium (S1.7): its own
# prompts for saving passwords, autofill, translate and site notifications
# go off in its profile, before it starts and once on a box installed
# before, and the rest of the profile stays as it was. Nothing reaches the
# Chromium on Omarchy's desktop.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-chromium-prefs"
profile="$SCRATCH/chromium"
prefs="$profile/Default/Preferences"

# No Chromium runs on the profile here.
mkdir -p "$SCRATCH/bin"
printf '#!/bin/bash\nexit 1\n' >"$SCRATCH/bin/pgrep"
chmod +x "$SCRATCH/bin/pgrep"
export PATH="$SCRATCH/bin:$PATH"

prompts_off() {
  jq -e '.credentials_enable_service == false and .credentials_enable_autosignin == false
    and .autofill.profile_enabled == false and .autofill.credit_card_enabled == false
    and .translate.enabled == false and .profile.default_content_setting_values.notifications == 2' "$prefs" >/dev/null
}

"$cmd" "$profile" >/dev/null || fail "it runs on a new profile"
prompts_off || fail "S1.7 a new profile starts with Chromium's prompts off" "$(cat "$prefs")"
[[ $(stat -c %a "$prefs") == 600 ]] || fail "the profile's settings stay the owner's alone"
pass "S1.7 a new services' profile starts with Chromium's prompts off"

# A profile the services already signed in on keeps everything else.
cat >"$prefs" <<'JSON'
{"profile": {"name": "Person 1", "default_content_setting_values": {"geolocation": 2}},
 "translate": {"blocked_languages": ["fr"]}, "media": {"engagement": {"schema_version": 5}},
 "credentials_enable_service": true, "autofill": {"profile_enabled": true}}
JSON
"$cmd" "$profile" >/dev/null || fail "it runs on a profile in use"
prompts_off || fail "a profile with the prompts on gets them off" "$(cat "$prefs")"
jq -e '.profile.name == "Person 1" and .profile.default_content_setting_values.geolocation == 2
  and .translate.blocked_languages == ["fr"] and .media.engagement.schema_version == 5' "$prefs" >/dev/null ||
  fail "the rest of the profile stays as it was" "$(cat "$prefs")"
pass "S1.7 a profile in use gets the prompts off and keeps everything else"

# Chromium resets a settings file it can't read, so this writes a new one.
echo "not json" >"$prefs"
"$cmd" "$profile" >/dev/null || fail "it runs on a broken settings file"
prompts_off || fail "a broken settings file gets a new one with the prompts off" "$(cat "$prefs")"
pass "a broken settings file gets a new one with the prompts off"

# While the services' Chromium runs, it writes its own settings back when it
# ends, so this leaves the file alone and the next start sets them.
echo '{"credentials_enable_service": true}' >"$prefs"
printf '#!/bin/bash\nexit 0\n' >"$SCRATCH/bin/pgrep"
out=$("$cmd" "$profile") || fail "it runs while the services' Chromium does"
[[ $(jq -c . "$prefs") == '{"credentials_enable_service":true}' && $out == *"next starts"* ]] ||
  fail "a running Chromium's profile is left for its next start" "$out"
printf '#!/bin/bash\nexit 1\n' >"$SCRATCH/bin/pgrep"
pass "a running Chromium's profile is left alone until its next start"

# A box installed before gets them from a migration.
migration=$(grep -l "agentv-chromium-prefs" "$ROOT"/migrations/agentv/*.sh)
rm -rf "$profile"
mkdir -p "$profile"
PATH="$ROOT/bin:$PATH" AGENTV_CHROMIUM_STATE="$profile" bash "$migration" >/dev/null || fail "the migration runs"
prompts_off || fail "the migration turns the prompts off" "$(cat "$prefs" 2>/dev/null)"
pass "S1.7 a box installed before gets the prompts off from a migration"

# The desktop's Chromium keeps its prompts: nothing of AgenTV's sets a
# Chromium policy for the whole system.
if grep -rln "/etc/chromium" "$ROOT"/bin/agentv* "$ROOT"/install/tv "$ROOT"/system "$ROOT"/session "$ROOT"/migrations/agentv "$ROOT"/daemon 2>/dev/null; then
  fail "nothing of AgenTV's writes Chromium's system-wide policies"
fi
pass "the Chromium on Omarchy's desktop keeps its prompts"
