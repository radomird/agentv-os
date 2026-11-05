# Omarchy's first run invites the owner to pick a default agent and to set up
# a fingerprint reader (and, on 4.0.x, to install Voxtype dictation), as
# notifications that come back after updates until they've been shown once.
# On a TV the AI provider is TV setup's question and voice comes from the
# phone (ADR-022, ADR-023, ADR-029), so they're marked as already offered,
# with the same markers Omarchy sets itself when it shows them. Omarchy 4.5
# has no Voxtype invitation, so its marker does nothing there. The notices
# with no marker are bin/agentv-quiet-first-run's.
for invitation in agent-setup-invitation voxtype-install-invitation fingerprint-setup-invitation; do
  runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" omarchy-done ensure "$invitation" || true
done
