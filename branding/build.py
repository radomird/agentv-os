#!/usr/bin/env python3
"""Builds origaiTV's pixel logo files from one bitmap.

The bitmap is Terminal's logo from branding/origaitv/: the folded play button
and "origaitv" in pixels, with "tv" in the accent colour. Every file here is
drawn from it, so they all match:

- logo.txt and logo.ansi, the wordmark in text for the USB stick's installer,
  Omarchy's About and screensaver, and fastfetch. Each text cell is one
  column wide and two pixels tall, drawn with half blocks.
- logo.svg and logo-light.svg, the play button and the wordmark on a clear
  background, for the READMEs.
- plymouth-logo.png, the boot splash.
- companion-web/icon-*.png, the play button alone, for the phone's page.
- launcher/origaitv-logo.ts, each look's logo for Settings, System, About:
  Terminal's from the bitmap, Glass's and Cinema's from branding/origaitv/.

Run: python3 branding/build.py  (stdlib only)
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# One character a pixel. "#" is the ink, "A" the accent, "m" the play
# button's top half and "d" its fold.
BITMAP = [
    '                                           ###                         ###                       ',
    '                                           ###                         ###                       ',
    '                                                                             AAA                 ',
    'mm                     #####      #####    ###    #####       #######  ###   AAA          A   A  ',
    'mmmm                  #######    #######   ###   #######     ########  ###  AAAAAAAAA    AA   AA ',
    'mmmmmm               ###   ###  ###   ###  ###  ###   ###   ###   ###  ###  AAAAAAAAA   AAA   AAA',
    'mmmmmmmm             ###   ###  ###   ###  ###  ###   ###   ###   ###  ###   AAA        AAA   AAA',
    'mmmmmmmmmm           ###   ###  ###   ##   ###  ###   ###   ###   ###  ###   AAA        AAA   AAA',
    'mmmmmmmmmmmm         ###   ###  ###   #    ###  ###   ###   ###   ###  ###   AAA        AAA   AAA',
    'mmmmmmmmmmmmmm       ###   ###  ###        ###  ###   ###   ###   ###  ###   AAA        AAA   AAA',
    'ddddddddAAAAAAA      ###   ###  ###        ###  ###   ###  ##########  ###   AAA        AAA   AAA',
    'ddddddAAAAAAAA       ###   ###  ###        ###  ###   ###  ##########  ###   AAA        AAA   AAA',
    'ddddAAAAAAAA         ###   ###  ###        ###  ###   ###   ###   ###  ###   AAA        AAA   AAA',
    'dddAAAAAAA           ###   ###  ###        ###  ###   ###   ###   ###  ###   AAA   A    AAA   AAA',
    'dAAAAAAA             ###   ###  ###        ###  ###   ###   ###   ###  ###   AAA   AA    AAA AAA ',
    'AAAAAA               ###   ###  ###        ###   ########   ###   ###  ###   AAA   AAA   AAA AAA ',
    'AAAA                 ###   ###  ###        ###    #######   ###   ###  ###   AAA   AAA    AAAAA  ',
    'AA                    #######    ##         ##        ###   ###   ##    ##    AAAAAAA      AAA   ',
    '                       #####      #          #  ###   ###   ###   #      #     AAAAA        A    ',
    '                                                ########                                         ',
    '                                                 ######                                          ',
]
MARK_COLUMNS = 15        # the play button is the first 15 columns
WORD_FROM = 21           # the wordmark starts here
WIDTH = 81               # the installer's dashboard takes its width from logo.txt
TAGLINE = 'powered by omarchy'

# Tokyo Night, and Tokyo Night Day for light backgrounds.
DARK = {'#': '#c0caf5', 'A': '#7aa2f7', 'm': '#c0caf5', 'd': '#3d59a1'}
LIGHT = {'#': '#343b58', 'A': '#2e7de9', 'm': '#8fb2f9', 'd': '#1f4fa8'}
BACKGROUND = '#1a1b26'


def pixels(first=0, last=None):
    """(x, y) -> colour key, for the columns first..last of the bitmap."""
    width = max(len(row) for row in BITMAP)
    last = width if last is None else last
    return {
        (x - first, y): ch
        for y, row in enumerate(BITMAP)
        for x, ch in enumerate(row.ljust(width))
        if first <= x < last and ch != ' '
    }


def crop(px):
    xs = [x for x, _ in px]
    ys = [y for _, y in px]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def text_rows(px):
    """The pixels as half blocks: two pixel rows to a line of text."""
    x0, y0, x1, y1 = crop(px)
    lines = []
    for y in range(y0, y1, 2):
        line = ''
        for x in range(x0, x1):
            top, bottom = (x, y) in px, (x, y + 1) in px
            line += '█' if top and bottom else '▀' if top else '▄' if bottom else ' '
        lines.append(line)
    return lines, x0, y0


def logo_txt(px):
    lines, _, _ = text_rows(px)
    w = len(lines[0])
    left = (WIDTH - w) // 2
    out = [(' ' * left + r).ljust(WIDTH) for r in lines]
    # The last line also carries the credit, right-aligned under the wordmark.
    end = left + w
    start = end - len(TAGLINE)
    assert out[-1][start:end].strip() == '', 'the credit would cover a descender'
    out[-1] = out[-1][:start] + TAGLINE + out[-1][end:]
    assert all(len(r) == WIDTH for r in out)
    return '\n'.join(out) + '\n'


def logo_ansi(px):
    """logo.txt in colour for the installer's console: the same 81 columns,
    "origai" in the ink colour, "tv" in the accent and the credit in grey, as
    indexed ANSI colours. The live console maps them to Tokyo Night (97 is
    #c0caf5, 34 is #7aa2f7, 37 is #a9b1d6), and renders indexed colours true
    where truecolour comes out muddy."""
    lines, x0, y0 = text_rows(px)
    text = logo_txt(px).split('\n')[:-1]
    left = (WIDTH - len(lines[0])) // 2
    ink, accent, credit = '\033[97m', '\033[34m', '\033[37m'
    out = []
    for row, line in enumerate(text):
        coloured, current = '', None
        for col, ch in enumerate(line):
            if ch == ' ':
                coloured += ch
                continue
            x, y = col - left + x0, 2 * row + y0
            key = px.get((x, y)) or px.get((x, y + 1))
            colour = credit if ch.isalpha() else accent if key == 'A' else ink
            if colour != current:
                coloured += colour
                current = colour
            coloured += ch
        out.append(coloured + '\033[0m')
    return '\n'.join(out) + '\n'


def svg(px, colours, unit=15):
    x0, y0, x1, y1 = crop(px)
    parts = {}
    for (x, y), key in sorted(px.items(), key=lambda k: (k[0][1], k[0][0])):
        parts.setdefault(colours[key], []).append(f'M{(x - x0) * unit} {(y - y0) * unit}h{unit}v{unit}h-{unit}z')
    w, h = (x1 - x0) * unit, (y1 - y0) * unit
    paths = ''.join(f'<path fill="{fill}" d="{"".join(d)}"/>' for fill, d in parts.items())
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
        f'role="img" aria-label="origaiTV">{paths}</svg>\n'
    )


def png(px, colours, scale, size=None, background=None):
    """An RGBA PNG of the pixels, centred on a square of size pixels when one
    is given, on the background colour or clear."""
    x0, y0, x1, y1 = crop(px)
    art_w, art_h = (x1 - x0) * scale, (y1 - y0) * scale
    w, h = (size, size) if size else (art_w, art_h)
    left, top = (w - art_w) // 2, (h - art_h) // 2

    def rgba(hexstr, a=255):
        hexstr = hexstr.lstrip('#')
        return bytes(int(hexstr[i:i + 2], 16) for i in (0, 2, 4)) + bytes([a])

    fills = {key: rgba(colour) for key, colour in colours.items()}
    bg = rgba(background) if background else bytes(4)
    raw = bytearray()
    for py in range(h):
        raw.append(0)
        gy = (py - top) // scale + y0 if py >= top else None
        for pxl in range(w):
            gx = (pxl - left) // scale + x0 if pxl >= left else None
            key = px.get((gx, gy)) if gx is not None and gy is not None else None
            raw += bg if key is None else fills[key]

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def clear(svg_text):
    """A logo file from branding/origaitv/ without its background, so it sits
    on whatever the theme draws behind it."""
    import re
    w, h = re.search(r'viewBox="0 0 (\S+) (\S+)"', svg_text).groups()
    background = f'<rect width="{w}" height="{h}" fill="'
    start = svg_text.index(background)
    return svg_text[:start] + svg_text[svg_text.index('/>', start) + 2:]


def launcher_logos(whole):
    """launcher/origaitv-logo.ts: each look's logo, dark and light, as data
    URIs, for Settings, System, About. Terminal's comes from the bitmap here,
    Glass's and Cinema's from branding/origaitv/."""
    import base64

    def uri(text):
        return 'data:image/svg+xml;base64,' + base64.b64encode(text.encode()).decode()

    def drawn(look, tone):
        with open(os.path.join(HERE, 'origaitv', f'origaitv-{look}-{tone}.svg')) as f:
            return clear(f.read())

    logos = {
        'terminal': {'dark': svg(whole, DARK), 'light': svg(whole, LIGHT)},
        'glass': {'dark': drawn('glass', 'dark'), 'light': drawn('glass', 'light')},
        'cinema': {'dark': drawn('cinema', 'dark'), 'light': drawn('cinema', 'light')},
    }
    lines = [
        "// origaiTV's logo in each look, dark and light, on a clear background,",
        '// for Settings, System, About. branding/build.py writes this file from',
        "// branding/origaitv/, so change those and run it again, not this.",
        '',
        'export const LOGOS = {',
    ]
    for look, tones in logos.items():
        lines.append(f'  {look}: {{')
        for tone, text in tones.items():
            lines.append(f'    {tone}: "{uri(text)}",')
        lines.append('  },')
    lines += [
        '} as const;',
        '',
        "// The logo for a look, on a light background or a dark one. A look it",
        "// doesn't know gets Terminal's.",
        'export function logoFor(look: string | null, light: boolean): string {',
        '  const tones = LOGOS[(look ?? "terminal") as keyof typeof LOGOS] ?? LOGOS.terminal;',
        '  return light ? tones.light : tones.dark;',
        '}',
        '',
    ]
    return '\n'.join(lines)


def main():
    whole = pixels()
    word = pixels(WORD_FROM)
    mark = pixels(0, MARK_COLUMNS)
    files = {
        os.path.join(HERE, 'logo.txt'): logo_txt(word).encode(),
        os.path.join(HERE, 'logo.ansi'): logo_ansi(word).encode(),
        os.path.join(HERE, 'logo.svg'): svg(whole, DARK).encode(),
        os.path.join(HERE, 'logo-light.svg'): svg(whole, LIGHT).encode(),
        # The boot splash: the size of Omarchy's 800 x 188 Plymouth logo.
        os.path.join(HERE, 'plymouth-logo.png'): png(whole, DARK, scale=8),
    }
    # The phone's page: the play button on the dark background, small enough
    # to sit inside a maskable icon's safe zone.
    for size, scale in ((180, 7), (192, 7), (512, 20)):
        files[os.path.join(ROOT, 'companion-web', f'icon-{size}.png')] = png(mark, DARK, scale, size, BACKGROUND)
    files[os.path.join(ROOT, 'launcher', 'origaitv-logo.ts')] = launcher_logos(whole).encode()
    for name, data in files.items():
        with open(name, 'wb') as f:
            f.write(data)
    print('\n'.join(r.rstrip() for r in logo_txt(word).split('\n')))
    x0, y0, x1, y1 = crop(whole)
    print(f'logo {x1 - x0} x {y1 - y0} pixels; wordmark {len(text_rows(word)[0][0])} columns of text')


if __name__ == '__main__':
    main()
