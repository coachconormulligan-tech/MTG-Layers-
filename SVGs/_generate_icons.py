#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2 counter icons: monochrome 'MTG medallion' style, richer detail + two-tone depth."""
import math, os, re
OUT = "/Users/conormulligan/Library/CloudStorage/Dropbox/Conor and Emily/Conor/Coding/Layers Website/Layers Website Editing Version/SVGs"
os.makedirs(OUT, exist_ok=True)

# ---- tokens --------------------------------------------------------------
FL  = 'fill="currentColor"'
# PURE BLACK & WHITE ONLY — no gray. The old gray depth tones (SH/SH2) are retired:
# they map to nothing so any leftover use simply leaves the black body showing.
# `wrap()` also strips every opacity attribute, so partial-opacity = gray is impossible.
SH  = 'fill="none"'                              # retired gray tone (was depth facet)
SH2 = 'fill="none"'                              # retired gray tone (was faint facet)
ST  = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"'
STm = 'fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"'
STt = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"'
STh = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
GL  = 'fill="#fff"'                              # white glint
CUT = 'fill="#fff"'                              # white interior cut
# White detail STROKES — carve form into a solid black body (corners, seams, text,
# facets). Black-on-black detail reads as nothing; white lines make the shape legible.
LW  = 'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"'
LWt = 'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
LWg = 'fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"'

# ---- geometry helpers ----------------------------------------------------
def P(seq): return " ".join(f"{x:.2f},{y:.2f}" for x, y in seq)
def rad(a): return math.radians(a)
def onc(cx, cy, r, a): return (cx + r*math.cos(rad(a)), cy + r*math.sin(rad(a)))

def star_pts(cx, cy, R, r, n=5, rot=-90):
    o = []
    for i in range(2*n):
        a = rad(rot + i*180.0/n); rr = R if i % 2 == 0 else r
        o.append((cx+rr*math.cos(a), cy+rr*math.sin(a)))
    return o
def star(cx, cy, R, r, n=5, rot=-90, attr=FL):
    return f'<polygon points="{P(star_pts(cx,cy,R,r,n,rot))}" {attr}/>'
def poly_pts(cx, cy, R, n, rot=-90):
    return [(cx+R*math.cos(rad(rot+i*360.0/n)), cy+R*math.sin(rad(rot+i*360.0/n))) for i in range(n)]
def circ_d(cx, cy, r):
    return f"M{cx-r:.1f} {cy:.1f} a{r:.1f} {r:.1f} 0 1 0 {2*r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2*r:.1f} 0 Z"
def wedge(cx, cy, r0, r1, a0, a1):
    a0r, a1r = rad(a0), rad(a1)
    x0o, y0o = cx+r1*math.cos(a0r), cy+r1*math.sin(a0r)
    x1o, y1o = cx+r1*math.cos(a1r), cy+r1*math.sin(a1r)
    x1i, y1i = cx+r0*math.cos(a1r), cy+r0*math.sin(a1r)
    x0i, y0i = cx+r0*math.cos(a0r), cy+r0*math.sin(a0r)
    lg = 1 if (a1-a0) > 180 else 0
    return (f'M{x0o:.1f} {y0o:.1f} A{r1} {r1} 0 {lg} 1 {x1o:.1f} {y1o:.1f} '
            f'L{x1i:.1f} {y1i:.1f} A{r0} {r0} 0 {lg} 0 {x0i:.1f} {y0i:.1f} Z')

# ---- shared shape builders (with depth) ----------------------------------
def coin(cx, cy, r, emblem='star'):
    # black disc with a white rim groove + white emblem cut into it (reads on parchment)
    s = (f'<circle cx="{cx}" cy="{cy}" r="{r}" {FL}/>'
         f'<circle cx="{cx}" cy="{cy}" r="{r-3:.1f}" fill="none" stroke="#fff" stroke-width="1.4"/>')
    if emblem == 'star':
        s += star(cx, cy, r*0.5, r*0.2, 5, -90, CUT)
    elif emblem == 'shine':
        s += (star(cx, cy, r*0.44, r*0.16, 4, -90, CUT)
              + f'<path d="M{cx-r*0.40:.1f} {cy-r*0.14:.1f} q{r*0.30:.1f} -{r*0.24:.1f} {r*0.62:.1f} 0" '
              f'fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/>')
    elif emblem == 'coin':
        s += (f'<text x="{cx}" y="{cy+r*0.36:.1f}" font-family="Georgia,serif" font-size="{r*1.05:.1f}" '
              f'font-weight="bold" text-anchor="middle" {CUT}>¢</text>')
    return s

def bolt(scale=1.0, tx=0.0, ty=0.0, sparks=True):
    main = 'M57 16 L30 57 L45 57 L39 84 L71 43 L55 43 L63 16 Z'
    bev = 'M57 16 L30 57 L40 57 L63 16 Z'
    s = (f'<g transform="translate({tx} {ty}) scale({scale})">'
         f'<path d="{main}" {FL}/><path d="{bev}" {SH}/></g>')
    if sparks:
        s += f'<circle cx="25" cy="33" r="2.2" {FL}/><circle cx="75" cy="67" r="2.2" {FL}/>'
    return s

def flame_layers():
    # black outer flame + a bright inner flame (white) → the classic two-tone fire read
    return (f'<path d="M50 15 C61 33 73 41 73 59 a23 23 0 0 1 -46 0 C27 46 37 41 43 29 '
            f'C46 42 51 44 54 40 C58 34 55 25 50 15 Z" {FL}/>'
            f'<path d="M50 39 C55 48 61 51 61 60 a11 11 0 0 1 -22 0 C39 53 44 50 47 44 '
            f'C48 51 51 51 52 48 C54 45 52 42 50 39 Z" fill="#fff" opacity="0.9"/>'
            f'<ellipse cx="50" cy="61" rx="5" ry="3" fill="#fff" opacity="0.55"/>')

def droplet(cx, cy, w, h):
    top = cy - h/2
    return (f'<path d="M{cx} {top:.1f} C{cx} {top:.1f} {cx-w/2:.1f} {cy+h*0.18:.1f} {cx-w/2:.1f} {cy+h*0.3:.1f} '
            f'a{w/2:.1f} {w/2:.1f} 0 0 0 {w:.1f} 0 C{cx+w/2:.1f} {cy+h*0.18:.1f} {cx} {top:.1f} {cx} {top:.1f} Z" {FL}/>'
            f'<path d="M{cx-w*0.18:.1f} {cy:.1f} q-{w*0.12:.1f} {h*0.16:.1f} 0 {h*0.3:.1f}" '
            f'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity="0.85"/>'
            f'<ellipse cx="{cx+w*0.16:.1f}" cy="{cy+h*0.18:.1f}" rx="{w*0.12:.1f}" ry="{h*0.16:.1f}" {SH}/>')

def skull(cx=50, cy=49, s=1.0, teeth=True, detail=True):
    def t(x, y): return (cx+(x-50)*s, cy+(y-50)*s)
    o = (f"M{t(50,24)[0]:.1f} {t(50,24)[1]:.1f} "
         f"C{t(33,24)[0]:.1f} {t(33,24)[1]:.1f} {t(24,35)[0]:.1f} {t(24,35)[1]:.1f} {t(24,49)[0]:.1f} {t(24,49)[1]:.1f} "
         f"C{t(24,59)[0]:.1f} {t(24,59)[1]:.1f} {t(31,65)[0]:.1f} {t(31,65)[1]:.1f} {t(35,68)[0]:.1f} {t(35,68)[1]:.1f} "
         f"L{t(35,76)[0]:.1f} {t(35,76)[1]:.1f} L{t(42,76)[0]:.1f} {t(42,76)[1]:.1f} L{t(42,70)[0]:.1f} {t(42,70)[1]:.1f} "
         f"L{t(46,76)[0]:.1f} {t(46,76)[1]:.1f} L{t(54,76)[0]:.1f} {t(54,76)[1]:.1f} L{t(58,70)[0]:.1f} {t(58,70)[1]:.1f} "
         f"L{t(58,76)[0]:.1f} {t(58,76)[1]:.1f} L{t(65,76)[0]:.1f} {t(65,76)[1]:.1f} L{t(65,68)[0]:.1f} {t(65,68)[1]:.1f} "
         f"C{t(69,65)[0]:.1f} {t(69,65)[1]:.1f} {t(76,59)[0]:.1f} {t(76,59)[1]:.1f} {t(76,49)[0]:.1f} {t(76,49)[1]:.1f} "
         f"C{t(76,35)[0]:.1f} {t(76,35)[1]:.1f} {t(67,24)[0]:.1f} {t(67,24)[1]:.1f} {t(50,24)[0]:.1f} {t(50,24)[1]:.1f} Z")
    el = circ_d(*t(40, 48), 7*s); er = circ_d(*t(60, 48), 7*s)
    nose = f"M{t(50,55)[0]:.1f} {t(50,55)[1]:.1f} L{t(45,64)[0]:.1f} {t(45,64)[1]:.1f} L{t(55,64)[0]:.1f} {t(55,64)[1]:.1f} Z"
    holes = el + er + nose
    if teeth:
        holes += (f"M{t(42,70)[0]:.1f} {t(42,70)[1]:.1f} L{t(42,76)[0]:.1f} {t(42,76)[1]:.1f} "
                  f"M{t(50,70)[0]:.1f} {t(50,70)[1]:.1f} L{t(50,76)[0]:.1f} {t(50,76)[1]:.1f}")
    out = f'<path fill-rule="evenodd" d="{o} {el} {er} {nose}" {FL}/>'
    if detail:
        out += (f'<line x1="{t(42,70)[0]:.1f}" y1="{t(42,70)[1]:.1f}" x2="{t(42,76)[0]:.1f}" y2="{t(42,76)[1]:.1f}" {STh} opacity="0.5"/>'
                f'<line x1="{t(50,70)[0]:.1f}" y1="{t(50,70)[1]:.1f}" x2="{t(50,76)[0]:.1f}" y2="{t(50,76)[1]:.1f}" {STh} opacity="0.5"/>'
                f'<line x1="{t(58,70)[0]:.1f}" y1="{t(58,70)[1]:.1f}" x2="{t(58,76)[0]:.1f}" y2="{t(58,76)[1]:.1f}" {STh} opacity="0.5"/>'
                f'<path d="M{t(44,30)[0]:.1f} {t(44,30)[1]:.1f} L{t(40,26)[0]:.1f} {t(40,26)[1]:.1f} L{t(43,24)[0]:.1f} {t(43,24)[1]:.1f}" {STh}/>')
    return out

def gem_facets(cx=50, cy=51, w=40, h=58):
    L = cx-w/2; R = cx+w/2; T = cy-h/2; B = cy+h/2; my = T+h*0.28; M = my+8
    # solid black gem + white facet seams (table apex, girdle, crown + pavilion facets)
    body = f'<polygon points="{cx},{T:.1f} {R:.1f},{my:.1f} {cx+6},{B:.1f} {cx-6},{B:.1f} {L:.1f},{my:.1f}" {FL}/>'
    seams = (f'<path d="M{cx} {T:.1f} L{cx} {B:.1f}" {LWt}/>'
             f'<path d="M{L:.1f} {my:.1f} L{cx} {M:.1f} L{R:.1f} {my:.1f}" {LWt}/>'
             f'<path d="M{cx-6} {B:.1f} L{cx} {M:.1f} L{cx+6} {B:.1f}" {LWt}/>'
             f'<path d="M{L:.1f} {my:.1f} H{R:.1f}" {LWt}/>')
    return body + seams

def cog(teeth=8):
    s = "".join(f'<g transform="rotate({i*360/teeth:.1f} 50 50)"><path d="M45 14 L55 14 L53.5 27 L46.5 27 Z" {FL}/></g>' for i in range(teeth))
    return (s + f'<circle cx="50" cy="50" r="23" {FL}/>'
            f'<circle cx="50" cy="50" r="16" {SH}/>'
            f'<circle cx="50" cy="50" r="8" {FL}/>'
            f'<circle cx="50" cy="50" r="3.6" {SH2}/>')

def heart(cx, cy, w, glint=True):
    d = (f"M{cx} {cy+0.34*w:.1f} C{cx-0.52*w:.1f} {cy-0.02*w:.1f} {cx-0.52*w:.1f} {cy-0.46*w:.1f} {cx} {cy-0.16*w:.1f} "
         f"C{cx+0.52*w:.1f} {cy-0.46*w:.1f} {cx+0.52*w:.1f} {cy-0.02*w:.1f} {cx} {cy+0.34*w:.1f} Z")
    d2 = (f"M{cx} {cy+0.30*w:.1f} C{cx-0.40*w:.1f} {cy-0.02*w:.1f} {cx-0.40*w:.1f} {cy-0.36*w:.1f} {cx} {cy-0.12*w:.1f} "
          f"C{cx+0.40*w:.1f} {cy-0.36*w:.1f} {cx+0.40*w:.1f} {cy-0.02*w:.1f} {cx} {cy+0.30*w:.1f} Z")
    s = f'<path d="{d}" {FL}/><path d="{d2}" {SH2}/>'
    if glint:
        s += f'<path d="M{cx-0.28*w:.1f} {cy-0.30*w:.1f} q-{0.10*w:.1f} {0.16*w:.1f} 0 {0.30*w:.1f}" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" opacity="0.85"/>'
    return s

def heart_d(cx, cy, w):
    return (f"M{cx} {cy+0.34*w:.1f} C{cx-0.52*w:.1f} {cy-0.02*w:.1f} {cx-0.52*w:.1f} {cy-0.46*w:.1f} {cx} {cy-0.16*w:.1f} "
            f"C{cx+0.52*w:.1f} {cy-0.46*w:.1f} {cx+0.52*w:.1f} {cy-0.02*w:.1f} {cx} {cy+0.34*w:.1f} Z")

def shield_d(cx=50, top=24, w=44, h=56):
    half = w/2
    return (f"M{cx} {top} L{cx+half} {top+8} V{top+h*0.5} "
            f"C{cx+half} {top+h*0.82} {cx+half*0.55} {top+h} {cx} {top+h} "
            f"C{cx-half*0.55} {top+h} {cx-half} {top+h*0.82} {cx-half} {top+h*0.5} V{top+8} Z")

def shield_solid(boss=True):
    s = f'<path d="{shield_d()}" {FL}/><path d="{shield_d(50,30,30,42)}" {SH}/>'
    if boss:
        s += f'<circle cx="50" cy="50" r="5" {FL}/>'
        s += (f'<circle cx="33" cy="34" r="1.8" {SH2}/><circle cx="67" cy="34" r="1.8" {SH2}/>')
    return s

def shield_line(inner=''):
    return f'<path d="{shield_d()}" {ST}/><path d="{shield_d(50,30,30,42)}" {STh} opacity="0.5"/>' + inner

def sword(ang=0):
    g = (f'<polygon points="50,20 54,30 54,57 46,57 46,30" {FL}/>'
         f'<polygon points="50,20 52,29 50,57 50,57" {SH}/>'
         f'<line x1="50" y1="30" x2="50" y2="55" {STh} opacity="0.45"/>'
         f'<rect x="38" y="57" width="24" height="5" rx="1.5" {FL}/>'
         f'<rect x="46.5" y="62" width="7" height="13" rx="2" {FL}/>'
         f'<path d="M46.5 65 h7 M46.5 69 h7" {STh} opacity="0.5"/>'
         f'<circle cx="50" cy="78" r="3.6" {FL}/>')
    return f'<g transform="rotate({ang} 50 50)">{g}</g>' if ang else g

def scroll(lines=3):
    s = (f'<path d="M30 28 a6 6 0 0 1 12 0 V72 a6 6 0 0 0 12 0" {STm}/>'
         f'<path d="M42 28 H64 a6 6 0 0 1 6 6 V72 a6 6 0 0 1 -6 6 H42" {STm}/>'
         f'<path d="M42 28 H64 a6 6 0 0 1 6 6 V74 H46 a6 6 0 0 0 -4 -6 Z" {SH2}/>')
    for i in range(lines):
        s += f'<line x1="48" y1="{42+i*10}" x2="{62 if i<lines-1 else 58}" y2="{42+i*10}" {STh}/>'
    return s

def snowflake():
    out = '<g ' + STm + '>'
    for i in range(6):
        a = i*60
        tx, ty = onc(50, 50, 27, a)
        out += f'<line x1="50" y1="50" x2="{tx:.1f}" y2="{ty:.1f}"/>'
        for frac in (0.55, 0.82):
            bx, by = onc(50, 50, 27*frac, a)
            blen = 8*(1-frac)+5
            for da in (40, -40):
                ex, ey = onc(bx, by, blen, a+da)
                out += f'<line x1="{bx:.1f}" y1="{by:.1f}" x2="{ex:.1f}" y2="{ey:.1f}"/>'
    out += '</g>'
    out += f'<circle cx="50" cy="50" r="3.5" {FL}/>' + star(50, 50, 6, 2.4, 6, -90, SH2)
    return out

# =========================================================================
I = {}

# ---------------- UNCHANGED-CONCEPT (now enriched) -----------------------
I["acorn"] = (f'<rect x="47.5" y="20" width="5" height="9" rx="2.5" {FL}/>'
              f'<path d="M28 38 C28 32 38 28 50 28 C62 28 72 32 72 38 C72 43 68 45 63 45 H37 C32 45 28 43 28 38 Z" {FL}/>'
              f'<path d="M35 46 C35 63 42 79 50 82 C58 79 65 63 65 46 Z" {FL}/>'
              # white cap cross-hatch + cap rim + nut seam → reads as an acorn
              f'<path d="M40 34 h20 M37 39 h26 M35 46 H65" {LWt}/>'
              f'<path d="M50 50 V78" {LWt}/>')

# a bow-and-arrow projectile: shaft + barbed head + fletching, drawn horizontally then
# rotated so it flies up-right. Black body, white feather barbs.
I["arrow"] = ('<g transform="rotate(-45 50 50)">'
              # shaft
              f'<line x1="20" y1="50" x2="66" y2="50" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>'
              # barbed arrowhead at the tip
              f'<polygon points="84,50 65,40 70,50 65,60" {FL}/>'
              # two symmetric fletching vanes (clean parallelograms) at the nock end
              f'<polygon points="22,50 40,50 34,41 16,41" {FL}/>'
              f'<polygon points="22,50 40,50 34,59 16,59" {FL}/>'
              # evenly-spaced white feather barbs, parallel to the vane edge
              f'<path d="M26 50 L20 41 M31 50 L25 41 M36 50 L30 41" {LWt}/>'
              f'<path d="M26 50 L20 59 M31 50 L25 59 M36 50 L30 59" {LWt}/>'
              '</g>')

I["arrowhead"] = (f'<polygon points="50,22 72,76 50,62 28,76" {FL}/>'
                  f'<polygon points="50,22 50,62 28,76" {SH}/>'
                  f'<polyline points="50,22 50,62" {STh} opacity="0.4"/>')

I["blood"] = (  # a blood drop with a splash crown of satellite droplets
              f'<path d="M50 22 C50 22 33 47 33 60 a17 17 0 0 0 34 0 C67 47 50 22 50 22 Z" {FL}/>'
              f'<path d="M42 52 q-4 6 0 14" {LWt}/>'
              f'<circle cx="30" cy="74" r="2.6" {FL}/><circle cx="70" cy="72" r="2.2" {FL}/><circle cx="50" cy="82" r="2.4" {FL}/>')

I["book"] = (  # an open book: two black pages meeting at a spine
             f'<path d="M50 32 C40 28 30 28 22 30 L22 66 C30 64 40 66 50 70 '
             f'C60 66 70 64 78 66 L78 30 C70 28 60 28 50 32 Z" {FL}/>'
             # white spine crease + ruled text lines so it reads as a book, not a block
             f'<path d="M50 32 V70" {LW}/>'
             f'<g {LWt}>'
             f'<line x1="28" y1="40" x2="44" y2="39"/><line x1="28" y1="47" x2="44" y2="46"/><line x1="28" y1="54" x2="40" y2="53"/>'
             f'<line x1="56" y1="39" x2="72" y2="40"/><line x1="56" y1="46" x2="72" y2="47"/><line x1="60" y1="53" x2="72" y2="54"/>'
             f'</g>')

