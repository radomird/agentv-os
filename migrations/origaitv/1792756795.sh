# Omarchy's invitations to pick a default agent, install Voxtype dictation and
# set up a fingerprint reader don't belong on a TV (ADR-029). Boxes installed
# before 0.1.2 mark them as offered here; new ones do it at first boot
# (install/tv/notices.sh).
for invitation in agent-setup-invitation voxtype-install-invitation fingerprint-setup-invitation; do
  omarchy-done ensure "$invitation" || true
done
