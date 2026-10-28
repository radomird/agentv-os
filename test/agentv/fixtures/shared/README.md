# A shared video

`clip.webm` is six seconds of ffmpeg's own test picture and a 440 Hz tone, made with:

```
ffmpeg -f lavfi -i "testsrc=size=160x90:rate=15:duration=6" -f lavfi -i "sine=frequency=440:duration=6" \
  -c:v libvpx -b:v 40k -c:a libvorbis -b:a 32k -shortest clip.webm
```

The layer 4 check sends it from the phone and plays it in the TV's player (ADR-050, S5.10). It's WebM because every Chromium plays it.
