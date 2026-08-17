"""
Subset the Sans 3 (Arimo) cuts to what the UI can render.

Arimo ships Latin, Greek, Cyrillic and Vietnamese — ~3,300 glyphs, 125-133 KB
per weight — and the interface sets none of the non-Latin scripts in it (the
Telugu and Devanagari in the search grammar fall through to a system face
either way). Keeping Latin + Latin Extended, punctuation, currency, arrows,
math and the symbol blocks the components emit brings each cut to ~52-56 KB
with the same metrics (OS/2 xAvgCharWidth is preserved) and the same GPOS.

    python scripts/font-subset.py typeface/... public/fonts/BuildObjectsSans3-Regular.woff2

Re-run scripts/font-metrics.py afterwards; tests/run.ts reads its output.
"""
import subprocess, sys

UNICODES = ",".join([
    "U+0000-024F",   # Basic Latin, Latin-1, Latin Extended A/B
    "U+02B0-02FF",   # spacing modifiers
    "U+0300-036F",   # combining diacritics
    "U+1E00-1EFF",   # Latin Extended Additional
    "U+2000-206F",   # general punctuation — dashes, quotes, ellipsis, ″
    "U+20A0-20CF",   # currency — ₹
    "U+2100-214F",   # letterlike — ™ ℓ №
    "U+2190-21FF",   # arrows
    "U+2200-22FF",   # mathematical operators — − ≈ ≤ ≥
    "U+2300-23FF",   # misc technical — ⌘
    "U+2500-25FF",   # box drawing, geometric shapes — ▲ ▸ ▼
    "U+2600-26FF",   # misc symbols
    "U+2700-27BF",   # dingbats — ✓ ✕ ✗
    "U+FB00-FB06",   # fi fl ligatures
    "U+FEFF,U+FFFD",
])

def main(src: str, out: str) -> None:
    subprocess.check_call([
        sys.executable, "-m", "fontTools.subset", src,
        "--flavor=woff2", f"--output-file={out}", f"--unicodes={UNICODES}",
        "--layout-features=*", "--name-IDs=*", "--notdef-outline",
    ])

if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