I["coin"] = (  # a minted coin: milled edge + inner ring + laurel wreath + central star
             f'<circle cx="50" cy="50" r="26" {FL}/>'
             + "".join(f'<line x1="{onc(50,50,23,a)[0]:.1f}" y1="{onc(50,50,23,a)[1]:.1f}" '
                       f'x2="{onc(50,50,26,a)[0]:.1f}" y2="{onc(50,50,26,a)[1]:.1f}" {LWt}/>' for a in range(0, 360, 18))
             + f'<circle cx="50" cy="50" r="19" fill="none" stroke="#fff" stroke-width="1.6"/>'
             f'<path d="M39 64 C31 57 31 45 39 39 M61 64 C69 57 69 45 61 39" {LWt}/>'   # laurel
             + f'<text x="50" y="58" font-family="Georgia,serif" font-size="22" font-weight="bold" text-anchor="middle" {GL}>$</text>')

I["crystal"] = (f'<polygon points="50,20 64,40 56,82 44,82 36,40" {FL}/>'
                # white facet edges so the gem reads as cut, not a flat shard
                f'<path d="M36 40 H64 M50 20 V82 M36 40 L50 49 L64 40" {LWt}/>'
                + star(61, 31, 4.5, 1.8, 4, -90, 'fill="#fff"'))

I["egg"] = (f'<path d="M50 22 C36 22 30 43 30 56 a20 24 0 0 0 40 0 C70 43 64 22 50 22 Z" {FL}/>'
            f'<path d="M50 22 C36 22 30 43 30 56 a20 24 0 0 0 20 24 Z" {SH2}/>'
            f'<ellipse cx="42" cy="40" rx="5" ry="8" {GL}/>')

I["feather"] = (f'<path d="M73 24 C46 28 33 44 32 76 C58 70 72 50 73 24 Z" {FL}/>'
                # white central rachis + barbs → reads as a feather
                f'<path d="M73 24 L34 74" {LW}/>'
                f'<path d="M66 36 L50 41 M61 48 L46 53 M56 59 L43 64" {LWt}/>')

I["flame"] = flame_layers()

I["flood"] = ('<g ' + ST + '>'
              '<path d="M24 40 q8 -9 16.5 0 t16.5 0 t16.5 0"/>'
              '<path d="M24 55 q8 -9 16.5 0 t16.5 0 t16.5 0"/>'
              '<path d="M24 70 q8 -9 16.5 0 t16.5 0 t16.5 0"/></g>'
              + f'<g {STh} opacity="0.4"><path d="M24 47 q8 -9 16.5 0 t16.5 0 t16.5 0"/>'
              f'<path d="M24 62 q8 -9 16.5 0 t16.5 0 t16.5 0"/></g>'
              + f'<circle cx="40" cy="33" r="2" {FL}/><circle cx="64" cy="30" r="1.6" {FL}/>')

# a deep-cut RUBY: rounded cushion-cut stone with a broad octagonal table,
# radiating crown facets, and a bright sparkle (distinct from the pointed `gem`/`crystal`)
I["gem"] = (f'<path d="M50 22 C66 22 78 33 78 49 C78 65 66 78 50 78 C34 78 22 65 22 49 C22 33 34 22 50 22 Z" {FL}/>'
            f'<g {LWt}>'
            f'<polygon points="42,38 58,38 66,49 58,60 42,60 34,49"/>'      # table
            f'<path d="M42 38 L34 30 M58 38 L66 30 M34 49 L24 49 M66 49 L76 49 '
            f'M42 60 L36 70 M58 60 L64 70 M50 60 V72"/>'                     # crown facets
            f'</g>'
            + star(63, 32, 4.5, 1.7, 4, -90, GL))

# stacked GOLD BARS (ingots) in a small pyramid + a shine particle
I["gold"] = (f'<polygon points="22,72 46,72 44,62 24,62" {FL}/>'          # bottom-left bar
             f'<polygon points="54,72 78,72 76,62 56,62" {FL}/>'          # bottom-right bar
             f'<polygon points="38,58 62,58 60,48 40,48" {FL}/>'          # top bar front
             f'<polygon points="40,48 60,48 64,44 44,44" {FL}/>'          # top bar 3D face
             f'<g {LWt}><path d="M24 62 H44 M56 62 H76 M40 48 H60"/>'     # top edges
             f'<path d="M40 48 L44 44 H64"/></g>'                          # top-bar bevel
             + star(52, 53, 4.6, 1.6, 4, -90, GL)                          # shine particle
             + f'<circle cx="33" cy="66" r="1.5" {GL}/>')

I["hourglass"] = (f'<g {STm}><line x1="32" y1="24" x2="68" y2="24"/><line x1="32" y1="76" x2="68" y2="76"/>'
                  f'<path d="M37 24 C37 40 50 46 50 50 C50 54 37 60 37 76"/>'
                  f'<path d="M63 24 C63 40 50 46 50 50 C50 54 63 60 63 76"/></g>'
                  f'<path d="M43 30 H57 L50 43 Z" {FL}/>'
                  f'<path d="M50 57 L44 70 H56 Z" {SH}/>'
                  f'<line x1="50" y1="50" x2="50" y2="62" {STh} opacity="0.6"/>')

I["ice"] = snowflake()   # user prefers the snowflake read

I["javelin"] = (f'<g transform="rotate(0 50 50)"><line x1="26" y1="74" x2="60" y2="40" {ST}/>'
                f'<polygon points="56,30 74,26 64,44" {FL}/>'
                f'<polygon points="56,30 74,26 65,35" {SH}/>'
                f'<line x1="34" y1="58" x2="44" y2="68" {STh} opacity="0.5"/></g>')

I["lore"] = (f'<path d="M50 33 C43 27 33 26 25 30 V72 C34 68 43 69 50 76 Z" {FL}/>'
             f'<path d="M50 33 C57 27 67 26 75 30 V72 C66 68 57 69 50 76 Z" {FL}/>'
             f'<path d="M50 33 V76" {STt}/>'
             f'<path d="M25 30 C34 27 43 29 50 35 C57 29 66 27 75 30" {STh} opacity="0.55"/>'
             f'<g {STh} opacity="0.55"><path d="M32 42 q8 -2 14 2"/><path d="M32 52 q8 -2 14 2"/>'
             f'<path d="M54 44 q7 -4 15 -2"/><path d="M54 54 q7 -4 15 -2"/></g>'
             f'<circle cx="50" cy="55" r="5" {SH2}/>' + star(50, 55, 4, 1.6, 4, -90, CUT))

I["ore"] = (f'<polygon points="32,42 48,28 70,36 75,58 58,76 33,72 24,52" {FL}/>'
            f'<polygon points="32,42 48,28 70,36 50,50" {SH2}/>'
            f'<polygon points="50,50 75,58 58,76 33,72 24,52" {SH}/>'
            f'<polygon points="44,52 48,47 52,52 48,57" {GL}/>'
            f'<polygon points="58,44 61,40 64,44 61,48" {GL}/>'
            f'<polygon points="53,63 56,59 59,63 56,67" {GL}/>')

I["page"] = (  # a plain sheet of paper — NO folded corner — with ruled lines
             f'<rect x="33" y="22" width="34" height="56" rx="2.5" {FL}/>'
             f'<g {LWt}><line x1="40" y1="34" x2="60" y2="34"/><line x1="40" y1="42" x2="60" y2="42"/>'
             f'<line x1="40" y1="50" x2="60" y2="50"/><line x1="40" y1="58" x2="60" y2="58"/>'
             f'<line x1="40" y1="66" x2="54" y2="66"/></g>')

I["petal"] = (f'<path d="M52 19 C72 33 70 59 47 82 C34 65 29 43 52 19 Z" {FL}/>'
              # white midrib + side veins → reads as a leaf/petal
              f'<path d="M51 25 C48 42 45 60 47 78" {LWt}/>'
              f'<path d="M48 50 C42 47 38 42 35 37 M49 60 C56 54 61 49 64 43" {LWt}/>')

I["pin"] = (f'<line x1="50" y1="54" x2="50" y2="82" {ST}/>'
            f'<path d="M37 28 H63 L57 54 H43 Z" {FL}/>'
            f'<path d="M37 28 H50 L50 54 H43 Z" {SH}/>'
            f'<rect x="33" y="25" width="34" height="5" rx="2.5" {FL}/>')

I["quest"] = (f'<line x1="33" y1="20" x2="33" y2="82" {ST}/>'
              f'<path d="M33 24 H70 L60 36 L70 48 H33 Z" {FL}/>'
              f'<path d="M33 24 H50 L50 48 H33 Z" {SH2}/>'
              + star(46, 36, 5, 2, 5, -90, GL))

I["shield"] = (  # a heraldic crest shield: per-pale divide, fess line, chevron, rivets
             f'<path d="M50 22 L74 30 V50 C74 68 62 78 50 80 C38 78 26 68 26 50 V30 Z" {FL}/>'
             f'<g {LWt}><path d="M50 22 V80"/><path d="M26 44 H74"/></g>'
             f'<path d="M37 31 L50 41 L63 31" {LW}/>'                                    # chevron
             f'<g fill="#fff"><circle cx="33" cy="33" r="1.6"/><circle cx="67" cy="33" r="1.6"/></g>')

I["shell"] = (f'<path d="M50 73 C26 73 21 43 50 30 C79 43 74 73 50 73 Z" {FL}/>'
              # white radiating ribs → reads as a scallop shell
              f'<g {LWt}><line x1="50" y1="33" x2="50" y2="71"/>'
              f'<line x1="40" y1="35" x2="36" y2="68"/><line x1="60" y1="35" x2="64" y2="68"/>'
              f'<line x1="33" y1="42" x2="30" y2="64"/><line x1="67" y1="42" x2="70" y2="64"/></g>'
              f'<path d="M43 32 q7 -8 14 0" {LW}/>')

I["skull"] = skull()

I["spore"] = (f'<circle cx="50" cy="52" r="15" {FL}/>'
              # white burst (center + radiating spokes) inside the pod
              f'<circle cx="50" cy="52" r="4.5" {CUT}/>'
              + "".join(f'<line x1="{onc(50,52,7,a)[0]:.1f}" y1="{onc(50,52,7,a)[1]:.1f}" x2="{onc(50,52,13,a)[0]:.1f}" y2="{onc(50,52,13,a)[1]:.1f}" {LWt}/>' for a in range(0, 360, 45))
              # black satellite spores drifting off
              + "".join(f'<circle cx="{onc(50,52,23,a)[0]:.1f}" cy="{onc(50,52,23,a)[1]:.1f}" r="3.2" {FL}/>' for a in range(22, 360, 45)))

I["story"] = (scroll(2) + f'<polygon points="56,28 70,28 70,48 63,42 56,48" {FL}/>'
              f'<polygon points="63,42 70,48 70,28" {SH}/>')

I["treasure"] = (  # a bulging drawstring TREASURE BAG with a sparkle
                 f'<path d="M30 50 C23 62 25 79 50 81 C75 79 77 62 70 50 C66 41 58 41 50 41 C42 41 34 41 30 50 Z" {FL}/>'
                 f'<path d="M41 43 C40 37 43 33 50 33 C57 33 60 37 59 43 Z" {FL}/>'      # gathered neck
                 f'<path d="M37 45 q13 -7 26 0" {LW}/>'                                   # drawstring band
                 f'<path d="M41 43 q-4 3 -8 2 M59 43 q4 3 8 2" {LWt}/>'                   # string ends
                 f'<g {LWt}><path d="M45 40 V34 M50 39 V33 M55 40 V34"/></g>'            # cinch pleats
                 + star(50, 62, 7, 2.6, 4, -90, GL)                                       # treasure shine
                 + f'<circle cx="42" cy="69" r="2" {GL}/><circle cx="60" cy="67" r="1.6" {GL}/>')

I["wish"] = (star(50, 49, 27, 11, 5, -90, FL) + star(50, 49, 16, 6, 5, -90, SH2)
             + f'<circle cx="70" cy="30" r="2.6" {FL}/><circle cx="31" cy="34" r="2" {FL}/>'
             f'<circle cx="72" cy="52" r="1.6" {FL}/>')

# ---------------- REDESIGNS (enriched) -----------------------------------
I["crank"] = (  # a hand-crank handle on an axle, with a turning arc
              f'<path d="M42 58 L42 40 L62 40" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
              f'<circle cx="42" cy="58" r="6" {FL}/><circle cx="42" cy="58" r="2.4" {CUT}/>'
              f'<circle cx="64" cy="40" r="6" {FL}/><circle cx="64" cy="40" r="2.4" {CUT}/>'
              f'<path d="M30 42 a18 18 0 0 1 9 -15" {STt}/><polygon points="26,40 30,44 33,38" {FL}/>')

I["eruption"] = (f'<polygon points="22,78 39,43 61,43 78,78" {FL}/>'
                 f'<polygon points="22,78 39,43 50,62" {SH}/>'
                 f'<path d="M40 43 q10 8 20 0 L58 51 q-8 5 -16 0 Z" {SH2}/>'
                 f'<polygon points="50,12 57,29 75,24 64,39 78,52 59,51 55,70 48,53 30,60 40,44 24,31 43,33" {FL}/>'
                 f'<polygon points="50,22 55,34 67,31 60,41 68,49 56,48 53,60 48,49 36,54 43,43 34,35 46,37" {CUT}/>'
                 f'<circle cx="28" cy="24" r="2.8" {FL}/><circle cx="72" cy="18" r="3.2" {FL}/><circle cx="79" cy="36" r="2.2" {SH}/>'
                 f'<line x1="34" y1="78" x2="66" y2="78" {ST}/>')

I["blaze"] = (f'<path d="M28 72 C18 56 31 47 32 34 C38 48 45 49 43 36 C42 27 48 21 54 14 '
              f'C51 34 66 36 70 52 C80 58 78 74 66 82 H34 C32 79 30 76 28 72 Z" {FL}/>'
              f'<path d="M50 36 C59 49 66 53 66 64 a16 16 0 0 1 -32 0 C34 55 42 53 45 44 '
              f'C47 55 53 54 55 48 C57 43 54 39 50 36 Z" fill="#fff" opacity="0.9"/>'
              f'<path d="M38 72 C38 61 43 59 46 50 C47 60 53 60 54 52 C61 59 61 72 50 78 C44 77 40 75 38 72 Z" {FL}/>')

I["ember"] = (f'<path d="M36 60 a14 14 0 1 0 28 0 C60 49 55 49 50 42 C45 49 40 49 36 60 Z" {FL}/>'
              f'<path d="M44 62 a8 8 0 1 0 12 0 C53 55 51 55 50 51 C48 55 46 55 44 62 Z" {SH2}/>'
              f'<g {STt} opacity="0.7"><line x1="50" y1="34" x2="50" y2="24"/>'
              f'<line x1="68" y1="42" x2="74" y2="34"/><line x1="32" y1="42" x2="26" y2="34"/></g>'
              f'<circle cx="50" cy="60" r="3" {GL}/>')

I["fury"] = (f'<circle cx="50" cy="50" r="27" {FL}/><circle cx="50" cy="50" r="27" {SH2}/>'
             f'<g {ST}><line x1="33" y1="39" x2="46" y2="45"/><line x1="67" y1="39" x2="54" y2="45"/></g>'
             f'<circle cx="41" cy="52" r="3.4" {CUT}/><circle cx="59" cy="52" r="3.4" {CUT}/>'
             f'<path d="M38 66 q12 -9 24 0 q-12 5 -24 0 Z" {CUT}/>'
             f'<polygon points="40,66 44,71 48,66" {FL}/><polygon points="52,66 56,71 60,66" {FL}/>')

I["burden"] = (f'<path d="M40 35 a10 10 0 0 1 20 0" {ST}/>'
               f'<path d="M33 37 H67 L73 75 H27 Z" {FL}/>'
               f'<path d="M33 37 H50 L50 75 H27 Z" {SH2}/>'
               f'<text x="50" y="66" font-family="Georgia,serif" font-size="22" font-weight="bold" '
               f'text-anchor="middle" {CUT}>!</text>')

I["brick"] = (f'<rect x="23" y="33" width="54" height="34" rx="3" {FL}/>'
              # white mortar courses → reads as brickwork
              f'<g {LW}><line x1="24" y1="50" x2="76" y2="50"/>'
              f'<line x1="50" y1="34" x2="50" y2="50"/>'
              f'<line x1="37" y1="50" x2="37" y2="66"/><line x1="63" y1="50" x2="63" y2="66"/></g>')

BRAIN = (f'<path d="M50 26 C42 22 31 27 31 38 C24 40 24 51 30 54 C27 62 34 70 43 67 '
         f'C45 74 55 74 57 67 C66 70 73 62 70 54 C76 51 76 40 69 38 C69 27 58 22 50 26 Z" {FL}/>'
         # white central fissure + gyri folds → reads as a brain, not a lump
         f'<g {LWt}><path d="M50 28 V68"/><path d="M40 38 q8 4 0 9 q-8 4 0 9"/>'
         f'<path d="M60 40 q-8 4 0 9 q8 5 0 9"/></g>')
I["brain"] = BRAIN

I["cage"] = (f'<path d="M30 30 H70 L66 70 H34 Z" {SH2}/>'
             f'<path d="M30 30 H70 L66 70 H34 Z" {STm}/>'
             f'<g {STt}><line x1="42" y1="30" x2="40" y2="70"/><line x1="50" y1="30" x2="50" y2="70"/>'
             f'<line x1="58" y1="30" x2="60" y2="70"/></g>'
             f'<path d="M40 30 q10 -10 20 0" {STm}/><circle cx="50" cy="21" r="3.6" {FL}/>'
             f'<ellipse cx="50" cy="58" rx="4" ry="5" {FL}/>')

I["charge"] = (  # a battery charging, lightning bolt in the window
              f'<rect x="30" y="30" width="40" height="44" rx="4" {FL}/>'
              f'<rect x="42" y="23" width="16" height="8" rx="2" {FL}/>'
              f'<rect x="35" y="35" width="30" height="34" rx="2" {CUT}/>'
              f'<polygon points="53,38 42,55 50,55 47,66 60,47 52,47" {FL}/>')

I["corruption"] = (f'<path d="M30 44 q4 -12 20 -12 q16 0 20 12 q8 2 6 12 q8 8 0 16 q-6 6 -14 2 '
                   f'q-4 6 -12 4 q-8 4 -14 -4 q-10 -2 -8 -14 q-6 -8 2 -16 Z" {FL}/>'
                   f'<path d="M30 44 q4 -12 20 -12 q4 22 -6 30 q-8 4 -14 -4 q-10 -2 -8 -14 q-6 -8 2 -16 Z" {SH2}/>'
                   f'<circle cx="42" cy="50" r="3" {CUT}/><circle cx="58" cy="54" r="2.5" {CUT}/>'
                   f'<path d="M40 78 q2 7 0 11 M52 78 q2 8 0 12 M62 74 q3 7 1 12" {STt} opacity="0.8"/>')

I["corpse"] = (skull(50, 28, 0.42, teeth=False, detail=False)
               +
               f'<line x1="50" y1="40" x2="50" y2="67" {STm}/>'
               f'<path d="M35 45 H65 M38 53 H62 M41 61 H59" {STh} opacity="0.65"/>'
               f'<line x1="50" y1="47" x2="34" y2="63" {STm}/><line x1="50" y1="47" x2="66" y2="63" {STm}/>'
               f'<line x1="50" y1="67" x2="39" y2="82" {STm}/><line x1="50" y1="67" x2="61" y2="82" {STm}/>'
               f'<circle cx="34" cy="63" r="3" {FL}/><circle cx="66" cy="63" r="3" {FL}/>'
               f'<circle cx="39" cy="82" r="3" {FL}/><circle cx="61" cy="82" r="3" {FL}/>')

I["cube"] = (f'<polygon points="50,22 74,36 74,64 50,78 26,64 26,36" {FL}/>'
             # all faces black; white internal edges define the corner where they meet (3D read)
             f'<polyline points="26,36 50,50 74,36" {LW}/>'
             f'<line x1="50" y1="50" x2="50" y2="78" {LW}/>')

