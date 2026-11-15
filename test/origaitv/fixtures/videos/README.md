# A theme's videos

The UI tests play these behind home, as an Omarchy theme's video background and its intro.

- `loop.webm` is one second of ffmpeg's own moving test picture, which home loops. `loop-still.jpg` is its first frame, as the TV session takes it for the still.
- `intro.webm` is a second and a half of a box sliding over the theme's blue, which home plays once. `intro-still.jpg` is its last frame, the picture it ends on.

They were made with:

```
ffmpeg -f lavfi -i "testsrc2=size=320x180:rate=24:duration=1" -c:v libvpx-vp9 -b:v 80k -pix_fmt yuv420p -an loop.webm
ffmpeg -f lavfi -i "color=c=0x7aa2f7:size=320x180:rate=24:duration=1.5,drawbox=x='t*120':y=60:w=60:h=60:color=white:t=fill" \
  -c:v libvpx-vp9 -b:v 60k -pix_fmt yuv420p -an intro.webm
ffmpeg -i loop.webm -frames:v 1 -q:v 3 loop-still.jpg
ffmpeg -sseof -0.05 -i intro.webm -frames:v 1 -q:v 3 intro-still.jpg
```

They're WebM with VP9 because every Chromium plays it.
