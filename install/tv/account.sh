# The account the USB stick's first screen makes, agentv, has a random
# password nobody knows, and the install leaves a note saying so. The phone
# sets a real password later. Until it does, SSH takes keys only, so there's
# no password to try and guess. A box installed through Omarchy's own
# installer, with a password someone typed, has no note and is left alone.
# Whatever sets the real password removes the file below and marks the note.
marker=${AGENTV_ACCOUNT_MARKER:-/var/lib/agentv/account.json}
no_password=${AGENTV_SSHD_NO_PASSWORD:-/etc/ssh/sshd_config.d/05-agentv-no-password.conf}

if [[ -f $marker ]] && [[ $(jq -r '.passwordKnown' "$marker" 2>/dev/null) == "false" ]]; then
  install -d -m 755 "$(dirname "$no_password")"
  cat >"$no_password" <<'CONF'
# AgenTV: nobody knows this box's password until the phone sets one, so
# until then SSH takes keys only (install/tv/account.sh).
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
  chmod 644 "$no_password"
  echo "agentv: nobody knows the account's password yet, so SSH takes keys only"
else
  rm -f "$no_password"
fi
