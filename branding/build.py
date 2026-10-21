#!/usr/bin/env python3
"""Builds the AgenTV logo files from one set of glyphs.

The letterforms follow Omarchy's logo.txt: three-cell stems, rounded corners,
the notch where a crossbar meets a stem. The "a" is Omarchy's own. Each text
cell is one column wide and two half-rows tall; the SVG and PNG draw every
half-row as one square, so all outputs come from the same bitmap.

Run: python3 branding/build.py  (stdlib only; writes next to this file)
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

# Ten rows like Omarchy's logo: row 0 holds ascenders, rows 1-8 the letters.
GLYPHS = {
    'a': [
        '          ',
        '  ▄███████',
        ' ███   ███',
        ' ███   ███',
        '▄███▄▄▄███',
        '▀███▀▀▀███',
        ' ███   ███',
        ' ███   ███',
        ' ███   █▀ ',
        '          ',
    ],
    'g': [  # bowl, then a hook below the line, like the descender on Omarchy's "r"
        '         ',
        ' ▄█████▄ ',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        ' ▀███████',
        '▄▄▄   ███',
        '▀██████▀ ',
    ],
    'e': [
        '         ',
        ' ▄█████▄ ',
        '███   ███',
        '███   ███',
        '███▄▄▄███',
        '███▀▀▀▀▀ ',
        '███   █▄ ',
        '███   ███',
        ' ▀█████▀ ',
        '         ',
    ],
    'n': [
        '         ',
        ' ▄█████▄ ',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        ' ▀█   █▀ ',
        '         ',
    ],
    't': [
        ' ▄▄▄      ',
        '▄███▄▄▄▄▄ ',
        '▀███▀▀▀▀▀ ',
        ' ███      ',
        ' ███      ',
        ' ███      ',
        ' ███   █▄ ',
        ' ███   ███',
        '  ▀█████▀ ',
        '          ',
    ],
    'v': [
        '         ',
        ' ▄█   █▄ ',
        '███   ███',
        '███   ███',
        '███   ███',
        '███   ███',
        '▀██▄ ▄██▀',
        ' ▀██▄██▀ ',
        '   ▀█▀   ',
        '         ',
    ],
}

WORD = 'agentv'
ACCENT_FROM = 4          # "tv" is drawn in the accent colour
GAP = 2                  # blank columns between letters
WIDTH = 81               # the installer dashboard takes its width from logo.txt
TAGLINE = 'powered by omarchy'

DARK = {'ink': '#c0caf5', 'accent': '#7aa2f7'}    # Tokyo Night, for dark backgrounds
LIGHT = {'ink': '#1a1b26', 'accent': '#2e7de9'}   # Tokyo Night Day, for light backgrounds


def wordmark():
    """Rows of text plus a parallel grid saying which letter owns each column."""
    rows = [''] * 10
    owner = []
    for i, ch in enumerate(WORD):
        g = GLYPHS[ch]
        w = len(g[0])
        assert all(len(r) == w for r in g), ch
        for r in range(10):
            rows[r] += g[r] + (' ' * GAP if i < len(WORD) - 1 else '')
        owner += [i] * w + ([i] * GAP if i < len(WORD) - 1 else [])
    return rows, owner


def logo_txt(rows):
    w = len(rows[0])
    left = (WIDTH - w) // 2
    out = [(' ' * left + r).ljust(WIDTH) for r in rows]
    # The descender row also carries the credit, right-aligned under the wordmark.
    end = left + w
    start = end - len(TAGLINE)
    assert out[9][start:end].strip() == '', 'tagline would cover a descender'
    out[9] = out[9][:start] + TAGLINE + out[9][end:]
    assert all(len(r) == WIDTH for r in out)
    return '\n'.join(out) + '\n'


def bitmap(rows, owner):
    """Half-row pixels: (x, y) -> letter index, y counts half-rows."""
    px = {}
    for r, line in enumerate(rows):
        for x, c in enumerate(line):
            top = c in '█▀'
            bottom = c in '█▄'
            if top:
                px[(x, 2 * r)] = owner[x]
            if bottom:
                px[(x, 2 * r + 1)] = owner[x]
    return px


def crop(px):
    xs = [x for x, _ in px]
    ys = [y for _, y in px]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def svg(px, colours, unit=15):
    x0, y0, x1, y1 = crop(px)
    parts = {'ink': [], 'accent': []}
    for (x, y), i in sorted(px.items(), key=lambda k: (k[0][1], k[0][0])):
        key = 'accent' if i >= ACCENT_FROM else 'ink'
        parts[key].append(f'M{(x - x0) * unit} {(y - y0) * unit}h{unit}v{unit}h-{unit}z')
    w, h = (x1 - x0) * unit, (y1 - y0) * unit
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
        f'role="img" aria-label="AgenTV">'
        f'<path fill="{colours["ink"]}" d="{"".join(parts["ink"])}"/>'
        f'<path fill="{colours["accent"]}" d="{"".join(parts["accent"])}"/></svg>\n'
    )


def png(px, colours, scale, pad=0, background=None):
    x0, y0, x1, y1 = crop(px)
    w = (x1 - x0) * scale + 2 * pad
    h = (y1 - y0) * scale + 2 * pad

    def rgba(hexstr, a=255):
        hexstr = hexstr.lstrip('#')
        return bytes(int(hexstr[i:i + 2], 16) for i in (0, 2, 4)) + bytes([a])

    ink, accent = rgba(colours['ink']), rgba(colours['accent'])
    bg = rgba(background) if background else bytes(4)
    raw = bytearray()
    for py in range(h):
        raw.append(0)
        gy = (py - pad) // scale + y0 if py >= pad else None
        for pxl in range(w):
            gx = (pxl - pad) // scale + x0 if pxl >= pad else None
            i = px.get((gx, gy)) if gx is not None and gy is not None else None
            raw += bg if i is None else (accent if i >= ACCENT_FROM else ink)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def main():
    rows, owner = wordmark()
    px = bitmap(rows, owner)
    files = {
        'logo.txt': logo_txt(rows).encode(),
        'logo.svg': svg(px, DARK).encode(),
        'logo-light.svg': svg(px, LIGHT).encode(),
        # Boot splash: same size class as Omarchy's 800 x 188 plymouth logo.
        'plymouth-logo.png': png(px, DARK, scale=12),
    }
    for name, data in files.items():
        with open(os.path.join(HERE, name), 'wb') as f:
            f.write(data)
    print('\n'.join(r.rstrip() for r in logo_txt(rows).split('\n')))
    x0, y0, x1, y1 = crop(px)
    print(f'wordmark {len(rows[0])} cols; bitmap {x1 - x0} x {y1 - y0} half-cells')


if __name__ == '__main__':
    main()
