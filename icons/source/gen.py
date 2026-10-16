import math
from engine import poly

def gear(cx=12, cy=12, r_out=9.0, r_in=6.9, teeth=8, top=0.42, base=0.62):
    """Cog with flat-topped teeth; corners soften once stroked with round joins."""
    pts = []
    step = 2*math.pi/teeth
    for i in range(teeth):
        a = i*step - math.pi/2
        for ang, r in ((a - step*base/2, r_in), (a - step*top/2, r_out), (a + step*top/2, r_out), (a + step*base/2, r_in)):
            pts.append((cx + r*math.cos(ang), cy + r*math.sin(ang)))
    return poly(pts)

def star(cx=12, cy=12.4, r_out=9.6, r_in=4.6, n=5):
    pts = []
    for i in range(2*n):
        r = r_out if i % 2 == 0 else r_in
        a = -math.pi/2 + i*math.pi/n
        pts.append((cx + r*math.cos(a), cy + r*math.sin(a)))
    return poly(pts)

def seal(cx=12, cy=12, r=8.6, amp=0.9, lobes=8, samples=48):
    """Scalloped badge: a wavy circle as a closed Catmull-Rom spline."""
    pts = []
    for i in range(samples):
        a = 2*math.pi*i/samples
        rr = r + amp*math.cos(lobes*a)
        pts.append((cx + rr*math.cos(a), cy + rr*math.sin(a)))
    n = len(pts)
    d = f'M{pts[0][0]:.3f} {pts[0][1]:.3f}'
    for i in range(n):
        p0, p1, p2, p3 = pts[i-1], pts[i], pts[(i+1) % n], pts[(i+2) % n]
        c1 = (p1[0] + (p2[0]-p0[0])/6, p1[1] + (p2[1]-p0[1])/6)
        c2 = (p2[0] - (p3[0]-p1[0])/6, p2[1] - (p3[1]-p1[1])/6)
        d += f' C{c1[0]:.3f} {c1[1]:.3f} {c2[0]:.3f} {c2[1]:.3f} {p2[0]:.3f} {p2[1]:.3f}'
    return 'p:' + d + ' Z'

