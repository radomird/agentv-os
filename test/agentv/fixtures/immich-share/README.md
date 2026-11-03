# Immich shared link test data

This is what the Immich album background's tests use (`test/agentv/unit/immich-album.test.mts` and `test/agentv/ui/setup.test.mts`): what an album's shared link answers. `test/agentv/ui/immich-share.mts` serves it.

The `*.json` replies and `preview.jpeg` come from Immich's own server. `test/agentv/fixtures/record/immich-share` recorded them in CI from Immich's official container images, and `recording.json` says which release and when.

The server was a throwaway one with three test-pattern photos made with ffmpeg just for this, so they're free to share under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Two of them are in an album, "Autumn", shared with a link. Every request used the link alone, with no account. The link's key is swapped for `fixture-key`, and the ids Immich made up for plain numbers.

- `shared-link.json`: the link. It names its album but lists none of its photos.
- `album.json`: the album by its id, with the link's key. This one lists them.
- `preview.json` and `preview.jpeg`: a photo's preview.
- `not-shared.json`: a photo that isn't in the album, refused.
- `wrong-key.json`: a key Immich doesn't know, refused.

To record new replies, push a branch called `record/immich-share`. The Record fixtures workflow pushes fresh ones back to it.
