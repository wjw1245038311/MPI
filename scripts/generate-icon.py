#!/usr/bin/env python3
"""Generate MPI app icon assets from the master artwork.

Source: resources/0.jpg — WJW bamboo-copter (竹蜻蜓) design on a light-blue
squircle with an "MPI" badge, provided by the maintainer. The source is a
PagePop template and carries its watermark in the bottom-right margin; this
script removes it and outputs:

  * resources/icon.png   1024px master, transparent outside the squircle
  * resources/icon.ico   multi-size Windows icon (16..256)
  * resources/icon.icns  macOS icon set

Usage: python scripts/generate-icon.py
"""
import os
from PIL import Image, ImageDraw
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, "..", "resources"))
SRC = os.path.join(RES, "0.jpg")

# Bottom-right margin box that contains the PagePop watermark. Pixels inside
# it are whitened unless they look like the blue tile (B channel clearly
# above R), so the artwork itself is never touched.
WM_BOX = (840, 935)


def load_clean() -> tuple[Image.Image, np.ndarray]:
    im = Image.open(SRC).convert("RGB")
    a = np.array(im)
    h, w, _ = a.shape
    x0, y0 = WM_BOX
    box = a[y0:h, x0:w].copy()
    not_blue = ~((box[:, :, 2].astype(int) > box[:, :, 0].astype(int) + 8))
    box[not_blue] = [255, 255, 255]
    a[y0:h, x0:w] = box
    return Image.fromarray(a), a


def tile_bbox(a: np.ndarray):
    """Bounding box of the squircle (non-white pixels)."""
    nw = ~((a[:, :, 0] > 248) & (a[:, :, 1] > 248) & (a[:, :, 2] > 248))
    rows = np.where(nw.any(axis=1))[0]
    cols = np.where(nw.any(axis=0))[0]
    return int(cols.min()), int(rows.min()), int(cols.max()), int(rows.max())


def corner_radius(a: np.ndarray, L: int, T: int, R: int, B: int) -> int:
    """Measure the rounded-corner radius at each corner (first row/col where
    the edge reaches the straight line) and return the median."""
    nw = ~((a[:, :, 0] > 248) & (a[:, :, 1] > 248) & (a[:, :, 2] > 248))

    def first_straight(fn, start, stop, step):
        for y in range(start, stop, step):
            xs = np.where(nw[y, :])[0]
            if len(xs) and fn(int(xs[0]), int(xs[-1])):
                return abs(y - (T if step > 0 else B))
        raise RuntimeError("corner arc not found")

    radii = [
        first_straight(lambda f, l: f <= L + 2, T, T + 500, 1),      # top-left
        first_straight(lambda f, l: l >= R - 2, T, T + 500, 1),      # top-right
        first_straight(lambda f, l: f <= L + 2, B, B - 500, -1),     # bottom-left
        first_straight(lambda f, l: l >= R - 2, B, B - 500, -1),     # bottom-right
    ]
    r = int(sorted(radii)[len(radii) // 2])
    if not 150 <= r <= 300:
        raise RuntimeError(f"implausible corner radius {r} (measured {radii})")
    return r


def build_mask(size: int, L: int, T: int, R: int, B: int, r: int) -> Image.Image:
    """2x-supersampled rounded-rect alpha mask so the squircle edge stays smooth."""
    s2 = size * 2
    mask = Image.new("L", (s2, s2), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([L * 2 - 2, T * 2 - 2, R * 2 + 2, B * 2 + 2], radius=r * 2, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def save_ico(master: Image.Image, path: str) -> None:
    master.save(path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def save_icns(master: Image.Image, path: str) -> None:
    try:
        master.save(path, format="ICNS", sizes=[(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    except Exception as e:  # macOS icon is a nice-to-have; don't fail the build.
        print(f"warning: ICNS generation skipped ({e})")


def main() -> None:
    im, a = load_clean()
    L, T, R, B = tile_bbox(a)
    r = corner_radius(a, L, T, R, B)
    size = im.width

    master = im.convert("RGBA")
    master.putalpha(build_mask(size, L, T, R, B, r))

    png_path = os.path.join(RES, "icon.png")
    ico_path = os.path.join(RES, "icon.ico")
    icns_path = os.path.join(RES, "icon.icns")
    master.save(png_path, format="PNG")
    save_ico(master, ico_path)
    save_icns(master, icns_path)

    print(f"tile bbox=({L},{T})-({R},{B}) radius={r}")
    print(f"wrote: {png_path}")
    print(f"wrote: {ico_path}")
    print(f"wrote: {icns_path}")


if __name__ == "__main__":
    main()
