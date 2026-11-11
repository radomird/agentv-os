# The TV ships with no voice of its own now. A TV from before still has the
# old one, Piper in the agentv-voice package. It's taken off once nothing
# asks for it any more, so the TV's answers show without being said, as on a
# new install. An AI's own voice still speaks where a key has one.
if pacman -Q agentv-voice >/dev/null 2>&1 &&
  ! pacman -Qi agentv 2>/dev/null | sed -n '/^Depends On/,/^Optional Deps/p' | grep -qw agentv-voice; then
  sudo pacman -Rns --noconfirm agentv-voice || true
fi
