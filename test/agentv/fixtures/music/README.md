# Music test data

This is what the Music app's tests use: two short albums of tones and a playlist. `make` made them with ffmpeg just for this, so they're free to share under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

- `Test Tones`, by AgenTV (2026): MP3, FLAC and Ogg Vorbis, with `cover.jpg` next to them.
- `Night Shift`, by Pixel Band (2025): Opus, AAC with its cover inside, and WAV.
- `evening.m3u`: Dusk, then A.

Each track is two seconds long. To make them again, run `test/agentv/fixtures/music/make`.
