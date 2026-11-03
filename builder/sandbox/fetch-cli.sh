#!/bin/bash

# The provider's CLI in the builder's own home (ADR-040, ADR-047), fetched
# with mise the way Omarchy's omarchy-default-agent fetches it for the
# person, and linked as ~/.local/bin/<cli>, where the builder runs it from.
# Its first run is here too: grok unpacks its binary and muse's launcher
# downloads its own, so a build doesn't wait on either.
# agentv-builder-cli@.service runs this as agentv-builder.
#
# Usage: fetch-cli.sh <claude|codex|gemini|grok|muse>

set -euo pipefail

cli=${1:-}
case "$cli" in
  claude | codex | gemini) package=$cli ;;
  grok) package="npm:@xai-official/grok" ;;
  muse) package="http:muse[url=https://api.meta.ai/muse-launcher.sh,bin=muse,version_list_url=https://api.meta.ai/muse-code/channels/muse-stable,version_json_path=.version]" ;;
  *)
    echo "Usage: fetch-cli.sh <claude|codex|gemini|grok|muse>" >&2
    exit 2
    ;;
esac

mise use -g "$package"
mkdir -p "$HOME/.local/bin"
ln -sfn "$(mise which "$cli")" "$HOME/.local/bin/$cli"
GROK_HOME="$HOME/.grok" "$HOME/.local/bin/$cli" --version