I["discovery"] = (f'<circle cx="44" cy="44" r="18" {SH2}/>'
                  f'<circle cx="44" cy="44" r="18" fill="none" stroke="currentColor" stroke-width="5.5"/>'
                  f'<circle cx="44" cy="44" r="10" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5"/>'
                  f'<path d="M38 39 a8 8 0 0 1 6 -4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity="0.8"/>'
                  f'<line x1="57" y1="57" x2="76" y2="76" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>')

I["dream"] = (  # a daydream thought-cloud with a star and trailing bubbles (moon now belongs to `night`)
              f'<path d="M32 58 C24 58 22 48 28 44 C26 34 40 30 46 36 C52 28 66 32 66 42 C74 42 76 54 68 57 C60 62 40 62 32 58 Z" {FL}/>'
              + star(47, 47, 7, 2.8, 5, -90, CUT)
              + f'<circle cx="61" cy="66" r="3.5" {FL}/><circle cx="67" cy="73" r="2.2" {FL}/>')

I["echo"] = (f'<circle cx="36" cy="50" r="5" {FL}/>'
             f'<g fill="none" stroke="currentColor" stroke-linecap="round">'
             f'<path d="M48 38 a16 16 0 0 1 0 24" stroke-width="5"/>'
             f'<path d="M58 30 a28 28 0 0 1 0 40" stroke-width="4" opacity="0.7"/>'
             f'<path d="M68 22 a40 40 0 0 1 0 56" stroke-width="3" opacity="0.45"/></g>')

I["energy"] = (f'<circle cx="50" cy="50" r="27" {SH2}/>'
               f'<circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="3"/>'
               + bolt(0.66, 17, 17, sparks=False))

I["everything"] = (star(50, 50, 31, 8, 4, -90, FL) + star(50, 50, 22, 6, 4, -45, SH)
                   + star(50, 50, 11, 4, 4, -90, FL))

I["experience"] = (star(50, 36, 15, 6.5, 5, -90, FL) + star(50, 36, 9, 3.5, 5, -90, SH2)
                   + f'<circle cx="50" cy="36" r="15" fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.5"/>'
                   f'<polygon points="42,49 58,49 62,76 50,67 38,76" {FL}/>'
                   f'<polygon points="50,49 58,49 62,76 50,67" {SH}/>')

I["eyeball"] = (f'<path d="M18 50 Q50 24 82 50 Q50 76 18 50 Z" {FL}/>'
                f'<path d="M18 50 Q50 24 82 50 Q50 62 18 50 Z" {SH2}/>'
                f'<circle cx="50" cy="50" r="15" {CUT}/><circle cx="50" cy="50" r="9" {SH}/><circle cx="50" cy="50" r="4.4" {FL}/>'
                f'<circle cx="55" cy="45" r="2.8" {GL}/>'
                f'<path d="M26 47 q8 -2 14 3 M74 47 q-8 -2 -14 3 M32 56 q9 2 14 -2 M68 56 q-9 2 -14 -2" {STh} opacity="0.45"/>'
                f'<path d="M22 45 Q18 40 15 37 M78 45 Q82 40 85 37 M50 35 V29" {STh} opacity="0.55"/>')

I["eyestalk"] = (f'<path d="M50 82 C42 70 42 58 50 50" stroke="currentColor" stroke-width="7" fill="none" stroke-linecap="round"/>'
                 f'<path d="M50 82 C46 70 46 58 50 50" stroke="currentColor" stroke-width="2" fill="none" opacity="0.4"/>'
                 f'<path d="M28 38 Q50 20 72 38 Q50 56 28 38 Z" {FL}/>'
                 f'<path d="M28 38 Q50 20 72 38 Q50 47 28 38 Z" {SH2}/>'
                 f'<circle cx="50" cy="38" r="7" {CUT}/><circle cx="50" cy="38" r="4" {FL}/>'
                 f'<circle cx="52" cy="36" r="1.5" {GL}/>')

I["fade"] = (star(46, 48, 23, 9, 5, -90, FL) + star(46, 48, 14, 5, 5, -90, SH2)
             + f'<circle cx="70" cy="36" r="3" {FL}/><circle cx="74" cy="50" r="2.3" {SH}/>'
             f'<circle cx="66" cy="60" r="2" {FL}/><circle cx="75" cy="64" r="1.6" {SH}/>'
             f'<circle cx="71" cy="44" r="1.4" {SH}/>')

I["fate"] = (f'<g {STt}><path d="M20 26 C44 40 56 46 68 50"/><path d="M20 74 C44 60 56 54 68 50"/></g>'
             f'<circle cx="72" cy="40" r="7" fill="none" stroke="currentColor" stroke-width="3.2"/>'
             f'<circle cx="72" cy="60" r="7" fill="none" stroke="currentColor" stroke-width="3.2"/>'
             f'<line x1="69" y1="45" x2="54" y2="60" {STt}/><line x1="69" y1="55" x2="54" y2="40" {STt}/>'
             f'<circle cx="72" cy="40" r="2.6" {SH2}/><circle cx="72" cy="60" r="2.6" {SH2}/>')

I["feeding"] = (f'<path d="M22 40 Q50 24 78 40 L66 45 Q50 36 34 45 Z" {FL}/>'
                f'<path d="M22 60 Q50 76 78 60 L66 55 Q50 64 34 55 Z" {FL}/>'
                f'<path d="M22 40 Q50 24 78 40 L66 45 Q50 36 34 45 Z" {SH2}/>'
                f'<polygon points="38,45 42,53 46,45" {CUT}/><polygon points="54,45 58,53 62,45" {CUT}/>'
                f'<polygon points="46,55 50,47 54,55" {CUT}/><polygon points="34,55 38,49 42,55" {CUT}/>'
                f'<polygon points="58,55 62,49 66,55" {CUT}/>')

I["fellowship"] = (f'<path d="M22 49 C30 39 38 36 44 42 L51 49 L45 56 L37 49 C33 46 29 48 25 55 Z" {FL}/>'
                   f'<path d="M78 49 C70 39 62 36 56 42 L49 49 L55 56 L63 49 C67 46 71 48 75 55 Z" {FL}/>'
                   f'<path d="M38 50 L47 59 C50 62 54 62 57 59 L64 52" {STm}/>'
                   f'<path d="M42 54 L49 61 M50 49 L58 57 M31 57 L39 67 M69 57 L61 67" {STh} opacity="0.65"/>'
                   f'<circle cx="50" cy="50" r="3.2" {GL}/>')

I["fetch"] = (  # a FRISBEE (flying disc) tilted in flight, with motion streaks
              f'<g transform="rotate(-16 55 47)">'
              f'<ellipse cx="55" cy="47" rx="27" ry="11" {FL}/>'
              f'<line x1="29" y1="47" x2="81" y2="47" {LW}/>'                # rim/dome seam
              f'<ellipse cx="55" cy="44" rx="16" ry="5.4" fill="none" stroke="#fff" stroke-width="1.8"/>'
              f'<ellipse cx="55" cy="44" rx="7" ry="2.4" fill="none" stroke="#fff" stroke-width="1.8"/>'
              f'</g>'
              f'<g {STm}><path d="M14 62 H30"/><path d="M12 70 H28"/><path d="M20 77 H34"/></g>'
              f'<circle cx="20" cy="55" r="1.8" {FL}/>')

I["filibuster"] = (  # a long unfurling speech scroll with a curled bottom + lots of text
                   f'<path d="M32 26 H62 a4 4 0 0 1 4 4 V72 a6 6 0 0 1 -12 0 V68 H30 a4 4 0 0 1 -4 -4 V30 a4 4 0 0 0 8 0 Z" {FL}/>'
                   f'<g {LWt}>' + "".join(f'<line x1="34" y1="{y}" x2="58" y2="{y}"/>' for y in (34, 40, 46, 52, 58, 64)) + '</g>')

I["finality"] = (f'<path d="M30 80 V44 a20 20 0 0 1 40 0 V80 Z" {FL}/>'
                 f'<path d="M30 80 V44 a20 20 0 0 1 20 -20 V80 Z" {SH2}/>'
                 f'<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"><line x1="50" y1="48" x2="50" y2="66"/><line x1="42" y1="56" x2="58" y2="56"/></g>'
                 f'<line x1="25" y1="80" x2="75" y2="80" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
                 f'<ellipse cx="50" cy="80" rx="25" ry="3" {SH2}/>')

I["fungus"] = (f'<path d="M22 52 C22 33 37 25 50 25 C63 25 78 33 78 52 C78 56 74 56 69 56 H31 C26 56 22 56 22 52 Z" {FL}/>'
               f'<path d="M22 52 C22 33 37 25 50 25 C50 40 40 52 31 56 H31 C26 56 22 56 22 52 Z" {SH2}/>'
               f'<path d="M41 56 C41 70 39 76 37 80 H63 C61 76 59 70 59 56 Z" {FL}/>'
               f'<path d="M41 56 C41 70 39 76 37 80 H50 V56 Z" {SH2}/>'
               f'<circle cx="40" cy="41" r="3.5" {CUT}/><circle cx="58" cy="39" r="4" {CUT}/><circle cx="50" cy="47" r="2.6" {CUT}/>')

I["ghostform"] = (f'<path d="M30 75 V48 a20 20 0 0 1 40 0 V75 L62 69 L54 75 L46 69 L38 75 Z" {FL}/>'
                  f'<path d="M30 75 V48 a20 20 0 0 1 20 -20 V75 L46 69 L38 75 Z" {SH2}/>'
                  f'<circle cx="42" cy="46" r="3.6" {CUT}/><circle cx="58" cy="46" r="3.6" {CUT}/>'
                  f'<circle cx="42" cy="46" r="1.6" {FL}/><circle cx="58" cy="46" r="1.6" {FL}/>')

I["glyph"] = (f'<circle cx="50" cy="50" r="27" {SH2}/>'
              f'<g {ST}><polyline points="38,24 38,76"/><polyline points="38,30 60,30"/>'
              f'<polyline points="60,30 60,50 40,50"/><line x1="50" y1="62" x2="64" y2="76"/></g>'
              f'<circle cx="62" cy="40" r="2.8" {FL}/>')

I["growth"] = (f'<path d="M50 82 V40" {ST}/>'
               f'<path d="M50 54 C40 54 29 48 27 35 C42 33 50 42 50 54 Z" {FL}/>'
               f'<path d="M50 46 C60 46 71 40 73 27 C58 25 50 34 50 46 Z" {FL}/>'
               # white midrib veins in each leaf
               f'<path d="M49 53 C44 49 37 44 31 39 M51 45 C56 41 63 36 69 31" {LWt}/>')

I["harmony"] = (f'<circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="3.5"/>'
                f'<path d="M50 23 a13.5 13.5 0 0 1 0 27 a13.5 13.5 0 0 0 0 27 A27 27 0 0 1 50 23 Z" {FL}/>'
                f'<circle cx="50" cy="36.5" r="4" {CUT}/><circle cx="50" cy="63.5" r="4" {FL}/>')

I["hatching"] = (f'<g {STm}>'
                 f'<path d="M31 56 Q31 80 50 80 Q69 80 69 56 L63 62 L57 54 L51 62 L45 54 L39 62 L33 56 Z"/>'
                 f'<path d="M35 48 Q35 30 50 28 Q65 30 65 48 L59 42 L53 50 L47 42 L41 50 Z"/></g>'
                 f'<path d="M31 56 Q31 80 50 80 V56 Z" {SH2}/>'
                 f'<path d="M44 25 L40 18 M51 23 L51 16 M58 26 L63 20" {STt} opacity="0.8"/>')

I["healing"] = (f'<path d="M42 24 H58 V42 H76 V58 H58 V76 H42 V58 H24 V42 H42 Z" {FL}/>'
                f'<path d="M42 24 H58 V42 H76 V58 H58 V76 H50 V24 Z" {SH2}/>'
                f'<circle cx="50" cy="50" r="4" {GL}/>')

I["hit"] = (star(50, 50, 31, 11, 8, -90, FL) + star(50, 50, 18, 6, 8, -90, SH)
            + f'<circle cx="50" cy="50" r="5" {GL}/>')

I["hunger"] = (f'<path d="M25 36 Q50 28 75 36 Q70 72 50 80 Q30 72 25 36 Z" {FL}/>'
               f'<path d="M25 36 Q50 28 75 36 Q72 50 50 54 Q28 50 25 36 Z" {SH2}/>'
               f'<polygon points="33,40 37,51 41,40" {CUT}/><polygon points="45,42 50,54 55,42" {CUT}/>'
               f'<polygon points="59,40 63,51 67,40" {CUT}/>'
               f'<polygon points="40,64 44,55 48,64" {CUT}/><polygon points="52,64 56,55 60,64" {CUT}/>')

I["immunity"] = (  # a protective ward bubble with a health plus + radiant sparks
                 f'<circle cx="50" cy="50" r="24" {FL}/>'
                 f'<circle cx="50" cy="50" r="24" fill="none" stroke="#fff" stroke-width="2"/>'
                 f'<path d="M40 38 q-8 6 -8 18" {LWt}/>'
                 f'<path d="M50 40 V60 M40 50 H60" {LW}/>'
                 + "".join(f'<line x1="{onc(50,50,27,a)[0]:.1f}" y1="{onc(50,50,27,a)[1]:.1f}" '
                           f'x2="{onc(50,50,32,a)[0]:.1f}" y2="{onc(50,50,32,a)[1]:.1f}" {STt}/>' for a in range(0, 360, 45)))

I["incarnation"] = (f'<path d="M50 22 C40 22 33 30 33 42 C33 50 37 54 37 62 C29 66 27 80 27 80 '
                    f'C40 75 46 77 50 82 C54 77 60 75 73 80 C73 80 71 66 63 62 C63 54 67 50 67 42 '
                    f'C67 30 60 22 50 22 Z" {FL}/>'
                    f'<path d="M50 22 C40 22 33 30 33 42 C33 50 37 54 37 62 C29 66 27 80 27 80 '
                    f'C40 75 46 77 50 82 Z" {SH2}/>'
                    f'<circle cx="44" cy="42" r="3" {CUT}/><circle cx="56" cy="42" r="3" {CUT}/>'
                    f'<path d="M44 52 q6 4 12 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>')

I["incubation"] = (f'<ellipse cx="50" cy="44" rx="14" ry="18" {FL}/>'
                   f'<ellipse cx="50" cy="44" rx="14" ry="18" {SH2}/>'
                   f'<ellipse cx="45" cy="36" rx="4" ry="6" {GL}/>'
                   f'<g {STt}><path d="M22 64 Q36 54 50 64 Q64 54 78 64"/><path d="M24 64 Q50 80 76 64"/></g>'
                   f'<g {STh} opacity="0.6"><path d="M30 60 L26 67 M42 62 L38 69 M58 62 L62 69 M70 60 L74 67"/></g>')

I["infection"] = (f'<circle cx="50" cy="50" r="15" {FL}/><circle cx="50" cy="50" r="15" {SH2}/>'
                  f'<circle cx="44" cy="47" r="3" {CUT}/><circle cx="55" cy="53" r="3.5" {CUT}/>'
                  + "".join(f'<line x1="{onc(50,50,15,a)[0]:.1f}" y1="{onc(50,50,15,a)[1]:.1f}" x2="{onc(50,50,25,a)[0]:.1f}" y2="{onc(50,50,25,a)[1]:.1f}" {STt}/>'
                            f'<circle cx="{onc(50,50,28,a)[0]:.1f}" cy="{onc(50,50,28,a)[1]:.1f}" r="2.6" {FL}/>'
                            for a in range(0, 360, 45)))

I["influence"] = (f'<line x1="24" y1="26" x2="76" y2="26" {ST}/>'
                  f'<g {STt}><line x1="36" y1="26" x2="42" y2="44"/><line x1="64" y1="26" x2="58" y2="44"/>'
                  f'<line x1="50" y1="26" x2="50" y2="40"/></g>'
                  f'<circle cx="50" cy="48" r="7" {FL}/><circle cx="50" cy="48" r="7" {SH2}/>'
                  f'<path d="M40 50 L36 72 M60 50 L64 72 M50 56 L50 76" {STt} opacity="0.8"/>')

I["invitation"] = (  # a CLOSED, wax-sealed envelope (flap folded down to a center seal)
                   f'<rect x="23" y="31" width="54" height="38" rx="3.5" {FL}/>'
                   f'<path d="M23 34 L50 54 L77 34" {LW}/>'          # folded flap edges meeting at center
                   f'<circle cx="50" cy="55" r="6" {GL}/>'           # wax seal
                   f'<path d="M47 53 l3 3 l3 -3 M47 57 h6" {STt}/>')  # monogram on the seal

I["isolation"] = (  # a lone figure hunched in the corner of a box/room
                  f'<rect x="24" y="24" width="52" height="52" rx="2.5" fill="none" stroke="currentColor" stroke-width="3.5"/>'
                  f'<circle cx="40" cy="55" r="6.5" {FL}/>'                              # bowed head
                  f'<path d="M30 73 C30 63 34 59 41 60 C49 61 53 67 53 73 Z" {FL}/>'      # curled body/knees
                  f'<path d="M33 66 q8 -3 15 2" {LWt}/>')                                 # arms hugging knees

I["judgment"] = (f'<line x1="50" y1="24" x2="50" y2="72" {STm}/><line x1="28" y1="33" x2="72" y2="33" {STm}/>'
                 f'<circle cx="50" cy="24" r="4" {FL}/>'
                 f'<path d="M28 33 L20 53 a11 6 0 0 0 16 0 Z" {FL}/><path d="M28 33 L20 53 a11 6 0 0 0 16 0 Z" {SH2}/>'
                 f'<path d="M72 33 L64 53 a11 6 0 0 0 16 0 Z" {FL}/><path d="M72 33 L64 53 a11 6 0 0 0 16 0 Z" {SH2}/>'
                 f'<g {STt}><line x1="50" y1="33" x2="28" y2="33"/><line x1="50" y1="33" x2="72" y2="33"/>'
                 f'<line x1="40" y1="74" x2="60" y2="74"/></g>')

I["knowledge"] = (f'<path d="M50 44 C44 38 33 38 27 40 V70 C33 68 44 68 50 72 C56 68 67 68 73 70 V40 C67 38 56 38 50 44 Z" {FL}/>'
                  # white spine + ruled page lines → reads as an open book
                  f'<path d="M50 44 V72" {LW}/>'
                  f'<g {LWt}>'
                  f'<line x1="32" y1="48" x2="46" y2="49"/><line x1="32" y1="56" x2="46" y2="57"/><line x1="32" y1="64" x2="44" y2="64"/>'
                  f'<line x1="54" y1="49" x2="68" y2="48"/><line x1="54" y1="57" x2="68" y2="56"/><line x1="56" y1="64" x2="68" y2="64"/>'
                  f'</g>'
                  # radiant rays sit on the parchment, so they stay dark
                  f'<g {STt}><line x1="50" y1="34" x2="50" y2="23"/><line x1="38" y1="36" x2="31" y2="27"/>'
                  f'<line x1="62" y1="36" x2="69" y2="27"/></g>'
                  + star(50, 31, 4.5, 1.8, 4, -90, FL))

I["level"] = (f'<polygon points="26,74 26,62 42,62 42,50 58,50 58,38 74,38 74,26 74,74" {FL}/>'
              # white tread/riser edges → reads as ascending steps
              f'<polyline points="26,62 42,62 42,50 58,50 58,38 74,38 74,26" {LW}/>')

I["luck"] = (  # a FOUR-LEAF CLOVER: four heart leaves meeting at center, veined, with a stem
             "".join(f'<path d="{heart_d(50,42.5,22)}" transform="rotate({a} 50 50)" {FL}/>' for a in (0, 90, 180, 270))
             + "".join(f'<path d="M50 50 V29" transform="rotate({a} 50 50)" {LWt}/>' for a in (0, 90, 180, 270))
             + f'<path d="M50 50 C53 64 56 73 62 81" {STm}/>')

