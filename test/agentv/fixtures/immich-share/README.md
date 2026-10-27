# An Immich album's shared link

What an album's shared link answers, for the Immich album background's tests (`test/agentv/unit/immich-album.test.mts`, `test/agentv/ui/setup.test.mts`), served by `test/agentv/ui/immich-share.mts`.

The `*.json` replies and `preview.jpeg` come from Immich's own server, recorded by `test/agentv/fixtures/record/immich-share` in CI from its official container images; `recording.json` says which release and when. The server was a throwaway one with three photos of a test pattern made with ffmpeg for this, so they're ours to give away, under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Two of them are in an album, "Autumn", shared with a link. Every request was made with the link alone, no account. The link's key is replaced with `fixture-key`, and the ids Immich made up with plain numbered ones.

- `shared-link.json`: the link, which names its album but lists none of its photos.
- `album.json`: the album by its id, with the link's key, which lists them.
- `preview.json` and `preview.jpeg`: a photo's preview.
- `not-shared.json`: a photo that isn't in the album, refused.
- `wrong-key.json`: a key Immich doesn't know, refused.

To record them again, push a branch named `record/immich-share`: the Record fixtures workflow pushes fresh ones back to it.
