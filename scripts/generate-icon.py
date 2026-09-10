#!/usr/bin/env python3
"""Generate MPI app icon assets from the master artwork.

Source: resources/umbrella.jpg — black umbrella "WW" line art on white,
provided by the maintainer (v0.5.x rebrand). The script crops the artwork to
its bounding box, cleans JPEG noise near the edges, and composites it onto a
white squircle tile so the icon stays readable in both light and dark themes:

  * resources/icon.png   1024px master, transparent outside the squircle
  * resources/icon.ico   multi-size Windows icon (16..256)
  * resources/icon.icns  macOS icon set

The tile geometry matches the previous bamboo-copter icon exactly (963px
squircle at offset 30, corner radius ~182), so the on-screen footprint in the
taskbar / title bar does not change.

Usage: python scripts/generate-icon.py
"""
import os
from PIL import Image, ImageDraw
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, "..", "resources"))
SRC = os.path.join(RES, "umbrella.jpg")

# Tile geometry (measured from the previous icon.png).
TILE_L, TILE_T, TILE_R, TILE_B = 30, 30, 992, 992
CORNER_RADIUS = 182
CANVAS = 1024
# Artwork occupies this fraction of the tile height.
ART_FRACTION = 0.78


def load_art() -> Image.Image:
    """Crop the artwork to its bounding box and whiten JPEG noise."""
    im = Image.open(SRC).convert("RGB")
    a = np.array(im)
    # Near-white pixels (JPEG ringing around the black strokes) → pure white.
    light = a.min(axis=2) > 235
    a[light] = [255, 255, 255]
    im = Image.fromarray(a)
    nw = ~((a[:, :, 0] > 248) & (a[:, :, 1] > 248) & (a[:, :, 2] > 248))
    ys, xs = np.where(nw)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return im.crop(box)


def build_tile() -> Image.Image:
    """2x-supersampled white squircle on a transparent canvas."""
    s2 = CANVAS * 2
    mask = Image.new("L", (s2, s2), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle(
        [TILE_L * 2 - 2, TILE_T * 2 - 2, TILE_R * 2 + 2, TILE_B * 2 + 2],
        radius=CORNER_RADIUS * 2,
        fill=255,
    )
    mask = mask.resize((CANVAS, CANVAS), Image.LANCZOS)
    tile = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 0))
    tile.putalpha(mask)
    return tile


def save_ico(master: Image.Image, path: str) -> None:
    master.save(path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def save_icns(master: Image.Image, path: str) -> None:
    try:
        master.save(path, format="ICNS", sizes=[(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    except Exception as e:  # macOS icon is a nice-to-have; don't fail the build.
        print(f"warning: ICNS generation skipped ({e})")


def main() -> None:
    art = load_art()
    tile_h = TILE_B - TILE_T + 1
    scale = (tile_h * ART_FRACTION) / art.height
    new_w, new_h = round(art.width * scale), round(art.height * scale)
    art = art.resize((new_w, new_h), Image.LANCZOS)

    master = build_tile()
    # The artwork is black-on-white; pasting it straight onto the white tile
    # lets its background merge seamlessly with the tile.
    x = (CANVAS - new_w) // 2
    y = (CANVAS - new_h) // 2
    master.paste(art, (x, y))

    png_path = os.path.join(RES, "icon.png")
    ico_path = os.path.join(RES, "icon.ico")
    icns_path = os.path.join(RES, "icon.icns")
    master.save(png_path, format="PNG")
    save_ico(master, ico_path)
    save_icns(master, icns_path)

    print(f"artwork {art.width}x{art.height} at ({x},{y}) on {CANVAS}px canvas")
    print(f"wrote: {png_path}")
    print(f"wrote: {ico_path}")
    print(f"wrote: {icns_path}")


if __name__ == "__main__":
    main()