I["lure"] = (f'<line x1="48" y1="22" x2="48" y2="58" {STm}/>'
             f'<path d="M48 58 a12 12 0 1 0 24 0 V52" {STm}/>'
             f'<circle cx="48" cy="22" r="5" fill="none" stroke="currentColor" stroke-width="3.4"/>'
             f'<polygon points="72,40 67,52 77,52" {FL}/>'
             f'<circle cx="60" cy="70" r="2.4" {SH}/>')

I["manifestation"] = (f'<path d="M50 24 C40 24 32 32 32 46 V66 L40 60 L48 66 L50 64 L52 66 L60 60 L68 66 V46 C68 32 60 24 50 24 Z" {FL}/>'
                      f'<path d="M50 24 C40 24 32 32 32 46 V66 L40 60 L48 66 L50 64 Z" {SH2}/>'
                      f'<circle cx="43" cy="44" r="3" {CUT}/><circle cx="57" cy="44" r="3" {CUT}/>'
                      f'<path d="M30 80 q8 -6 16 0 M54 80 q8 -6 16 0" {STt} opacity="0.7"/>')

I["matrix"] = (f'<rect x="26" y="26" width="48" height="48" rx="3" {FL}/>'
               # white grid lines + lit nodes → reads as a grid/matrix
               f'<g {LWt}>' + "".join(f'<line x1="{x}" y1="28" x2="{x}" y2="72"/>' for x in (42, 58))
               + "".join(f'<line x1="28" y1="{y}" x2="72" y2="{y}"/>' for y in (42, 58)) + '</g>'
               f'<circle cx="42" cy="42" r="2.8" {CUT}/><circle cx="58" cy="58" r="2.8" {CUT}/>')

I["memory"] = (f'<g transform="translate(46 52) scale(0.74) translate(-50 -50)">{BRAIN}</g>'
               + bolt(0.40, 56, 26, sparks=False))

I["mine"] = (f'<g transform="rotate(18 50 50)"><rect x="47" y="26" width="6" height="50" rx="3" {FL}/>'
             f'<rect x="47" y="26" width="3" height="50" {SH2}/>'
             f'<path d="M24 36 Q50 22 76 36 Q66 42 50 40 Q34 42 24 36 Z" {FL}/>'
             f'<path d="M24 36 Q50 22 76 36 Q63 39 50 40 Q37 39 24 36 Z" {SH2}/></g>')

I["mining"] = ("".join(
    f'<g transform="rotate({r} 50 50)"><rect x="47.5" y="20" width="5" height="40" rx="2.5" {FL}/>'
    f'<path d="M30 30 Q50 19 70 30 Q62 36 50 35 Q38 36 30 30 Z" {FL}/>'
    f'<path d="M30 30 Q50 19 70 30 Q60 33 50 35 Z" {SH2}/></g>' for r in (45, -45))
    + f'<polygon points="38,72 50,60 62,72 56,80 44,80" {FL}/>'
    f'<polygon points="38,72 50,60 50,80 44,80" {SH2}/>')

I["mire"] = (f'<path d="M22 58 q6 -8 14 -4 q4 -8 14 -6 q8 -4 14 4 q10 -2 12 8 q4 10 -8 14 '
             f'q-20 4 -38 0 q-12 -4 -8 -16 Z" {FL}/>'
             f'<path d="M22 58 q6 -8 14 -4 q4 -8 14 -6 q4 16 -4 26 q-20 4 -38 0 q-12 -4 -8 -16 Z" {SH2}/>'
             f'<path d="M40 50 q3 -6 8 -4 M58 52 q4 -5 8 -2" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" opacity="0.8"/>'
             f'<circle cx="36" cy="68" r="2.4" {CUT}/><circle cx="60" cy="66" r="2" {CUT}/>'
             f'<circle cx="48" cy="72" r="1.6" {CUT}/>')

I["music"] = (f'<path d="M33 29 C31 45 34 61 50 73 C66 61 69 45 67 29" {STm}/>'
              f'<path d="M33 29 H67" {STm}/>'
              f'<path d="M43 33 V65 M50 33 V72 M57 33 V65" {STh} opacity="0.65"/>'
              f'<path d="M39 48 q11 -8 22 0" {STh} opacity="0.55"/>'
              f'<circle cx="33" cy="29" r="4" {FL}/><circle cx="67" cy="29" r="4" {FL}/>'
              f'<ellipse cx="50" cy="74" rx="8" ry="4" {FL}/>')

I["muster"] = (f'<line x1="32" y1="20" x2="32" y2="82" {ST}/>'
               f'<path d="M32 26 H72 V52 H32 Z" {FL}/>'
               f'<path d="M32 26 H72 L32 52 Z" {SH2}/>'
               + star(52, 39, 8, 3.4, 5, -90, CUT))

I["net"] = (f'<path d="M27 25 H73 L79 75 H21 Z" {SH2}/>'
            f'<path d="M27 25 H73 L79 75 H21 Z" {STm}/>'
            f'<g {STt}>'
            f'<path d="M36 25 L31 75 M50 25 V75 M64 25 L69 75"/>'
            f'<path d="M24 38 H76 M23 51 H77 M22 64 H78"/>'
            f'<path d="M27 25 L79 75 M73 25 L21 75"/></g>'
            f'<circle cx="50" cy="51" r="3" {FL}/><circle cx="36" cy="38" r="2" {FL}/><circle cx="64" cy="64" r="2" {FL}/>')

I["nest"] = (f'<path d="M24 56 Q50 40 76 56 Q72 76 50 78 Q28 76 24 56 Z" {FL}/>'
             f'<path d="M24 56 Q50 40 76 56 Q72 66 50 68 Q28 66 24 56 Z" {SH2}/>'
             f'<g stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none" opacity="0.55">'
             f'<path d="M28 60 Q50 50 72 60"/><path d="M30 66 Q50 58 70 66"/></g>'
             f'<ellipse cx="42" cy="52" rx="6" ry="5" {CUT}/><ellipse cx="56" cy="50" rx="6" ry="5" {CUT}/>'
             f'<ellipse cx="42" cy="52" rx="6" ry="5" {STh}/><ellipse cx="56" cy="50" rx="6" ry="5" {STh}/>')

I["omen"] = (star(63, 35, 15, 6, 5, -90, FL) + star(63, 35, 9, 3.4, 5, -90, SH2)
             + f'<g {STt} opacity="0.85"><path d="M52 46 L26 70"/><path d="M58 50 L34 72"/><path d="M48 42 L24 62"/></g>')

I["pain"] = (f'<path d="{heart_d(50,52,48)}" {FL}/>'
             f'<polygon points="50,26 43,46 57,52 47,76 53,52 41,46 56,26" {CUT}/>'
             f'<polyline points="50,26 43,46 57,52 47,76" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4"/>')

I["paralyzation"] = (f'<g {STm}><circle cx="50" cy="34" r="7"/><line x1="50" y1="41" x2="50" y2="62"/>'
                     f'<line x1="50" y1="48" x2="36" y2="42"/><line x1="50" y1="48" x2="64" y2="42"/>'
                     f'<line x1="50" y1="62" x2="40" y2="78"/><line x1="50" y1="62" x2="60" y2="78"/></g>'
                     + bolt(0.34, 60, 8, sparks=False) + bolt(0.34, 8, 8, sparks=False))

I["pause"] = (f'<rect x="33" y="27" width="13" height="46" rx="3" {FL}/>'
              f'<rect x="54" y="27" width="13" height="46" rx="3" {FL}/>'
              f'<rect x="33" y="27" width="5" height="46" rx="2" {SH2}/>'
              f'<rect x="54" y="27" width="5" height="46" rx="2" {SH2}/>')

I["petrification"] = (f'<path d="M32 28 H68 L73 50 L64 80 H36 L27 50 Z" {FL}/>'
                      f'<path d="M32 28 H68 L73 50 L50 56 L27 50 Z" {SH2}/>'
                      f'<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"><line x1="44" y1="48" x2="40" y2="48"/>'
                      f'<line x1="60" y1="48" x2="56" y2="48"/><line x1="42" y1="66" x2="58" y2="66"/></g>'
                      f'<g {STh} opacity="0.5"><line x1="32" y1="40" x2="40" y2="38"/><line x1="68" y1="40" x2="60" y2="38"/></g>')

I["phylactery"] = (f'<circle cx="50" cy="25" r="6" fill="none" stroke="currentColor" stroke-width="4"/>'
                   f'<line x1="50" y1="31" x2="50" y2="40" stroke="currentColor" stroke-width="3.6"/>'
                   f'<path d="M50 40 L71 56 L50 82 L29 56 Z" {FL}/>'
                   f'<path d="M50 40 L71 56 L50 82 Z" {SH2}/>'
                   f'<circle cx="50" cy="58" r="7" {SH}/>' + star(50, 58, 4.5, 1.8, 4, -90, GL))

I["phyresis"] = (f'<line x1="50" y1="18" x2="50" y2="84" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>'
                 f'<ellipse cx="50" cy="44" rx="15" ry="13" fill="none" stroke="currentColor" stroke-width="5.5"/>'
                 f'<ellipse cx="50" cy="44" rx="15" ry="13" {SH2}/>'
                 f'<path d="M36 64 q-8 6 -4 16 M64 64 q8 6 4 16" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>')

I["plague"] = (f'<circle cx="44" cy="44" r="11" {FL}/><circle cx="62" cy="50" r="9" {FL}/><circle cx="50" cy="62" r="8" {FL}/>'
               f'<circle cx="44" cy="44" r="11" {SH2}/>'
               f'<circle cx="44" cy="44" r="3.5" {CUT}/><circle cx="62" cy="50" r="3" {CUT}/><circle cx="50" cy="62" r="2.6" {CUT}/>'
               f'<circle cx="30" cy="34" r="2.6" {FL}/><circle cx="70" cy="34" r="2.2" {FL}/><circle cx="72" cy="66" r="2.4" {FL}/>')

I["plot"] = (f'<path d="M26 29 H74 V74 H26 Z" {FL}/>'
             f'<path d="M26 29 H74 V74 H26 Z" {SH2}/>'
             f'<path d="M26 29 H74 V74 H26 Z" {STt}/>'
             f'<g {STh} opacity="0.45"><line x1="38" y1="29" x2="38" y2="74"/><line x1="50" y1="29" x2="50" y2="74"/>'
             f'<line x1="62" y1="29" x2="62" y2="74"/><line x1="26" y1="43" x2="74" y2="43"/><line x1="26" y1="58" x2="74" y2="58"/></g>'
             f'<path d="M34 64 C42 46 51 58 57 39 C61 28 68 34 69 35" {STm}/>'
             f'<circle cx="34" cy="64" r="3.5" {CUT}/><circle cx="57" cy="39" r="3" {CUT}/><polygon points="69,28 75,39 63,39" {CUT}/>')

I["point"] = (f'<circle cx="50" cy="50" r="22" fill="none" stroke="currentColor" stroke-width="4.5"/>'
              f'<circle cx="50" cy="50" r="13" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"/>'
              f'<circle cx="50" cy="50" r="4" {FL}/>'
              f'<g stroke="currentColor" stroke-width="4.5" stroke-linecap="round">'
              f'<line x1="50" y1="20" x2="50" y2="33"/><line x1="50" y1="67" x2="50" y2="80"/>'
              f'<line x1="20" y1="50" x2="33" y2="50"/><line x1="67" y1="50" x2="80" y2="50"/></g>')

I["polyp"] = (f'<path d="M50 82 V40" {STm}/>'
              f'<g {STt}><path d="M50 56 C40 56 30 50 30 38 C42 38 50 46 50 56"/>'
              f'<path d="M50 50 C60 50 70 44 70 32 C58 32 50 40 50 50"/>'
              f'<path d="M50 42 C44 42 38 38 38 28"/><path d="M50 42 C56 42 62 38 62 28"/></g>'
              f'<circle cx="50" cy="34" r="3.4" {FL}/><circle cx="38" cy="27" r="2.6" {FL}/>'
              f'<circle cx="62" cy="27" r="2.6" {FL}/><circle cx="30" cy="37" r="2.6" {FL}/><circle cx="70" cy="31" r="2.6" {FL}/>')

I["pressure"] = (f'<rect x="26" y="23" width="48" height="11" rx="2" {FL}/>'
                 f'<rect x="26" y="23" width="48" height="4" {SH2}/>'
                 f'<rect x="32" y="58" width="36" height="11" rx="2" {FL}/>'
                 f'<line x1="50" y1="34" x2="50" y2="46" {STm}/>'
                 f'<g stroke="currentColor" stroke-width="4" stroke-linecap="round"><line x1="40" y1="40" x2="40" y2="48"/><line x1="60" y1="40" x2="60" y2="48"/></g>'
                 f'<polygon points="44,46 56,46 50,55" {FL}/>'
                 f'<line x1="32" y1="74" x2="68" y2="74" {ST}/>')

I["pupa"] = (f'<path d="M50 20 C38 20 33 33 33 50 C33 69 42 80 50 80 C58 80 67 69 67 50 C67 33 62 20 50 20 Z" {FL}/>'
             f'<path d="M50 20 C38 20 33 33 33 50 C33 69 42 80 50 80 Z" {SH2}/>'
             f'<g stroke="#fff" stroke-width="2.8" stroke-linecap="round" opacity="0.8">'
             f'<line x1="40" y1="30" x2="60" y2="38"/><line x1="60" y1="30" x2="40" y2="38"/>'
             f'<line x1="40" y1="46" x2="60" y2="54"/><line x1="60" y1="46" x2="40" y2="54"/>'
             f'<line x1="42" y1="62" x2="58" y2="68"/><line x1="58" y1="62" x2="42" y2="68"/></g>')

I["rad"] = ("".join(f'<path d="{wedge(50,50,9,30,c-50,c+50)}" {FL}/>' for c in (-90, 30, 150))
            + f'<circle cx="50" cy="50" r="6" {FL}/>'
            + "".join(f'<path d="{wedge(50,50,9,30,c-50,c-10)}" {SH2}/>' for c in (-90, 30, 150)))

I["revival"] = (f'<path d="M50 82 C50 82 28 64 28 43 C28 29 39 21 50 26 C61 21 72 29 72 43 '
                f'C72 56 61 60 56 56 C58 64 52 71 50 82 Z" {FL}/>'
                f'<path d="M50 82 C50 82 28 64 28 43 C28 29 39 21 50 26 C50 40 50 70 50 82 Z" {SH2}/>'
                f'<path d="M50 72 C48 60 44 56 44 45 M50 72 C52 60 56 56 56 45" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none" opacity="0.8"/>')

I["ribbon"] = (f'<path d="M30 22 H70 V64 L50 52 L30 64 Z" {FL}/>'
               f'<path d="M30 22 H50 V58 L30 64 Z" {SH2}/>'
               f'<polygon points="30,64 38,64 30,78" {FL}/><polygon points="70,64 62,64 70,78" {FL}/>'
               f'<circle cx="50" cy="40" r="6.5" {CUT}/>' + star(50, 40, 4, 1.6, 5, -90, FL))

I["rust"] = (cog() + f'<polyline points="50,30 45,44 53,50 47,60 50,70" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>'
             f'<circle cx="38" cy="40" r="2" {CUT}/><circle cx="62" cy="58" r="1.8" {CUT}/><circle cx="58" cy="36" r="1.6" {CUT}/>')

I["shred"] = (f'<path d="M32 22 H68 V72 L62 66 L56 74 L50 66 L44 74 L38 66 L32 74 Z" {FL}/>'
              f'<path d="M32 22 H50 V70 L44 74 L38 66 L32 74 Z" {SH2}/>'
              f'<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"><line x1="40" y1="34" x2="60" y2="34"/>'
              f'<line x1="40" y1="44" x2="60" y2="44"/><line x1="40" y1="54" x2="56" y2="54"/></g>')

I["silver"] = (  # a stack of two silver pieces (coins) seen at an angle, with shine
               f'<ellipse cx="50" cy="59" rx="22" ry="9" {FL}/>'
               f'<rect x="28" y="49" width="44" height="10" {FL}/>'
               f'<ellipse cx="50" cy="49" rx="22" ry="9" {FL}/>'
               f'<ellipse cx="50" cy="49" rx="22" ry="9" fill="none" stroke="#fff" stroke-width="1.6"/>'
               f'<ellipse cx="50" cy="49" rx="12" ry="4.6" fill="none" stroke="#fff" stroke-width="1.4"/>'
               + star(50, 49, 4.5, 1.8, 4, -90, GL)
               + f'<circle cx="35" cy="47" r="1.8" {GL}/>')

I["sleep"] = (f'<circle cx="50" cy="50" r="27" {SH2}/>'
              f'<circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="3"/>'
              f'<g {STm}><path d="M35 46 q5 5 10 0"/><path d="M53 46 q5 5 10 0"/><path d="M40 64 q10 -6 20 0"/></g>'
              f'<text x="69" y="33" font-family="Georgia,serif" font-size="17" font-weight="bold" text-anchor="middle" {FL}>Z</text>')

I["slime"] = (f'<path d="M28 36 q22 -10 44 0 V52 q0 18 -22 26 q-22 -8 -22 -26 Z" {FL}/>'
              f'<path d="M28 36 q22 -10 44 0 V52 q0 18 -22 26 V36 Z" {SH2}/>'
              f'<path d="M34 60 q2 8 0 14 M50 64 q2 9 0 16 M64 58 q3 8 1 14" {STt} opacity="0.8"/>'
              f'<circle cx="42" cy="46" r="3" {CUT}/><circle cx="58" cy="46" r="3" {CUT}/>'
              f'<circle cx="42" cy="46" r="1.3" {FL}/><circle cx="58" cy="46" r="1.3" {FL}/>')

I["soot"] = (f'<path d="M34 60 a14 14 0 0 1 2 -27 a13 13 0 0 1 24 -4 a13 13 0 0 1 8 31 Z" {FL}/>'
             # white billow curls inside the cloud + black wisps falling below
             f'<path d="M37 52 a6 6 0 0 1 11 -3 M52 48 a7 7 0 0 1 12 4" {LWt}/>'
             f'<path d="M40 68 q3 6 0 11 M52 68 q3 7 0 12 M62 64 q3 6 0 11" {STt}/>')

I["soul"] = (f'<circle cx="50" cy="47" r="22" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.45"/>'
             f'<circle cx="50" cy="47" r="16" {FL}/><circle cx="50" cy="47" r="16" {SH2}/>'
             f'<circle cx="45" cy="42" r="4.5" {GL}/>'
             f'<path d="M50 63 C50 72 57 74 57 82" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>')

I["spite"] = (f'<path d="{heart_d(50,54,44)}" {FL}/><path d="{heart_d(50,54,44)}" {SH2}/>'
              f'<g transform="rotate(35 50 50)"><polygon points="62,16 66,40 58,40" {FL}/>'
              f'<rect x="55" y="40" width="14" height="4" {FL}/><rect x="60.5" y="44" width="3" height="13" {FL}/></g>'
              f'<polyline points="50,30 45,48 55,56 49,70" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity="0.8"/>')

I["stash"] = (f'<rect x="26" y="40" width="48" height="34" rx="3" {FL}/>'
              f'<path d="M26 42 V35 a5 5 0 0 1 5 -5 H69 a5 5 0 0 1 5 5 V42 Z" {FL}/>'
              # white lid seam, corner straps, lock plate → reads as a treasure chest
              f'<line x1="26" y1="42" x2="74" y2="42" {LW}/>'
              f'<g {LWt}><line x1="35" y1="42" x2="35" y2="74"/><line x1="65" y1="42" x2="65" y2="74"/></g>'
              f'<rect x="45" y="48" width="10" height="13" rx="2" {CUT}/>'
              f'<rect x="49" y="53" width="2" height="5" rx="1" {FL}/>')

I["storage"] = (f'<rect x="26" y="30" width="48" height="44" rx="3" {FL}/>'
                # white shelf seams + cross-brace → reads as a stacked crate
                f'<g {LW}><line x1="27" y1="44" x2="73" y2="44"/><line x1="27" y1="60" x2="73" y2="60"/></g>'
                f'<g {LWt}><line x1="29" y1="46" x2="71" y2="58"/><line x1="71" y1="46" x2="29" y2="58"/></g>')

