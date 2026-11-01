#!/bin/bash

# Guards the TV's spoken answers (stage 8, Q146, Q152): the providers'
# voices asked as their docs say, the router's service speaking with the
# key and never logging the words, the provider's voice or Piper on the
# box, every answer said, "i didn't get that" too, and the TV session
# playing the clip.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/voice.test.mts"
