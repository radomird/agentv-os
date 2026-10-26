# Museum archive replies

What the art picker's tests (`test/agentv/unit/art.test.mts`, `test/agentv/ui/setup.test.mts`) serve in place of each archive's API, through `test/agentv/ui/archives.mts`, with the pictures' addresses pointed at the test's own server.

- `met-search.json`, `aic-search.json`, `commons-search.json` and the `met-object-*.json` for the works The Met's search lists are the archives' own replies, recorded by `test/agentv/fixtures/record/art` from GitHub's runners (`recorded.txt` says when). To record them again, push a branch named `record/art`: the Record fixtures workflow pushes fresh ones back to it.
- `met-object-267004.json` was recorded by hand from the same API on 2026-10-26. The Met's search can list works that aren't public domain even with `isPublicDomain=true`, as it did for "sea" that day, and this is one of them, so the tests can show it's left out.
- `sea.jpg`, `lilies.jpg` and `harbour.jpg` are made with ImageMagick for these tests, not any archive's pictures.

What the recordings showed: Commons keeps its thumbnails on `thumb.wikimedia.org` and its originals on `upload.wikimedia.org`, adds `utm_` tracking to both addresses, and writes when a photo was taken as "Taken on 30 January 2010".
