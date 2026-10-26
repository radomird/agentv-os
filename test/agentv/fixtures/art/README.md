# Museum archive replies

What the art picker's tests (`test/agentv/unit/art.test.mts`) serve in place of each archive's API, with the pictures' addresses pointed at the test's own server.

- `met-search.json` and `met-object-*.json` are The Met's own replies, recorded on 2026-10-26 from `collectionapi.metmuseum.org` for "sea" (`/public/collection/v1.1/search?hasImages=true&isPublicDomain=true`) and three of its works, cut down to the fields AgenTV reads. The search lists works that aren't public domain even so (267004 here), which is why each work is checked again.
- `aic-search.json` and `commons-search.json` are written to the shapes the Art Institute of Chicago's and Wikimedia's API documentation give. Neither answered from the machine they were made on (a bot challenge and a rate limit), so they'll be replaced by recorded replies from the NUC. The works in them that aren't free to show (not public domain, "Fair use", an SVG) are there to be left out.
