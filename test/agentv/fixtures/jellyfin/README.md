# Jellyfin fixtures

Replies from Jellyfin's own server, recorded by `test/agentv/fixtures/record/jellyfin` in CI from its official container image, for the Jellyfin app's contract tests (coming soon, in `agentv-app-jellyfin`). `recording.json` says which image and when.

The server was a throwaway one with a film and an episode of test pattern made with ffmpeg for this, so they're ours to give away, under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Its access token is replaced with `fixture-token`, and the ids it made up with plain numbered ones.

To record them again, push a branch named `record/jellyfin`: the Record fixtures workflow pushes fresh ones back to it.
