"""Compile icon definitions into single filled paths (outline + fill variants)."""
import math, re
import pathops
from picosvg import svg_pathops as sp
from picosvg.svg_types import SVGPath, SVGCircle, SVGRect, SVGEllipse

W_OUT = 1.5      # outline stroke
W_FILL = 2.0     # free strokes in the fill variant
W_CUT = 1.5      # default knockout width

def shape_cmds(spec):
    kind, _, arg = spec.partition(':')
    if kind == 'p':
        return SVGPath(d=arg).as_cmd_seq()
    nums = [float(x) for x in re.split(r'[ ,]+', arg.strip())]
    if kind == 'c':
        cx, cy, r = nums; return SVGCircle(cx=cx, cy=cy, r=r).as_path().as_cmd_seq()
    if kind == 'e':
        cx, cy, rx, ry = nums; return SVGEllipse(cx=cx, cy=cy, rx=rx, ry=ry).as_path().as_cmd_seq()
    if kind == 'r':
        x, y, w, h, *rx = nums; rx = rx[0] if rx else 0
        return SVGRect(x=x, y=y, width=w, height=h, rx=rx, ry=rx).as_path().as_cmd_seq()
    raise ValueError(spec)

def poly(points, close=True):
    d = 'M' + ' L'.join(f'{x:.3f} {y:.3f}' for x, y in points)
    return 'p:' + d + (' Z' if close else '')

def to_path(cmds):
    return sp.skia_path(list(cmds), 'nonzero')

def stroked(cmds, w):
    return to_path(sp.stroke(list(cmds), 'round', 'round', w, 4, 0.05))

def compile_layers(layers, variant, t=None):
    acc = pathops.Path()
    for item in layers:
        op, _, spec = item.partition(' ')
        cmds = list(shape_cmds(spec))
        m = re.match(r'([A-Z]+)([\d.]*)$', op)
        tag, num = m.group(1), m.group(2)
        w = float(num) if num else None
        if tag == 'S':
            p = stroked(cmds, w or (W_OUT if variant == 'outline' else W_FILL))
        elif tag == 'F':      # filled body that keeps the outline's outer edge
            p = pathops.op(to_path(cmds), stroked(cmds, W_OUT), pathops.PathOp.UNION)
        elif tag == 'D':      # plain fill, no stroke
            p = to_path(cmds)
        elif tag == 'X':
            p = stroked(cmds, w or W_CUT)
        elif tag == 'XF':
            p = to_path(cmds)
        else:
            raise ValueError(op)
        if t:
            p = transformed(p, t)
        acc = pathops.op(acc, p, pathops.PathOp.DIFFERENCE if tag.startswith('X') else pathops.PathOp.UNION)
    acc.simplify()
    return acc

def transformed(p, t):
    a, b, c, d, e, f = t
    out = pathops.Path()
    pen = out.getPen()
    def tf(pt):
        x, y = pt; return (a*x + c*y + e, b*x + d*y + f)
    for verb, pts in p:
        pts = [tf(q) for q in pts]
        if verb == pathops.PathVerb.MOVE: pen.moveTo(*pts)
        elif verb == pathops.PathVerb.LINE: pen.lineTo(*pts)
        elif verb == pathops.PathVerb.QUAD: pen.qCurveTo(*pts)
        elif verb == pathops.PathVerb.CUBIC: pen.curveTo(*pts)
        elif verb == pathops.PathVerb.CLOSE: pen.closePath()
        elif verb == pathops.PathVerb.CONIC: raise ValueError('conic')
    return out

def rot(deg, cx=12, cy=12):
    r = math.radians(deg); co, si = math.cos(r), math.sin(r)
    return (co, si, -si, co, cx - co*cx + si*cy, cy - si*cx - co*cy)

FLIP_Y = (1, 0, 0, -1, 0, 24)
FLIP_X = (-1, 0, 0, 1, 24, 0)

def to_d(path):
    sv = SVGPath.from_commands(sp.svg_commands(path))
    sv = sv.round_floats(2)
    return sv.d

