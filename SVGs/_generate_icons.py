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

I["blood"] = droplet(50, 53, 42, 60)

I["book"] = (  # an open book: two black pages meeting at a spine
             f'<path d="M50 32 C40 28 30 28 22 30 L22 66 C30 64 40 66 50 70 '
             f'C60 66 70 64 78 66 L78 30 C70 28 60 28 50 32 Z" {FL}/>'
             # white spine crease + ruled text lines so it reads as a book, not a block
             f'<path d="M50 32 V70" {LW}/>'
             f'<g {LWt}>'
             f'<line x1="28" y1="40" x2="44" y2="39"/><line x1="28" y1="47" x2="44" y2="46"/><line x1="28" y1="54" x2="40" y2="53"/>'
             f'<line x1="56" y1="39" x2="72" y2="40"/><line x1="56" y1="46" x2="72" y2="47"/><line x1="60" y1="53" x2="72" y2="54"/>'
             f'</g>')

I["coin"] = coin(50, 50, 23, 'coin')

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

I["gem"] = gem_facets() + star(64, 30, 4.5, 1.8, 4, -90, GL)

I["gold"] = coin(50, 50, 23, 'star') + f'<circle cx="40" cy="40" r="3" {GL}/>'

I["hourglass"] = (f'<g {STm}><line x1="32" y1="24" x2="68" y2="24"/><line x1="32" y1="76" x2="68" y2="76"/>'
                  f'<path d="M37 24 C37 40 50 46 50 50 C50 54 37 60 37 76"/>'
                  f'<path d="M63 24 C63 40 50 46 50 50 C50 54 63 60 63 76"/></g>'
                  f'<path d="M43 30 H57 L50 43 Z" {FL}/>'
                  f'<path d="M50 57 L44 70 H56 Z" {SH}/>'
                  f'<line x1="50" y1="50" x2="50" y2="62" {STh} opacity="0.6"/>')

I["ice"] = snowflake()

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

I["page"] = (f'<path d="M34 22 H58 L68 32 V78 H34 Z" {FL}/>'
             # white dog-eared fold + ruled lines → reads as a sheet of paper
             f'<polyline points="58,22 58,32 68,32" {LWt}/>'
             f'<g {LWt}><line x1="40" y1="44" x2="62" y2="44"/><line x1="40" y1="52" x2="62" y2="52"/>'
             f'<line x1="40" y1="60" x2="62" y2="60"/><line x1="40" y1="68" x2="54" y2="68"/></g>')

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

I["shield"] = shield_line(star(50, 50, 7, 3, 4, -90, FL))

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

I["treasure"] = (  # coins spilling above a chest — black bodies, white detail
                 f'<circle cx="40" cy="40" r="5" {FL}/><circle cx="40" cy="40" r="3.2" fill="none" stroke="#fff" stroke-width="1.2"/>'
                 f'<circle cx="51" cy="36" r="5.5" {FL}/><circle cx="51" cy="36" r="3.6" fill="none" stroke="#fff" stroke-width="1.2"/>'
                 f'<circle cx="61" cy="40" r="5" {FL}/><circle cx="61" cy="40" r="3.2" fill="none" stroke="#fff" stroke-width="1.2"/>'
                 f'<path d="M27 47 Q50 33 73 47 V51 H27 Z" {FL}/>'
                 f'<path d="M28 51 H72 V70 Q72 74 68 74 H32 Q28 74 28 70 Z" {FL}/>'
                 f'<path d="M27 51 H73" {LW}/>'
                 f'<g {LWt}><path d="M38 51 V74"/><path d="M62 51 V74"/></g>'
                 f'<rect x="46" y="56" width="8" height="11" rx="1.5" {CUT}/>'
                 f'<rect x="49" y="60" width="2" height="4" rx="1" {FL}/>')

