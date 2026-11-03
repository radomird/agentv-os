# Museum archive test data

This is what the art picker's tests use (`test/agentv/unit/art.test.mts` and `test/agentv/ui/setup.test.mts`). `test/agentv/ui/archives.mts` serves these files in place of each archive's API, with the pictures' addresses pointed at the test's own server.

`met-search.json`, `aic-search.json`, `commons-search.json`, and a `met-object-*.json` for each work The Met's search lists, are the archives' own replies. `test/agentv/fixtures/record/art` recorded them from GitHub's runners, and `recorded.txt` says when. To record them again, push a branch called `record/art`. The Record fixtures workflow pushes fresh ones back to it.

`met-object-267004.json` was recorded by hand from the same API on 2026-10-26. The Met's search can list works that aren't public domain, even with `isPublicDomain=true`. It did for "sea" that day, and this is one of them, so the tests can show it's left out.

`sea.jpg`, `lilies.jpg` and `harbour.jpg` aren't any archive's pictures. They're made with ImageMagick for these tests.

What the recordings showed: Commons keeps its thumbnails on `thumb.wikimedia.org` and its originals on `upload.wikimedia.org`. It adds `utm_` tracking to both addresses, and writes when a photo was taken as "Taken on 30 January 2010".