I["study"] = (f'<g {STm}><circle cx="34" cy="56" r="13"/><circle cx="66" cy="56" r="13"/>'
              f'<line x1="47" y1="52" x2="53" y2="52"/>'
              f'<line x1="22" y1="50" x2="18" y2="36"/><line x1="78" y1="50" x2="82" y2="36"/></g>'
              f'<circle cx="34" cy="56" r="13" {SH2}/><circle cx="66" cy="56" r="13" {SH2}/>'
              f'<path d="M28 50 a8 8 0 0 1 6 -4 M60 50 a8 8 0 0 1 6 -4" stroke="#fff" stroke-width="2" fill="none" opacity="0.7"/>')

I["stun"] = (f'<g {STm}><path d="M34 64 q16 -14 32 0"/></g>'
             f'<path d="M30 56 q20 -22 40 0" {STt} opacity="0.5"/>'
             + star(33, 40, 7.5, 3, 5, -90, FL) + star(50, 31, 8.5, 3.4, 5, -90, FL) + star(67, 40, 7.5, 3, 5, -90, FL)
             + f'<circle cx="42" cy="50" r="1.8" {FL}/><circle cx="58" cy="50" r="1.8" {FL}/>')

I["supply"] = (f'<rect x="28" y="44" width="44" height="30" rx="3" {FL}/>'
               f'<rect x="28" y="44" width="44" height="30" rx="3" {SH2}/>'
               f'<rect x="28" y="44" width="44" height="30" rx="3" {STt}/>'
               f'<line x1="28" y1="56" x2="72" y2="56" {STt}/>'
               f'<g stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none">'
               f'<line x1="50" y1="20" x2="50" y2="38"/><polyline points="42,30 50,40 58,30"/></g>')

I["suspect"] = (f'<circle cx="44" cy="44" r="18" {SH2}/>'
                f'<circle cx="44" cy="44" r="18" fill="none" stroke="currentColor" stroke-width="5"/>'
                f'<line x1="57" y1="57" x2="76" y2="76" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>'
                f'<circle cx="39" cy="42" r="2.4" {FL}/><circle cx="49" cy="42" r="2.4" {FL}/>'
                f'<path d="M38 50 q6 5 12 0" {STh}/>')

I["takeover"] = (f'<line x1="34" y1="18" x2="34" y2="78" {ST}/>'
                 f'<path d="M34 24 H68 L60 33 L68 42 H34 Z" {FL}/>'
                 f'<path d="M34 24 H50 V42 H34 Z" {SH2}/>'
                 f'<path d="M20 78 Q34 72 50 76 Q66 80 80 76" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" fill="none"/>'
                 f'<ellipse cx="50" cy="80" rx="30" ry="3" {SH2}/>')

I["task"] = (  # a clipboard with a BULLETED checklist
             f'<rect x="28" y="26" width="44" height="52" rx="4" {FL}/>'
             f'<rect x="42" y="20" width="16" height="10" rx="2.5" {FL}/>'       # clip
             f'<rect x="45" y="22" width="10" height="4.5" rx="2" {CUT}/>'        # clip hole
             f'<g fill="#fff"><circle cx="38" cy="40" r="2.4"/><circle cx="38" cy="52" r="2.4"/>'
             f'<circle cx="38" cy="64" r="2.4"/></g>'                             # bullets
             f'<g {LW}><line x1="45" y1="40" x2="62" y2="40"/><line x1="45" y1="52" x2="62" y2="52"/>'
             f'<line x1="45" y1="64" x2="58" y2="64"/></g>')                      # list items

I["theft"] = (f'<circle cx="58" cy="32" r="9" fill="none" stroke="currentColor" stroke-width="4"/>'
              f'<text x="58" y="37" font-family="Georgia,serif" font-size="11" font-weight="bold" text-anchor="middle" {FL}>$</text>'
              f'<path d="M24 80 V58 a4 4 0 0 1 8 0 V48 a4 4 0 0 1 8 0 V50 a4 4 0 0 1 8 0 V54 a4 4 0 0 1 8 0 V64 '
              f'C56 76 48 82 38 82 Z" {FL}/>'
              f'<path d="M24 80 V58 a4 4 0 0 1 8 0 V82 Z" {SH2}/>')

I["tide"] = (  # waves rolling onto a SHORE: water + foamy waterline + wet-sand ripples + sun
             f'<circle cx="64" cy="31" r="6" {FL}/>'                                 # low sun
             f'<g {STm}><path d="M22 40 q7 -6 14 0 t14 0 t14 0"/>'
             f'<path d="M24 49 q7 -6 14 0 t14 0 t12 0"/></g>'                        # open water
             f'<path d="M20 61 C32 55 40 65 52 61 C62 58 70 65 80 61" {LWg}/>'       # foamy shoreline
             f'<g {STt}><path d="M26 71 C36 68 44 74 54 71 C62 69 70 73 76 71"/>'
             f'<path d="M30 79 C40 76 48 81 58 78"/></g>')                           # wet-sand ripples

I["time"] = (f'<circle cx="50" cy="50" r="27" {SH2}/>'
             f'<circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="5"/>'
             f'<g stroke="currentColor" stroke-width="5" stroke-linecap="round"><line x1="50" y1="50" x2="50" y2="31"/>'
             f'<line x1="50" y1="50" x2="64" y2="56"/></g>'
             f'<circle cx="50" cy="50" r="3.2" {FL}/>'
             + "".join(f'<line x1="{onc(50,50,24,a)[0]:.1f}" y1="{onc(50,50,24,a)[1]:.1f}" x2="{onc(50,50,27,a)[0]:.1f}" y2="{onc(50,50,27,a)[1]:.1f}" {STh} opacity="0.5"/>' for a in range(0, 360, 30)))

I["tower"] = (f'<path d="M34 78 V40 H66 V78 Z" {FL}/>'
              f'<path d="M34 78 V40 H50 V78 Z" {SH2}/>'
              f'<path d="M30 40 V30 H38 V36 H46 V30 H54 V36 H62 V30 H70 V40 Z" {FL}/>'
              f'<rect x="44" y="58" width="12" height="20" {SH}/>'
              f'<circle cx="50" cy="48" r="3.5" {CUT}/>'
              f'<g {STh} opacity="0.5"><line x1="34" y1="52" x2="66" y2="52"/></g>')

I["training"] = (f'<g stroke="currentColor" stroke-linecap="round">'
                 f'<line x1="22" y1="50" x2="78" y2="50" stroke-width="6"/>'
                 f'<line x1="28" y1="37" x2="28" y2="63" stroke-width="12"/>'
                 f'<line x1="72" y1="37" x2="72" y2="63" stroke-width="12"/>'
                 f'<line x1="20" y1="43" x2="20" y2="57" stroke-width="7"/>'
                 f'<line x1="80" y1="43" x2="80" y2="57" stroke-width="7"/></g>'
                 f'<circle cx="50" cy="50" r="3" {GL}/>')

# a detailed upright blade centered at x=50 (shared by the "strike" family only)
_bsw = (f'<polygon points="50,22 54,31 52,58 48,58 46,31" {FL}/>'
        f'<path d="M50 27 V56" {LWt}/>'
        f'<rect x="40" y="58" width="20" height="4.5" rx="2" {FL}/>'
        f'<rect x="46.5" y="62.5" width="7" height="12" rx="2" {FL}/>'
        f'<path d="M47.5 66 h5 M47.5 70 h5" {LWt}/>'
        f'<circle cx="50" cy="77" r="3" {FL}/>')
I["training-swords"] = (f'<g transform="rotate(28 50 52)">{_bsw}</g>'   # crossed practice blades
                        f'<g transform="rotate(-28 50 52)">{_bsw}</g>')

def _trap_teeth(r_out, r_in):
    s = ""
    for i in range(12):
        a = i*30
        x1, y1 = onc(50, 50, r_out, a-11); x2, y2 = onc(50, 50, r_out, a+11); xa, ya = onc(50, 50, r_in, a)
        s += f'<polygon points="{x1:.1f},{y1:.1f} {x2:.1f},{y2:.1f} {xa:.1f},{ya:.1f}" {FL}/>'
    return s
I["trap"] = (f'<circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" stroke-width="4.5"/>'
             f'<circle cx="50" cy="50" r="27" {SH2}/>' + _trap_teeth(26.5, 13)
             + f'<circle cx="50" cy="50" r="4" {FL}/>'
             f'<circle cx="24" cy="50" r="4" {FL}/><circle cx="76" cy="50" r="4" {FL}/>')

I["velocity"] = (f'<g stroke="currentColor" stroke-linecap="round" fill="none">'
                 f'<path d="M24 38 H64" stroke-width="6"/><path d="M18 52 H56" stroke-width="6"/><path d="M28 66 H60" stroke-width="6"/>'
                 f'<polyline points="58,30 72,38 58,46" stroke-width="5" stroke-linejoin="round"/></g>'
                 f'<path d="M24 38 H48 M18 52 H40" stroke="currentColor" stroke-width="2" opacity="0.4" stroke-linecap="round"/>')

I["verse"] = (f'<g stroke="currentColor" stroke-width="3" stroke-linecap="round">'
              + "".join(f'<line x1="24" y1="{y}" x2="76" y2="{y}"/>' for y in (34, 42, 50, 58, 66)) + '</g>'
              f'<ellipse cx="56" cy="62" rx="7" ry="5.5" transform="rotate(-20 56 62)" {FL}/>'
              f'<rect x="61" y="32" width="4" height="32" rx="2" {FL}/>'
              f'<path d="M61 32 q10 2 8 12 q-2 -6 -8 -6 Z" {FL}/>')

I["vitality"] = (f'<path d="{heart_d(50,53,46)}" {FL}/><path d="{heart_d(50,53,46)}" {SH2}/>'
                 f'<path d="M50 68 V44" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.85"/>'
                 f'<path d="M50 52 C44 52 38 48 37 40 C45 39 50 44 50 52 Z" {CUT}/>'
                 f'<path d="M50 48 C56 48 62 44 63 36 C55 35 50 40 50 48 Z" {CUT}/>')

I["void"] = (f'<circle cx="50" cy="50" r="32" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"/>'
             f'<circle cx="50" cy="50" r="26" {FL}/>'
             f'<path d="M50 26 A24 24 0 0 1 74 50" fill="none" stroke="#fff" stroke-width="2.4" opacity="0.5"/>'
             f'<circle cx="50" cy="50" r="9" {SH2}/>'
             f'<path d="M30 38 A40 40 0 0 1 72 28 M70 72 A40 40 0 0 1 28 64" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.35"/>')

I["vortex"] = (  # a churning maelstrom: three spiral arms + inner swirls + eye + flung debris
               f'<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="5">'
               + "".join(f'<path transform="rotate({a} 50 50)" d="M50 22 C66 24 76 38 72 52 C69 62 60 66 52 62"/>' for a in (0, 120, 240))
               + '</g>'
               f'<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="3">'
               + "".join(f'<path transform="rotate({a} 50 50)" d="M50 38 C58 39 62 46 58 52"/>' for a in (60, 180, 300))
               + '</g>'
               f'<circle cx="50" cy="50" r="4.5" {FL}/>'
               f'<circle cx="50" cy="17" r="2.4" {FL}/><circle cx="81" cy="56" r="2" {FL}/>'
               f'<circle cx="23" cy="58" r="1.8" {FL}/>')

I["vow"] = (f'<circle cx="50" cy="57" r="18" fill="none" stroke="currentColor" stroke-width="6.5"/>'
            f'<circle cx="50" cy="57" r="14.5" {LWt}/>'  # white inner rim of the band
            f'<polygon points="50,16 61,31 50,40 39,31" {FL}/>'
            f'<path d="M39 31 H61 M50 16 V40" {LWt}/>'  # white diamond facets
            + f'<circle cx="45" cy="27" r="1.8" {CUT}/>')

I["wage"] = (f'<g>'
             f'<ellipse cx="50" cy="68" rx="20" ry="6" {FL}/>'
             f'<path d="M30 68 V58 a20 6 0 0 0 40 0 V68" {FL}/><path d="M30 58 a20 6 0 0 0 40 0 V68 H30 Z" {SH2}/>'
             f'<path d="M30 58 V48 a20 6 0 0 0 40 0 V58" {FL}/><path d="M30 48 a20 6 0 0 0 40 0 V58 H30 Z" {SH2}/>'
             f'<path d="M30 48 V38 a20 6 0 0 1 40 0 V48" {FL}/>'
             f'<ellipse cx="50" cy="38" rx="20" ry="6" {SH}/></g>'
             + star(50, 38, 5, 2, 5, -90, GL))

I["winch"] = (f'<rect x="27" y="29" width="32" height="23" rx="3" {FL}/>'
              f'<rect x="27" y="29" width="32" height="23" rx="3" {SH2}/>'
              f'<circle cx="43" cy="40" r="6" {CUT}/><circle cx="43" cy="40" r="2.4" {FL}/>'
              f'<rect x="59" y="34" width="10" height="4" rx="2" {FL}/>'
              f'<line x1="50" y1="52" x2="50" y2="60" {STm}/>'
              f'<path d="M50 60 a8 8 0 1 0 8 8" {STm}/><polygon points="56,64 62,68 56,72" {FL}/>')

I["wind"] = (f'<g {ST}><path d="M24 38 H58 a7 7 0 1 0 -7 -7"/>'
             f'<path d="M24 52 H68 a7 7 0 1 1 -7 7"/>'
             f'<path d="M24 66 H50 a6 6 0 1 1 -6 6"/></g>'
             f'<g {STh} opacity="0.4"><path d="M24 45 H50"/><path d="M24 59 H56"/></g>')

# ---------------- KEYWORD COUNTERS ---------------------------------------
_angel_wing = (  # one big stylized angel wing right of center: 3 feather rows, scalloped tips
               f'<path d="M50 33 C61 26 74 24 87 25 '
               f'C79 31 81 33 71 36 C78 40 68 43 60 44 '
               f'C69 48 58 50 52 51 C60 55 53 58 50 58 Z" {FL}/>'
               f'<g {LWt}><path d="M52 53 C62 49 73 46 82 41"/>'
               f'<path d="M54 48 C64 44 75 39 85 33"/>'
               f'<path d="M56 43 C66 38 77 33 87 27"/></g>')
I["flying"] = (_angel_wing
               + f'<g transform="translate(100,0) scale(-1,1)">{_angel_wing}</g>'
               + f'<ellipse cx="50" cy="21" rx="8.5" ry="3.4" fill="none" stroke="currentColor" stroke-width="3"/>')  # halo

I["first-strike"] = _bsw + f'<path d="M62 30 q6 4 6 12" {STt}/>'                          # one blade + speed swoosh
I["double-strike"] = (f'<g transform="translate(-10,0)">{_bsw}</g>'                        # two parallel blades
                      f'<g transform="translate(10,0)">{_bsw}</g>')

I["vigilance"] = (f'<path d="M31 75 V35 H69 V75 Z" {FL}/>'
                  f'<path d="M31 75 V35 H50 V75 Z" {SH2}/>'
                  f'<path d="M27 35 V25 H37 V31 H46 V25 H54 V31 H63 V25 H73 V35 Z" {FL}/>'
                  f'<path d="M43 75 V58 a7 7 0 0 1 14 0 V75 Z" {SH}/>'
                  f'<path d="M50 42 L58 50 L50 58 L42 50 Z" {CUT}/><circle cx="50" cy="50" r="3" {FL}/>'
                  f'<path d="M22 42 L34 48 M78 42 L66 48 M50 18 V27" {STh} opacity="0.65"/>')

I["reach"] = (  # a HAND reaching/grasping upward — palm + three fingers + thumb
              f'<path d="M36 80 V62 C34 52 40 48 46 52 C50 48 58 50 60 58 L62 80 Z" {FL}/>'
              f'<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">'
              f'<path d="M41 58 C40 46 40 36 43 27"/>'      # index
              f'<path d="M50 56 C49 42 49 32 51 23"/>'      # middle (tallest)
              f'<path d="M58 58 C58 46 59 38 60 30"/>'      # ring
              f'<path d="M37 62 C30 58 26 54 25 47"/>'      # thumb
              f'</g>'
              f'<g {LWt}><path d="M40 43 h6 M48 39 h6 M57 45 h5"/></g>')   # knuckle creases

I["menace"] = (  # a snarling horned demon face — far more intimidating
               f'<path d="M24 32 L33 39 C38 28 62 28 67 39 L76 32 '
               f'C73 45 75 51 70 60 C64 72 56 78 50 80 C44 78 36 72 30 60 C25 51 27 45 24 32 Z" {FL}/>'
               f'<polygon points="36,48 48,52 36,57" {CUT}/>'                          # angry left eye
               f'<polygon points="64,48 52,52 64,57" {CUT}/>'                          # angry right eye
               f'<circle cx="41" cy="52.5" r="1.8" {FL}/><circle cx="59" cy="52.5" r="1.8" {FL}/>'  # pupils
               f'<path d="M34 45 L48 49 M66 45 L52 49" {LW}/>'                         # furrowed brow
               f'<path d="M38 64 L44 64 L46 70 L50 64 L54 70 L56 64 L62 64 '
               f'L58 73 L50 77 L42 73 Z" {CUT}/>')                                     # bared fangs

I["lifelink"] = (  # a heart crossed by an EKG heartbeat pulse — life linked
                 f'<path d="{heart_d(50,55,44)}" {FL}/>'
                 f'<path d="M28 53 H40 L44 44 L50 62 L55 49 L58 53 H72" '
                 f'fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>')
I["death"] = (f'<path d="M32 78 V47 a18 18 0 0 1 36 0 V78 Z" {FL}/>'
              f'<path d="M32 78 V47 a18 18 0 0 1 18 -18 V78 Z" {SH2}/>'
              f'<path d="M42 50 H58 M50 40 V65" stroke="#fff" stroke-width="3.2" stroke-linecap="round" opacity="0.8"/>'
              f'<line x1="26" y1="80" x2="74" y2="80" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
              f'<path d="M29 30 C37 18 55 17 67 26" {STt}/>')
I["deathtouch"] = (  # a clawed beast paw with venom dripping off the talons
                   f'<path d="M28 32 C34 22 66 22 72 32 C66 38 58 36 50 36 C42 36 34 38 28 32 Z" {FL}/>'   # knuckle pad
                   f'<path d="M31 30 C28 45 31 56 37 66 C42 56 44 44 43 29 C39 34 35 34 31 30 Z" {FL}/>'   # talon L
                   f'<path d="M44 28 C42 46 46 60 50 71 C54 60 58 46 56 28 C52 33 48 33 44 28 Z" {FL}/>'   # talon C
                   f'<path d="M57 29 C56 44 58 56 63 66 C69 56 72 45 69 30 C65 34 61 34 57 29 Z" {FL}/>'   # talon R
                   f'<g {LWt}><path d="M36 34 C34 46 36 55 39 62"/><path d="M50 33 C49 47 50 58 51 67"/>'
                   f'<path d="M64 34 C66 46 64 55 61 62"/><path d="M34 31 C42 35 58 35 66 31"/></g>'        # edge highlights
                   f'<path d="M37 66 q-1 7 1 10 M50 71 q0 5 0 9 M63 66 q1 6 -1 9" {STt}/>'                  # venom strands
                   f'<path d="M38 77 C38 77 35 81 35 83 a3 3 0 0 0 6 0 C41 81 38 77 38 77 Z" {FL}/>'        # drip
                   f'<path d="M50 80 C50 80 47.5 83.5 47.5 85 a2.6 2.6 0 0 0 5.2 0 C52.7 83.5 50 80 50 80 Z" {FL}/>'
                   f'<path d="M62 76 C62 76 59.5 79.5 59.5 81 a2.6 2.6 0 0 0 5.2 0 C64.7 79.5 62 76 62 76 Z" {FL}/>'
                   f'<circle cx="37" cy="81" r="0.9" {GL}/><circle cx="49" cy="83.5" r="0.8" {GL}/>')
