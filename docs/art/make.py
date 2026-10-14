"""Draws the README's animated pixel scenes into docs/*.svg.

Run: python3 docs/art/make.py

Each scene is a small pixel grid with CSS keyframes inside the SVG, so it
animates on GitHub and on the site with no GIFs. Sprites and colours come from
site/scripts/sprites.py so both stay in one style.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "site" / "scripts"))
from sprites import CLOUD, FLAME_A, FLAME_B, PAL, hero, rects  # noqa: E402

OUT = ROOT / "docs"
PAL.update({"G": "#22C55E", "B": "#2B1A10", "X": "#EF4444"})
DUR = 7  # seconds per loop


def px(rows, x, y):
    return rects(rows, x, y)


class Scene:
    def __init__(self, key, w, h, title):
        self.key, self.w, self.h, self.title = key, w, h, title
        self.body, self.css, self.n = [], [], 0

    def _name(self):
        self.n += 1
        return f"{self.key}{self.n}"

    def add(self, svg, show=None, base=0.0, move=None):
        """show: [(start, end)] fractions of the loop when fully visible (else
        `base` opacity). move: [(t, dx, dy)] keyframes, stepped a pixel at a time."""
        anims = []
        if show:
            name = self._name()
            frames = {0.0: base}
            for a, b in show:
                frames[a] = 1
                if b < 1:
                    frames[b] = base
            if 1.0 not in frames:
                frames[1.0] = frames[max(frames)]
            body = "".join(f"{t * 100:.2f}%{{opacity:{v}}}" for t, v in sorted(frames.items()))
            self.css.append(f"@keyframes {name}{{{body}}}")
            anims.append(f"{name} {DUR}s step-end infinite")
        if move:
            name = self._name()
            frames = {}
            for (t0, x0, y0), (t1, x1, y1) in zip(move, move[1:]):
                steps = max(abs(x1 - x0), abs(y1 - y0), 1)
                for k in range(steps + 1):
                    f = k / steps
                    frames[t0 + (t1 - t0) * f] = (round(x0 + (x1 - x0) * f), round(y0 + (y1 - y0) * f))
            body = "".join(f"{t * 100:.2f}%{{transform:translate({x}px,{y}px)}}" for t, (x, y) in sorted(frames.items()))
            self.css.append(f"@keyframes {name}{{{body}}}")
            anims.append(f"{name} {DUR}s step-end infinite")
        style = f' style="animation:{",".join(anims)}"' if anims else ""
        op = f' opacity="{base}"' if show and base == 0 else ""
        self.body.append(f"<g{style}{op}>{svg}</g>")

    def dots(self, a, b, t0, t1, n=None, keep=0.0):
        """A dotted link from a to b; dots light up one after another from t0 to t1."""
        (x0, y0), (x1, y1) = a, b
        n = n or max(3, max(abs(x1 - x0), abs(y1 - y0)) // 3)
        for k in range(1, n):
            f = k / n
            x, y = round(x0 + (x1 - x0) * f), round(y0 + (y1 - y0) * f)
            t = t0 + (t1 - t0) * k / n
            col = PAL["O"] if k % 2 else PAL["Y"]
            self.add(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{col}"/>',
                     show=[(t, min(t + 0.1 + keep, 1.0))], base=0.25)

    def svg(self):
        css = "".join(self.css) + "@media (prefers-reduced-motion:reduce){g{animation:none!important}}"
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
                f'width="{self.w * 6}" height="{self.h * 6}" shape-rendering="crispEdges" role="img">'
                f"<title>{self.title}</title><style>{css}</style>"
                f'<rect width="{self.w}" height="{self.h}" fill="#FFFAF1"/>'
                + "".join(self.body) + "</svg>\n")


# Sprites ---------------------------------------------------------------------

def phone(color="O", screen="c"):
    top = "." + color * 12 + "."
    rows = [top, color * 14] + [color + screen * 12 + color] * 15 + [color * 14, color * 5 + "ww" + color * 7, top]
    return rows


PHONE = phone()
ANDROID = phone("G", "c")
BROWSER = ["B" * 24, "B" + "O" * 3 + "Y" * 3 + "B" * 17, "B" * 24] + ["B" + "c" * 22 + "B"] * 5 + ["B" * 24]
CHIP = [".I.I.I.I.I.", "DDDDDDDDDDD", "IDOOOOOOODI", ".DOYYYYYOD.", "IDOYLLLYODI",
        ".DOYLLLYOD.", "IDOYYYYYODI", ".DOOOOOOOD.", "IDDDDDDDDDI", ".I.I.I.I.I."]
HOUSE = ["......RR......", ".....ROOR.....", "....ROOOOR....", "...ROOOOOOR...",
         "..ROOOOOOOOR..", ".ROOOOOOOOOOR.", "RRRRRRRRRRRRRR", ".PCCCCCCCCCCP.",
         ".PCCCCCCCCCCP.", ".PCCCRRRCCCCP.", ".PCCCRYRCCCCP.", ".PCCCRRRCCCCP.", ".PPPPPPPPPPPP."]
CHECK = ["....G", "...GG", "G.GG.", "GGG..", ".G..."]
SLASH = ["X.....", "XX....", ".XX...", "..XX..", "...XX.", "....XX", ".....X"]
Z = ["OOO", "..O", ".O.", "O..", "OOO"]
BOX_SLEEP = [".PPPPPPPPPP.", "PSSSSSSSSSSP", "PSSSSSSSSSSP", "PSSPPSSPPSSP", "PSSSSSSSSSSP",
             "PSSSSPPSSSSP", "PSSSSSSSSSSP", ".PPPPPPPPPP."]
BOX_AWAKE = [".OOOOOOOOOO.", "OccccccccccO", "OcccBcccBccO", "OcccBcccBccO", "OccccccccccO",
             "OccccBBccccO", "OccccccccccO", ".OOOOOOOOOO."]


def bar(color, w=8):
    return [color * w]


# Scenes ----------------------------------------------------------------------

def offline():
    s = Scene("offline", 96, 40, "A phone writes offline, then syncs when the network is back")
    s.add(px(PHONE, 10, 10))
    for i, t in enumerate([0.06, 0.16, 0.26]):  # writes land locally at once
        s.add(px(["gg." + "O" * 7], 12, 13 + i * 4), show=[(t, 1)])
    s.add(px(CLOUD, 58, 15))
    s.add(px(SLASH, 71, 17), show=[(0, 0.42)])
    s.dots((25, 20), (60, 20), 0.48, 0.72, keep=0.05)
    s.add(px(CHECK, 72, 18), show=[(0.76, 0.98)])
    return s


def spaces():
    s = Scene("spaces", 96, 40, "Phones join a shared space with an 8-letter invite code")
    s.add(px(HOUSE, 41, 6))
    for i in range(8):  # the invite code fills in
        s.add(px(["OOO", "OYO", "OOO"], 21 + i * 7, 32), show=[(0.05 + i * 0.05, 1)], base=0.2)
    s.add(px(PHONE, 4, 6))
    s.dots((19, 14), (40, 14), 0.5, 0.65, keep=0.3)
    s.add(px(PHONE, 78, 6), show=[(0.48, 0.98)], base=0.25)  # a new phone joins
    s.dots((77, 14), (56, 14), 0.66, 0.8, keep=0.15)
    return s


def merges():
    s = Scene("merges", 96, 40, "Two people edit at once; both edits survive the merge")
    doc = ["." + "P" * 18 + ".", "P" + "C" * 18 + "P"] + ["P" + "C" * 18 + "P"] * 9 + ["." + "P" * 18 + "."]
    for (x, y, row, t) in [(2, 3, 0, 0.12), (2, 23, 2, 0.24)]:
        s.add(px(doc, x, y))
        for r in range(3):
            s.add(px(bar("S", 12), x + 3, y + 3 + r * 3))
        s.add(px(bar("O" if row == 0 else "G", 12), x + 3, y + 3 + row * 3), show=[(t, 1)])
    s.dots((23, 9), (62, 18), 0.36, 0.56)
    s.dots((23, 29), (62, 22), 0.4, 0.6)
    s.add(px(doc, 64, 12))
    for r in range(3):
        s.add(px(bar("S", 12), 67, 15 + r * 3))
    s.add(px(bar("O", 12), 67, 15), show=[(0.62, 0.98)])
    s.add(px(bar("G", 12), 67, 21), show=[(0.66, 0.98)])
    s.add(px(CHECK, 86, 6), show=[(0.72, 0.98)])
    return s


def platforms():
    s = Scene("platforms", 96, 40, "One Rust core runs on iPhone, Android and the web")
    s.add(px(CHIP, 42, 15))
    s.add(px(PHONE, 4, 10))
    s.add(px(ANDROID, 78, 10))
    s.add(px(BROWSER, 36, 30))
    s.dots((41, 20), (19, 20), 0.1, 0.3, keep=0.4)
    s.dots((53, 20), (77, 20), 0.35, 0.55, keep=0.25)
    s.dots((47, 26), (47, 30), 0.6, 0.75, n=3, keep=0.15)
    return s


def cheap():
    s = Scene("cheap", 96, 40, "A space's Durable Object sleeps until someone syncs")
    s.add(px(PHONE, 6, 10))
    s.add(px(BOX_SLEEP, 66, 16), show=[(0, 0.42), (0.78, 1)])
    s.add(px(BOX_AWAKE, 66, 16), show=[(0.42, 0.78)])
    s.add(px(FLAME_A, 67, 2), show=[(0.42, 0.78)])
    for i, (x, y, t) in enumerate([(80, 12, 0.0), (83, 8, 0.12), (86, 4, 0.24), (80, 12, 0.8), (83, 8, 0.9)]):
        s.add(px(Z, x, y), show=[(t, min(t + 0.16, 0.42 if t < 0.4 else 1))])
    s.dots((21, 20), (65, 20), 0.28, 0.42, keep=0.05)
    s.dots((65, 24), (21, 24), 0.55, 0.7, keep=0.05)
    return s


if __name__ == "__main__":
    scenes = {"flare.svg": None, "offline.svg": offline(), "spaces.svg": spaces(),
              "merges.svg": merges(), "platforms.svg": platforms(), "cheap.svg": cheap()}
    for name, sc in scenes.items():
        text = hero() if sc is None else sc.svg()
        (OUT / name).write_text(text)
        print(name, len(text))
