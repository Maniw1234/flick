#!/usr/bin/env python3
"""Makes the Google Play listing's graphics (see listing.md): icon-512.png, feature-graphic.png and screenshots/.

usage: python play/make_graphics.py   (Pillow; the fonts are the phone app's Inter)

Screenshots: each phone screenshot in play/raw/ (1080 x 2400, as `adb exec-out screencap -p` takes them) becomes
1080 x 2160 in play/screenshots/: Play takes no screenshot more than twice as tall as it is wide.
"""
import os
import shutil
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = os.path.join(ROOT, 'phone', 'fonts', 'InterVariable.woff2')


def font(size, weight):
    f = ImageFont.truetype(FONT, size)
    # (its axes: optical size, then weight)
    f.set_variation_by_axes([32 if size >= 60 else 14, weight])
    return f


def icon():
    shutil.copyfile(os.path.join(ROOT, 'art', 'icon-512.png'), os.path.join(HERE, 'icon-512.png'))


def feature():
    W, H = 1024, 500
    img = Image.new('RGB', (W, H), (0, 0, 0))
    # the Connect screen's glow: warm orange from the right edge into black
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    px = glow.load()
    for x in range(W):
        for y in range(H):
            dx = (W + 120 - x) / W
            dy = abs(y - H / 2) / H
            t = max(0.0, 1.0 - (dx * dx * 1.6 + dy * dy * 1.2))
            px[x, y] = (int(255 * t * 0.85), int(110 * t * 0.85), int(30 * t * 0.6))
    img = Image.blend(img, glow, 1.0)
    ic = Image.open(os.path.join(ROOT, 'art', 'icon-512.png')).convert('RGBA').resize((230, 230), Image.LANCZOS)
    img.paste(ic, (80, (H - 230) // 2), ic)
    d = ImageDraw.Draw(img)
    d.text((350, 150), 'Flick', font=font(118, 750), fill=(255, 255, 255))
    d.text((356, 300), 'Phone to PC with a flick.', font=font(38, 550), fill=(235, 235, 240))
    d.text((356, 352), 'Fast, private, no cables.', font=font(38, 550), fill=(170, 170, 178))
    img.save(os.path.join(HERE, 'feature-graphic.png'))


def screenshots():
    src, out = os.path.join(HERE, 'raw'), os.path.join(HERE, 'screenshots')
    os.makedirs(out, exist_ok=True)
    for n in sorted(os.listdir(src)):
        if not n.lower().endswith('.png'):
            continue
        s = Image.open(os.path.join(src, n)).convert('RGB')
        # scaled to 2160 tall and centred on black (the app's own background): nothing of the screen is cut off
        w = round(s.width * 2160 / s.height)
        s = s.resize((w, 2160), Image.LANCZOS)
        c = Image.new('RGB', (1080, 2160), (0, 0, 0))
        c.paste(s, ((1080 - w) // 2, 0))
        c.save(os.path.join(out, n))


if __name__ == '__main__':
    icon()
    feature()
    screenshots()
    print('play/: icon-512.png, feature-graphic.png, screenshots/')
