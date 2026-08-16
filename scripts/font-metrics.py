"""
Measure the fonts the app actually ships, so tests/run.ts can hold the type
contract against real files rather than against a lookup table of fonts we no
longer use.

Writes public/fonts/metrics.json with, per family:
  hasRupee     — U+20B9 present in cmap. The leading glyph of every price.
  xWidthAvg    — average advance of a-z, in em. Fits-the-money-column guard.
  lineBox      — (ascender - descender + lineGap) / unitsPerEm. Layout guard.
  weights      — the cuts we ship.

Run:  python scripts/font-metrics.py
Uses fontTools, which the type program's own build already depends on.
"""
import json
import os
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "public", "fonts")

FAMILIES = {
    "display": ["BuildObjectsDisplay2-Regular.woff2"],
    "ui": [f"BuildObjectsSans3-{w}.woff2" for w in ("Regular", "Medium", "SemiBold", "Bold")],
    "figure": [f"BuildObjectsSans5-{w}.woff2" for w in ("Light", "Regular", "Medium", "SemiBold", "Bold")],
}

def measure(path):
    f = TTFont(path)
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    os2 = f["OS/2"]
    hhea = f["hhea"]
    # Average lowercase advance — what capsize calls xWidthAvg.
    lower = [hmtx[cmap[c]][0] for c in range(ord("a"), ord("z") + 1) if c in cmap]
    x_avg = sum(lower) / len(lower) / upm if lower else None
    # Browsers use hhea on mac and typo/win on windows; capsize uses hhea. Match.
    line_box = (hhea.ascent - hhea.descent + hhea.lineGap) / upm
    return {
        "file": os.path.basename(path),
        "family": f["name"].getDebugName(1),
        "weight": os2.usWeightClass,
        "hasRupee": 0x20B9 in cmap,
        "xWidthAvg": round(x_avg, 4) if x_avg else None,
        "lineBox": round(line_box, 4),
        "glyphs": len(f.getGlyphOrder()),
    }

out = {}
for role, files in FAMILIES.items():
    cuts = [measure(os.path.join(FONTS, fn)) for fn in files if os.path.exists(os.path.join(FONTS, fn))]
    out[role] = {
        "family": cuts[0]["family"] if cuts else None,
        "hasRupee": all(c["hasRupee"] for c in cuts) if cuts else False,
        "xWidthAvg": cuts[0]["xWidthAvg"] if cuts else None,
        "lineBox": cuts[0]["lineBox"] if cuts else None,
        "weights": sorted(c["weight"] for c in cuts),
        "cuts": cuts,
    }

dst = os.path.join(FONTS, "metrics.json")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)

for role, m in out.items():
    # 'rupee' spelled out: the Windows console is cp1252 and cannot print U+20B9.
    print(f"{role:8} {m['family']:28} rupee={'yes' if m['hasRupee'] else 'NO '}  "
          f"xAvg={m['xWidthAvg']}  lineBox={m['lineBox']}  weights={m['weights']}")
print(f"\nwrote {os.path.relpath(dst, ROOT)}")