I["wish"] = (star(50, 49, 27, 11, 5, -90, FL) + star(50, 49, 16, 6, 5, -90, SH2)
             + f'<circle cx="70" cy="30" r="2.6" {FL}/><circle cx="31" cy="34" r="2" {FL}/>'
             f'<circle cx="72" cy="52" r="1.6" {FL}/>')

# ---------------- REDESIGNS (enriched) -----------------------------------
I["crank"] = cog()

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

I["charge"] = bolt()

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

I["dream"] = (f'<path d="M64 60 A22 22 0 1 1 50 26 A17 17 0 1 0 64 60 Z" {FL}/>'
              f'<path d="M64 60 A22 22 0 0 1 36 30 A17 17 0 0 0 64 60 Z" {SH2}/>'
              + star(70, 32, 6, 2.6, 4, -90, FL) + star(57, 22, 4, 1.6, 4, -90, FL)
              + f'<circle cx="74" cy="50" r="2.2" {FL}/>')

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

I["fetch"] = (f'<path d="M40 80 V52 a4 4 0 0 1 8 0 V40 a4 4 0 0 1 8 0 V42 a4 4 0 0 1 8 0 V46 a4 4 0 0 1 8 0 V58 '
              f'C72 73 64 82 54 82 Z" {FL}/>'
              f'<path d="M40 80 V52 a4 4 0 0 1 8 0 V82 Z" {SH2}/>'
              f'<line x1="40" y1="56" x2="29" y2="43" {ST}/>'
              f'<g {STh} opacity="0.5"><path d="M48 52 V64 M56 56 V64 M64 58 V64"/></g>')

I["filibuster"] = scroll(3)

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

I["immunity"] = shield_line(star(50, 50, 11, 4.5, 4, -90, FL) + f'<circle cx="44" cy="40" r="2" {GL}/>')

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

I["invitation"] = (f'<rect x="25" y="33" width="50" height="34" rx="3" {FL}/>'
                   f'<rect x="25" y="33" width="50" height="34" rx="3" {SH2}/>'
                   f'<rect x="25" y="33" width="50" height="34" rx="3" {STt}/>'
                   f'<polyline points="25,35 50,55 75,35" {STt}/>'
                   f'<polyline points="25,65 42,50 M75,65 58,50" {STh} opacity="0.5"/>'
                   + star(50, 50, 5, 2, 5, -90, GL))

I["isolation"] = (f'<circle cx="50" cy="50" r="29" fill="none" stroke="currentColor" stroke-width="3.5"/>'
                  f'<circle cx="50" cy="50" r="29" {SH2}/>'
                  f'<circle cx="50" cy="42" r="7.5" {FL}/>'
                  f'<path d="M37 68 Q50 50 63 68 Z" {FL}/>')

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

I["luck"] = ("".join(f'<path d="{heart_d(50,40.5,23)}" transform="rotate({a} 50 48)" {FL}/>' for a in (0, 90, 180, 270))
             + "".join(f'<path d="{heart_d(50,40.5,16)}" transform="rotate({a} 50 48)" {SH2}/>' for a in (0, 90, 180, 270))
             + f'<path d="M50 48 Q53 67 59 80" {STt}/>')

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

I["silver"] = coin(50, 50, 23, 'shine')

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

I["task"] = (f'<rect x="30" y="26" width="40" height="50" rx="3" {FL}/>'
             f'<rect x="30" y="26" width="40" height="50" rx="3" {SH2}/>'
             f'<rect x="30" y="26" width="40" height="50" rx="3" {STt}/>'
             f'<rect x="42" y="21" width="16" height="9" rx="2" {FL}/>'
             f'<polyline points="38,50 45,58 60,40" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
             f'<g {STh} opacity="0.5"><line x1="38" y1="64" x2="62" y2="64"/></g>')

