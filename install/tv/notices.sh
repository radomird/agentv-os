# Omarchy's first run invites the owner to pick a default agent, to install
# Voxtype dictation and to set up a fingerprint reader, as notifications that
# come back after updates until they've been shown once. On a TV the AI
# provider is TV setup's question and voice comes from the phone (ADR-022,
# ADR-023, ADR-029), so they're marked as already offered, with the same
# markers Omarchy sets itself when it shows them.
for invitation in agent-setup-invitation voxtype-install-invitation fingerprint-setup-invitation; do
  runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" omarchy-done ensure "$invitation" || true
done