I["indestructible"] = (  # a heavy iron anvil — unbreakable
                       f'<path d="M26 40 H58 C58 46 64 48 72 46 C68 52 60 54 58 52 V56 H64 V62 H36 V56 H42 V44 H26 Z" {FL}/>'
                       f'<path d="M40 62 H60 L64 72 H36 Z" {FL}/>'
                       f'<path d="M29 42 H54" {LWt}/>')

def hexproof(pip=None, letter=None):
    # black-and-white only: a black mana pip with a white W/U/B/R/G letter keeps the
    # five colors distinguishable without using color.
    base = f'<path d="{shield_d()}" {ST}/>'
    if letter:
        return (base + f'<circle cx="50" cy="50" r="14" {FL}/>'
                f'<text x="50" y="56.5" font-family="Georgia,serif" font-size="17" font-weight="bold" '
                f'text-anchor="middle" fill="#fff">{letter}</text>')
    return base
I["hexproof"] = (f'<path d="{shield_d()}" {ST}/><path d="{shield_d(50,30,30,42)}" {STh} opacity="0.4"/>'
                 f'<polygon points="{P(poly_pts(50,50,12,3,-90))}" {STt}/>'
                 f'<polygon points="{P(poly_pts(50,50,12,3,90))}" {STt}/>'
                 f'<circle cx="50" cy="50" r="3" {FL}/>')
I["hexproof-white"] = hexproof("#f5f0d8", "W")
I["hexproof-blue"] = hexproof("#3a7fd0", "U")
I["hexproof-black"] = hexproof("#444444", "B")
I["hexproof-red"] = hexproof("#d04a3a", "R")
I["hexproof-green"] = hexproof("#3aa05a", "G")

I["trample"] = (f'<path d="M34 26 C30 26 28 32 30 40 L34 60 C36 72 44 80 50 80 C56 80 64 72 66 60 '
                f'L70 40 C72 32 70 26 66 26 C64 32 60 34 58 30 C56 36 52 36 50 30 C48 36 44 36 42 30 '
                f'C40 34 36 32 34 26 Z" {FL}/>'
                f'<path d="M34 26 C30 26 28 32 30 40 L34 60 C36 72 44 80 50 80 V30 C48 36 44 36 42 30 C40 34 36 32 34 26 Z" {SH2}/>'
                f'<path d="M50 44 V72 M40 48 L40 64 M60 48 L60 64" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity="0.8"/>')

I["haste"] = (  # a detailed winged speed-boot: laced shaft, sole, heel + a small wing & streaks
              f'<path d="M36 24 H52 C54 24 55 25 55 28 V47 H70 C76 47 81 52 81 60 V63 '
              f'C81 66 79 68 75 68 H35 C32 68 30 66 30 63 V28 C30 25 32 24 36 24 Z" {FL}/>'
              f'<path d="M30 63 H81" {LW}/>'                                   # sole
              f'<path d="M30 30 H55" {LWt}/>'                                  # cuff fold
              f'<g {LWt}><path d="M37 34 L52 38 M37 40 L52 44 M37 46 L52 50"/></g>'   # laces
              f'<g fill="#fff"><circle cx="38" cy="34" r="1.3"/><circle cx="38" cy="40" r="1.3"/>'
              f'<circle cx="38" cy="46" r="1.3"/></g>'                          # eyelets
              f'<path d="M70 63 H81 L78 68 H72 Z" {CUT}/>'                      # toe sole highlight
              f'<path d="M32 48 C22 47 15 51 12 60 C19 57 19 57 24 60 C25 54 28 50 33 52 Z" {FL}/>'  # heel wing
              f'<g {LWt}><path d="M30 52 C24 52 19 54 16 58"/><path d="M30 56 C26 56 22 57 19 60"/></g>'
              f'<g {STm}><path d="M14 35 H28"/><path d="M16 43 H26"/></g>')     # motion streaks
I["flash"] = (  # a radiant burst of light — eight tapering rays from a bright core
              "".join(f'<polygon points="50,50 {onc(50,50,30,a-4)[0]:.1f},{onc(50,50,30,a-4)[1]:.1f} '
                      f'{onc(50,50,30,a+4)[0]:.1f},{onc(50,50,30,a+4)[1]:.1f}" {FL}/>' for a in range(0, 360, 45))
              + f'<circle cx="50" cy="50" r="7" {FL}/><circle cx="50" cy="50" r="3.6" {GL}/>')
I["ward"] = (f'<path d="{shield_d()}" {ST}/><path d="{shield_d(50,30,30,42)}" {STh} opacity="0.4"/>'
             + star(50, 49, 13, 4.5, 4, -90, FL) + f'<circle cx="50" cy="49" r="3" {GL}/>')

I["shadow"] = (f'<path d="M50 24 C40 24 33 32 33 44 C28 47 28 56 33 58 V78 H67 V58 '
               f'C72 56 72 47 67 44 C67 32 60 24 50 24 Z" {FL}/>'
               f'<path d="M50 24 C40 24 33 32 33 44 C28 47 28 56 33 58 V78 H50 Z" {SH2}/>'
               f'<path d="M42 44 a8 8 0 0 1 16 0 Z" {CUT}/>')

I["exalted"] = (f'<circle cx="50" cy="50" r="13" {FL}/><circle cx="50" cy="50" r="13" {SH2}/>'
                + '<g stroke="currentColor" stroke-width="5" stroke-linecap="round">'
                + "".join(f'<line x1="{onc(50,50,19,a)[0]:.1f}" y1="{onc(50,50,19,a)[1]:.1f}" x2="{onc(50,50,30,a)[0]:.1f}" y2="{onc(50,50,30,a)[1]:.1f}"/>' for a in range(0, 360, 45))
                + '</g>'
                + '<g stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.5">'
                + "".join(f'<line x1="{onc(50,50,20,a)[0]:.1f}" y1="{onc(50,50,20,a)[1]:.1f}" x2="{onc(50,50,27,a)[0]:.1f}" y2="{onc(50,50,27,a)[1]:.1f}"/>' for a in range(22, 360, 45))
                + '</g>'
                + f'<circle cx="46" cy="46" r="3" {GL}/>')

I["decayed"] = (skull(50, 44, 0.82)
                + f'<path d="M34 64 q3 8 0 14 M50 66 q3 9 0 16 M66 64 q3 8 0 14" {STt} opacity="0.8"/>')

I["defender"] = (f'<path d="M26 42 H31 V35 H39 V42 H46 V35 H54 V42 H61 V35 H69 V42 H74 V74 H26 Z" {FL}/>'
                 f'<path d="M26 42 H31 V35 H39 V42 H46 V35 H50 V74 H26 Z" {SH2}/>'
                 f'<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"><line x1="26" y1="56" x2="74" y2="56"/>'
                 f'<line x1="40" y1="42" x2="40" y2="56"/><line x1="60" y1="42" x2="60" y2="56"/>'
                 f'<line x1="33" y1="56" x2="33" y2="74"/><line x1="50" y1="56" x2="50" y2="74"/><line x1="67" y1="56" x2="67" y2="74"/></g>')

# ---------------- WIKI COMPLETENESS COUNTERS -----------------------------
def sun(cx=50, cy=50, r=13):
    return (star(cx, cy, r+14, r+5, 12, -90, FL)
            + f'<circle cx="{cx}" cy="{cy}" r="{r}" {CUT}/>'
            + f'<circle cx="{cx}" cy="{cy}" r="{r-5}" {FL}/>')

def key_shape():
    return (f'<circle cx="36" cy="48" r="10" fill="none" stroke="currentColor" stroke-width="5"/>'
            f'<line x1="46" y1="48" x2="76" y2="48" {ST}/>'
            f'<path d="M63 48 V58 M72 48 V55" {STt}/>')

def lock_shape(opened=False):
    shackle = f'<path d="M38 41 V34 a12 12 0 0 1 24 0 V41" {STm}/>'
    if opened:
        shackle = f'<path d="M39 41 V34 a12 12 0 0 1 21 -8" {STm}/>'
    return (shackle + f'<rect x="31" y="41" width="38" height="32" rx="4" {FL}/>'
            f'<rect x="31" y="41" width="38" height="32" rx="4" {SH2}/>'
            f'<circle cx="50" cy="55" r="4" {CUT}/><line x1="50" y1="59" x2="50" y2="66" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>')

def vial(cx=50, cy=50, fill_drop=True):
    return (f'<path d="M43 24 H57 M46 24 V39 L34 68 a9 9 0 0 0 8 13 H58 a9 9 0 0 0 8 -13 L54 39 V24" {STm}/>'
            f'<path d="M40 66 H60 L64 75 H36 Z" {FL}/>'
            f'<path d="M40 66 H50 V75 H36 Z" {SH2}/>'
            + (f'<circle cx="{cx}" cy="{cy+18}" r="3" {CUT}/>' if fill_drop else ''))

def ticket_shape():
    return (f'<path d="M25 36 H75 V46 a5 5 0 0 0 0 10 V66 H25 V56 a5 5 0 0 0 0 -10 Z" {FL}/>'
            f'<path d="M25 36 H50 V66 H25 V56 a5 5 0 0 0 0 -10 Z" {SH2}/>'
            f'<path d="M50 40 V62" {STh} opacity="0.7"/>'
            + star(63, 51, 6, 2.4, 5, -90, CUT))

I["aegis"] = (  # a tower shield bearing a radiant sun emblem
              f'<path d="M30 24 H70 V52 C70 69 60 78 50 81 C40 78 30 69 30 52 Z" {FL}/>'
              f'<path d="M30 32 H70" {LWt}/>'
              f'<circle cx="50" cy="49" r="7" {CUT}/>'
              + "".join(f'<line x1="{onc(50,49,9,a)[0]:.1f}" y1="{onc(50,49,9,a)[1]:.1f}" '
                        f'x2="{onc(50,49,13,a)[0]:.1f}" y2="{onc(50,49,13,a)[1]:.1f}" {LWt}/>' for a in range(0, 360, 45)))
I["age"] = (  # a candle burned low with wax drips — cumulative wear/upkeep mounting each turn
            f'<path d="M50 20 C55 27 58 30 58 36 a8 8 0 0 1 -16 0 C42 31 46 30 48 25 C49 31 52 31 50 27 Z" {FL}/>'
            f'<line x1="50" y1="38" x2="50" y2="45" {STt}/>'
            f'<path d="M38 46 C42 44 46 45 50 45 C54 45 58 44 62 46 V73 C62 76 60 77 56 77 H44 C40 77 38 76 38 73 Z" {FL}/>'
            f'<ellipse cx="50" cy="79" rx="20" ry="4.5" {FL}/>'
            f'<path d="M38 58 q-3 7 -1 14 a3 3 0 0 0 4 0 q1 -8 -3 -14 Z" {FL}/>'   # wax drip
            f'<path d="M41 48 q9 4 18 0" {LWt}/>'
            f'<g {LWt}><path d="M45 53 V73"/><path d="M55 53 V73"/></g>')
I["aim"] = (  # a drawn bow firing an arrow into a bullseye target (aiming)
            f'<path d="M24 24 C40 34 40 56 24 66" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>'
            f'<path d="M24 24 L17 45 L24 66" {STt}/>'
            f'<line x1="17" y1="45" x2="49" y2="45" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'
            f'<polygon points="17,45 24,42 24,48" {FL}/>'
            f'<polygon points="55,45 47,41 49,45 47,49" {FL}/>'
            f'<circle cx="66" cy="45" r="14" fill="none" stroke="currentColor" stroke-width="3.5"/>'
            f'<circle cx="66" cy="45" r="6.5" fill="none" stroke="currentColor" stroke-width="2.5"/>'
            f'<circle cx="66" cy="45" r="2.4" {FL}/>'
            f'<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="66" y1="27" x2="66" y2="33"/>'
            f'<line x1="66" y1="57" x2="66" y2="63"/><line x1="82" y1="45" x2="86" y2="45"/></g>')
I["awakening"] = sun(50, 48, 12)
I["bait"] = (  # a fishhook with a wriggling worm threaded on it (the `lure` hook + bait)
             f'<line x1="48" y1="22" x2="48" y2="56" {STm}/>'
             f'<path d="M48 56 a12 12 0 1 0 24 0 V50" {STm}/>'
             f'<circle cx="48" cy="22" r="5" fill="none" stroke="currentColor" stroke-width="3.4"/>'
             f'<polygon points="72,40 67,50 77,50" {FL}/>'
             f'<path d="M36 70 q7 -9 14 -4 q8 5 16 -3" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>'
             f'<g {LWt}><path d="M44 66 v3 M52 66 v3 M60 65 v3"/></g>'
             f'<circle cx="67" cy="62" r="1.6" {CUT}/>')
I["blessing"] = (  # a winged heart with a sparkle above — a blessing
                 f'<path d="{heart_d(50,57,32)}" {FL}/>'
                 f'<path d="M33 49 C23 45 17 49 17 57 C23 54 25 55 29 57 C29 52 31 50 35 52 Z" {FL}/>'
                 f'<path d="M67 49 C77 45 83 49 83 57 C77 54 75 55 71 57 C71 52 69 50 65 52 Z" {FL}/>'
                 f'<g {LWt}><path d="M30 53 C26 52 22 53 19 56"/><path d="M70 53 C74 52 78 53 81 56"/></g>'
                 + star(50, 31, 5, 2, 4, -90, FL))
I["blight"] = (f'<path d="M52 20 C70 36 67 62 48 80 C35 63 31 42 52 20 Z" {FL}/>'
               f'<path d="M34 36 L65 67 M62 36 L37 62" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["bloodline"] = (  # a blood drop branching down into descendant drops (a lineage)
                  f'<path d="M50 18 C50 18 42 30 42 36 a8 8 0 0 0 16 0 C58 30 50 18 50 18 Z" {FL}/>'
                  f'<path d="M50 44 V52 M50 52 C50 52 36 56 36 63 M50 52 C50 52 64 56 64 63" {STm}/>'
                  f'<path d="M36 59 C36 59 31 67 31 70 a5 5 0 0 0 10 0 C41 67 36 59 36 59 Z" {FL}/>'
                  f'<path d="M64 59 C64 59 59 67 59 70 a5 5 0 0 0 10 0 C69 67 64 59 64 59 Z" {FL}/>')
I["bloodstain"] = (  # an irregular splatter stain with flung droplets
                   f'<path d="M38 32 C50 26 58 34 60 40 C70 38 75 48 68 54 C75 61 70 71 60 70 '
                   f'C58 78 46 79 42 70 C32 73 25 62 32 56 C23 50 28 38 38 32 Z" {FL}/>'
                   f'<ellipse cx="46" cy="44" rx="3.5" ry="5.5" fill="none" stroke="#fff" stroke-width="1.6"/>'
                   f'<circle cx="74" cy="31" r="3" {FL}/><circle cx="27" cy="74" r="2.4" {FL}/>'
                   f'<circle cx="79" cy="62" r="2" {FL}/><circle cx="34" cy="25" r="1.8" {FL}/>')
I["bounty"] = (  # a "WANTED" reward poster with a star and a tack
               f'<path d="M28 26 L72 24 L74 76 L26 74 Z" {FL}/>'
               f'<g {LWt}><line x1="34" y1="34" x2="66" y2="33"/>'
               f'<line x1="36" y1="64" x2="64" y2="64"/><line x1="40" y1="70" x2="60" y2="70"/></g>'
               + star(50, 49, 11, 4.5, 5, -90, GL)
               + f'<circle cx="50" cy="22" r="2.6" {FL}/>')
I["bribery"] = (  # a cupped palm receiving coins from above (a payoff) — distinct from `theft`
                f'<path d="M26 56 C30 54 34 56 40 60 H58 C64 60 64 68 58 68 H40 C32 68 26 64 26 56 Z" {FL}/>'
                f'<g {LWt}><path d="M44 62 V68 M50 62 V68 M56 62 V68"/></g>'
                f'<circle cx="44" cy="40" r="6" {FL}/><circle cx="44" cy="40" r="3.6" {CUT}/>'
                f'<circle cx="58" cy="46" r="5" {FL}/><circle cx="58" cy="46" r="3" {CUT}/>'
                f'<text x="44" y="43.5" font-family="Georgia,serif" font-size="8" font-weight="bold" text-anchor="middle" {FL}>$</text>')
I["carrion"] = (  # a picked-clean ribcage carcass with a couple of flies
                f'<path d="M50 22 V76" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
                + "".join(f'<circle cx="50" cy="{y}" r="2.6" {FL}/>' for y in (28, 40, 52, 64))
                + f'<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">'
                + "".join(f'<path d="M50 {y} q-18 2 -16 18"/><path d="M50 {y} q18 2 16 18"/>' for y in (32, 44, 56))
                + '</g>'
                f'<circle cx="26" cy="30" r="2" {FL}/><circle cx="75" cy="34" r="1.8" {FL}/>')
I["cell"] = (  # a JAIL cell: vertical bars behind top & bottom rails
             f'<g {FL}>' + "".join(f'<rect x="{x}" y="24" width="5" height="52" rx="2"/>' for x in (28, 40, 52, 64)) + '</g>'
             f'<rect x="24" y="30" width="52" height="5" rx="2.5" {FL}/>'
             f'<rect x="24" y="65" width="52" height="5" rx="2.5" {FL}/>')
I["collection"] = (  # a 2x2 display case of varied collected items — distinct from the `stash` chest
                   f'<rect x="28" y="28" width="44" height="44" rx="3" {FL}/>'
                   f'<g fill="#fff"><rect x="33" y="33" width="14" height="14" rx="1.5"/><rect x="53" y="33" width="14" height="14" rx="1.5"/>'
                   f'<rect x="33" y="53" width="14" height="14" rx="1.5"/><rect x="53" y="53" width="14" height="14" rx="1.5"/></g>'
                   + star(40, 40, 5, 2, 5, -90, FL)
                   + f'<circle cx="60" cy="40" r="5" {FL}/>'
                   + f'<polygon points="40,55 45,64 35,64" {FL}/>'
                   + f'<path d="{heart_d(60,61,11)}" {FL}/>')
I["component"] = (  # a microchip / IC with pins and a die
                  f'<rect x="34" y="34" width="32" height="32" rx="2" {FL}/>'
                  f'<rect x="40" y="40" width="20" height="20" rx="1.5" {CUT}/>'
                  f'<circle cx="50" cy="50" r="3.5" {FL}/>'
                  f'<g fill="#fff">'
                  + "".join(f'<rect x="{x}" y="28" width="3" height="6"/><rect x="{x}" y="66" width="3" height="6"/>' for x in (38, 48.5, 59))
                  + "".join(f'<rect x="28" y="{y}" width="6" height="3"/><rect x="66" y="{y}" width="6" height="3"/>' for y in (38, 48.5, 59))
                  + '</g>')
I["contested"] = (f'<path d="M36 22 V78 M64 22 V78" {STm}/><path d="M36 26 H63 L55 36 L63 46 H36 Z" {FL}/>'
                  f'<path d="M64 54 H37 L45 64 L37 74 H64 Z" {FL}/>')
I["credit"] = (  # a chip credit card with EMV chip + embossed number rows
               f'<rect x="22" y="34" width="56" height="34" rx="4" {FL}/>'
               f'<rect x="28" y="43" width="12" height="9" rx="1.5" {CUT}/>'              # chip
               f'<path d="M31 43 V52 M37 43 V52 M28 47.5 H40" {STt}/>'                    # chip contacts
               f'<g fill="#fff"><rect x="28" y="58" width="20" height="3" rx="1.5"/>'
               f'<rect x="52" y="58" width="14" height="3" rx="1.5"/></g>'                # number groups
               f'<line x1="48" y1="47" x2="70" y2="47" {LWt}/>')                          # embossed line
I["croak"] = (f'<path d="M28 55 C28 35 72 35 72 55 C72 70 62 78 50 78 C38 78 28 70 28 55 Z" {FL}/>'
              f'<circle cx="39" cy="39" r="8" {FL}/><circle cx="61" cy="39" r="8" {FL}/>'
              f'<circle cx="39" cy="39" r="3" {CUT}/><circle cx="61" cy="39" r="3" {CUT}/><path d="M39 60 q11 8 22 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>')