I["theft"] = (f'<circle cx="58" cy="32" r="9" fill="none" stroke="currentColor" stroke-width="4"/>'
              f'<text x="58" y="37" font-family="Georgia,serif" font-size="11" font-weight="bold" text-anchor="middle" {FL}>$</text>'
              f'<path d="M24 80 V58 a4 4 0 0 1 8 0 V48 a4 4 0 0 1 8 0 V50 a4 4 0 0 1 8 0 V54 a4 4 0 0 1 8 0 V64 '
              f'C56 76 48 82 38 82 Z" {FL}/>'
              f'<path d="M24 80 V58 a4 4 0 0 1 8 0 V82 Z" {SH2}/>')

I["tide"] = (f'<path d="M22 64 C30 50 38 50 46 58 C54 66 64 64 70 52 C74 44 72 36 66 34 '
             f'C72 32 78 38 78 48 C78 64 64 74 50 74 C38 74 28 70 22 64 Z" {FL}/>'
             f'<path d="M70 52 C74 44 72 36 66 34 C72 32 78 38 78 48 C78 56 74 62 68 66 Z" {SH2}/>'
             f'<path d="M26 70 q10 4 22 2 M40 76 q10 2 20 -1" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.6"/>'
             f'<circle cx="58" cy="44" r="3" {GL}/>')

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

I["training-swords"] = sword(32) + sword(-32)

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

I["vortex"] = (f'<path d="M50 50 c0 -8 12 -8 12 2 c0 14 -20 16 -24 0 c-4 -22 26 -26 36 -4 '
               f'c8 22 -22 38 -44 24" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>'
               f'<path d="M50 50 c0 -8 12 -8 12 2 c0 14 -20 16 -24 0" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4" stroke-linecap="round"/>'
               f'<circle cx="50" cy="50" r="3" {FL}/>')

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
I["flying"] = (f'<path d="M20 56 C36 40 56 36 80 38 C72 44 72 44 78 48 C68 50 68 50 72 56 '
               f'C60 56 60 56 62 62 C46 60 30 60 20 56 Z" {FL}/>'
               f'<path d="M20 56 C36 40 56 36 80 38 C60 46 40 52 20 56 Z" {SH2}/>'
               f'<path d="M34 50 H62 M30 54 H58" {STh} opacity="0.4"/>')

I["first-strike"] = sword()
I["double-strike"] = sword(30) + sword(-30)

I["vigilance"] = (f'<path d="M31 75 V35 H69 V75 Z" {FL}/>'
                  f'<path d="M31 75 V35 H50 V75 Z" {SH2}/>'
                  f'<path d="M27 35 V25 H37 V31 H46 V25 H54 V31 H63 V25 H73 V35 Z" {FL}/>'
                  f'<path d="M43 75 V58 a7 7 0 0 1 14 0 V75 Z" {SH}/>'
                  f'<path d="M50 42 L58 50 L50 58 L42 50 Z" {CUT}/><circle cx="50" cy="50" r="3" {FL}/>'
                  f'<path d="M22 42 L34 48 M78 42 L66 48 M50 18 V27" {STh} opacity="0.65"/>')

I["reach"] = (f'<path d="M38 80 V52 a4 4 0 0 1 8 0 V34 a4 4 0 0 1 8 0 V52 a4 4 0 0 1 8 0 V44 '
              f'a4 4 0 0 1 8 0 a4 4 0 0 1 8 0 V62 C70 75 62 82 52 82 Z" {FL}/>'
              f'<path d="M38 80 V52 a4 4 0 0 1 8 0 V82 Z" {SH2}/>')

I["menace"] = (f'<path d="M28 36 C28 30 36 30 38 36 C44 30 56 30 62 36 C64 30 72 30 72 36 '
               f'C72 52 62 68 50 74 C38 68 28 52 28 36 Z" {FL}/>'
               f'<path d="M28 36 C28 30 36 30 38 36 C44 30 50 30 50 36 V74 C38 68 28 52 28 36 Z" {SH2}/>'
               f'<polygon points="40,46 46,46 43,54" {CUT}/><polygon points="54,46 60,46 57,54" {CUT}/>'
               f'<path d="M44 62 q6 5 12 0" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" opacity="0.85"/>')

