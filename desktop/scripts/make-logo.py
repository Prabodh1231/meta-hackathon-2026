"""Draw the Groundwork logo: a page with a quotation mark, standing on ground, in a green rounded
square. Writes the SVG the app shows and the PNG/ICO icons electron-builder and the window use.

    backend/.venv/Scripts/python desktop/scripts/make-logo.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

GREEN, CREAM = "#0b5240", "#fbf6ea"
DESKTOP = Path(__file__).resolve().parents[1]


def bezier(p0, p1, p2, p3, n=24):
    return [
        tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t**2 * c + t**3 * d for a, b, c, d in zip(p0, p1, p2, p3))
        for t in (i / n for i in range(1, n + 1))
    ]


def quote_mark(x):
    """One '6'-shaped mark: a square block with a curled tail, in a 100-unit box."""
    pts = [(x, 62), (x, 53)]
    pts += bezier((x, 53), (x, 46.5), (x + 3.5, 42.5), (x + 9.5, 41.5))
    pts += [(x + 10.5, 45.5)]
    pts += bezier((x + 10.5, 45.5), (x + 7, 46.5), (x + 5, 48.5), (x + 5, 52))
    pts += [(x + 10, 52), (x + 10, 62)]
    return pts


PAGE = [(29, 17), (58, 17), (58, 31), (72, 31), (72, 74), (29, 74)]
FOLD = [(61.5, 17), (72, 27.5), (61.5, 27.5)]
GROUND = [(27, 78.5), (74, 78.5), (79, 86), (22, 86)]
CREAM_SHAPES = [PAGE, FOLD, GROUND]
GREEN_SHAPES = [quote_mark(37.5), quote_mark(52)]
RADIUS = 22


def svg() -> str:
    def poly(pts, fill):
        return f'<polygon fill="{fill}" stroke="{fill}" stroke-width="1.2" stroke-linejoin="round" points="' + " ".join(f"{x:.2f},{y:.2f}" for x, y in pts) + '"/>'

    shapes = [poly(p, CREAM) for p in CREAM_SHAPES] + [poly(p, GREEN) for p in GREEN_SHAPES]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<rect width="100" height="100" rx="{RADIUS}" fill="{GREEN}"/>' + "".join(shapes) + "</svg>\n"
    )


def png(size: int) -> Image.Image:
    big = size * 4  # draw large, then downsample for smooth edges
    s = big / 100
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=RADIUS * s, fill=GREEN)
    for shapes, fill in ((CREAM_SHAPES, CREAM), (GREEN_SHAPES, GREEN)):
        for pts in shapes:
            d.polygon([(x * s, y * s) for x, y in pts], fill=fill)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    (DESKTOP / "src" / "assets").mkdir(parents=True, exist_ok=True)
    (DESKTOP / "build").mkdir(exist_ok=True)
    (DESKTOP / "src" / "assets" / "logo.svg").write_text(svg(), encoding="utf-8")
    png(512).save(DESKTOP / "build" / "icon.png")
    png(256).save(DESKTOP / "build" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote src/assets/logo.svg, build/icon.png, build/icon.ico")