I["currency"] = (  # a paper banknote with a portrait window + corner marks
                 f'<rect x="22" y="34" width="56" height="32" rx="2.5" {FL}/>'
                 f'<rect x="26" y="38" width="48" height="24" rx="1.5" fill="none" stroke="#fff" stroke-width="1.6"/>'
                 f'<ellipse cx="50" cy="50" rx="8.5" ry="10.5" {CUT}/>'
                 f'<circle cx="50" cy="47" r="3" {FL}/><path d="M44 58 q6 -6 12 0" {STt}/>'
                 f'<g fill="#fff"><circle cx="31" cy="43" r="2"/><circle cx="69" cy="57" r="2"/></g>')
I["defense"] = (  # a round buckler shield with a central boss + ring of rivets
                f'<circle cx="50" cy="50" r="27" {FL}/>'
                f'<circle cx="50" cy="50" r="27" fill="none" stroke="#fff" stroke-width="1.8"/>'
                f'<circle cx="50" cy="50" r="18" fill="none" stroke="#fff" stroke-width="1.6"/>'
                f'<circle cx="50" cy="50" r="6" {CUT}/>'
                + "".join(f'<circle cx="{onc(50,50,22.5,a)[0]:.1f}" cy="{onc(50,50,22.5,a)[1]:.1f}" r="1.8" fill="#fff"/>' for a in range(0, 360, 45)))
I["delay"] = (  # a snail (slowness / postponement) — distinct from any clock/hourglass
              f'<circle cx="56" cy="50" r="16" {FL}/>'
              f'<path d="M56 50 a6 6 0 1 0 6 -6" fill="none" stroke="#fff" stroke-width="2.4"/>'
              f'<path d="M40 66 C28 66 24 58 30 54 L42 52 C46 60 44 66 40 66 Z" {FL}/>'
              f'<circle cx="27" cy="58" r="5.5" {FL}/>'
              f'<path d="M24 54 V45 M31 54 V46" {STt}/>'
              f'<circle cx="24" cy="44" r="1.7" {FL}/><circle cx="31" cy="45" r="1.7" {FL}/>')
I["depletion"] = (f'<rect x="26" y="38" width="42" height="24" rx="3" {STm}/><rect x="68" y="45" width="6" height="10" rx="2" {FL}/>'
                  f'<line x1="34" y1="69" x2="66" y2="31" {STm}/>')
I["descent"] = (f'<line x1="50" y1="22" x2="50" y2="72" {ST}/><polyline points="34,56 50,74 66,56" {ST}/>'
                f'<path d="M30 28 q20 8 40 0" {STh} opacity="0.45"/>')
I["despair"] = (  # a broken heart, split by a jagged crack
                f'<path d="{heart_d(50,54,44)}" {FL}/>'
                f'<path d="M50 32 L44 45 L54 53 L46 63 L52 71" '
                f'fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')
I["devotion"] = (  # a sacred flaming heart
                 f'<path d="{heart_d(50,60,32)}" {FL}/>'
                 f'<path d="M50 34 C54 40 56 43 56 47 a6 6 0 0 1 -12 0 C44 43 47 41 48 38 C49 42 51 42 51 40 C52 38 51 36 50 34 Z" {FL}/>'
                 f'<path d="M40 54 q10 6 20 0" {LWt}/>'
                 f'<path d="M50 28 V34" {STt}/>')
I["divinity"] = (f'<ellipse cx="50" cy="29" rx="19" ry="7" fill="none" stroke="currentColor" stroke-width="4"/>'
                 f'<path d="M50 39 L62 72 H38 Z" {FL}/>' + star(50, 55, 7, 2.8, 4, -90, CUT))
I["doom"] = (  # a coffin marked with a cross — distinct from the hooded `death` reaper
             f'<polygon points="42,22 58,22 68,42 63,76 50,80 37,76 32,42" {FL}/>'
             f'<g {LWt}><path d="M50 30 V66 M41 44 H59"/></g>')
I["duty"] = (  # a watch/summons bell (the call to duty) — distinct from the `task` clipboard
             f'<path d="M50 24 a4 4 0 0 1 4 4 C63 31 66 48 66 64 H34 C34 48 37 31 46 28 a4 4 0 0 1 4 -4 Z" {FL}/>'
             f'<rect x="30" y="64" width="40" height="6" rx="2" {FL}/>'
             f'<circle cx="50" cy="75" r="4" {FL}/>'
             f'<path d="M44 36 q-4 14 -1 26" {LWt}/>')
I["elixir"] = (  # a round-bottom potion flask with liquid + rising bubbles
               f'<circle cx="50" cy="58" r="17" {FL}/>'
               f'<rect x="45" y="30" width="10" height="16" {FL}/>'
               f'<rect x="44" y="23" width="12" height="8" rx="2" {FL}/>'
               f'<path d="M35 56 q15 -7 30 0" {LWt}/>'
               f'<g fill="#fff"><circle cx="45" cy="63" r="2.2"/><circle cx="56" cy="66" r="1.6"/><circle cx="50" cy="60" r="1.4"/></g>')
I["enlightened"] = (  # a radiant lotus blossom (enlightenment) — distinct from the `knowledge` book
                    f'<path d="M50 28 C45 42 45 54 50 64 C55 54 55 42 50 28 Z" {FL}/>'
                    f'<path d="M50 64 C42 54 32 50 24 52 C28 62 38 68 50 68 Z" {FL}/>'
                    f'<path d="M50 64 C58 54 68 50 76 52 C72 62 62 68 50 68 Z" {FL}/>'
                    f'<path d="M50 65 C46 51 38 43 30 41 C30 55 40 67 50 67 Z" {FL}/>'
                    f'<path d="M50 65 C54 51 62 43 70 41 C70 55 60 67 50 67 Z" {FL}/>'
                    f'<g {STt}><line x1="50" y1="24" x2="50" y2="16"/><line x1="34" y1="28" x2="29" y2="22"/><line x1="66" y1="28" x2="71" y2="22"/></g>')
I["eon"] = (  # an infinity symbol with a star (endless time) — distinct from the `time` clock
            f'<path d="M50 50 C44 38 28 38 28 50 C28 62 44 62 50 50 C56 38 72 38 72 50 C72 62 56 62 50 50 Z" '
            f'fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/>'
            + star(50, 50, 4, 1.6, 4, -90, FL))
I["exposure"] = (  # a radiation dosimeter METER: gauge + needle in the red, trefoil on the body
                 f'<path d="M22 60 A28 28 0 0 0 78 60" fill="none" stroke="currentColor" stroke-width="4"/>'
                 + "".join(f'<line x1="{onc(50,60,24,a)[0]:.1f}" y1="{onc(50,60,24,a)[1]:.1f}" '
                           f'x2="{onc(50,60,28,a)[0]:.1f}" y2="{onc(50,60,28,a)[1]:.1f}" stroke="currentColor" stroke-width="2.2"/>' for a in range(180, 361, 20))
                 + f'<line x1="50" y1="60" x2="68" y2="45" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
                 f'<circle cx="50" cy="60" r="4.5" {FL}/>'
                 f'<rect x="33" y="63" width="34" height="14" rx="2.5" {FL}/>'
                 + "".join(f'<path d="{wedge(50,70,1.8,5.5,a,a+46)}" {CUT}/>' for a in (67, 187, 307))
                 + f'<circle cx="50" cy="70" r="1.9" {CUT}/>')
I["film"] = (f'<rect x="27" y="25" width="46" height="50" rx="3" {FL}/>'
             f'<rect x="34" y="34" width="32" height="32" {CUT}/>'
             # white sprocket perforations down both margins → reads as a film frame
             f'<g fill="#fff">'
             + "".join(f'<rect x="28.5" y="{y}" width="4" height="5" rx="1"/><rect x="67.5" y="{y}" width="4" height="5" rx="1"/>' for y in (30, 41, 52, 63))
             + '</g>')
I["fire"] = (  # a campfire: crossed logs under flames (distinct from the single `flame`)
             f'<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round">'
             f'<line x1="30" y1="73" x2="62" y2="65"/><line x1="38" y1="73" x2="70" y2="65"/></g>'
             f'<path d="M50 26 C58 38 66 42 66 54 a16 16 0 0 1 -32 0 C34 44 42 42 46 34 C47 44 52 44 54 40 C56 36 53 31 50 26 Z" {FL}/>'
             f'<path d="M50 40 C54 47 58 49 58 55 a8 8 0 0 1 -16 0 C42 50 46 49 48 45 C49 51 52 50 50 47 Z" {CUT}/>')
I["foreshadow"] = (  # a crystal ball on a stand (seeing what's to come) — distinct from the `omen` comet
                   f'<circle cx="50" cy="46" r="20" {FL}/>'
                   f'<path d="M38 38 q-4 8 0 16" {LWt}/>'
                   + star(57, 40, 4.5, 1.8, 4, -90, CUT)
                   + f'<path d="M34 64 H66 L60 73 H40 Z" {FL}/>')
I["fuse"] = (f'<path d="M28 70 C42 42 58 58 72 28" {STm}/>' + star(73, 27, 10, 3, 8, -90, FL))
I["hack"] = (  # a terminal screen showing < > code + cursor — distinct from the `matrix` grid
             f'<rect x="26" y="30" width="48" height="36" rx="3" {FL}/>'
             f'<rect x="30" y="34" width="40" height="28" rx="1.5" {CUT}/>'
             f'<g stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none">'
             f'<path d="M41 42 L36 47 L41 52"/><path d="M57 42 L62 47 L57 52"/></g>'
             f'<line x1="44" y1="57" x2="54" y2="57" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
             f'<rect x="44" y="66" width="12" height="6" {FL}/><rect x="36" y="72" width="28" height="4" rx="2" {FL}/>')
I["hatchling"] = (  # a baby chick poking out of cracked shell halves (distinct from the cracking `hatching`)
                  f'<path d="M30 60 Q50 70 70 60 L66 52 L60 58 L54 50 L48 58 L42 50 L36 58 L34 54 Z" {FL}/>'
                  f'<circle cx="50" cy="46" r="13" {FL}/>'
                  f'<circle cx="45" cy="44" r="2" {CUT}/><circle cx="55" cy="44" r="2" {CUT}/>'
                  f'<polygon points="48,48 52,48 50,52" {CUT}/>'
                  f'<path d="M40 36 L44 30 L48 36 L52 30 L56 36 Q50 32 40 36 Z" {FL}/>'
                  f'<path d="M50 33 V27" {STt}/>')
I["hope"] = sun(50, 45, 11) + f'<path d="{heart_d(50,67,20)}" {FL}/>'
I["hone"] = (f'<polygon points="31,72 66,26 75,35 40,81" {FL}/><polygon points="31,72 49,49 58,58 40,81" {SH2}/>'
             f'<path d="M26 32 L43 49 M57 63 L74 80" {STh} opacity="0.55"/>')
I["hoofprint"] = (f'<path d="M34 35 C28 52 34 72 50 78 C66 72 72 52 66 35 L57 39 C62 54 57 64 50 68 C43 64 38 54 43 39 Z" {FL}/>'
                  f'<path d="M50 40 V68" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["hour"] = (  # a pocket watch with crown + ring (distinct from the wall-clock `time`)
             f'<circle cx="50" cy="55" r="22" {FL}/>'
             f'<circle cx="50" cy="55" r="22" fill="none" stroke="#fff" stroke-width="1.8"/>'
             f'<rect x="44" y="25" width="12" height="7" rx="2" {FL}/>'
             f'<rect x="45.5" y="18" width="9" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="3"/>'
             f'<g {LWt}><line x1="50" y1="55" x2="50" y2="41"/><line x1="50" y1="55" x2="60" y2="59"/></g>'
             f'<circle cx="50" cy="55" r="2" {CUT}/>')
I["impostor"] = (f'<path d="M25 43 C38 32 62 32 75 43 C72 63 62 73 50 73 C38 73 28 63 25 43 Z" {FL}/>'
                 f'<circle cx="40" cy="50" r="5" {CUT}/><circle cx="60" cy="50" r="5" {CUT}/><path d="M42 65 q8 -5 16 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>')
I["ingenuity"] = (  # a glowing idea lightbulb with rays + filament
                  f'<path d="M37 41 a13 13 0 1 1 26 0 C61 48 57 51 57 57 H43 C43 51 39 48 37 41 Z" {FL}/>'
                  f'<rect x="43" y="57" width="14" height="4" {FL}/><rect x="44" y="61" width="12" height="4" {FL}/>'
                  f'<path d="M46 65 h8" {STm}/>'
                  f'<path d="M44 56 V45 a6 6 0 0 1 12 0 V56 M50 41 q-3 5 0 13" {LWt}/>'
                  f'<g {STt}><line x1="50" y1="22" x2="50" y2="16"/><line x1="30" y1="30" x2="25" y2="25"/><line x1="70" y1="30" x2="75" y2="25"/></g>')
I["intel"] = (  # a dossier folder with a ruled document peeking out — distinct from the `discovery` magnifier
              f'<rect x="34" y="30" width="32" height="34" rx="1.5" {CUT}/>'
              f'<g stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="40" y1="38" x2="60" y2="38"/>'
              f'<line x1="40" y1="44" x2="60" y2="44"/><line x1="40" y1="50" x2="54" y2="50"/></g>'
              f'<path d="M22 48 H40 L44 44 H78 V74 H22 Z" {FL}/>'
              f'<path d="M22 54 H78" {LWt}/>')
I["intervention"] = (  # a beam of divine light breaking through clouds, from a radiant star
                     f'<polygon points="45,24 55,24 72,70 28,70" {FL}/>'
                     f'<g {LWt}><line x1="50" y1="28" x2="50" y2="68"/>'
                     f'<line x1="46" y1="34" x2="40" y2="66"/><line x1="54" y1="34" x2="60" y2="66"/></g>'
                     + star(50, 24, 8, 3, 8, -90, FL)
                     + f'<path d="M24 70 q8 -8 16 0 q8 -8 16 0 q8 -8 16 0 V78 H24 Z" {FL}/>')
I["keyword"] = key_shape()
I["ki"] = (  # an open martial-arts palm inside an energy enso ring (chi)
           f'<path d="M71 33 A28 28 0 1 1 64 26" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/>'
           f'<path d="M40 66 C40 54 42 50 50 50 C58 50 60 54 60 66 C60 68 58 69 56 69 H44 C42 69 40 68 40 66 Z" {FL}/>'
           f'<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round">'
           f'<line x1="43" y1="54" x2="42" y2="37"/><line x1="49" y1="54" x2="49" y2="34"/>'
           f'<line x1="55" y1="54" x2="56" y2="37"/><line x1="61" y1="56" x2="63" y2="43"/></g>'
           f'<path d="M40 58 C34 56 31 60 33 65" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
           f'<path d="M42 56 q9 -3 18 0" {LWt}/>')
I["kick"] = (  # a bent leg kicking with an impact burst — distinct from the standing `haste` boot
             f'<path d="M26 32 L44 50 L68 46" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>'
             f'<path d="M68 46 L80 42 L78 54 Z" {FL}/>'
             + star(80, 48, 9, 3, 8, -90, FL)
             + f'<g {STt}><line x1="58" y1="34" x2="64" y2="29"/><line x1="60" y1="60" x2="66" y2="64"/></g>')
I["knickknack"] = (f'<rect x="32" y="35" width="36" height="36" rx="6" {FL}/>' + star(50, 53, 13, 5, 6, -90, CUT))
I["loot"] = (  # an open treasure chest spilling coins — distinct from the `treasure` drawstring bag
             f'<path d="M26 52 H74 V70 Q74 74 70 74 H30 Q26 74 26 70 Z" {FL}/>'
             f'<path d="M26 52 Q26 36 50 34 Q74 36 74 52 Z" {FL}/>'
             f'<path d="M26 52 H74" {LW}/>'
             f'<g {LWt}><path d="M40 52 V74 M60 52 V74"/></g>'
             f'<rect x="46" y="54" width="8" height="9" rx="1.5" {CUT}/>'
             f'<circle cx="36" cy="47" r="4" {FL}/><circle cx="36" cy="47" r="2.4" {CUT}/>'
             f'<circle cx="50" cy="44" r="4.5" {FL}/><circle cx="50" cy="44" r="2.8" {CUT}/>'
             f'<circle cx="64" cy="47" r="4" {FL}/><circle cx="64" cy="47" r="2.4" {CUT}/>')
I["loyalty"] = (f'<polygon points="28,70 34,37 47,55 50,31 53,55 66,37 72,70" {FL}/>'
                f'<rect x="30" y="70" width="40" height="7" rx="2" {FL}/>' + star(50, 58, 6, 2.4, 5, -90, CUT))
I["magnet"] = (f'<path d="M30 31 V56 a20 20 0 0 0 40 0 V31 H58 V56 a8 8 0 0 1 -16 0 V31 Z" {FL}/>'
               f'<rect x="30" y="31" width="12" height="11" {CUT}/><rect x="58" y="31" width="12" height="11" {CUT}/>')
I["manabond"] = (f'<circle cx="36" cy="50" r="12" {FL}/><circle cx="64" cy="50" r="12" {FL}/><path d="M48 50 H52" {STm}/>'
                 + star(36, 50, 5, 2, 5, -90, CUT) + star(64, 50, 5, 2, 5, -90, CUT))
I["mannequin"] = (f'<circle cx="50" cy="31" r="8" {FL}/><path d="M50 39 V65 M34 49 H66 M50 65 L38 80 M50 65 L62 80" {STm}/>'
                  f'<path d="M28 20 C38 26 62 26 72 20" {STh} opacity="0.5"/>')
I["mask"] = (  # a masquerade eye-mask on a stick (distinct from the full-face `impostor`)
             f'<path d="M24 42 C24 36 32 34 38 36 C44 33 56 33 62 36 C68 34 76 36 76 42 '
             f'C76 54 66 60 58 56 C54 60 46 60 42 56 C34 60 24 54 24 42 Z" {FL}/>'
             f'<ellipse cx="38" cy="46" rx="6" ry="4.5" {CUT}/><ellipse cx="62" cy="46" rx="6" ry="4.5" {CUT}/>'
             f'<path d="M30 40 q4 -3 8 -1 M70 40 q-4 -3 -8 -1" {LWt}/>'
             f'<line x1="62" y1="57" x2="72" y2="74" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>')
I["midway"] = (f'<path d="M28 74 H72 L58 29 H42 Z" {FL}/><path d="M50 29 V74" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
               f'<path d="M39 51 H61" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["necrodermis"] = (  # a metallic visored skull (living metal) — distinct from the `corpse` skeleton
                    f'<path d="M50 24 C36 24 28 34 28 48 C28 58 34 64 40 67 V74 H60 V67 C66 64 72 58 72 48 C72 34 64 24 50 24 Z" {FL}/>'
                    f'<path d="M34 44 H66 V50 H56 L52 60 H48 L44 50 H34 Z" {CUT}/>'
                    f'<g {LWt}><path d="M50 24 V40 M38 30 H62 M40 68 V74 M50 67 V74 M60 68 V74"/></g>')
I["night"] = (  # a crescent moon with stars and a wisp of cloud (distinct from `dream`)
              f'<path d="M60 58 A21 21 0 1 1 47 26 A16 16 0 1 0 60 58 Z" {FL}/>'
              + star(70, 30, 5, 2, 5, -90, FL) + star(32, 64, 4, 1.6, 5, -90, FL) + star(64, 71, 3, 1.2, 5, -90, FL)
              + f'<path d="M28 46 q9 -3 17 0 q6 -2 11 1" {STt}/>')
I["oil"] = (  # an oil drop falling into a rippling puddle
            f'<path d="M50 22 C50 22 38 42 38 52 a12 12 0 0 0 24 0 C62 42 50 22 50 22 Z" {FL}/>'
            f'<path d="M44 44 q-3 5 0 10" {LWt}/>'
            f'<ellipse cx="50" cy="71" rx="23" ry="6.5" {FL}/>'
            f'<ellipse cx="50" cy="71" rx="14" ry="3.6" fill="none" stroke="#fff" stroke-width="1.6"/>'
            f'<ellipse cx="50" cy="71" rx="6.5" ry="1.6" fill="none" stroke="#fff" stroke-width="1.4"/>')