I["lifelink"] = heart(50, 52, 48)
I["death"] = (f'<path d="M32 78 V47 a18 18 0 0 1 36 0 V78 Z" {FL}/>'
              f'<path d="M32 78 V47 a18 18 0 0 1 18 -18 V78 Z" {SH2}/>'
              f'<path d="M42 50 H58 M50 40 V65" stroke="#fff" stroke-width="3.2" stroke-linecap="round" opacity="0.8"/>'
              f'<line x1="26" y1="80" x2="74" y2="80" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
              f'<path d="M29 30 C37 18 55 17 67 26" {STt}/>')
I["deathtouch"] = (f'<path d="M38 23 C45 43 44 62 34 78 C54 67 64 48 62 25 C56 34 48 34 38 23 Z" {FL}/>'
                   f'<path d="M38 23 C45 43 44 62 34 78 C44 64 49 44 46 29 Z" {SH2}/>'
                   f'<path d="M62 25 C60 48 66 63 76 77 C60 69 53 50 54 33 C58 33 60 31 62 25 Z" {FL}/>'
                   f'<path d="M48 70 q2 8 -2 13 M61 68 q3 8 -1 14" {STt} opacity="0.85"/>'
                   f'<circle cx="48" cy="84" r="2.6" {FL}/><circle cx="61" cy="83" r="2.4" {FL}/>')
I["indestructible"] = shield_solid()

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

I["haste"] = (f'<path d="M36 25 H55 L59 49 L72 56 C78 59 77 70 68 72 H34 C27 72 24 67 29 61 L40 48 Z" {FL}/>'
              f'<path d="M36 25 H48 L45 50 L31 68 C28 65 29 61 33 57 L40 48 Z" {SH2}/>'
              f'<path d="M54 49 L70 57 H51 Z" {SH}/>'
              f'<path d="M23 39 H37 M17 51 H34 M23 63 H29" {STm}/>'
              f'<circle cx="76" cy="39" r="2.2" {FL}/><circle cx="82" cy="51" r="1.8" {SH}/>')
I["flash"] = star(50, 50, 31, 7, 4, -90, FL) + star(50, 50, 16, 4, 4, -90, SH) + f'<circle cx="50" cy="50" r="3.4" {GL}/>'
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

I["aegis"] = shield_solid() + star(50, 51, 8, 3, 4, -90, CUT)
I["age"] = I["hourglass"]
I["aim"] = I["point"]
I["awakening"] = sun(50, 48, 12)
I["bait"] = I["lure"]
I["blessing"] = heart(50, 58, 32) + sun(50, 32, 7)
I["blight"] = (f'<path d="M52 20 C70 36 67 62 48 80 C35 63 31 42 52 20 Z" {FL}/>'
               f'<path d="M34 36 L65 67 M62 36 L37 62" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["bloodline"] = (droplet(50, 35, 18, 26)
                  +
                  f'<path d="M50 47 V61 M50 61 L35 74 M50 61 L65 74" {STt}/>'
                  f'<circle cx="35" cy="74" r="5" {FL}/><circle cx="65" cy="74" r="5" {FL}/>')
I["bloodstain"] = (droplet(50, 54, 34, 46)
                   +
                   f'<circle cx="32" cy="42" r="4" {FL}/><circle cx="68" cy="45" r="5" {FL}/><circle cx="61" cy="77" r="3" {FL}/>')
I["bounty"] = coin(50, 50, 22, 'star') + f'<circle cx="50" cy="50" r="31" fill="none" stroke="currentColor" stroke-width="3"/>'
I["bribery"] = I["theft"] + f'<circle cx="68" cy="70" r="7" {FL}/><circle cx="68" cy="70" r="4" {CUT}/>'
I["carrion"] = skull(50, 45, 0.62, teeth=False, detail=False) + f'<path d="M30 73 Q50 62 70 73" {STm}/>'
I["cell"] = (f'<polygon points="{P(poly_pts(50,50,29,6,-90))}" {FL}/>'
             # white inner membrane + nucleus → reads as a cell, not a flat hexagon
             f'<polygon points="{P(poly_pts(50,50,18,6,-90))}" {LWt}/>'
             f'<circle cx="50" cy="50" r="5" {CUT}/>')
