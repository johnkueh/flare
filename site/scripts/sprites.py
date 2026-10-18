"""Draws the site's pixel art as crisp SVGs. Run: python3 site/scripts/sprites.py"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "art"

PAL = {
    "O": "#F97316", "D": "#C2410C", "R": "#EA580C", "Y": "#FBBF24", "L": "#FEF3C7",
    "c": "#FDF0D5", "w": "#FFE7C2", "P": "#E59A63", "C": "#FFFFFF", "S": "#FCDDB8",
    "I": "#3B2414", "K": "#F97316", "k": "#C2410C", "g": "#FDBA74",
}

def grid(rows):
    w = max(len(r) for r in rows)
    return [r.ljust(w, ".") for r in rows]

def rects(rows, ox=0, oy=0, cls=None):
    out = []
    for y, row in enumerate(grid(rows)):
        x = 0
        while x < len(row):
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            run = 1
            while x + run < len(row) and row[x + run] == ch:
                run += 1
            c = f' class="{cls}"' if cls else ""
            out.append(f'<rect x="{ox + x}" y="{oy + y}" width="{run}" height="1" fill="{PAL[ch]}"{c}/>')
            x += run
    return "".join(out)

def svg(w, h, body, title, extra=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges" role="img">'
            f"<title>{title}</title>{extra}{body}</svg>\n")

PHONE = [".OOOOOO.", "OccccccO", "OccccccO", "OccccccO", "OccccccO", "OccccccO",
         "OccccccO", "OccccccO", "OccccccO", "OOOOOOOO", "OOOwwOOO", ".OOOOOO."]
CLOUD = [
    "...........PPPPPP",
    ".........PPCCCCCCPP",
    "........PCCCCCCCCCCP...PPPP",
    "......PPCCCCCCCCCCCCPPPCCCCP",
    "....PPCCCCCCCCCCCCCCCCCCCCCCPP",
    "...PCCCCCCCCCCCCCCCCCCCCCCCCCCP",
    "..PCCCCCCCCCCCCCCCCCCCCCCCCCCCCP",
    "..PCCCCCCCCCCCCCCCCCCCCCCCCCCCCP",
    "..PSSCCCCCCCCCCCCCCCCCCCCCCCCSSP",
    "...PSSSSSSSSSSSSSSSSSSSSSSSSSSP",
    "....PPPPPPPPPPPPPPPPPPPPPPPPPP",
]
FLAME_A = [
    ".....R", "....RR", "....ROR", "...ROOR..R", "..ROOOOR.R", "..ROOYOORR",
    ".ROOYYOOR", ".ROYYYYOR", "ROOYLLYOOR", "ROYYLLYYOR", "ROYLLLLYOR",
    ".ROYLLYOR", "..RROORR", "....RR",
]
FLAME_B = [
    "....R", "....RR", "...ROR", "...ROOR", ".R.ROOOR", "RR.ROYOOR",
    "RROOYYOOR", ".ROYYYYOR", "ROOYLLYOOR", "ROYYLLYYOR", "ROYLLLLYOR",
    ".ROYLLYOR", "..RROORR", "....RR",
]

ANIM = ("<style>"
        ".dot{animation:blink 2.4s steps(1) infinite;animation-delay:calc(var(--i) * .15s);opacity:.35}"
        ".spark{animation:rise 1.8s steps(3) infinite;animation-delay:calc(var(--i) * .4s)}"
        ".flame-b{animation:flick .5s steps(1) infinite}.flame-a{animation:flick .5s steps(1) infinite reverse}"
        "@keyframes blink{0%{opacity:1}20%{opacity:.35}}"
        "@keyframes flick{0%{opacity:1}50%{opacity:0}}"
        "@keyframes rise{0%{transform:translateY(0);opacity:1}100%{transform:translateY(-6px);opacity:0}}"
        "@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important}.flame-b{opacity:0!important}}"
        "</style>")

def hero():
    W, H = 104, 60
    body = []
    phones = [(4, 6), (4, 42), (92, 6), (92, 42)]
    for px, py in phones:
        body.append(rects(PHONE, px, py))
    cx, cy = 36, 34
    body.append(rects(CLOUD, cx, cy))
    fx, fy = 49, 20
    body.append(f'<g class="flame-a">{rects(FLAME_A, fx, fy)}</g>')
    body.append(f'<g class="flame-b">{rects(FLAME_B, fx, fy)}</g>')
    # Dotted links from each phone to the cloud; CSS lights them in turn.
    hub = (cx + 16, cy + 5)
    for i, (px, py) in enumerate(phones):
        sx = px + 9 if px < hub[0] else px - 2
        sy = py + 6
        n = 8
        for k in range(1, n):
            t = k / n
            x = round(sx + (hub[0] - sx) * t * 0.82)
            y = round(sy + (hub[1] - sy) * t * 0.82)
            col = PAL["O"] if k % 2 else PAL["Y"]
            out = (k if px < hub[0] else n - k)
            body.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{col}" class="dot" style="--i:{out + i * 2}"/>')
    # Sparks above the flame
    for k, (x, y) in enumerate([(54, 15), (56, 10), (52, 6)]):
        body.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{PAL["O"] if k != 1 else PAL["Y"]}" class="spark" style="--i:{k}"/>')
    return svg(W, H, "".join(body), "Phones linked to a cloud with a flame", ANIM)

SMALL_PHONE = [".OOOO.", "OccccO", "OccccO", "OccccO", "OccccO", "OccccO", "OOwwOO", ".OOOO."]

def icon_sync():
    body = rects(SMALL_PHONE, 1, 4) + rects(SMALL_PHONE, 17, 4)
    for k, x in enumerate(range(8, 16, 2)):
        body += f'<rect x="{x}" y="7" width="1" height="1" fill="{PAL["O"] if k % 2 == 0 else PAL["Y"]}" class="dot" style="--i:{k}"/>'
        body += f'<rect x="{22 - x}" y="10" width="1" height="1" fill="{PAL["Y"] if k % 2 == 0 else PAL["O"]}" class="dot" style="--i:{k + 4}"/>'
    return svg(24, 16, body, "Two phones swapping changes", ANIM)

KEY = [
    "..KKKKK", ".KKKKKKK", "KKk...kKK", "KK.....KK", "KK.....KK", "KKk...kKK",
    ".KKKKKKK", "..KKKKK", "....KK", "....KKKK", "....KK", "....KKK", "....KK", "....kk",
]

def icon_auth():
    return svg(24, 16, rects(KEY, 8, 1), "A key")

def icon_analytics():
    body = []
    for i, h in enumerate([4, 7, 5, 10, 13]):
        x = 4 + i * 4
        body.append(f'<rect x="{x}" y="{14 - h}" width="3" height="{h}" fill="{PAL["O"] if i == 4 else PAL["g"]}"/>')
    body.append(f'<rect x="2" y="14" width="21" height="1" fill="{PAL["I"]}"/>')
    body.append(f'<rect x="2" y="1" width="1" height="13" fill="{PAL["I"]}"/>')
    return svg(24, 16, "".join(body), "A bar chart")

FLAG = [
    "I", "IOOOOOOOOO", "IOOOOOOOOOO", "IOOYYOOOOOOO", "IOOYYOOOOOOO", "IOOOOOOOOOO", "IOOOOOOOOO",
    "IDDDDDDDD", "I", "I", "I", "I", "I", "III",
]

def icon_flags():
    # A flag on a pole, next to a switch flipped on.
    body = rects(FLAG, 3, 1)
    body += f'<rect x="16" y="9" width="7" height="4" fill="{PAL["g"]}"/>'
    body += f'<rect x="20" y="9" width="3" height="4" fill="{PAL["O"]}"/>'
    return svg(24, 16, body, "A flag and a switch")

BELL = [
    "....DD", "...DOOD", "..DOOOOD", ".DOYOOOOD", ".DOYOOOOD", ".DOYOOOOD",
    ".DOOOOOOD", "DOOOOOOOOD", "DDDDDDDDDD", "....RR",
]

def icon_push():
    # A bell ringing, with a badge.
    body = rects(BELL, 7, 4) + rects([".R.", "RYR", ".R."], 15, 1)
    for k, (x, y) in enumerate([(4, 6), (3, 7), (4, 8), (19, 6), (20, 7), (19, 8)]):
        body += f'<rect x="{x}" y="{y}" width="1" height="1" fill="{PAL["O"]}" class="dot" style="--i:{k % 3}"/>'
    return svg(24, 16, body, "A ringing bell with a badge", ANIM)

LINK = [
    "..XXXXXXX..", ".XXXXXXXXX.", "XX.......XX", "XX.......XX",
    "XX.......XX", ".XXXXXXXXX.", "..XXXXXXX..",
]

def icon_links():
    # Two chain links, the orange one passing over the dark one.
    a = [r.replace("X", "O") for r in LINK]
    b = [r.replace("X", "D") for r in LINK]
    body = rects(a, 2, 3) + rects(b, 11, 6)
    body += rects(["OO", "OO", "OO"], 11, 6)  # the orange link's right side, on top
    return svg(24, 16, body, "Two chain links")

def favicon():
    return svg(10, 14, rects(FLAME_A, 0, 0), "Flare")

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, s in {"hero.svg": hero(), "sync.svg": icon_sync(), "auth.svg": icon_auth(),
                    "analytics.svg": icon_analytics(), "flags.svg": icon_flags(), "push.svg": icon_push(),
                    "links.svg": icon_links(),
                    "flame.svg": favicon()}.items():
        (OUT / name).write_text(s)
        print(name, len(s))