I["palliation"] = (f'<rect x="25" y="42" width="50" height="16" rx="8" {FL}/><rect x="42" y="25" width="16" height="50" rx="8" {FL}/>'
                   f'<circle cx="50" cy="50" r="5" {CUT}/>')
I["poison"] = (  # a poison bottle with a skull-and-label
               f'<rect x="44" y="22" width="12" height="8" rx="2" {FL}/>'
               f'<path d="M42 30 H58 V40 C64 44 66 52 66 60 C66 72 58 78 50 78 C42 78 34 72 34 60 C34 52 36 44 42 40 Z" {FL}/>'
               f'<rect x="40" y="50" width="20" height="20" rx="2" {CUT}/>'
               + skull(50, 60, 0.22, teeth=False, detail=False))
I["possession"] = (f'<circle cx="58" cy="43" r="15" {SH2}/><path d="M28 78 V58 a4 4 0 0 1 8 0 V48 a4 4 0 0 1 8 0 V50 a4 4 0 0 1 8 0 V55 a4 4 0 0 1 8 0 V64 C60 76 52 82 42 82 Z" {FL}/>')
I["prey"] = (  # an animal paw-print track (hunting prey) — its own icon, no longer aim+star
             f'<path d="M37 58 C37 50 43 47 50 47 C57 47 63 50 63 58 C63 67 56 71 50 71 C44 71 37 67 37 58 Z" {FL}/>'
             f'<g {FL}><ellipse cx="39" cy="42" rx="4.5" ry="6"/><ellipse cx="50" cy="38" rx="4.5" ry="6"/>'
             f'<ellipse cx="61" cy="42" rx="4.5" ry="6"/><ellipse cx="69" cy="53" rx="4" ry="5"/></g>')
I["rally"] = (  # a raised clenched fist (rallying) — distinct from the `muster` banner
              f'<rect x="40" y="60" width="20" height="22" rx="2" {FL}/>'
              f'<path d="M36 50 C36 44 40 40 46 40 H58 C62 40 66 44 66 50 V62 H36 Z" {FL}/>'
              f'<path d="M36 53 C30 53 27 59 31 64" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>'
              f'<g {LWt}><path d="M44 47 V61 M52 46 V61 M60 47 V61"/><path d="M37 55 H65"/></g>')
I["rejection"] = (f'<circle cx="50" cy="50" r="28" fill="none" stroke="currentColor" stroke-width="6"/><line x1="31" y1="69" x2="69" y2="31" {ST}/>')
I["reprieve"] = (  # a dove with an olive branch (mercy / a stay) — distinct from hourglass/shield
                 f'<path d="M28 56 C36 46 48 44 60 48 C66 40 72 40 76 38 C74 46 72 50 66 52 C70 56 64 62 54 62 L40 64 C34 64 30 60 28 56 Z" {FL}/>'
                 f'<path d="M44 52 C50 45 58 45 64 49 C58 53 51 54 44 52 Z" {LWt}/>'
                 f'<circle cx="70" cy="44" r="1.7" {CUT}/>'
                 f'<path d="M26 60 q-7 1 -12 6" {STt}/><circle cx="15" cy="64" r="1.9" {FL}/><circle cx="20" cy="62" r="1.7" {FL}/>')
I["rev"] = (f'<path d="M25 64 a25 25 0 0 1 50 0" {STm}/><line x1="50" y1="64" x2="66" y2="45" {ST}/>'
            f'<circle cx="50" cy="64" r="4" {FL}/><path d="M31 64 H69" {STh} opacity="0.5"/>')
I["ritual"] = (f'<rect x="35" y="42" width="8" height="31" rx="2" {FL}/><rect x="57" y="42" width="8" height="31" rx="2" {FL}/>'
               + flame_layers() + f'<path d="M28 75 H72" {STt}/>')
I["rope"] = (f'<path d="M31 55 a19 19 0 1 1 38 0 a14 14 0 1 1 -28 0 a9 9 0 1 1 18 0" {STm}/>')
I["scream"] = (f'<path d="M50 22 C36 22 30 36 30 52 C30 70 40 80 50 80 C60 80 70 70 70 52 C70 36 64 22 50 22 Z" {FL}/>'
               f'<circle cx="42" cy="45" r="4" {CUT}/><circle cx="58" cy="45" r="4" {CUT}/><ellipse cx="50" cy="63" rx="7" ry="11" {CUT}/>')
I["scroll"] = (  # a horizontal rolled scroll: two rollers + parchment with text
               f'<rect x="30" y="34" width="40" height="32" {FL}/>'
               f'<g {LWt}><line x1="37" y1="42" x2="63" y2="42"/><line x1="37" y1="50" x2="63" y2="50"/>'
               f'<line x1="37" y1="58" x2="57" y2="58"/></g>'
               f'<rect x="24" y="30" width="10" height="40" rx="5" {FL}/>'
               f'<rect x="66" y="30" width="10" height="40" rx="5" {FL}/>'
               f'<g {LWt}><line x1="29" y1="34" x2="29" y2="66"/><line x1="71" y1="34" x2="71" y2="66"/></g>')
I["sleight"] = (f'<rect x="31" y="31" width="28" height="40" rx="3" transform="rotate(-12 45 51)" {FL}/>'
                f'<rect x="43" y="28" width="28" height="40" rx="3" transform="rotate(12 57 48)" {FL}/>' + star(55, 48, 5, 2, 4, -90, CUT))
I["slumber"] = (  # a pillow on a bed with rising Zzz — distinct from the closed-eyes `sleep` face
                f'<path d="M22 58 C22 50 30 47 50 47 C70 47 78 50 78 58 V64 C78 68 74 70 68 70 H32 C26 70 22 68 22 64 Z" {FL}/>'
                f'<path d="M30 54 q20 -5 40 0" {LWt}/>'
                f'<rect x="20" y="70" width="60" height="6" rx="2" {FL}/>'
                f'<text x="56" y="38" font-family="Georgia,serif" font-size="16" font-weight="bold" {FL}>Z</text>'
                f'<text x="67" y="30" font-family="Georgia,serif" font-size="11" font-weight="bold" {FL}>z</text>')
I["spark"] = (  # a bright 4-point sparkle with drifting particles
              f'<polygon points="50,20 55,44 80,50 55,56 50,80 45,56 20,50 45,44" {FL}/>'
              f'<polygon points="50,38 53,47 62,50 53,53 50,62 47,53 38,50 47,47" {CUT}/>'
              f'<circle cx="71" cy="29" r="2.4" {FL}/><circle cx="29" cy="69" r="2" {FL}/>')
I["spooky"] = (  # a carved jack-o'-lantern — distinct from the `ghostform` ghost
               f'<path d="M48 34 C46 30 44 28 40 28" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
               f'<path d="M50 36 C42 30 30 34 28 50 C26 64 36 74 50 74 C64 74 74 64 72 50 C70 34 58 30 50 36 Z" {FL}/>'
               f'<g {LWt}><path d="M42 40 q-5 14 0 30 M58 40 q5 14 0 30"/></g>'
               f'<polygon points="38,50 46,46 44,54" {CUT}/><polygon points="62,50 54,46 56,54" {CUT}/>'
               f'<polygon points="47,56 53,56 50,61" {CUT}/>'
               f'<path d="M38 64 L43 62 L46 66 L50 62 L54 66 L57 62 L62 64 L57 70 L43 70 Z" {CUT}/>')
I["strife"] = (  # two opposing forces clashing at a central burst
              f'<path d="M22 36 L40 50 L22 64" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
              f'<path d="M78 36 L60 50 L78 64" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
              + star(50, 50, 14, 5, 8, -90, FL) + f'<circle cx="50" cy="50" r="4" {GL}/>')
I["ticket"] = ticket_shape()
I["unity"] = (f'<circle cx="39" cy="50" r="15" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="61" cy="50" r="15" fill="none" stroke="currentColor" stroke-width="6"/>'
              f'<circle cx="50" cy="50" r="5" {FL}/>')
I["unlock"] = lock_shape(opened=True)
I["valor"] = (  # an award medal on a ribbon with a star
              f'<path d="M40 24 L50 46 L42 50 L34 28 Z" {FL}/>'
              f'<path d="M60 24 L50 46 L58 50 L66 28 Z" {FL}/>'
              f'<circle cx="50" cy="60" r="17" {FL}/>'
              f'<circle cx="50" cy="60" r="17" fill="none" stroke="#fff" stroke-width="1.6"/>'
              + star(50, 60, 9, 3.6, 5, -90, CUT))
I["volatile"] = (  # an Erlenmeyer flask fizzing over with an explosive burst
                 f'<path d="M45 24 H55 V38 L67 68 a4 4 0 0 1 -4 6 H37 a4 4 0 0 1 -4 -6 L45 38 Z" {FL}/>'
                 f'<path d="M40 56 H60" {LWt}/>'
                 + star(50, 19, 9, 3, 8, -90, FL)
                 + f'<circle cx="41" cy="15" r="2.4" {FL}/><circle cx="61" cy="13" r="2" {FL}/>')
I["voyage"] = (f'<path d="M24 63 Q50 76 76 63 Q70 78 50 80 Q30 78 24 63 Z" {FL}/><path d="M50 24 V64" {STm}/>'
               f'<path d="M50 28 L70 58 H50 Z" {FL}/><path d="M50 35 L33 58 H50 Z" {SH2}/>')
I["wreck"] = (f'<path d="M25 67 Q50 80 75 67 Q66 78 50 80 Q34 78 25 67 Z" {FL}/>'
              f'<path d="M39 27 L65 70 M62 30 L35 70" {STm}/><path d="M26 82 q24 -8 48 0" {STh} opacity="0.45"/>')

# ---------------- P/T COUNTERS -------------------------------------------
def pt(top, bot, sign):
    return (f'<text x="50" y="44" font-family="Georgia,serif" font-weight="700" font-size="26" '
            f'text-anchor="middle" {FL}>{sign}{top}</text>'
            f'<line x1="31" y1="50" x2="69" y2="50" stroke="currentColor" stroke-width="2.4" opacity="0.5"/>'
            f'<text x="50" y="78" font-family="Georgia,serif" font-weight="700" font-size="26" '
            f'text-anchor="middle" {FL}>{sign}{bot}</text>')
PLUS = [(1,1),(0,1),(1,0),(0,2),(2,0),(1,2),(2,1),(2,2)]
for a,b in PLUS:
    I[f"plus-{a}-{b}"] = pt(a,b,"+")
    I[f"minus-{a}-{b}"] = pt(a,b,"−")
# blank medallion (for arbitrary values overlaid by CSS/JS)
I["pt-blank"] = f'<line x1="31" y1="50" x2="69" y2="50" stroke="currentColor" stroke-width="2.4" opacity="0.5"/>'

# =========================================================================
def bead_ring():
    # denticle / bead ring just inside the rim — classic minted-coin detail, solid black
    s = ''
    for i in range(40):
        x, y = onc(50, 50, 41, i*360/40)
        s += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.15" fill="currentColor"/>'
    return s
FRAME = (  # pure black-and-white minted rim: outer ring + denticle beads + inner ring
    '<circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="2.6"/>'
    + bead_ring()
    + '<circle cx="50" cy="50" r="37" fill="none" stroke="currentColor" stroke-width="1.4"/>')

BG = '#17171c'   # dark disc background (real MTG counters: dark disc, white symbol)

def wrap(inner):
    body = f'  {FRAME}\n  {inner}\n'
    # HARD GUARANTEE of pure black & white: strip every opacity attribute so no shape
    # can render as a translucent (gray) tone.
    body = re.sub(r'\s+opacity="[^"]*"', '', body)
    body = re.sub(r"\s+opacity='[^']*'", '', body)
    # INVERT the palette to the real-MTG-counter look: a dark disc with a WHITE frame +
    # symbol and DARK cut-out detail. Icons are authored black-body (currentColor) + white
    # detail (#fff); here we flip both. Order matters — retire #fff first so the currentColor
    # -> #fff step below doesn't get re-flipped.
    body = body.replace('#fff', BG)              # white cut/glint/detail -> dark cut-out
    body = body.replace('currentColor', '#fff')  # black bodies / frame / line-art -> white
    bg = f'  <circle cx="50" cy="50" r="50" fill="{BG}"/>\n'
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">\n'
            + bg + body + '</svg>\n')

# =========================================================================
# DECORATIVE SURROUND FLOURISHES (framing flair, like the ki enso ring).
# Authored in the black-body convention (currentColor/#fff) so wrap() inverts them to
# white. They live in the annulus (r ~32-37) between the subject and the inner frame ring.
def sur_dots(n=20, r=35, rr=1.15, a0=0):
    return "".join(f'<circle cx="{onc(50,50,r,a0+i*360/n)[0]:.1f}" cy="{onc(50,50,r,a0+i*360/n)[1]:.1f}" r="{rr}" {FL}/>' for i in range(n))
def sur_ticks(n=24, r0=32.5, r1=36.5, w=1.7):
    return (f'<g stroke="currentColor" stroke-width="{w}" stroke-linecap="round">'
            + "".join(f'<line x1="{onc(50,50,r0,i*360/n)[0]:.1f}" y1="{onc(50,50,r0,i*360/n)[1]:.1f}" x2="{onc(50,50,r1,i*360/n)[0]:.1f}" y2="{onc(50,50,r1,i*360/n)[1]:.1f}"/>' for i in range(n)) + '</g>')
def sur_spikes(n=20, r0=32.5, r1=37, frac=0.5):
    hw = 180.0/n*frac
    out = ''
    for i in range(n):
        a = i*360.0/n
        tip = onc(50, 50, r1, a); b1 = onc(50, 50, r0, a-hw); b2 = onc(50, 50, r0, a+hw)
        out += f'<polygon points="{tip[0]:.1f},{tip[1]:.1f} {b1[0]:.1f},{b1[1]:.1f} {b2[0]:.1f},{b2[1]:.1f}" {FL}/>'
    return out
def sur_enso(r=31, w=3.4, a0=-52, a1=232):
    x0, y0 = onc(50, 50, r, a0); x1, y1 = onc(50, 50, r, a1)
    large = 1 if (a1-a0) % 360 > 180 else 0
    return f'<path d="M{x0:.1f} {y0:.1f} A{r} {r} 0 {large} 1 {x1:.1f} {y1:.1f}" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round"/>'
def sur_rays(n=12, r0=33.5, r1=37, w=2.0):
    return (f'<g stroke="currentColor" stroke-width="{w}" stroke-linecap="round">'
            + "".join(f'<line x1="{onc(50,50,r0,i*360/n)[0]:.1f}" y1="{onc(50,50,r0,i*360/n)[1]:.1f}" x2="{onc(50,50,r1,i*360/n)[0]:.1f}" y2="{onc(50,50,r1,i*360/n)[1]:.1f}"/>' for i in range(n)) + '</g>')
def sur_sparkles(pts=None):
    pts = pts or [(27, 27), (73, 27), (27, 73), (73, 73)]
    return "".join(star(x, y, 3.6, 1.35, 4, -90, FL) for x, y in pts)
def sur_arcs():  # a swoosh above and below (brushstroke frame)
    return (f'<path d="M28 30 A32 32 0 0 1 72 30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'
            f'<path d="M28 70 A32 32 0 0 0 72 70" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>')

# Per-icon flair assignment. Each icon gets a thematic surround (deathtouch & menace
# excluded per user; P/T counters excluded so they match the inline renderer).
_R = sur_rays(12, 33.5, 37, 2.0)     # radiant — holy / light / valuable / vision
_S = sur_spikes(20, 32.5, 37, 0.5)   # jagged spikes — aggressive / fire / decay (sharp texture)
_D = sur_dots(20, 35.5, 1.1)         # orbit dots — organic / neutral / time / water
_T = sur_ticks(24, 32.5, 36.5, 1.7)  # radial ticks — mechanical / measured / tool
_K = sur_sparkles()                  # corner sparkles — treasure / magic / luck
_E = sur_enso()                      # brush ring — energy / spirit / flow
_FX = {
    _R: ["aegis","awakening","blessing","crystal","defense","devotion","divinity","exalted","experience",
         "flash","flying","foreshadow","gem","healing","hexproof","hexproof-black","hexproof-blue",
         "hexproof-green","hexproof-red","hexproof-white","hope","ice","immunity","incarnation","ingenuity",
         "intervention","lifelink","lore","loyalty","muster","palliation","phylactery","quest","rally",
         "reprieve","revival","shield","soul","story","study","unity","valor","verse","vitality","vow","ward"],
    _S: ["arrow","arrowhead","blaze","blight","burden","carrion","charge","corruption","death","decayed",
         "descent","despair","double-strike","ember","finality","fire","first-strike","flame","fury","hit",
         "hone","hunger","infection","javelin","kick","mine","mining","necrodermis","ore","pain",
         "paralyzation","petrification","phyresis","plague","pressure","rad","rejection","rev","ritual",
         "rust","scream","shred","skull","spite","spooky","strife","stun","takeover","training",
         "training-swords","trample","velocity","void","volatile","wreck"],
    _D: ["acorn","age","aim","bait","blood","bloodline","bloodstain","book","brain","brick","cage","cell",
         "collection","contested","corpse","credit","croak","cube","currency","defender","delay","depletion",
         "dream","echo","egg","enlightened","eon","eruption","exposure","eyeball","eyestalk","fade","fate",
         "feather","feeding","fellowship","fetch","film","flood","fungus","ghostform","growth","hack","haste",
         "hatching","hatchling","hoofprint","hour","hourglass","impostor","incubation","indestructible","intel",
         "invitation","isolation","judgment","knowledge","level","loot","lure","manifestation","mannequin",
         "mask","matrix","memory","midway","mire","music","nest","net","night","oil","page","pause","petal",
         "poison","polyp","possession","prey","pupa","reach","ribbon","rope","scroll","shadow","shell","sleep",
         "slime","slumber","soot","spore","suspect","task","tide","time","tower","vigilance","voyage","wind"],
    _T: ["bounty","bribery","component","crank","duty","glyph","keyword","magnet","pin","plot","point",
         "stash","storage","supply","theft","ticket","unlock","winch"],
    _K: ["coin","elixir","everything","fuse","gold","knickknack","luck","manabond","omen","silver","sleight",
         "spark","treasure","wage","wish"],
    _E: ["energy","harmony","influence","ki"],
}
SURROUND_FX = {}
for _motif, _names in _FX.items():
    for _n in _names:
        SURROUND_FX[_n] = _motif

count = 0
for name, inner in I.items():
    fx = SURROUND_FX.get(name, '') if name not in ('deathtouch', 'menace') else ''
    with open(os.path.join(OUT, name + ".svg"), "w", encoding="utf-8") as f:
        f.write(wrap(inner + fx))
    count += 1
names = sorted(I)
cards = "\n".join(
    f'<figure><span class="token"><img src="{name}.svg" alt="{name}"></span><figcaption>{name}</figcaption></figure>'
    for name in names
)
index_html = f'''<!doctype html>
<meta charset="utf-8">
<title>Counter icons</title>
<style>
  body {{ margin: 24px; background: #101014; color: #eeeef4; font-family: system-ui, sans-serif; }}
  h1 {{ margin: 0 0 16px; font-size: 18px; font-weight: 650; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 16px; }}
  figure {{ margin: 0; text-align: center; }}
  .token {{ display: inline-grid; place-items: center; width: 72px; height: 72px; border-radius: 50%; background: #efe7d2; box-shadow: 0 0 0 1px rgba(0,0,0,.45); }}
  img {{ display: block; width: 72px; height: 72px; }}
  figcaption {{ margin-top: 6px; color: #aaaab6; font-size: 11px; overflow-wrap: anywhere; }}
</style>
<h1>Counter icon set - {len(names)} icons</h1>
<div class="grid">
{cards}
</div>
'''
with open(os.path.join(OUT, "_index.html"), "w", encoding="utf-8") as f:
    f.write(index_html)
print(f"Wrote {count} SVGs to {OUT}")