I["collection"] = I["stash"] + star(64, 42, 5, 2, 4, -90, GL)
I["component"] = cog(6) + f'<rect x="44" y="44" width="12" height="12" rx="2" {CUT}/>'
I["contested"] = (f'<path d="M36 22 V78 M64 22 V78" {STm}/><path d="M36 26 H63 L55 36 L63 46 H36 Z" {FL}/>'
                  f'<path d="M64 54 H37 L45 64 L37 74 H64 Z" {FL}/>')
I["credit"] = coin(50, 50, 23, 'coin') + f'<path d="M64 33 h9 M68.5 28.5 v9" {STh} opacity="0.75"/>'
I["croak"] = (f'<path d="M28 55 C28 35 72 35 72 55 C72 70 62 78 50 78 C38 78 28 70 28 55 Z" {FL}/>'
              f'<circle cx="39" cy="39" r="8" {FL}/><circle cx="61" cy="39" r="8" {FL}/>'
              f'<circle cx="39" cy="39" r="3" {CUT}/><circle cx="61" cy="39" r="3" {CUT}/><path d="M39 60 q11 8 22 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>')
I["currency"] = coin(50, 50, 23, 'coin')
I["defense"] = shield_solid()
I["delay"] = I["hourglass"] + f'<rect x="62" y="24" width="10" height="22" rx="2" {FL}/>'
I["depletion"] = (f'<rect x="26" y="38" width="42" height="24" rx="3" {STm}/><rect x="68" y="45" width="6" height="10" rx="2" {FL}/>'
                  f'<line x1="34" y1="69" x2="66" y2="31" {STm}/>')
I["descent"] = (f'<line x1="50" y1="22" x2="50" y2="72" {ST}/><polyline points="34,56 50,74 66,56" {ST}/>'
                f'<path d="M30 28 q20 8 40 0" {STh} opacity="0.45"/>')
I["despair"] = (f'<path d="{heart_d(50,54,44)}" {FL}/><path d="M36 42 L64 70 M64 42 L36 70" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>')
I["devotion"] = heart(50, 54, 38) + f'<path d="M50 26 V45 M40 34 L60 34" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
I["divinity"] = (f'<ellipse cx="50" cy="29" rx="19" ry="7" fill="none" stroke="currentColor" stroke-width="4"/>'
                 f'<path d="M50 39 L62 72 H38 Z" {FL}/>' + star(50, 55, 7, 2.8, 4, -90, CUT))
I["doom"] = I["death"] + f'<path d="M70 25 L76 16" {STt}/>'
I["duty"] = I["task"]
I["elixir"] = vial()
I["enlightened"] = I["knowledge"] + sun(66, 28, 5)
I["eon"] = I["time"] + f'<path d="M30 30 C50 16 70 30 70 50 C70 70 50 84 30 70" {STh} opacity="0.5"/>'
I["exposure"] = I["eyeball"] + f'<path d="M22 28 L16 20 M78 28 L84 20 M50 22 V12" {STh}/>'
I["film"] = (f'<rect x="27" y="25" width="46" height="50" rx="3" {FL}/>'
             f'<rect x="34" y="34" width="32" height="32" {CUT}/>'
             # white sprocket perforations down both margins → reads as a film frame
             f'<g fill="#fff">'
             + "".join(f'<rect x="28.5" y="{y}" width="4" height="5" rx="1"/><rect x="67.5" y="{y}" width="4" height="5" rx="1"/>' for y in (30, 41, 52, 63))
             + '</g>')
I["fire"] = I["flame"]
I["foreshadow"] = I["omen"] + f'<path d="M27 76 q23 -10 46 0" {STh} opacity="0.5"/>'
I["fuse"] = (f'<path d="M28 70 C42 42 58 58 72 28" {STm}/>' + star(73, 27, 10, 3, 8, -90, FL))
I["hack"] = I["matrix"] + f'<path d="M39 62 L47 42 L53 58 L61 38" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>'
I["hatchling"] = I["hatching"]
I["hope"] = sun(50, 45, 11) + f'<path d="{heart_d(50,67,20)}" {FL}/>'
I["hone"] = (f'<polygon points="31,72 66,26 75,35 40,81" {FL}/><polygon points="31,72 49,49 58,58 40,81" {SH2}/>'
             f'<path d="M26 32 L43 49 M57 63 L74 80" {STh} opacity="0.55"/>')
I["hoofprint"] = (f'<path d="M34 35 C28 52 34 72 50 78 C66 72 72 52 66 35 L57 39 C62 54 57 64 50 68 C43 64 38 54 43 39 Z" {FL}/>'
                  f'<path d="M50 40 V68" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["hour"] = I["time"]
I["impostor"] = (f'<path d="M25 43 C38 32 62 32 75 43 C72 63 62 73 50 73 C38 73 28 63 25 43 Z" {FL}/>'
                 f'<circle cx="40" cy="50" r="5" {CUT}/><circle cx="60" cy="50" r="5" {CUT}/><path d="M42 65 q8 -5 16 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>')
I["ingenuity"] = cog(7) + star(67, 28, 6, 2, 4, -90, GL)
I["intel"] = I["discovery"] + f'<rect x="25" y="57" width="24" height="20" rx="2" {FL}/>'
I["intervention"] = shield_solid() + f'<path d="M25 62 H75" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
I["keyword"] = key_shape()
I["ki"] = I["energy"]
I["kick"] = I["haste"]
I["knickknack"] = (f'<rect x="32" y="35" width="36" height="36" rx="6" {FL}/>' + star(50, 53, 13, 5, 6, -90, CUT))
I["loot"] = I["treasure"]
I["loyalty"] = (f'<polygon points="28,70 34,37 47,55 50,31 53,55 66,37 72,70" {FL}/>'
                f'<rect x="30" y="70" width="40" height="7" rx="2" {FL}/>' + star(50, 58, 6, 2.4, 5, -90, CUT))
I["magnet"] = (f'<path d="M30 31 V56 a20 20 0 0 0 40 0 V31 H58 V56 a8 8 0 0 1 -16 0 V31 Z" {FL}/>'
               f'<rect x="30" y="31" width="12" height="11" {CUT}/><rect x="58" y="31" width="12" height="11" {CUT}/>')
I["manabond"] = (f'<circle cx="36" cy="50" r="12" {FL}/><circle cx="64" cy="50" r="12" {FL}/><path d="M48 50 H52" {STm}/>'
                 + star(36, 50, 5, 2, 5, -90, CUT) + star(64, 50, 5, 2, 5, -90, CUT))
I["mannequin"] = (f'<circle cx="50" cy="31" r="8" {FL}/><path d="M50 39 V65 M34 49 H66 M50 65 L38 80 M50 65 L62 80" {STm}/>'
                  f'<path d="M28 20 C38 26 62 26 72 20" {STh} opacity="0.5"/>')
I["mask"] = I["impostor"]
I["midway"] = (f'<path d="M28 74 H72 L58 29 H42 Z" {FL}/><path d="M50 29 V74" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
               f'<path d="M39 51 H61" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>')
I["necrodermis"] = I["corpse"] + f'<path d="M28 70 q22 11 44 0" {STh} opacity="0.5"/>'
I["night"] = I["dream"]
I["oil"] = droplet(50, 54, 36, 50) + f'<ellipse cx="50" cy="73" rx="11" ry="4" {SH2}/>'
I["palliation"] = (f'<rect x="25" y="42" width="50" height="16" rx="8" {FL}/><rect x="42" y="25" width="16" height="50" rx="8" {FL}/>'
                   f'<circle cx="50" cy="50" r="5" {CUT}/>')
I["poison"] = vial() + skull(50, 66, 0.25, teeth=False, detail=False)
I["possession"] = (f'<circle cx="58" cy="43" r="15" {SH2}/><path d="M28 78 V58 a4 4 0 0 1 8 0 V48 a4 4 0 0 1 8 0 V50 a4 4 0 0 1 8 0 V55 a4 4 0 0 1 8 0 V64 C60 76 52 82 42 82 Z" {FL}/>')
I["prey"] = I["aim"] + f'<path d="M50 34 L55 47 L68 50 L55 53 L50 66 L45 53 L32 50 L45 47 Z" {FL}/>'
I["rally"] = I["muster"]
I["rejection"] = (f'<circle cx="50" cy="50" r="28" fill="none" stroke="currentColor" stroke-width="6"/><line x1="31" y1="69" x2="69" y2="31" {ST}/>')
I["reprieve"] = I["hourglass"] + f'<path d="{shield_d(68,48,20,28)}" {FL}/>'
I["rev"] = (f'<path d="M25 64 a25 25 0 0 1 50 0" {STm}/><line x1="50" y1="64" x2="66" y2="45" {ST}/>'
            f'<circle cx="50" cy="64" r="4" {FL}/><path d="M31 64 H69" {STh} opacity="0.5"/>')
I["ritual"] = (f'<rect x="35" y="42" width="8" height="31" rx="2" {FL}/><rect x="57" y="42" width="8" height="31" rx="2" {FL}/>'
               + flame_layers() + f'<path d="M28 75 H72" {STt}/>')
I["rope"] = (f'<path d="M31 55 a19 19 0 1 1 38 0 a14 14 0 1 1 -28 0 a9 9 0 1 1 18 0" {STm}/>')
I["scream"] = (f'<path d="M50 22 C36 22 30 36 30 52 C30 70 40 80 50 80 C60 80 70 70 70 52 C70 36 64 22 50 22 Z" {FL}/>'
               f'<circle cx="42" cy="45" r="4" {CUT}/><circle cx="58" cy="45" r="4" {CUT}/><ellipse cx="50" cy="63" rx="7" ry="11" {CUT}/>')
I["scroll"] = scroll(4)
I["sleight"] = (f'<rect x="31" y="31" width="28" height="40" rx="3" transform="rotate(-12 45 51)" {FL}/>'
                f'<rect x="43" y="28" width="28" height="40" rx="3" transform="rotate(12 57 48)" {FL}/>' + star(55, 48, 5, 2, 4, -90, CUT))
I["slumber"] = I["sleep"]
I["spark"] = star(50, 50, 30, 7, 8, -90, FL) + star(50, 50, 14, 4, 8, -90, CUT)
I["spooky"] = I["ghostform"]
I["strife"] = sword(45) + sword(-45)
I["ticket"] = ticket_shape()
I["unity"] = (f'<circle cx="39" cy="50" r="15" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="61" cy="50" r="15" fill="none" stroke="currentColor" stroke-width="6"/>'
              f'<circle cx="50" cy="50" r="5" {FL}/>')
I["unlock"] = lock_shape(opened=True)
I["valor"] = shield_solid() + sword(0)
I["volatile"] = vial(fill_drop=False) + star(64, 35, 12, 4, 8, -90, FL)
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

def wrap(inner):
    body = f'  {FRAME}\n  {inner}\n'
    # HARD GUARANTEE of pure black & white: strip every opacity attribute so no shape
    # can render as a translucent (gray) tone. Every fill/stroke is now solid black
    # (currentColor) or solid white (#fff).
    body = re.sub(r'\s+opacity="[^"]*"', '', body)
    body = re.sub(r"\s+opacity='[^']*'", '', body)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">\n'
            + body + '</svg>\n')

count = 0
for name, inner in I.items():
    with open(os.path.join(OUT, name + ".svg"), "w", encoding="utf-8") as f:
        f.write(wrap(inner))
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
